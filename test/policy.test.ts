import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessage } from "../src/message.ts";
import { inboundMode, LoopGuard } from "../src/policy.ts";

const from = { kind: "session" as const, name: "peer", address: "s-aaaaaaaaaaaa" };

test("inbound mode defaults to accept and ignores junk", () => {
  assert.equal(inboundMode({}), "accept");
  assert.equal(inboundMode({ PI_POST_INBOUND: "ask" }), "ask");
  assert.equal(inboundMode({ PI_POST_INBOUND: "refuse" }), "refuse");
  assert.equal(inboundMode({ PI_POST_INBOUND: "banana" }), "accept");
});

test("identical body from one sender inside the window is dropped", () => {
  const guard = new LoopGuard();
  const message = createMessage({ from, body: "same" });
  assert.equal(guard.check(message, 1000), "deliver");
  assert.equal(guard.check(createMessage({ from, body: "same" }), 5000), "drop-duplicate");
  // Outside the window it is a new message.
  assert.equal(guard.check(createMessage({ from, body: "same" }), 20_000), "deliver");
});

test("different senders never suppress each other", () => {
  const guard = new LoopGuard();
  const other = { kind: "session" as const, name: "peer2", address: "s-bbbbbbbbbbbb" };
  assert.equal(guard.check(createMessage({ from, body: "same" }), 1000), "deliver");
  assert.equal(guard.check(createMessage({ from: other, body: "same" }), 1001), "deliver");
});

test("a sender is throttled past the rate cap, and recovers after the window", () => {
  const guard = new LoopGuard();
  for (let i = 0; i < 8; i++) {
    assert.equal(guard.check(createMessage({ from, body: `${i}` }), 1000 + i), "deliver");
  }
  assert.equal(guard.check(createMessage({ from, body: "ninth" }), 1010), "drop-rate");
  // A loop between two agents therefore stops on its own; time passing resets it.
  assert.equal(guard.check(createMessage({ from, body: "later" }), 40_000), "deliver");
});
