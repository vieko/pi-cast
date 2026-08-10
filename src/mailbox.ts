import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseMessage, type Message } from "./message.ts";

/** A mailbox stops accepting at this many queued messages. */
export const BACKLOG_CAP = 50;

export class BacklogFullError extends Error {
  constructor(address: string) {
    super(`mailbox ${address} holds ${BACKLOG_CAP} unread messages; not accepting more`);
    this.name = "BacklogFullError";
  }
}

export function postRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_POST_DIR || join(homedir(), ".pi", "agent", "post");
}

export function inboxDir(root: string, address: string): string {
  return join(root, "inbox", address);
}

export function registryDir(root: string): string {
  return join(root, "registry");
}

export function ensureDirs(root: string, address?: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(registryDir(root), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "inbox"), { recursive: true, mode: 0o700 });
  if (address) mkdirSync(inboxDir(root, address), { recursive: true, mode: 0o700 });
}

function messageFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".json")).sort();
}

/**
 * Deposit a message into an address's inbox. Writes `.tmp` then renames into
 * place, so a draining reader never observes a partial message. Returns the
 * final path (used to await consumption).
 */
export function deposit(root: string, address: string, message: Message): string {
  const dir = inboxDir(root, address);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (messageFiles(dir).length >= BACKLOG_CAP) throw new BacklogFullError(address);
  const path = join(dir, `${message.id}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(message), { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

/**
 * Drain an inbox oldest-first. Each message is unlinked *before* it is
 * returned, so nothing is ever delivered twice. Malformed files are removed
 * and skipped. ENOENT races (another drain won) are tolerated silently.
 */
export function drain(root: string, address: string): Message[] {
  const dir = inboxDir(root, address);
  const messages: Message[] = [];
  for (const name of messageFiles(dir)) {
    const path = join(dir, name);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue; // gone: another reader took it
    }
    try {
      unlinkSync(path);
    } catch {
      continue; // lost the race after reading; treat as not ours
    }
    const message = parseMessage(raw);
    if (message) messages.push(message);
  }
  return messages;
}

/** List queued messages without consuming them. Reading has no side effects. */
export function peek(root: string, address: string): Message[] {
  const dir = inboxDir(root, address);
  const messages: Message[] = [];
  for (const name of messageFiles(dir)) {
    try {
      const message = parseMessage(readFileSync(join(dir, name), "utf8"));
      if (message) messages.push(message);
    } catch {
      // raced away; ignore
    }
  }
  return messages;
}

export function queuedCount(root: string, address: string): number {
  return messageFiles(inboxDir(root, address)).length;
}

/**
 * Wait for a deposited message to be consumed. Resolves true (delivered) when
 * the file vanishes within `timeoutMs`, false (queued) otherwise.
 */
export function awaitConsumption(path: string, timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise) => {
    const tick = () => {
      if (!existsSync(path)) return resolvePromise(true);
      if (Date.now() >= deadline) return resolvePromise(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

/**
 * Watch an inbox and fire `onMail` (debounced) when messages arrive. The
 * callback should drain; it may fire spuriously. Returns the watcher for
 * cleanup in `session_shutdown`.
 */
export function watchInbox(root: string, address: string, onMail: () => void): FSWatcher {
  const dir = inboxDir(root, address);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(dir, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onMail, 60);
  });
  // Never keep the process alive on our account.
  watcher.unref?.();
  return watcher;
}
