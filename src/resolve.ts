import { basename } from "node:path";
import { canonicalPath, isAddress, looksLikePath } from "./address.ts";
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
 * Resolve a target string to a session address. Targets name sessions that
 * exist — a directory path is a *query* for the session registered in it,
 * not an address of its own. Refuses rather than guesses.
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

  const byName = records.filter((r) => r.name === trimmed);
  const matches = byName.length > 0 ? byName : records.filter((r) => basename(r.cwd) === trimmed);
  if (matches.length === 0) {
    throw new UnknownTargetError(
      `"${trimmed}" is not an address, a directory with a registered session, or a known session name`,
    );
  }
  return pick(trimmed, matches);
}
