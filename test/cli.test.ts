import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPath, sessionAddress } from "../src/address.ts";
import { drain } from "../src/mailbox.ts";
import { writeRecord, type SessionRecord } from "../src/registry.ts";

const CLI = fileURLToPath(new URL("../bin/pi-post.mjs", import.meta.url));
const newRoot = () => mkdtempSync(join(tmpdir(), "post-cli-"));

/** Register an offline session in `dir` so path targets resolve, and return its address. */
function registerSession(root: string, dir: string, address = "s-abcdefabcdef"): string {
  const record: SessionRecord = {
    v: 1,
    address,
    sessionId: "sid",
    name: "target",
    cwd: canonicalPath(dir),
    startedAt: 0,
    lastSeen: Date.now(),
  };
  writeRecord(root, record);
  return address;
}

function run(root: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, PI_POST_DIR: root, PI_POST_REPLY_TO: "", PI_SESSION_ID: "", ...env },
    encoding: "utf8",
  });
}

test("a CLI message is a real message: the TS parser accepts it verbatim", () => {
  const root = newRoot();
  const dir = mkdtempSync(join(tmpdir(), "post-cli-target-"));
  const address = registerSession(root, dir);
  const result = run(root, ["send", "--to", dir, "--body", "gate green, log at /tmp/x", "--from", "golem:test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^queued /);

  const messages = drain(root, address);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.body, "gate green, log at /tmp/x");
  assert.equal(messages[0]!.from.kind, "process");
  assert.equal(messages[0]!.from.name, "golem:test");
  assert.equal(messages[0]!.replyTo, undefined);
});

test("a directory target requires a registered session there", () => {
  const root = newRoot();
  const dir = mkdtempSync(join(tmpdir(), "post-cli-target-"));
  const result = run(root, ["send", "--to", dir, "--body", "hello"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no session is registered/);
});

test("reply-to derives from PI_SESSION_ID, exactly as the extension derives it", () => {
  const root = newRoot();
  const dir = mkdtempSync(join(tmpdir(), "post-cli-target-"));
  const address = registerSession(root, dir);
  const result = run(root, ["send", "--to", dir, "--body", "done"], { PI_SESSION_ID: "sess-123" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(drain(root, address)[0]!.replyTo, sessionAddress("sess-123"));
});

test("reply-to none omits the reply address", () => {
  const root = newRoot();
  const dir = mkdtempSync(join(tmpdir(), "post-cli-target-"));
  const address = registerSession(root, dir);
  run(root, ["send", "--to", dir, "--body", "fyi", "--reply-to", "none"], { PI_SESSION_ID: "sess-123" });
  assert.equal(drain(root, address)[0]!.replyTo, undefined);
});

test("stdin is the body when --body is absent", () => {
  const root = newRoot();
  const dir = mkdtempSync(join(tmpdir(), "post-cli-target-"));
  const address = registerSession(root, dir);
  const result = spawnSync(process.execPath, [CLI, "send", "--to", dir], {
    env: { ...process.env, PI_POST_DIR: root, PI_POST_REPLY_TO: "", PI_SESSION_ID: "" },
    input: "piped brief\n",
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(drain(root, address)[0]!.body, "piped brief\n");
});

test("an oversize body is refused with a nonzero exit", () => {
  const root = newRoot();
  const result = run(root, ["send", "--to", "s-abcdefabcdef", "--body", "x".repeat(33 * 1024)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cap/);
});

test("an unknown name fails loudly instead of creating a dead mailbox", () => {
  const root = newRoot();
  const result = run(root, ["send", "--to", "nonesuch", "--body", "hi"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not an address/);
});

test("a session id is a valid send target, exactly like the extension resolves it", () => {
  const root = newRoot();
  const dir = mkdtempSync(join(tmpdir(), "post-cli-target-"));
  const record: SessionRecord = {
    v: 1,
    address: "s-abcdefabcdef",
    sessionId: "019fd2b2-93d5-7447-b42a-c740be761735",
    name: "target",
    cwd: canonicalPath(dir),
    startedAt: 0,
    lastSeen: Date.now(),
  };
  writeRecord(root, record);
  const result = run(root, ["send", "--to", "019fd2b2-93d5", "--body", "by session id"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(drain(root, "s-abcdefabcdef")[0]!.body, "by session id");
});

test("resolve prints the full directory record, resume command included", () => {
  const root = newRoot();
  const dir = mkdtempSync(join(tmpdir(), "post-cli-target-"));
  const record: SessionRecord = {
    v: 1,
    address: "s-abcdefabcdef",
    sessionId: "019fd2b2-93d5-7447-b42a-c740be761735",
    name: "target",
    cwd: canonicalPath(dir),
    startedAt: 0,
    lastSeen: Date.now(),
  };
  writeRecord(root, record);
  const result = run(root, ["resolve", "target"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /name: {5}target/);
  assert.match(result.stdout, /address: {2}s-abcdefabcdef/);
  assert.match(result.stdout, /session: {2}019fd2b2-93d5-7447-b42a-c740be761735/);
  assert.match(result.stdout, /presence: offline/);
  assert.match(result.stdout, new RegExp(`resume: {3}cd ${canonicalPath(dir)} && pi --session 019fd2b2-93d5-7447`));
});

test("resolve on a bare address with no record says so instead of inventing one", () => {
  const root = newRoot();
  const result = run(root, ["resolve", "s-abcdefabcdef"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no registry record/);
});

test("whoami prints the same session address the extension would register", () => {
  const root = newRoot();
  const result = run(root, ["whoami"], { PI_SESSION_ID: "sess-xyz" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), sessionAddress("sess-xyz"));
});

test("list is live-first with ages; --all reveals collapsed stale sessions", () => {
  const root = newRoot();
  registerSession(root, mkdtempSync(join(tmpdir(), "post-cli-target-")), "s-aaaaaaaaaaaa");
  const stale: SessionRecord = {
    v: 1,
    address: "s-bbbbbbbbbbbb",
    sessionId: "sid-2",
    name: "stale",
    cwd: "/x",
    startedAt: 0,
    lastSeen: Date.now() - 3 * 24 * 3600_000,
  };
  writeRecord(root, stale);

  const short = run(root, ["list"]);
  assert.equal(short.status, 0, short.stderr);
  assert.match(short.stdout, /target .*\(offline just now\)/);
  assert.doesNotMatch(short.stdout, /^stale/m);
  assert.match(short.stdout, /and 1 offline session unseen for over a day \(--all lists them\)/);

  const full = run(root, ["list", "--all"]);
  assert.match(full.stdout, /stale .*\(offline 3d ago\)/);
});

test("repeated --to fans one body out to each target with distinct message ids", () => {
  const root = newRoot();
  const dirA = mkdtempSync(join(tmpdir(), "post-cli-target-"));
  const dirB = mkdtempSync(join(tmpdir(), "post-cli-target-"));
  const a = registerSession(root, dirA, "s-aaaaaaaaaaaa");
  const b = registerSession(root, dirB, "s-bbbbbbbbbbbb");
  const result = run(root, ["send", "--to", dirA, "--to", dirB, "--body", "same brief"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 2);

  const inboxA = drain(root, a);
  const inboxB = drain(root, b);
  assert.equal(inboxA[0]!.body, "same brief");
  assert.equal(inboxB[0]!.body, "same brief");
  assert.notEqual(inboxA[0]!.id, inboxB[0]!.id);
});

test("one unresolvable target aborts the whole send: nothing is deposited", () => {
  const root = newRoot();
  const dir = mkdtempSync(join(tmpdir(), "post-cli-target-"));
  const a = registerSession(root, dir, "s-aaaaaaaaaaaa");
  const result = run(root, ["send", "--to", dir, "--to", "nonesuch", "--body", "brief"]);
  assert.equal(result.status, 1);
  assert.equal(drain(root, a).length, 0, "no partial delivery");
});
