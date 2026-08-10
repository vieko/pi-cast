import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessage } from "../src/message.ts";
import { deposit, queuedCount } from "../src/mailbox.ts";
import {
  listRecords,
  markOffline,
  presence,
  readRecord,
  standingClaimedLive,
  sweepRegistry,
  writeRecord,
  type SessionRecord,
} from "../src/registry.ts";

const newRoot = () => mkdtempSync(join(tmpdir(), "post-reg-"));

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    v: 1,
    address: "s-aaaaaaaaaaaa",
    sessionId: "sid",
    name: "test",
    cwd: "/x",
    standing: "w-aaaaaaaaaaaa",
    pid: process.pid,
    startedAt: 1000,
    lastSeen: Date.now(),
    ...overrides,
  };
}

test("a record outlives the process: shutdown marks offline, never removes", () => {
  const root = newRoot();
  writeRecord(root, record());
  assert.equal(presence(readRecord(root, "s-aaaaaaaaaaaa")!), "live");

  markOffline(root, "s-aaaaaaaaaaaa");
  const after = readRecord(root, "s-aaaaaaaaaaaa");
  assert.ok(after, "record still exists after shutdown");
  assert.equal(presence(after), "offline");
});

test("a dead pid reads as offline even if shutdown never ran", () => {
  const root = newRoot();
  // PID 1 exists but is not ours to signal on macOS/Linux as a normal user…
  // use an implausible pid instead.
  writeRecord(root, record({ pid: 2 ** 30 }));
  assert.equal(presence(readRecord(root, "s-aaaaaaaaaaaa")!), "offline");
});

test("a standing address counts as live only while a live session's cwd claims it", () => {
  const root = newRoot();
  writeRecord(root, record({ standing: "w-cccccccccccc", pid: process.pid }));
  assert.equal(standingClaimedLive(root, "w-cccccccccccc"), true);
  assert.equal(standingClaimedLive(root, "w-dddddddddddd"), false);

  markOffline(root, "s-aaaaaaaaaaaa");
  assert.equal(standingClaimedLive(root, "w-cccccccccccc"), false);
});

test("sweep removes only stale offline records, and mail is never touched", () => {
  const root = newRoot();
  const stale = record({ address: "s-bbbbbbbbbbbb", pid: undefined, lastSeen: Date.now() - 60 * 24 * 3600 * 1000 });
  writeRecord(root, stale);
  writeRecord(root, record()); // live, keeps its record

  // Stale session still has queued mail in its inbox.
  deposit(root, "s-bbbbbbbbbbbb", createMessage({ from: { kind: "process", name: "t" }, body: "waits" }));

  sweepRegistry(root);

  const addresses = listRecords(root).map((r) => r.address);
  assert.ok(!addresses.includes("s-bbbbbbbbbbbb"), "stale record swept");
  assert.ok(addresses.includes("s-aaaaaaaaaaaa"), "live record kept");
  assert.equal(queuedCount(root, "s-bbbbbbbbbbbb"), 1, "mail outranks tidiness");
});
