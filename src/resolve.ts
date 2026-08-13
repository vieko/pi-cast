import { basename } from "node:path";
import { canonicalPath, isAddress, looksLikePath, looksLikeSessionId } from "./address.ts";
import { listRecords, presence, type SessionRecord } from "./registry.ts";

export interface ResolvedTarget {
  address: string;
  /** Human-readable description of what the address names. */
  display: string;
  record?: SessionRecord;
}

export class AmbiguousTargetError extends Error {
  constructor(target: string, candidates: SessionRecord[]) {
    const lines = candidates.map((r) => `  ${r.name} (${r.address}) — ${r.cwd}`);
    super(`"${target}" matches more than one session; use an address:\n${lines.join("\n")}`);
    this.name = "AmbiguousTargetError";
  }
}

export class UnknownTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownTargetError";
  }
}

/** Beyond this many targets a send is a broadcast, which stays a non-goal. */
export const MAX_TARGETS = 8;

export class TooManyTargetsError extends Error {
  constructor(count: number) {
    super(`${count} targets in one send; the cap is ${MAX_TARGETS} — a wider fan-out is a broadcast, not a message`);
    this.name = "TooManyTargetsError";
  }
}

/** Live sessions outrank offline ones; a remaining tie is refused, never guessed. */
function pick(target: string, matches: SessionRecord[]): ResolvedTarget {
  const live = matches.filter((r) => presence(r) === "live");
  const pool = live.length > 0 ? live : matches;
  if (pool.length === 1) {
    const record = pool[0]!;
    return { address: record.address, display: `${record.name} (${record.cwd})`, record };
  }
  throw new AmbiguousTargetError(target, pool);
}

/**
 * Resolve a target string to a session address. Every handle a session has
 * resolves: an address, a directory path (a *query* for the session
 * registered there), pi's own session id (or a unique prefix), or a name.
 * Refuses rather than guesses.
 */
export function resolveTarget(root: string, target: string, cwd?: string): ResolvedTarget {
  const trimmed = target.trim();
  if (isAddress(trimmed)) {
    const record = listRecords(root).find((r) => r.address === trimmed);
    return { address: trimmed, display: record ? `${record.name} (${record.cwd})` : trimmed, record };
  }

  const records = listRecords(root);

  if (looksLikePath(trimmed)) {
    const canonical = canonicalPath(trimmed, cwd);
    const matches = records.filter((r) => r.cwd === canonical);
    if (matches.length === 0) {
      throw new UnknownTargetError(
        `no session is registered in ${canonical} — a directory names the session running in it. ` +
          "Spawn the session first, or leave context for future sessions in project memory instead.",
      );
    }
    return pick(trimmed, matches);
  }

  if (looksLikeSessionId(trimmed)) {
    const lower = trimmed.toLowerCase();
    const bySessionId = records.filter((r) => r.sessionId.toLowerCase().startsWith(lower));
    if (bySessionId.length > 0) return pick(trimmed, bySessionId);
    // fall through: a hex-looking string may still be a session name
  }

  const byName = records.filter((r) => r.name === trimmed);
  const matches = byName.length > 0 ? byName : records.filter((r) => basename(r.cwd) === trimmed);
  if (matches.length === 0) {
    throw new UnknownTargetError(
      `"${trimmed}" is not an address, a session id, a directory with a registered session, or a known session name`,
    );
  }
  return pick(trimmed, matches);
}

/**
 * Resolve several targets before anything is deposited: any unknown or
 * ambiguous target fails the whole batch, and two handles that name one
 * session collapse to a single target.
 */
export function resolveTargets(root: string, targets: string[], cwd?: string): ResolvedTarget[] {
  if (targets.length === 0) throw new UnknownTargetError("no targets given");
  if (targets.length > MAX_TARGETS) throw new TooManyTargetsError(targets.length);
  const byAddress = new Map<string, ResolvedTarget>();
  for (const target of targets) {
    const resolved = resolveTarget(root, target, cwd);
    if (!byAddress.has(resolved.address)) byAddress.set(resolved.address, resolved);
  }
  return [...byAddress.values()];
}
