import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPath, standingAddress } from "../src/address.ts";
import { writeRecord, type SessionRecord } from "../src/registry.ts";
import { AmbiguousTargetError, resolveTarget, UnknownTargetError } from "../src/resolve.ts";

const newRoot = () => mkdtempSync(join(tmpdir(), "cast-res-"));

function record(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    v: 1,
    address: "s-aaaaaaaaaaaa",
    sessionId: "sid",
    name: "gtm",
    cwd: "/dev/gtm",
    standing: "w-aaaaaaaaaaaa",
    startedAt: 0,
    lastSeen: Date.now(),
    ...overrides,
  };
}

test("an explicit address resolves as-is", () => {
  const root = newRoot();
  assert.equal(resolveTarget(root, "s-abcdefabcdef").address, "s-abcdefabcdef");
});

test("a path resolves to the directory's standing address, canonicalized", () => {
  const root = newRoot();
  const dir = mkdtempSync(join(tmpdir(), "cast-target-"));
  const resolved = resolveTarget(root, dir);
  assert.equal(resolved.address, standingAddress(canonicalPath(dir)));
});

test("a path that does not exist yet is still addressable (the successor case)", () => {
  const root = newRoot();
  const future = join(tmpdir(), "cast-not-yet", "worktree");
  const resolved = resolveTarget(root, future);
  assert.equal(resolved.address, standingAddress(canonicalPath(future)));
});

test("a unique session name resolves; relative to nothing else", () => {
  const root = newRoot();
  writeRecord(root, record({}));
  assert.equal(resolveTarget(root, "gtm").address, "s-aaaaaaaaaaaa");
});

test("ambiguity refuses rather than guesses, unless liveness disambiguates", () => {
  const root = newRoot();
  writeRecord(root, record({ address: "s-aaaaaaaaaaaa", pid: undefined }));
  writeRecord(root, record({ address: "s-bbbbbbbbbbbb", cwd: "/elsewhere/gtm", pid: process.pid }));

  // Two matches, one live: the live one wins.
  assert.equal(resolveTarget(root, "gtm").address, "s-bbbbbbbbbbbb");

  // Two live matches: refuse.
  writeRecord(root, record({ address: "s-aaaaaaaaaaaa", pid: process.pid }));
  assert.throws(() => resolveTarget(root, "gtm"), AmbiguousTargetError);
});

test("an unknown name is an error, not a silent mailbox", () => {
  const root = newRoot();
  assert.throws(() => resolveTarget(root, "nonesuch"), UnknownTargetError);
});
