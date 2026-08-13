import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessage } from "../src/message.ts";
import { deposit, queuedCount } from "../src/mailbox.ts";
import { existsSync, mkdirSync } from "node:fs";
import {
  defaultSessionName,
  listRecords,
  markOffline,
  presence,
  readRecord,
  sweepInboxes,
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
    pid: process.pid,
    startedAt: 1000,
    lastSeen: Date.now(),
    ...overrides,
  };
}

test("the default name is the cwd basename plus an address tail, stable and distinct", () => {
  assert.equal(defaultSessionName("/Users/x/dev/gtm", "s-4ee4233e83c0"), "gtm-4ee4");
  // Two unnamed sessions in the same repository get different names.
  assert.notEqual(
    defaultSessionName("/Users/x/dev/gtm", "s-4ee4233e83c0"),
    defaultSessionName("/Users/x/dev/gtm", "s-a393f9c85744"),
  );
});

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

test("sweep removes stale offline records, but queued mail pins a record in place", () => {
  const root = newRoot();
  const staleAge = Date.now() - 60 * 24 * 3600 * 1000;
  writeRecord(root, record({ address: "s-bbbbbbbbbbbb", pid: undefined, lastSeen: staleAge }));
  writeRecord(root, record({ address: "s-cccccccccccc", pid: undefined, lastSeen: staleAge }));
  writeRecord(root, record()); // live, keeps its record

  // One stale session still has queued mail in its inbox.
  deposit(root, "s-cccccccccccc", createMessage({ from: { kind: "process", name: "t" }, body: "waits" }));

  sweepRegistry(root);

  const addresses = listRecords(root).map((r) => r.address);
  assert.ok(!addresses.includes("s-bbbbbbbbbbbb"), "stale empty record swept");
  assert.ok(addresses.includes("s-aaaaaaaaaaaa"), "live record kept");
  assert.ok(addresses.includes("s-cccccccccccc"), "queued mail keeps the record alive");
  assert.equal(queuedCount(root, "s-cccccccccccc"), 1, "mail outranks tidiness");
});

test("a record inside the TTL survives the sweep even with an empty mailbox", () => {
  const root = newRoot();
  writeRecord(root, record({ address: "s-bbbbbbbbbbbb", pid: undefined, lastSeen: Date.now() - 3600 * 1000 }));
  sweepRegistry(root);
  assert.ok(listRecords(root).some((r) => r.address === "s-bbbbbbbbbbbb"));
});

test("inbox sweep removes only empty orphan mailboxes", () => {
  const root = newRoot();
  writeRecord(root, record()); // s-aaaaaaaaaaaa has a record

  const inbox = (address: string) => join(root, "inbox", address);
  mkdirSync(inbox("s-aaaaaaaaaaaa"), { recursive: true });
  mkdirSync(inbox("w-000000000000"), { recursive: true }); // orphan, empty
  deposit(root, "s-dddddddddddd", createMessage({ from: { kind: "process", name: "t" }, body: "waits" })); // orphan, but holds mail

  sweepInboxes(root);

  assert.ok(existsSync(inbox("s-aaaaaaaaaaaa")), "registered mailbox kept");
  assert.ok(!existsSync(inbox("w-000000000000")), "empty orphan removed");
  assert.ok(existsSync(inbox("s-dddddddddddd")), "orphan with mail kept");
  assert.equal(queuedCount(root, "s-dddddddddddd"), 1);
});
