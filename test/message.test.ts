import { test } from "node:test";
import assert from "node:assert/strict";
import { BodyTooLargeError, createMessage, MAX_BODY_BYTES, parseMessage } from "../src/message.ts";

const from = { kind: "session" as const, name: "test", address: "s-aaaaaaaaaaaa", cwd: "/x" };

test("a message survives the round trip intact", () => {
  const message = createMessage({ from, body: "hello", replyTo: "s-bbbbbbbbbbbb" });
  const parsed = parseMessage(JSON.stringify(message));
  assert.deepEqual(parsed, message);
});

test("the body cap is enforced at creation: a brief fits, a payload does not", () => {
  assert.ok(createMessage({ from, body: "x".repeat(MAX_BODY_BYTES) }));
  assert.throws(() => createMessage({ from, body: "x".repeat(MAX_BODY_BYTES + 1) }), BodyTooLargeError);
});

test("the cap counts bytes, not characters", () => {
  // 4-byte code points: MAX/4 chars fit, +1 does not.
  const fits = "\u{1F600}".repeat(MAX_BODY_BYTES / 4);
  assert.ok(createMessage({ from, body: fits }));
  assert.throws(() => createMessage({ from, body: fits + "a" }), BodyTooLargeError);
});

test("malformed input parses to null, never to a partial message", () => {
  assert.equal(parseMessage("not json"), null);
  assert.equal(parseMessage("{}"), null);
  assert.equal(parseMessage(JSON.stringify({ v: 2, id: "x", sentAt: 1, body: "b", from })), null);
  assert.equal(parseMessage(JSON.stringify({ v: 1, id: "x", sentAt: 1, body: "b" })), null);
  assert.equal(
    parseMessage(JSON.stringify({ v: 1, id: "x", sentAt: 1, body: "b", from: { kind: "ghost", name: "g" } })),
    null,
  );
  const oversize = { v: 1, id: "x", sentAt: 1, body: "x".repeat(MAX_BODY_BYTES + 1), from };
  assert.equal(parseMessage(JSON.stringify(oversize)), null);
});

test("message ids sort chronologically because the timestamp leads", () => {
  const a = createMessage({ from, body: "a", now: 1000 });
  const b = createMessage({ from, body: "b", now: 2000 });
  assert.ok(a.id < b.id);
});
