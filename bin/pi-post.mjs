#!/usr/bin/env node
/**
 * pi-post CLI — the deposit half of pi-post for processes that are not pi
 * sessions: anvil runs at exit, Claude Code hooks, CI, shell scripts.
 *
 * Standalone on purpose: it duplicates the message/address contract from
 * src/ (which is TypeScript) so it runs under bare node. test/cli.test.ts
 * pins that both sides stay in agreement.
 *
 *   pi-post send --to <target> [--to <target> …] [--body <text>] [--from <label>] [--reply-to <addr>|none]
 *   pi-post list
 *   pi-post resolve <target>
 *   pi-post peek <target>
 *   pi-post whoami
 *
 * With no --body, the body is read from stdin. Env: PI_POST_DIR,
 * PI_POST_FROM, PI_POST_REPLY_TO; PI_SESSION_ID (set inside pi bash tools)
 * derives the default reply address.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

const MAX_BODY_BYTES = 32 * 1024;
const BACKLOG_CAP = 50;
const MAX_TARGETS = 8;
const ADDRESS_RE = /^s-[0-9a-f]{12}$/;

const root = process.env.PI_POST_DIR || join(homedir(), ".pi", "agent", "post");

const h12 = (input) => createHash("sha256").update(input).digest("hex").slice(0, 12);
const sessionAddress = (sessionId) => `s-${h12(`session\0${sessionId}`)}`;
const looksLikeSessionId = (t) => /^[0-9a-f]{8}[0-9a-f-]{0,28}$/i.test(t);
const resumeHandle = (sessionId) => (sessionId.length > 18 ? sessionId.slice(0, 18) : sessionId);

function canonicalPath(path) {
  let expanded = path;
  if (expanded === "~" || expanded.startsWith("~/")) expanded = resolve(homedir(), expanded.slice(2));
  const absolute = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

const looksLikePath = (t) =>
  t === "~" || t === "." || t === ".." || t.startsWith("~/") || t.startsWith("./") ||
  t.startsWith("../") || t.startsWith("/") || t.includes("/");

function listRecords() {
  const dir = join(root, "registry");
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (record.v === 1 && typeof record.address === "string") records.push(record);
    } catch {
      // ignore malformed records
    }
  }
  return records;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const isLive = (record) => record.pid !== undefined && pidAlive(record.pid);



function fail(message) {
  console.error(`pi-post: ${message}`);
  process.exit(1);
}

/** Live sessions outrank offline ones; a remaining tie is refused, never guessed. */
function pick(target, matches) {
  const live = matches.filter(isLive);
  const pool = live.length > 0 ? live : matches;
  if (pool.length === 1) {
    const record = pool[0];
    return { address: record.address, display: `${record.name} (${record.cwd})`, record };
  }
  fail(`"${target}" matches more than one session; use an address:\n` +
    pool.map((r) => `  ${r.name} (${r.address}) — ${r.cwd}`).join("\n"));
}

function resolveTarget(target) {
  const t = target.trim();
  if (ADDRESS_RE.test(t)) {
    return { address: t, display: t, record: listRecords().find((r) => r.address === t) };
  }
  const records = listRecords();
  if (looksLikePath(t)) {
    const canonical = canonicalPath(t);
    const matches = records.filter((r) => r.cwd === canonical);
    if (matches.length === 0) {
      fail(`no session is registered in ${canonical} — a directory names the session running in it`);
    }
    return pick(t, matches);
  }
  if (looksLikeSessionId(t)) {
    const bySessionId = records.filter((r) => r.sessionId.toLowerCase().startsWith(t.toLowerCase()));
    if (bySessionId.length > 0) return pick(t, bySessionId);
    // fall through: a hex-looking string may still be a session name
  }
  const byName = records.filter((r) => r.name === t);
  const matches = byName.length > 0 ? byName : records.filter((r) => basename(r.cwd) === t);
  if (matches.length === 0) {
    fail(`"${t}" is not an address, a session id, a directory with a registered session, or a known session name`);
  }
  return pick(t, matches);
}

