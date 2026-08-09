import { basename } from "node:path";
import { canonicalPath, isAddress, looksLikePath, standingAddress } from "./address.ts";
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
  constructor(target: string) {
    super(`"${target}" is not an address, a directory path, or a known session name`);
    this.name = "UnknownTargetError";
  }
}

/**
 * Resolve a target string to an address. Refuses rather than guesses:
 * - an explicit address is taken as-is
 * - anything path-shaped becomes the directory's standing address
 * - otherwise it must match exactly one registered session by name
 *   (live sessions outrank offline ones before ambiguity is declared)
 */
export function resolveTarget(root: string, target: string, cwd?: string): ResolvedTarget {
  const trimmed = target.trim();
  if (isAddress(trimmed)) {
    const record = listRecords(root).find((r) => r.address === trimmed);
    return { address: trimmed, display: record ? `${record.name} (${record.cwd})` : trimmed, record };
  }

  if (looksLikePath(trimmed)) {
    const canonical = canonicalPath(trimmed, cwd);
    return { address: standingAddress(canonical), display: canonical };
  }

  const records = listRecords(root);
  const byName = records.filter((r) => r.name === trimmed);
  const byBase = byName.length > 0 ? byName : records.filter((r) => basename(r.cwd) === trimmed);
  let matches = byBase;
  if (matches.length > 1) {
    const live = matches.filter((r) => presence(r) === "live");
    if (live.length === 1) matches = live;
  }
  if (matches.length === 1) {
    const record = matches[0]!;
    return { address: record.address, display: `${record.name} (${record.cwd})`, record };
  }
  if (matches.length > 1) throw new AmbiguousTargetError(trimmed, matches);
  throw new UnknownTargetError(trimmed);
}
