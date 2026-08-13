import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const ADDRESS_RE = /^s-[0-9a-f]{12}$/;

function h12(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/** Stable address for a pi session id. Survives restarts and `pi -c`. */
export function sessionAddress(sessionId: string): string {
  return `s-${h12(`session\0${sessionId}`)}`;
}

/**
 * Canonicalize a directory path: expand `~`, resolve against `cwd`, and
 * follow symlinks when the path exists so aliases share one address.
 */
export function canonicalPath(path: string, cwd?: string): string {
  let expanded = path;
  if (expanded === "~" || expanded.startsWith("~/")) {
    expanded = resolve(homedir(), expanded.slice(2));
  }
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd ?? process.cwd(), expanded);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function isAddress(value: string): boolean {
  return ADDRESS_RE.test(value);
}

/**
 * Heuristic: does this target look like a pi session id, or a prefix of one?
 * At least 8 leading hex chars keeps short hex-looking names out; resolution
 * still falls through to name matching when no session id matches.
 */
export function looksLikeSessionId(value: string): boolean {
  return /^[0-9a-f]{8}[0-9a-f-]{0,28}$/i.test(value);
}

/** Heuristic: does this target string denote a path (a query for the session running there)? */
export function looksLikePath(target: string): boolean {
  return (
    target === "~" ||
    target === "." ||
    target === ".." ||
    target.startsWith("~/") ||
    target.startsWith("./") ||
    target.startsWith("../") ||
    target.startsWith("/") ||
    target.includes("/")
  );
}
