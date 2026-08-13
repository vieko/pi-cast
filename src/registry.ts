import { readdirSync, readFileSync, unlinkSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { registryDir } from "./mailbox.ts";

export interface SessionRecord {
  v: 1;
  address: string;
  sessionId: string;
  /** Display name: pi session name when set, else `defaultSessionName`. */
  name: string;
  cwd: string;
  pid?: number;
  startedAt: number;
  lastSeen: number;
}

export type Presence = "live" | "offline";

/**
 * Default display name for an unnamed session: cwd basename plus a short
 * address tail, so concurrent unnamed sessions in one repository stay
 * distinguishable (`gtm-4ee4`, not `gtm` × 17). The tail comes from the
 * address, so it is stable across restarts and resumes. Resolution is
 * unaffected: the bare basename still matches via the cwd fallback, and the
 * full default name matches exactly.
 */
export function defaultSessionName(cwd: string, address: string): string {
  return `${basename(cwd)}-${address.slice(2, 6)}`;
}

/** A record outlives the process that wrote it; shutdown marks, never removes. */
export function writeRecord(root: string, record: SessionRecord): void {
  const dir = registryDir(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${record.address}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  renameSync(tmp, path);
}

export function readRecord(root: string, address: string): SessionRecord | null {
  try {
    const raw = readFileSync(join(registryDir(root), `${address}.json`), "utf8");
    const record = JSON.parse(raw) as SessionRecord;
    return record.v === 1 && typeof record.address === "string" ? record : null;
  } catch {
    return null;
  }
}

export function listRecords(root: string): SessionRecord[] {
  let names: string[];
  try {
    names = readdirSync(registryDir(root));
  } catch {
    return [];
  }
  const records: SessionRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = readRecord(root, name.slice(0, -".json".length));
    if (record) records.push(record);
  }
  return records;
}

export function touchRecord(root: string, address: string): void {
  const record = readRecord(root, address);
  if (record) writeRecord(root, { ...record, lastSeen: Date.now() });
}

export function markOffline(root: string, address: string): void {
  const record = readRecord(root, address);
  if (record) {
    const { pid: _pid, ...rest } = record;
    writeRecord(root, { ...rest, lastSeen: Date.now() });
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function presence(record: SessionRecord): Presence {
  return record.pid !== undefined && pidAlive(record.pid) ? "live" : "offline";
}


/** Remove registry records for sessions that are offline and stale. Mail is never touched. */
export function sweepRegistry(root: string, maxAgeMs = 30 * 24 * 60 * 60 * 1000): void {
  const now = Date.now();
  for (const record of listRecords(root)) {
    if (presence(record) === "offline" && now - record.lastSeen > maxAgeMs) {
      try {
        unlinkSync(join(registryDir(root), `${record.address}.json`));
      } catch {
        // already gone
      }
    }
  }
}
