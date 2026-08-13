import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatListing, resumeHandle } from "../src/format.ts";
import { writeRecord, type SessionRecord } from "../src/registry.ts";

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
  assert.match(listing, /gtm — s-aaaaaaaaaaaa \(offline\) \/dev\/gtm \[pi --session 019fd2b2-93d5-7447\]/);
});

test("the listing explains how to use the resume handle", () => {
  const root = newRoot();
  const listing = formatListing(root, [record({})]);
  assert.match(listing, /Reopen a session with its bracketed pi --session command/);
});
