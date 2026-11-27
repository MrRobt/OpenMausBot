// J-OMB-02 / R-L4: the first-level cache is only a hint; the disk is the single
// source of truth. A cached receipt path that vanished (backup restore / external
// GC) must drop the stale entry and fall back to the full directory scan, exactly
// like a cache miss, instead of surfacing a native ENOENT (mapped to HTTP 500).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskCreateReceipts, newThreadRequest } from "../../server/task-create-receipts.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scope = ["bot", "omb-cache-fallback", "loopback:owner"];
const req = (key: string) => newThreadRequest({ title: "Cache fallback fixture", createId: key, messageFingerprint: "a".repeat(64) })!;
const id = (n: number) => "cccccccc-cccc-4ccc-8ccc-" + n.toString(16).padStart(12, "0");
const pathFor = (dir: string, key: unknown) => join(dir, digest(key) + ".json");
const write = (path: string, threadId: string, fingerprint: string, created: boolean) =>
  fs.writeFileSync(path, JSON.stringify({ threadId, fingerprint, created }));
const parse = (path: string) => JSON.parse(fs.readFileSync(path, "utf8")) as { threadId: string; fingerprint: string; created: boolean };

test("a deleted cached receipt path falls back to the full scan and seals the relocated receipt", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "omb-cache-fallback-"));
  try {
    const targetId = id(1), tombId = id(2), otherId = id(3);
    const targetReq = req("cache-fallback-target");
    const tombReq = req("cache-fallback-tomb");
    const otherReq = req("cache-fallback-other");
    const targetFile = pathFor(dir, [...scope, targetReq.createId]);
    const tombFile = pathFor(dir, [...scope, tombReq.createId]);
    const otherFile = pathFor(dir, [...scope, otherReq.createId]);
    write(targetFile, targetId, targetReq.fingerprint, false);
    write(tombFile, tombId, tombReq.fingerprint, true);
    write(otherFile, otherId, otherReq.fingerprint, false);
    for (let i = 0; i < 5; i++) write(pathFor(dir, ["synthetic", i]), id(10 + i), targetReq.fingerprint, true);

    const receipts = new TaskCreateReceipts(dir);
    // Warm the in-process cache: a completed cold scan seals the target receipt
    // and publishes directory mappings (targetId -> targetFile) into reservedHere.
    receipts.sealExistingThreads([targetId]);
    assert.equal(parse(targetFile).created, true);

    // Backup restore rolls the receipt back to pre-commit; external GC then
    // deletes the exact file the cache points at; the same thread's receipt is
    // restored at a different path. The cache is now stale and unreadable.
    write(targetFile, targetId, targetReq.fingerprint, false);
    fs.rmSync(targetFile);
    const relocatedFile = pathFor(dir, ["relocated", targetId]);
    write(relocatedFile, targetId, targetReq.fingerprint, false);
    const before = fs.readdirSync(dir).sort();

    let lookups = 0, creates = 0;
    const lookup = (_tid: string) => { lookups++; return undefined; };
    const create = (tid: string) => { creates++; return { threadId: tid }; };

    // Unfixed: the hit path calls readFileSync(targetFile) with no try/catch, so
    // ENOENT is rethrown as a status-less native error -> HTTP 500.
    // Expected: delete the stale cache entry + fall back to the full scan, which
    // re-reads the disk and seals the relocated receipt (no 500, no resurrection).
    assert.doesNotThrow(() => receipts.sealExistingThreads([targetId]));
    assert.equal(parse(relocatedFile).created, true, "disk readback must locate and seal the relocated target receipt");

    // Tombstones are never deleted, unrelated receipts are not sealed, and the
    // seal itself never changes the on-disk file set.
    assert.ok(fs.existsSync(tombFile), "the tombstone must not be deleted");
    assert.equal(parse(tombFile).created, true);
    assert.equal(parse(otherFile).created, false, "unrelated unfinished reservations are not sealed");
    assert.deepEqual(fs.readdirSync(dir).sort(), before, "the file set is unchanged by the fallback scan");

    // The old key cannot be resurrected, lookups/creates match, and no duplicate
    // creation happens (a created tombstone replays as 409 with zero creates).
    const replay = new TaskCreateReceipts(dir);
    assert.throws(() => replay.run(scope, tombReq, lookup, create, () => {}), /no longer exists/);
    assert.throws(() => replay.run(scope, tombReq, lookup, create, () => {}), /no longer exists/);
    assert.equal(lookups, 2);
    assert.equal(creates, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a deleted cached receipt with no surviving on-disk record is judged absent without a 500", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "omb-cache-absent-"));
  try {
    const targetId = id(1), tombId = id(2), otherId = id(3);
    const targetReq = req("cache-absent-target");
    const tombReq = req("cache-absent-tomb");
    const otherReq = req("cache-absent-other");
    const targetFile = pathFor(dir, [...scope, targetReq.createId]);
    const tombFile = pathFor(dir, [...scope, tombReq.createId]);
    const otherFile = pathFor(dir, [...scope, otherReq.createId]);
    write(targetFile, targetId, targetReq.fingerprint, false);
    write(tombFile, tombId, tombReq.fingerprint, true);
    write(otherFile, otherId, otherReq.fingerprint, false);

    const receipts = new TaskCreateReceipts(dir);
    // Warm the cache and seal the target (created:false -> true).
    receipts.sealExistingThreads([targetId]);
    assert.equal(parse(targetFile).created, true);

    // Roll back to pre-commit, then external GC deletes the cached receipt;
    // no other on-disk receipt carries this threadId anymore.
    write(targetFile, targetId, targetReq.fingerprint, false);
    fs.rmSync(targetFile);
    const before = fs.readdirSync(dir).sort();

    let lookups = 0, creates = 0;
    const lookup = (_tid: string) => { lookups++; return undefined; };
    const create = (tid: string) => { creates++; return { threadId: tid }; };

    // Expected: drop the stale cache entry + fall back to the authoritative
    // full scan, which finds no reservation for this id -> nothing is sealed,
    // no uncaught ENOENT (no 500), and no silent resurrection.
    assert.doesNotThrow(() => receipts.sealExistingThreads([targetId]));

    assert.ok(fs.existsSync(tombFile), "the tombstone must not be deleted");
    assert.equal(parse(tombFile).created, true);
    assert.equal(parse(otherFile).created, false, "no unrelated receipt is sealed");
    assert.deepEqual(fs.readdirSync(dir).sort(), before, "the file set is unchanged by the fallback scan");

    const replay = new TaskCreateReceipts(dir);
    assert.throws(() => replay.run(scope, tombReq, lookup, create, () => {}), /no longer exists/);
    assert.throws(() => replay.run(scope, tombReq, lookup, create, () => {}), /no longer exists/);
    assert.equal(lookups, 2);
    assert.equal(creates, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupted cached receipt falls back to the full scan and keeps the fail-closed 409", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "omb-cache-corrupt-"));
  try {
    const targetId = id(1), tombId = id(2);
    const targetReq = req("cache-corrupt-target");
    const tombReq = req("cache-corrupt-tomb");
    const targetFile = pathFor(dir, [...scope, targetReq.createId]);
    const tombFile = pathFor(dir, [...scope, tombReq.createId]);
    write(targetFile, targetId, targetReq.fingerprint, false);
    write(tombFile, tombId, tombReq.fingerprint, true);

    const receipts = new TaskCreateReceipts(dir);
    receipts.sealExistingThreads([targetId]); // warm the cache (targetId -> targetFile)
    assert.equal(parse(targetFile).created, true);

    // The cached path now holds a malformed receipt (parse / shape mismatch).
    fs.writeFileSync(targetFile, "{");
    const before = fs.readdirSync(dir).sort();

    // Expected: the stale entry is dropped and the whole directory is
    // revalidated from disk, so the damaged receipt still yields a stable 409
    // (cold-scan fail-closed is NOT weakened), never a 500, never a silent seal.
    assert.throws(() => receipts.sealExistingThreads([targetId]),
      { status: 409, message: "Invalid stored conversation creation receipt" });

    assert.ok(fs.existsSync(tombFile), "the tombstone must not be deleted");
    assert.equal(parse(tombFile).created, true);
    assert.equal(fs.readFileSync(targetFile, "utf8"), "{", "the damaged receipt is not rewritten");
    assert.deepEqual(fs.readdirSync(dir).sort(), before, "the file set is unchanged");

    // Repairing the receipt lets the disk truth be re-established: the cache is
    // rebuilt by a full scan and the target is sealed again (behavior of a miss).
    write(targetFile, targetId, targetReq.fingerprint, false);
    assert.doesNotThrow(() => receipts.sealExistingThreads([targetId]));
    assert.equal(parse(targetFile).created, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
