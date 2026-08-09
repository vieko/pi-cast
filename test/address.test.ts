import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addressKind,
  canonicalPath,
  isAddress,
  looksLikePath,
  sessionAddress,
  standingAddress,
} from "../src/address.ts";

test("an address belongs to an identity, not a process: same input, same address", () => {
  assert.equal(sessionAddress("abc"), sessionAddress("abc"));
  assert.equal(standingAddress("/x/y"), standingAddress("/x/y"));
});

test("session and standing addresses never collide, even for equal input", () => {
  assert.notEqual(sessionAddress("x"), standingAddress("x"));
  assert.equal(addressKind(sessionAddress("x")), "session");
  assert.equal(addressKind(standingAddress("x")), "standing");
});

test("addresses match the wire format", () => {
  assert.ok(isAddress(sessionAddress("id")));
  assert.ok(isAddress(standingAddress("/p")));
  assert.ok(!isAddress("s-XYZ"));
  assert.ok(!isAddress("gtm"));
});

test("symlink aliases of one directory share one standing address", () => {
  const base = mkdtempSync(join(tmpdir(), "cast-addr-"));
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
