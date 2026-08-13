import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPath } from "../src/address.ts";
import { writeRecord, type SessionRecord } from "../src/registry.ts";
import {
  AmbiguousTargetError,
  resolveTarget,
  resolveTargets,
  TooManyTargetsError,
  UnknownTargetError,
} from "../src/resolve.ts";

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

test("a default-shaped name (basename-tail) resolves exactly; the bare basename still works", () => {
  const root = newRoot();
  writeRecord(root, record({ address: "s-aaaaaaaaaaaa", name: "gtm-aaaa", cwd: "/dev/gtm", pid: process.pid }));
  writeRecord(root, record({ address: "s-bbbbbbbbbbbb", name: "gtm-bbbb", cwd: "/elsewhere/gtm", pid: process.pid }));
  // The suffixed default name is a unique handle even with two sessions in play…
  assert.equal(resolveTarget(root, "gtm-aaaa").address, "s-aaaaaaaaaaaa");
  assert.equal(resolveTarget(root, "gtm-bbbb").address, "s-bbbbbbbbbbbb");
  // …while the bare basename keeps its cwd-fallback semantics: refuse a tie.
  assert.throws(() => resolveTarget(root, "gtm"), AmbiguousTargetError);
});

test("an unknown name is an error, not a silent mailbox", () => {
  const root = newRoot();
  assert.throws(() => resolveTarget(root, "nonesuch"), UnknownTargetError);
});

test("a full session id resolves to the session's address", () => {
  const root = newRoot();
  writeRecord(root, record({ sessionId: "019fd2b2-93d5-7447-b42a-c740be761735" }));
  assert.equal(
    resolveTarget(root, "019fd2b2-93d5-7447-b42a-c740be761735").address,
    "s-aaaaaaaaaaaa",
  );
});

test("a unique session id prefix resolves", () => {
  const root = newRoot();
  writeRecord(root, record({ sessionId: "019fd2b2-93d5-7447-b42a-c740be761735" }));
  assert.equal(resolveTarget(root, "019fd2b2-93d5").address, "s-aaaaaaaaaaaa");
});

test("an ambiguous session id prefix refuses rather than guesses", () => {
  const root = newRoot();
  writeRecord(root, record({ address: "s-aaaaaaaaaaaa", sessionId: "019fd2b2-93d5-7447-b42a-000000000001", pid: process.pid }));
  writeRecord(root, record({ address: "s-bbbbbbbbbbbb", sessionId: "019fd2b2-93d5-7447-b42a-000000000002", cwd: "/elsewhere/gtm", pid: process.pid }));
  assert.throws(() => resolveTarget(root, "019fd2b2"), AmbiguousTargetError);
});

test("a hex-looking string that matches no session id still resolves as a name", () => {
  const root = newRoot();
  writeRecord(root, record({ name: "deadbeefcafe" }));
  assert.equal(resolveTarget(root, "deadbeefcafe").address, "s-aaaaaaaaaaaa");
});

test("an unknown session id is an error, not a silent mailbox", () => {
  const root = newRoot();
  assert.throws(() => resolveTarget(root, "019fffff-0000-7000"), UnknownTargetError);
});

test("a batch resolves atomically: one bad target fails the whole send", () => {
  const root = newRoot();
  writeRecord(root, record({ address: "s-aaaaaaaaaaaa", name: "worker-1" }));
  assert.throws(() => resolveTargets(root, ["worker-1", "nonesuch"]), UnknownTargetError);
});

test("two handles naming one session collapse to a single target", () => {
  const root = newRoot();
  writeRecord(root, record({ address: "s-aaaaaaaaaaaa", name: "worker-1", sessionId: "019fd2b2-93d5-7447-b42a-c740be761735" }));
  const targets = resolveTargets(root, ["worker-1", "s-aaaaaaaaaaaa", "019fd2b2-93d5"]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.address, "s-aaaaaaaaaaaa");
});

test("more than eight targets is a broadcast, and broadcasts are refused", () => {
  const root = newRoot();
  const targets = Array.from({ length: 9 }, (_, i) => `s-${String(i).repeat(12)}`);
  assert.throws(() => resolveTargets(root, targets), TooManyTargetsError);
  assert.throws(() => resolveTargets(root, []), UnknownTargetError);
});
