import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Ensure the mailbox-owned CLI path points at the package's own executable. */
export function ensureCliShim(baseDir: string, targetPath: string): void {
  const shimDir = join(baseDir, "bin");
  const shimPath = join(shimDir, "pi-post");
  try {
    mkdirSync(shimDir, { recursive: true, mode: 0o700 });

    try {
      if (lstatSync(shimPath).isSymbolicLink()) {
        const linkTarget = readlinkSync(shimPath);
        if (resolve(dirname(shimPath), linkTarget) === resolve(targetPath) && existsSync(targetPath)) return;
      }
      unlinkSync(shimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    symlinkSync(targetPath, shimPath);
  } catch {
    // A CLI convenience must never prevent a session from starting.
  }
}
