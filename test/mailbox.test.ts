import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessage } from "../src/message.ts";
import {
  awaitConsumption,
  BACKLOG_CAP,
  BacklogFullError,
  deposit,
  drain,
  inboxDir,
  peek,
  queuedCount,
} from "../src/mailbox.ts";

const from = { kind: "process" as const, name: "test" };
const newRoot = () => mkdtempSync(join(tmpdir(), "post-mail-"));
const ADDR = "s-cccccccccccc";

test("deposit then drain: oldest first, exactly once", () => {
  const root = newRoot();
  deposit(root, ADDR, createMessage({ from, body: "second", now: 2000 }));
  deposit(root, ADDR, createMessage({ from, body: "first", now: 1000 }));

  const messages = drain(root, ADDR);
  assert.deepEqual(messages.map((l) => l.body), ["first", "second"]);

  // Nothing is delivered twice: the mailbox is now empty.
  assert.deepEqual(drain(root, ADDR), []);
  assert.equal(queuedCount(root, ADDR), 0);
});

test("a reader never sees half a message: .tmp files are invisible", () => {
  const root = newRoot();
  deposit(root, ADDR, createMessage({ from, body: "whole" }));
  writeFileSync(join(inboxDir(root, ADDR), "9999999999999-deadbeef.json.tmp"), "{partial");

  assert.deepEqual(drain(root, ADDR).map((l) => l.body), ["whole"]);
});

test("malformed messages are removed, not redelivered forever", () => {
  const root = newRoot();
  mkdirSync(inboxDir(root, "s-dddddddddddd"), { recursive: true });
  writeFileSync(join(inboxDir(root, "s-dddddddddddd"), "0000000000001-00000000.json"), "not json");
  assert.deepEqual(drain(root, "s-dddddddddddd"), []);
  assert.equal(readdirSync(inboxDir(root, "s-dddddddddddd")).length, 0);
});

test("draining a mailbox that never existed is empty, not an error", () => {
  assert.deepEqual(drain(newRoot(), "s-eeeeeeeeeeee"), []);
});

test("the backlog cap refuses message 51", () => {
  const root = newRoot();
  for (let i = 0; i < BACKLOG_CAP; i++) {
    deposit(root, ADDR, createMessage({ from, body: `${i}`, now: 1000 + i }));
  }
  assert.throws(() => deposit(root, ADDR, createMessage({ from, body: "overflow" })), BacklogFullError);
});

test("peek has no side effects", () => {
  const root = newRoot();
  deposit(root, ADDR, createMessage({ from, body: "still here" }));
  assert.equal(peek(root, ADDR).length, 1);
  assert.equal(peek(root, ADDR).length, 1);
  assert.equal(queuedCount(root, ADDR), 1);
});

test("consumption is the receipt: delivered means the file vanished", async () => {
  const root = newRoot();
  const path = deposit(root, ADDR, createMessage({ from, body: "x" }));

  // Not consumed: reports queued.
  assert.equal(await awaitConsumption(path, 150), false);

  // Consumed mid-wait: reports delivered.
  const path2 = deposit(root, ADDR, createMessage({ from, body: "y" }));
  const waiting = awaitConsumption(path2, 2000);
  setTimeout(() => unlinkSync(path2), 100);
  assert.equal(await waiting, true);
});
