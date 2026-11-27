import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskCreateReceipts } from "../../server/task-create-receipts.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fingerprint = "a".repeat(64);
const id = (n: number) => "cccccccc-cccc-4ccc-8ccc-" + n.toString(16).padStart(12, "0");
function put(dir: string, name: string, threadId: string) {
  const path = join(dir, digest(name) + ".json");
  fs.writeFileSync(path, JSON.stringify({ threadId, fingerprint, created: false }));
  return path;
}
function readsDuring(dir: string, action: () => void): number {
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = ((...args: Parameters<typeof original>) => {
    if (typeof args[0] === "string" && args[0].startsWith(dir) && args[0].endsWith(".json")) reads++;
    return original(...args);
  }) as typeof original;
  syncBuiltinESMExports();
  try { action(); } finally {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  }
  return reads;
}

test("the first cold scan warms subsequent historical seals without a second full scan", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "omb-cold-index-"));
  try {
    const files = Array.from({ length: 100 }, (_, i) => put(dir, "fixture-" + i, id(i)));
    const receipts = new TaskCreateReceipts(dir);
    assert.equal(readsDuring(dir, () => receipts.sealExistingThreads([id(0)])), 100);
    const reads = readsDuring(dir, () => receipts.sealExistingThreads([id(1)]));
    assert.equal(reads, 1, "historical receipt paths should be warmed by the completed scan");
    assert.equal(JSON.parse(fs.readFileSync(files[1]!, "utf8")).created, true);
    assert.equal(JSON.parse(fs.readFileSync(files[2]!, "utf8")).created, false);
    console.log(JSON.stringify({ coldReads: 100, subsequentReads: reads }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("historical duplicate thread mappings are never reduced to a single cached receipt", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "omb-cold-alias-"));
  try {
    const first = put(dir, "first", id(0));
    const aliasA = put(dir, "alias-a", id(1));
    const aliasB = put(dir, "alias-b", id(1));
    const receipts = new TaskCreateReceipts(dir);
    receipts.sealExistingThreads([id(0)]);
    assert.equal(JSON.parse(fs.readFileSync(first, "utf8")).created, true);
    receipts.sealExistingThreads([id(1)]);
    assert.equal(JSON.parse(fs.readFileSync(aliasA, "utf8")).created, true);
    assert.equal(JSON.parse(fs.readFileSync(aliasB, "utf8")).created, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a malformed receipt blocks unknown historical deletion until repaired", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "omb-cold-incomplete-"));
  try {
    const first = put(dir, "first", id(0));
    const second = put(dir, "second", id(1));
    const broken = put(dir, "broken", id(2));
    const original = fs.readFileSync(broken, "utf8");
    fs.writeFileSync(broken, "{");
    const receipts = new TaskCreateReceipts(dir);
    const rejected = { status: 409 };
    assert.throws(() => receipts.sealExistingThreads([id(2)]), rejected);
    assert.throws(() => receipts.sealExistingThreads([id(1)]), rejected);
    assert.equal(fs.readFileSync(broken, "utf8"), "{");
    fs.writeFileSync(broken, original);
    assert.equal(readsDuring(dir, () => receipts.sealExistingThreads([id(2)])), 3);
    assert.equal(JSON.parse(fs.readFileSync(broken, "utf8")).created, true);
    assert.equal(JSON.parse(fs.readFileSync(first, "utf8")).created, false);
    assert.equal(readsDuring(dir, () => receipts.sealExistingThreads([id(1)])), 1);
    assert.equal(JSON.parse(fs.readFileSync(second, "utf8")).created, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a changed cached historical mapping is revalidated before sealing", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "omb-cold-stale-"));
  try {
    put(dir, "first", id(0));
    const second = put(dir, "second", id(1));
    const receipts = new TaskCreateReceipts(dir);
    receipts.sealExistingThreads([id(0)]);
    put(dir, "second", id(2));
    const moved = put(dir, "moved", id(1));
    receipts.sealExistingThreads([id(1)]);
    assert.equal(JSON.parse(fs.readFileSync(second, "utf8")).created, false);
    assert.equal(JSON.parse(fs.readFileSync(moved, "utf8")).created, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
