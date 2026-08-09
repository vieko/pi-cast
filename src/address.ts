import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** A session address names a conversation; a standing address names a place. */
export type AddressKind = "session" | "standing";

const ADDRESS_RE = /^[sw]-[0-9a-f]{12}$/;

function h12(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/** Stable address for a pi session id. Survives restarts and `pi -c`. */
export function sessionAddress(sessionId: string): string {
  return `s-${h12(`session\0${sessionId}`)}`;
}

/** Stable address for a directory. Exists before and after any session. */
export function standingAddress(canonicalDir: string): string {
  return `w-${h12(`standing\0${canonicalDir}`)}`;
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

export function addressKind(address: string): AddressKind {
  return address.startsWith("s-") ? "session" : "standing";
}

/** Heuristic: does this target string denote a path rather than a name? */
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
