import { test } from "node:test";
import assert from "node:assert/strict";
import { BodyTooLargeError, createLetter, MAX_BODY_BYTES, parseLetter } from "../src/letter.ts";

const from = { kind: "session" as const, name: "test", address: "s-aaaaaaaaaaaa", cwd: "/x" };

test("a letter survives the round trip intact", () => {
  const letter = createLetter({ from, body: "hello", replyTo: "s-bbbbbbbbbbbb" });
  const parsed = parseLetter(JSON.stringify(letter));
  assert.deepEqual(parsed, letter);
});

test("the body cap is enforced at creation: a brief fits, a payload does not", () => {
  assert.ok(createLetter({ from, body: "x".repeat(MAX_BODY_BYTES) }));
  assert.throws(() => createLetter({ from, body: "x".repeat(MAX_BODY_BYTES + 1) }), BodyTooLargeError);
});

test("the cap counts bytes, not characters", () => {
  // 4-byte code points: MAX/4 chars fit, +1 does not.
  const fits = "\u{1F600}".repeat(MAX_BODY_BYTES / 4);
  assert.ok(createLetter({ from, body: fits }));
  assert.throws(() => createLetter({ from, body: fits + "a" }), BodyTooLargeError);
});

test("malformed input parses to null, never to a partial letter", () => {
  assert.equal(parseLetter("not json"), null);
  assert.equal(parseLetter("{}"), null);
  assert.equal(parseLetter(JSON.stringify({ v: 2, id: "x", sentAt: 1, body: "b", from })), null);
  assert.equal(parseLetter(JSON.stringify({ v: 1, id: "x", sentAt: 1, body: "b" })), null);
  assert.equal(
    parseLetter(JSON.stringify({ v: 1, id: "x", sentAt: 1, body: "b", from: { kind: "ghost", name: "g" } })),
    null,
  );
  const oversize = { v: 1, id: "x", sentAt: 1, body: "x".repeat(MAX_BODY_BYTES + 1), from };
  assert.equal(parseLetter(JSON.stringify(oversize)), null);
});

test("letter ids sort chronologically because the timestamp leads", () => {
  const a = createLetter({ from, body: "a", now: 1000 });
  const b = createLetter({ from, body: "b", now: 2000 });
  assert.ok(a.id < b.id);
});
