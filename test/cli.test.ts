import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionAddress, standingAddress, canonicalPath } from "../src/address.ts";
import { drain } from "../src/mailbox.ts";

const CLI = fileURLToPath(new URL("../bin/pi-post.mjs", import.meta.url));
const newRoot = () => mkdtempSync(join(tmpdir(), "post-cli-"));

function run(root: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, PI_POST_DIR: root, PI_POST_REPLY_TO: "", PI_SESSION_ID: "", ...env },
    encoding: "utf8",
  });
}

test("a CLI letter is a real letter: the TS parser accepts it verbatim", () => {
  const root = newRoot();
  const dir = mkdtempSync(join(tmpdir(), "post-cli-target-"));
  const result = run(root, ["send", "--to", dir, "--body", "gate green, log at /tmp/x", "--from", "golem:test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^queued /);

  const letters = drain(root, standingAddress(canonicalPath(dir)));
  assert.equal(letters.length, 1);
  assert.equal(letters[0]!.body, "gate green, log at /tmp/x");
  assert.equal(letters[0]!.from.kind, "process");
  assert.equal(letters[0]!.from.name, "golem:test");
  assert.equal(letters[0]!.replyTo, undefined);
});

test("reply-to derives from PI_SESSION_ID, exactly as the extension derives it", () => {
  const root = newRoot();
  const dir = mkdtempSync(join(tmpdir(), "post-cli-target-"));
  const result = run(root, ["send", "--to", dir, "--body", "done"], { PI_SESSION_ID: "sess-123" });
  assert.equal(result.status, 0, result.stderr);

  const letters = drain(root, standingAddress(canonicalPath(dir)));
  assert.equal(letters[0]!.replyTo, sessionAddress("sess-123"));
});

test("reply-to none omits the reply address", () => {
  const root = newRoot();
  const dir = mkdtempSync(join(tmpdir(), "post-cli-target-"));
  run(root, ["send", "--to", dir, "--body", "fyi", "--reply-to", "none"], { PI_SESSION_ID: "sess-123" });
  const letters = drain(root, standingAddress(canonicalPath(dir)));
  assert.equal(letters[0]!.replyTo, undefined);
});

test("stdin is the body when --body is absent", () => {
  const root = newRoot();
  const dir = mkdtempSync(join(tmpdir(), "post-cli-target-"));
  const result = spawnSync(process.execPath, [CLI, "send", "--to", dir], {
    env: { ...process.env, PI_POST_DIR: root, PI_POST_REPLY_TO: "", PI_SESSION_ID: "" },
    input: "piped brief\n",
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const letters = drain(root, standingAddress(canonicalPath(dir)));
  assert.equal(letters[0]!.body, "piped brief\n");
});

test("an oversize body is refused with a nonzero exit", () => {
  const root = newRoot();
  const result = run(root, ["send", "--to", "/tmp", "--body", "x".repeat(33 * 1024)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cap/);
});

test("an unknown name fails loudly instead of creating a dead mailbox", () => {
  const root = newRoot();
  const result = run(root, ["send", "--to", "nonesuch", "--body", "hi"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not an address/);
});

test("whoami prints the same session address the extension would register", () => {
  const root = newRoot();
  const result = run(root, ["whoami"], { PI_SESSION_ID: "sess-xyz" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), sessionAddress("sess-xyz"));
});
