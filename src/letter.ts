import { randomBytes } from "node:crypto";

export const LETTER_VERSION = 1;
export const MAX_BODY_BYTES = 32 * 1024;

export interface LetterFrom {
  kind: "session" | "process";
  /** Human-readable sender label, e.g. "gtm-summoner" or "golem:gtmeng-2573". */
  name: string;
  /** Sender's own address, when it has an inbox. */
  address?: string;
  cwd?: string;
}

export interface Letter {
  v: typeof LETTER_VERSION;
  /** Matches the filename stem: `<sentAt ms, 13 digits>-<8 hex nonce>`. */
  id: string;
  from: LetterFrom;
  /** Address results should be sent to. Pinned at dispatch. */
  replyTo?: string;
  sentAt: number;
  body: string;
}

export class BodyTooLargeError extends Error {
  constructor(bytes: number) {
    super(`letter body is ${bytes} bytes; the cap is ${MAX_BODY_BYTES} (send a summary and a path, not a payload)`);
    this.name = "BodyTooLargeError";
  }
}

export function createLetter(input: {
  from: LetterFrom;
  body: string;
  replyTo?: string;
  now?: number;
}): Letter {
  const bytes = Buffer.byteLength(input.body, "utf8");
  if (bytes > MAX_BODY_BYTES) throw new BodyTooLargeError(bytes);
  const sentAt = input.now ?? Date.now();
  const id = `${String(sentAt).padStart(13, "0")}-${randomBytes(4).toString("hex")}`;
  const letter: Letter = { v: LETTER_VERSION, id, from: input.from, sentAt, body: input.body };
  if (input.replyTo) letter.replyTo = input.replyTo;
  return letter;
}

/** Parse and validate raw JSON into a Letter. Returns null for anything malformed. */
export function parseLetter(raw: string): Letter | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const l = value as Record<string, unknown>;
  if (l.v !== LETTER_VERSION) return null;
  if (typeof l.id !== "string" || typeof l.sentAt !== "number" || typeof l.body !== "string") return null;
  if (Buffer.byteLength(l.body as string, "utf8") > MAX_BODY_BYTES) return null;
  const from = l.from as Record<string, unknown> | undefined;
  if (typeof from !== "object" || from === null) return null;
  if (from.kind !== "session" && from.kind !== "process") return null;
  if (typeof from.name !== "string" || from.name.length === 0) return null;
  if (from.address !== undefined && typeof from.address !== "string") return null;
  if (from.cwd !== undefined && typeof from.cwd !== "string") return null;
  if (l.replyTo !== undefined && typeof l.replyTo !== "string") return null;
  return value as Letter;
}
