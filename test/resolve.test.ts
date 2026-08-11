import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPath } from "../src/address.ts";
import { writeRecord, type SessionRecord } from "../src/registry.ts";
import { AmbiguousTargetError, resolveTarget, UnknownTargetError } from "../src/resolve.ts";

const newRoot = () => mkdtempSync(join(tmpdir(), "post-res-"));

function record(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    v: 1,
    address: "s-aaaaaaaaaaaa",
    sessionId: "sid",
    name: "gtm",
    cwd: "/dev/gtm",
    startedAt: 0,
    lastSeen: Date.now(),
    ...overrides,
  };
}

test("an explicit address resolves as-is", () => {
  const root = newRoot();
  assert.equal(resolveTarget(root, "s-abcdefabcdef").address, "s-abcdefabcdef");
});

test("a directory is a query for the session registered in it, not an address", () => {
  const root = newRoot();
  const dir = canonicalPath(mkdtempSync(join(tmpdir(), "post-target-")));
  writeRecord(root, record({ cwd: dir, pid: process.pid }));
  assert.equal(resolveTarget(root, dir).address, "s-aaaaaaaaaaaa");
});

test("a directory with no registered session is an error, not a ghost mailbox", () => {
  const root = newRoot();
  assert.throws(
    () => resolveTarget(root, join(tmpdir(), "post-not-yet", "worktree")),
    UnknownTargetError,
  );
});

test("a directory shared by live and offline sessions resolves to the live one", () => {
  const root = newRoot();
  const dir = canonicalPath(mkdtempSync(join(tmpdir(), "post-target-")));
  writeRecord(root, record({ address: "s-aaaaaaaaaaaa", cwd: dir, pid: undefined }));
  writeRecord(root, record({ address: "s-bbbbbbbbbbbb", cwd: dir, pid: process.pid }));
  assert.equal(resolveTarget(root, dir).address, "s-bbbbbbbbbbbb");
});

test("a directory with several live sessions refuses rather than guesses", () => {
  const root = newRoot();
  const dir = canonicalPath(mkdtempSync(join(tmpdir(), "post-target-")));
  writeRecord(root, record({ address: "s-aaaaaaaaaaaa", cwd: dir, pid: process.pid }));
  writeRecord(root, record({ address: "s-bbbbbbbbbbbb", cwd: dir, pid: process.pid }));
  assert.throws(() => resolveTarget(root, dir), AmbiguousTargetError);
});

test("a unique session name resolves; liveness breaks name ties", () => {
  const root = newRoot();
  writeRecord(root, record({ address: "s-aaaaaaaaaaaa", pid: undefined }));
  assert.equal(resolveTarget(root, "gtm").address, "s-aaaaaaaaaaaa");

  writeRecord(root, record({ address: "s-bbbbbbbbbbbb", cwd: "/elsewhere/gtm", pid: process.pid }));
  assert.equal(resolveTarget(root, "gtm").address, "s-bbbbbbbbbbbb");

  writeRecord(root, record({ address: "s-aaaaaaaaaaaa", pid: process.pid }));
  assert.throws(() => resolveTarget(root, "gtm"), AmbiguousTargetError);
});

test("an unknown name is an error, not a silent mailbox", () => {
  const root = newRoot();
  assert.throws(() => resolveTarget(root, "nonesuch"), UnknownTargetError);
});
