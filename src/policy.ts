import type { Letter } from "./letter.ts";

export type InboundMode = "accept" | "ask" | "refuse";

export function inboundMode(env: NodeJS.ProcessEnv = process.env): InboundMode {
  const value = env.PI_CAST_INBOUND;
  if (value === "ask" || value === "refuse") return value;
  return "accept";
}

export type GuardVerdict = "deliver" | "drop-duplicate" | "drop-rate";

const DUPLICATE_WINDOW_MS = 10_000;
const RATE_WINDOW_MS = 30_000;
const RATE_CAP = 8;

/**
 * Structural loop breaker, independent of what any model decides to do:
 * identical body from one sender inside 10s is dropped, and a sender is
 * throttled past 8 letters in 30s.
 */
export class LoopGuard {
  private lastBody = new Map<string, { body: string; at: number }>();
  private recent = new Map<string, number[]>();

  check(letter: Letter, now = Date.now()): GuardVerdict {
    const sender = letter.from.address ?? `name:${letter.from.name}`;

    const last = this.lastBody.get(sender);
    if (last && last.body === letter.body && now - last.at < DUPLICATE_WINDOW_MS) {
      return "drop-duplicate";
    }

    const times = (this.recent.get(sender) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (times.length >= RATE_CAP) {
      this.recent.set(sender, times);
      return "drop-rate";
    }

    times.push(now);
    this.recent.set(sender, times);
    this.lastBody.set(sender, { body: letter.body, at: now });
    return "deliver";
  }
}
