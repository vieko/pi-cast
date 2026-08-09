import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLetter } from "../src/letter.ts";
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
const newRoot = () => mkdtempSync(join(tmpdir(), "cast-mail-"));
const ADDR = "w-aaaaaaaaaaaa";

test("deposit then drain: oldest first, exactly once", () => {
  const root = newRoot();
  deposit(root, ADDR, createLetter({ from, body: "second", now: 2000 }));
  deposit(root, ADDR, createLetter({ from, body: "first", now: 1000 }));

  const letters = drain(root, ADDR);
  assert.deepEqual(letters.map((l) => l.body), ["first", "second"]);

  // Nothing is delivered twice: the mailbox is now empty.
  assert.deepEqual(drain(root, ADDR), []);
  assert.equal(queuedCount(root, ADDR), 0);
});

test("a reader never sees half a letter: .tmp files are invisible", () => {
  const root = newRoot();
  deposit(root, ADDR, createLetter({ from, body: "whole" }));
  writeFileSync(join(inboxDir(root, ADDR), "9999999999999-deadbeef.json.tmp"), "{partial");

  assert.deepEqual(drain(root, ADDR).map((l) => l.body), ["whole"]);
});

test("malformed letters are removed, not redelivered forever", () => {
  const root = newRoot();
  mkdirSync(inboxDir(root, "w-bbbbbbbbbbbb"), { recursive: true });
  writeFileSync(join(inboxDir(root, "w-bbbbbbbbbbbb"), "0000000000001-00000000.json"), "not json");
  assert.deepEqual(drain(root, "w-bbbbbbbbbbbb"), []);
  assert.equal(readdirSync(inboxDir(root, "w-bbbbbbbbbbbb")).length, 0);
});

test("draining a mailbox that never existed is empty, not an error", () => {
  assert.deepEqual(drain(newRoot(), "w-cccccccccccc"), []);
});

test("the backlog cap refuses letter 51", () => {
  const root = newRoot();
  for (let i = 0; i < BACKLOG_CAP; i++) {
    deposit(root, ADDR, createLetter({ from, body: `${i}`, now: 1000 + i }));
  }
  assert.throws(() => deposit(root, ADDR, createLetter({ from, body: "overflow" })), BacklogFullError);
});

test("peek has no side effects", () => {
  const root = newRoot();
  deposit(root, ADDR, createLetter({ from, body: "still here" }));
  assert.equal(peek(root, ADDR).length, 1);
  assert.equal(peek(root, ADDR).length, 1);
  assert.equal(queuedCount(root, ADDR), 1);
});

test("consumption is the receipt: delivered means the file vanished", async () => {
  const root = newRoot();
  const path = deposit(root, ADDR, createLetter({ from, body: "x" }));

  // Not consumed: reports queued.
  assert.equal(await awaitConsumption(path, 150), false);

  // Consumed mid-wait: reports delivered.
  const path2 = deposit(root, ADDR, createLetter({ from, body: "y" }));
  const waiting = awaitConsumption(path2, 2000);
  setTimeout(() => unlinkSync(path2), 100);
  assert.equal(await waiting, true);
});
