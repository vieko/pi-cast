import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureCliShim } from "../src/cli-shim.ts";

const newRoot = () => mkdtempSync(join(tmpdir(), "pi-post-shim-"));

function shimPath(root: string): string {
  return join(root, "bin", "pi-post");
}

test("creates the package CLI symlink", () => {
  const root = newRoot();
  const target = join(root, "package", "bin", "pi-post.mjs");
  mkdirSync(join(root, "package", "bin"), { recursive: true });
  writeFileSync(target, "");

  ensureCliShim(root, target);

  assert.equal(lstatSync(shimPath(root)).isSymbolicLink(), true);
  assert.equal(resolve(join(root, "bin"), readlinkSync(shimPath(root))), resolve(target));
});

test("replaces a stale CLI symlink", () => {
  const root = newRoot();
  const target = join(root, "target.mjs");
  const stale = join(root, "stale.mjs");
  writeFileSync(target, "");
  writeFileSync(stale, "");
  mkdirSync(join(root, "bin"), { mode: 0o700 });
  const path = shimPath(root);
  symlinkSync(stale, path);

  ensureCliShim(root, target);

  assert.equal(resolve(join(root, "bin"), readlinkSync(path)), resolve(target));
});

test("replaces a dead CLI symlink", () => {
  const root = newRoot();
  const target = join(root, "target.mjs");
  writeFileSync(target, "");
  mkdirSync(join(root, "bin"), { mode: 0o700 });
  const path = shimPath(root);
  symlinkSync(join(root, "missing.mjs"), path);

  ensureCliShim(root, target);

  assert.equal(resolve(join(root, "bin"), readlinkSync(path)), resolve(target));
});

test("leaves a correct CLI symlink alone", () => {
  const root = newRoot();
  const target = join(root, "target.mjs");
  writeFileSync(target, "");
  mkdirSync(join(root, "bin"), { mode: 0o700 });
  const path = shimPath(root);
  symlinkSync(target, path);
  const before = readlinkSync(path);

  ensureCliShim(root, target);

  assert.equal(readlinkSync(path), before);
});

test("swallows CLI shim failures", () => {
  const root = newRoot();
  writeFileSync(join(root, "bin"), "not a directory");

  assert.doesNotThrow(() => ensureCliShim(root, join(root, "target.mjs")));
});
