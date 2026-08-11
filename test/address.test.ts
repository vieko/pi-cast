import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPath, isAddress, looksLikePath, sessionAddress } from "../src/address.ts";

test("an address belongs to a conversation, not a process: same session id, same address", () => {
  assert.equal(sessionAddress("abc"), sessionAddress("abc"));
  assert.notEqual(sessionAddress("abc"), sessionAddress("abd"));
});

test("addresses match the wire format; only sessions have addresses", () => {
  assert.ok(isAddress(sessionAddress("id")));
  assert.ok(!isAddress("w-abcdefabcdef")); // standing addresses were removed in v0.3.0
  assert.ok(!isAddress("s-XYZ"));
  assert.ok(!isAddress("gtm"));
});

test("symlink aliases of one directory share one canonical path", () => {
  const base = mkdtempSync(join(tmpdir(), "post-addr-"));
  const real = join(base, "real");
  const alias = join(base, "alias");
  mkdirSync(real);
  symlinkSync(real, alias);
  assert.equal(canonicalPath(alias), canonicalPath(real));
});

test("path detection distinguishes names from places", () => {
  for (const p of ["~/dev/gtm", "./x", "../x", "/abs", "a/b", ".", ".."]) {
    assert.ok(looksLikePath(p), p);
  }
  for (const n of ["gtm", "summoner", "s-abcdefabcdef"]) {
    assert.ok(!looksLikePath(n), n);
  }
});