function parseArgs(argv) {
  const args = { _: [] };
  const flags = new Set(["all"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (flags.has(key)) {
        args[key] = true;
        continue;
      }
      const value = argv[i + 1];
      if (key === "to" && args.to !== undefined) {
        args.to = Array.isArray(args.to) ? [...args.to, value] : [args.to, value];
      } else {
        args[key] = value;
      }
      i++;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function defaultReplyTo() {
  if (process.env.PI_POST_REPLY_TO) return process.env.PI_POST_REPLY_TO;
  if (process.env.PI_SESSION_ID) return sessionAddress(process.env.PI_SESSION_ID);
  return undefined;
}

async function send(args) {
  if (!args.to) fail("send requires --to <target>");
  const body = args.body ?? (await readStdin());
  if (!body || body.trim().length === 0) fail("empty body (pass --body or pipe stdin)");
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_BODY_BYTES) {
    fail(`body is ${bytes} bytes; the cap is ${MAX_BODY_BYTES} (send a summary and a path, not a payload)`);
  }

  // Resolve everything before depositing anything: an unresolvable target
  // fails the whole send, never a partial delivery. Duplicate handles for
  // one session collapse to a single deposit.
  const requested = Array.isArray(args.to) ? args.to : [args.to];
  if (requested.length > MAX_TARGETS) {
    fail(`${requested.length} targets in one send; the cap is ${MAX_TARGETS} — a wider fan-out is a broadcast, not a message`);
  }
  const targets = [];
  for (const t of requested) {
    const resolved = resolveTarget(t);
    if (!targets.some((existing) => existing.address === resolved.address)) targets.push(resolved);
  }
  const replyToArg = args["reply-to"] ?? defaultReplyTo();
  const replyTo = replyToArg === "none" ? undefined : replyToArg;
  const from = {
    kind: "process",
    name: args.from ?? process.env.PI_POST_FROM ?? `process:${basename(process.cwd())}`,
    cwd: process.cwd(),
  };

  const deposits = [];
  for (const target of targets) {
    const sentAt = Date.now();
    const message = {
      v: 1,
      id: `${String(sentAt).padStart(13, "0")}-${randomBytes(4).toString("hex")}`,
      from,
      ...(replyTo ? { replyTo } : {}),
      sentAt,
      body,
    };

    const dir = join(root, "inbox", target.address);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const queued = readdirSync(dir).filter((n) => n.endsWith(".json"));
    if (queued.length >= BACKLOG_CAP) {
      fail(`mailbox ${target.address} holds ${BACKLOG_CAP} unread messages; not accepting more`);
    }
    const path = join(dir, `${message.id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(message), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    deposits.push({ target, message, path });
  }

  for (const { target, message, path } of deposits) {
    const live = target.record ? isLive(target.record) : false;
    let consumed = false;
    if (live) {
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        if (!existsSync(path)) {
          consumed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!existsSync(path)) consumed = true;
    }
    console.log(`${consumed ? "delivered" : "queued"} ${target.address} ${message.id}`);
  }
}

function queuedCount(address) {
  try {
    return readdirSync(join(root, "inbox", address)).filter((n) => n.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Compact relative age for offline rows: `5m ago`, `3h ago`, `2d ago`. */
function relativeAge(lastSeen, now = Date.now()) {
  const minutes = Math.round(Math.max(0, now - lastSeen) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function list(args) {
  const now = Date.now();
  const records = listRecords().sort((a, b) => {
    const liveDelta = Number(isLive(b)) - Number(isLive(a));
    return liveDelta || b.lastSeen - a.lastSeen;
  });
  if (records.length === 0) {
    console.log("No registered sessions.");
    return;
  }
  let hidden = 0;
  for (const record of records) {
    const live = isLive(record);
    const queued = queuedCount(record.address);
    // Stale offline rows collapse into a count — unless they hold mail.
    if (!args.all && !live && queued === 0 && now - record.lastSeen > DAY_MS) {
      hidden++;
      continue;
    }
    const state = live ? "live" : `offline ${relativeAge(record.lastSeen, now)}`;
    const mail = queued > 0 ? `, ${queued} queued` : "";
    console.log(
      `${record.name} — ${record.address} (${state}${mail}) ${record.cwd} ` +
        `[pi --session ${resumeHandle(record.sessionId)}]`,
    );
  }
  if (hidden > 0) {
    const plural = hidden === 1 ? "session" : "sessions";
    console.log(`… and ${hidden} offline ${plural} unseen for over a day (--all lists them)`);
  }
}

/** The directory answer for one session: every handle it has, in both directions. */
function resolveCmd(args) {
  const targetArg = args._[1];
  if (!targetArg) fail("resolve requires a target (address, session id, path, or session name)");
  const target = resolveTarget(targetArg);
  const record = target.record;
  if (!record) {
    console.log(`address:  ${target.address}`);
    console.log("no registry record — the session never registered here, or its record was swept");
    return;
  }
  const queued = queuedCount(record.address);
  console.log(`name:     ${record.name}`);
  console.log(`address:  ${record.address}`);
  console.log(`session:  ${record.sessionId}`);
  console.log(`presence: ${isLive(record) ? "live" : "offline"}${queued > 0 ? `, ${queued} queued` : ""}`);
  console.log(`cwd:      ${record.cwd}`);
  console.log(`resume:   cd ${record.cwd} && pi --session ${resumeHandle(record.sessionId)}`);
}

function peek(args) {
  const target = args._[1] ? resolveTarget(args._[1]) : null;
  if (!target) fail("peek requires a target (address, path, or session name)");
  const dir = join(root, "inbox", target.address);
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    // no mailbox yet
  }
  if (names.length === 0) {
    console.log(`empty ${target.address}`);
    return;
  }
  for (const name of names) {
    try {
      const message = JSON.parse(readFileSync(join(dir, name), "utf8"));
      const preview = message.body.length > 80 ? `${message.body.slice(0, 80)}…` : message.body;
      console.log(`${new Date(message.sentAt).toISOString()} ${message.from.name}: ${preview.replaceAll("\n", " ")}`);
    } catch {
      // raced away or malformed; skip
    }
  }
}

function whoami() {
  const sessionId = process.env.PI_SESSION_ID;
  if (!sessionId) fail("PI_SESSION_ID is not set (run inside a pi bash tool, or use an explicit address)");
  console.log(sessionAddress(sessionId));
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

switch (command) {
  case "send":
    await send(args);
    break;
  case "list":
    list(args);
    break;
  case "resolve":
    resolveCmd(args);
    break;
  case "peek":
    peek(args);
    break;
  case "whoami":
    whoami();
    break;
  default:
    console.log("usage: pi-post send --to <target> [--to <target> …] [--body <text>] [--from <label>] [--reply-to <addr>|none]");
    console.log("       pi-post list [--all] | resolve <target> | peek <target> | whoami");
    process.exit(command ? 1 : 0);
}
