#!/usr/bin/env node
/**
 * pi-cast CLI — the deposit half of pi-cast for processes that are not pi
 * sessions: anvil runs at exit, Claude Code hooks, CI, shell scripts.
 *
 * Standalone on purpose: it duplicates the letter/address contract from
 * src/ (which is TypeScript) so it runs under bare node. test/cli.test.ts
 * pins that both sides stay in agreement.
 *
 *   pi-cast send --to <target> [--body <text>] [--from <label>] [--reply-to <addr>|none]
 *   pi-cast list
 *   pi-cast peek <target>
 *   pi-cast whoami
 *
 * With no --body, the body is read from stdin. Env: PI_CAST_DIR,
 * PI_CAST_FROM, PI_CAST_REPLY_TO; PI_SESSION_ID (set inside pi bash tools)
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
const ADDRESS_RE = /^[sw]-[0-9a-f]{12}$/;

const root = process.env.PI_CAST_DIR || join(homedir(), ".pi", "agent", "cast");

const h12 = (input) => createHash("sha256").update(input).digest("hex").slice(0, 12);
const sessionAddress = (sessionId) => `s-${h12(`session\0${sessionId}`)}`;
const standingAddress = (dir) => `w-${h12(`standing\0${dir}`)}`;

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

function resolveTarget(target) {
  const t = target.trim();
  if (ADDRESS_RE.test(t)) {
    return { address: t, display: t, record: listRecords().find((r) => r.address === t) };
  }
  if (looksLikePath(t)) {
    const canonical = canonicalPath(t);
    return { address: standingAddress(canonical), display: canonical };
  }
  const records = listRecords();
  const byName = records.filter((r) => r.name === t);
  let matches = byName.length > 0 ? byName : records.filter((r) => basename(r.cwd) === t);
  if (matches.length > 1) {
    const live = matches.filter(isLive);
    if (live.length === 1) matches = live;
  }
  if (matches.length === 1) {
    const record = matches[0];
    return { address: record.address, display: `${record.name} (${record.cwd})`, record };
  }
  if (matches.length > 1) {
    fail(`"${t}" matches more than one session; use an address:\n` +
      matches.map((r) => `  ${r.name} (${r.address}) — ${r.cwd}`).join("\n"));
  }
  fail(`"${t}" is not an address, a directory path, or a known session name`);
}

function fail(message) {
  console.error(`pi-cast: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      args[key] = argv[i + 1];
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
  if (process.env.PI_CAST_REPLY_TO) return process.env.PI_CAST_REPLY_TO;
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

  const target = resolveTarget(args.to);
  const replyToArg = args["reply-to"] ?? defaultReplyTo();
  const replyTo = replyToArg === "none" ? undefined : replyToArg;
  const from = {
    kind: "process",
    name: args.from ?? process.env.PI_CAST_FROM ?? `process:${basename(process.cwd())}`,
    cwd: process.cwd(),
  };

  const sentAt = Date.now();
  const letter = {
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
    fail(`mailbox ${target.address} holds ${BACKLOG_CAP} unread letters; not accepting more`);
  }
  const path = join(dir, `${letter.id}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(letter), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);

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
  console.log(`${consumed ? "delivered" : "queued"} ${target.address} ${letter.id}`);
}

function list() {
  const records = listRecords().sort((a, b) => b.lastSeen - a.lastSeen);
  if (records.length === 0) {
    console.log("No registered sessions.");
    return;
  }
  for (const record of records) {
    const queued = (() => {
      try {
        return readdirSync(join(root, "inbox", record.address)).filter((n) => n.endsWith(".json")).length;
      } catch {
        return 0;
      }
    })();
    const mail = queued > 0 ? `, ${queued} queued` : "";
    console.log(`${record.name} — ${record.address} (${isLive(record) ? "live" : "offline"}${mail}) ${record.cwd}`);
  }
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
      const letter = JSON.parse(readFileSync(join(dir, name), "utf8"));
      const preview = letter.body.length > 80 ? `${letter.body.slice(0, 80)}…` : letter.body;
      console.log(`${new Date(letter.sentAt).toISOString()} ${letter.from.name}: ${preview.replaceAll("\n", " ")}`);
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
    list();
    break;
  case "peek":
    peek(args);
    break;
  case "whoami":
    whoami();
    break;
  default:
    console.log("usage: pi-cast send --to <target> [--body <text>] [--from <label>] [--reply-to <addr>|none]");
    console.log("       pi-cast list | peek <target> | whoami");
    process.exit(command ? 1 : 0);
}
