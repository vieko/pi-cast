import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatListing, relativeAge, resumeHandle } from "../src/format.ts";
import { writeRecord, type SessionRecord } from "../src/registry.ts";
import { createMessage } from "../src/message.ts";
import { deposit } from "../src/mailbox.ts";

const newRoot = () => mkdtempSync(join(tmpdir(), "post-fmt-"));

function record(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    v: 1,
    address: "s-aaaaaaaaaaaa",
    sessionId: "019fd2b2-93d5-7447-b42a-c740be761735",
    name: "gtm",
    cwd: "/dev/gtm",
    startedAt: 0,
    lastSeen: Date.now(),
    ...overrides,
  };
}

test("the resume handle is three UUID groups: timestamp plus random bits", () => {
  assert.equal(resumeHandle("019fd2b2-93d5-7447-b42a-c740be761735"), "019fd2b2-93d5-7447");
});

test("a short or non-UUID session id is shown whole, never padded or sliced blind", () => {
  assert.equal(resumeHandle("sid"), "sid");
});

test("every listed session carries its resume handle beside the address", () => {
  const root = newRoot();
  writeRecord(root, record({}));
  const listing = formatListing(root, [record({})]);
  assert.match(listing, /gtm — s-aaaaaaaaaaaa \(offline just now\) \/dev\/gtm \[pi --session 019fd2b2-93d5-7447\]/);
});

test("relative age reads in minutes, hours, then days", () => {
  const now = Date.now();
  assert.equal(relativeAge(now, now), "just now");
  assert.equal(relativeAge(now - 5 * 60_000, now), "5m ago");
  assert.equal(relativeAge(now - 3 * 3600_000, now), "3h ago");
  assert.equal(relativeAge(now - 2 * 24 * 3600_000, now), "2d ago");
});

test("live sessions list first, offline rows carry their age", () => {
  const root = newRoot();
  const listing = formatListing(root, [
    record({ address: "s-aaaaaaaaaaaa", name: "idle", pid: undefined, lastSeen: Date.now() - 3600_000 }),
    record({ address: "s-bbbbbbbbbbbb", name: "busy", pid: process.pid }),
  ]);
  const lines = listing.split("\n");
  assert.match(lines[0]!, /^busy .*\(live\)/);
  assert.match(lines[1]!, /^idle .*\(offline 1h ago\)/);
});

test("offline sessions unseen for over a day collapse into a count; all lists them", () => {
  const root = newRoot();
  const records = [
    record({ address: "s-bbbbbbbbbbbb", name: "fresh", pid: undefined }),
    record({ address: "s-cccccccccccc", name: "stale-1", pid: undefined, lastSeen: Date.now() - 3 * 24 * 3600_000 }),
    record({ address: "s-dddddddddddd", name: "stale-2", pid: undefined, lastSeen: Date.now() - 9 * 24 * 3600_000 }),
  ];
  const listing = formatListing(root, records, undefined, { allHint: "all: true" });
  assert.match(listing, /fresh/);
  assert.doesNotMatch(listing, /stale-1/);
  assert.match(listing, /and 2 offline sessions unseen for over a day \(all: true lists them\)/);

  const full = formatListing(root, records, undefined, { all: true });
  assert.match(full, /stale-1/);
  assert.match(full, /stale-2 .*\(offline 9d ago\)/);
});

test("queued messages and self are never collapsed, however stale", () => {
  const root = newRoot();
  const staleAge = Date.now() - 5 * 24 * 3600_000;
  deposit(root, "s-cccccccccccc", createMessage({ from: { kind: "process", name: "t" }, body: "waits" }));
  const records = [
    record({ address: "s-cccccccccccc", name: "has-messages", pid: undefined, lastSeen: staleAge }),
    record({ address: "s-dddddddddddd", name: "stale-self", pid: undefined, lastSeen: staleAge }),
  ];
  const listing = formatListing(root, records, "s-dddddddddddd");
  assert.match(listing, /has-messages .*1 queued/);
  assert.match(listing, /stale-self .*\[self\]/);
});

test("the listing explains how to use the resume handle", () => {
  const root = newRoot();
  const listing = formatListing(root, [record({})]);
  assert.match(listing, /Reopen a session with its bracketed pi --session command/);
});
