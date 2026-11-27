// J-OMB-02 / R-L4: directed coverage for the 4096-entry FIFO cache boundary,
// mixed hit/miss batches, and cache rebuild after a fresh-process cold start.
// The disk remains the single source of truth in every case.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskCreateReceipts, newThreadRequest } from "../../server/task-create-receipts.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scope = ["bot", "omb-cache-capacity", "loopback:owner"];
const fp = "a".repeat(64);
const req = (key: string) => newThreadRequest({ title: "Cache capacity fixture", createId: key, messageFingerprint: fp })!;
const id = (n: number) => "cccccccc-cccc-4ccc-8ccc-" + n.toString(16).padStart(12, "0");
const hexName = (n: number) => n.toString(16).padStart(64, "0") + ".json";
const write = (path: string, threadId: string, fingerprint: string, created: boolean) =>
  fs.writeFileSync(path, JSON.stringify({ threadId, fingerprint, created }));
const parse = (path: string) => JSON.parse(fs.readFileSync(path, "utf8")) as { threadId: string; fingerprint: string; created: boolean };
const cacheOf = (receipts: TaskCreateReceipts) =>
  (receipts as unknown as { reservedHere: Map<string, string> }).reservedHere;
const tombKey = "cache-capacity-tomb-key";
const tombName = () => digest([...scope, req(tombKey).createId]) + ".json";
const tombThread = () => id(0xf000);
const putTomb = (dir: string) => {
  const name = tombName();
  write(join(dir, name), tombThread(), req(tombKey).fingerprint, true);
  return name;
};
// Replaying a created tombstone whose task is gone must refuse to resurrect.
const assertNoResurrection = (dir: string, lookups: { n: number }, creates: { n: number }) => {
  const lookup = (_tid: string) => { lookups.n++; return undefined; };
  const create = (tid: string) => { creates.n++; return { threadId: tid }; };
  const replay = new TaskCreateReceipts(dir);
  assert.throws(() => replay.run(scope, req(tombKey), lookup, create, () => {}), /no longer exists/);
};
const readsDuring = (dir: string, action: () => void): number => {
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
};

test("FIFO eviction above 4096 cached reservations still resolves seals by disk readback", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "omb-cache-eviction-"));
  try {
    const total = 4096;
    const fileOf = new Map<string, string>();
    for (let i = 0; i < total; i++) {
      const name = hexName(i);
      const threadId = id(i);
      write(join(dir, name), threadId, fp, false);
      fileOf.set(threadId, name);
    }
    const tomb = putTomb(dir);

    const receipts = new TaskCreateReceipts(dir);
    const cache = cacheOf(receipts);
    // A cold scan publishes at most 4096 mappings (candidates.size < 4096),
    // sealing nothing because the requested id has no on-disk reservation.
    receipts.sealExistingThreads([id(0xffff)]);
    assert.equal(cache.size, 4096, "the cache is capped at 4096 entries");
    const beforeKeys = new Set(cache.keys());

    // New reservations push the map past 4096, evicting the oldest entries.
    const lookups = { n: 0 }, creates = { n: 0 };
    const lookup = (_tid: string) => { lookups.n++; return undefined; };
    const create = (tid: string) => { creates.n++; return { threadId: tid }; };
    for (let i = 0; i < 3; i++) receipts.run(scope, req("cache-evict-new-" + i), lookup, create, () => {});
    assert.equal(cache.size, 4096, "FIFO eviction keeps the cache bounded at 4096");

    const evicted = [...beforeKeys].filter(key => !cache.has(key));
    assert.ok(evicted.length >= 1, "at least one oldest reservation was evicted");
    const evictedId = evicted[0]!;
    const evictedName = fileOf.get(evictedId)!;
    const evictedFile = join(dir, evictedName);

    const before = fs.readdirSync(dir).sort();
    // The evicted id is no longer cached -> the seal falls back to the full
    // directory scan and reads the truth back from disk (no 500, no skip).
    const reads = readsDuring(dir, () => receipts.sealExistingThreads([evictedId]));
    assert.equal(parse(evictedFile).created, true, "disk readback locates and seals the evicted reservation");
    assert.ok(reads > 1, "the evicted id was resolved by a full scan, not a cache hit");

    // Tombstone retained, file set unchanged, old key not resurrected, no duplicate creation.
    assert.ok(fs.existsSync(join(dir, tomb)), "the tombstone must not be deleted");
    assert.equal(parse(join(dir, tomb)).created, true);
    assert.deepEqual(fs.readdirSync(dir).sort(), before, "eviction/seal never deletes receipts");
    assertNoResurrection(dir, lookups, creates);
    assert.equal(creates.n, 3, "exactly the three new reservations were created, no duplicates");
    assert.equal(lookups.n, 4, "three creations plus one tombstone replay lookup");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a mixed batch of cache hits and cold-scan misses seals every target", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "omb-cache-mixed-"));
  try {
    const receipts = new TaskCreateReceipts(dir);
    const lookups = { n: 0 }, creates = { n: 0 };
    const lookup = (_tid: string) => { lookups.n++; return undefined; };
    const create = (tid: string) => { creates.n++; return { threadId: tid }; };
    // Two ids enter the cache via run() (warm / cache-hit path).
    const hitIds: string[] = [];
    const hitFiles: string[] = [];
    for (const key of ["cache-mixed-hit-a", "cache-mixed-hit-b"]) {
      const task = receipts.run(scope, req(key), lookup, create, () => {}).task;
      const name = digest([...scope, req(key).createId]) + ".json";
      fs.writeFileSync(join(dir, name), JSON.stringify({ threadId: task.threadId, fingerprint: req(key).fingerprint, created: false }));
      hitIds.push(task.threadId);
      hitFiles.push(join(dir, name));
    }
    // Two ids are written directly to disk and were never cached (cold path).
    const coldIds = [id(1), id(2)];
    const coldFiles = coldIds.map((threadId, i) => {
      const name = hexName(100 + i);
      write(join(dir, name), threadId, fp, false);
      return join(dir, name);
    });
    const tomb = putTomb(dir);
    const before = fs.readdirSync(dir).sort();

    // One batch mixes cache hits (fast path) with cold-scan misses (full scan).
    const reads = readsDuring(dir, () => receipts.sealExistingThreads([...hitIds, ...coldIds]));
    for (const file of [...hitFiles, ...coldFiles]) {
      assert.equal(parse(file).created, true, "every target in the mixed batch is sealed");
    }
    assert.ok(reads > hitIds.length, "the batch exercised the full directory scan for cold ids");

    assert.ok(fs.existsSync(join(dir, tomb)), "the tombstone must not be deleted");
    assert.equal(parse(join(dir, tomb)).created, true);
    assert.deepEqual(fs.readdirSync(dir).sort(), before, "the mixed batch never deletes receipts");
    assertNoResurrection(dir, lookups, creates);
    assert.equal(creates.n, 2, "exactly the two warm reservations were created, no duplicates");
    assert.equal(lookups.n, 3, "two creations plus one tombstone replay lookup");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh-process cold start rebuilds the cache by full scan and seals correctly", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "omb-cache-restart-"));
  try {
    const a = id(1), b = id(2);
    const nameA = hexName(1), nameB = hexName(2);
    write(join(dir, nameA), a, fp, false);
    write(join(dir, nameB), b, fp, false);
    const tomb = putTomb(dir);
    const before = fs.readdirSync(dir).sort();

    // Spawn a genuinely new process (process.execPath = the locked Node24 from
    // omb-dev.py, never the global Node22). Its reservedHere starts empty, so
    // the first seal must cold-scan the directory and rebuild the cache from disk.
    const modUrl = new URL("../../server/task-create-receipts.ts", import.meta.url).href;
    const childCode = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const { TaskCreateReceipts } = await import(${JSON.stringify(modUrl)});
const dir = process.env.CACHE_DIR;
const rng = new TaskCreateReceipts(dir);
const orig = fs.readFileSync;
const counted = (fn) => {
  let n = 0;
  fs.readFileSync = ((...args) => {
    if (typeof args[0] === "string" && args[0].startsWith(dir) && args[0].endsWith(".json")) n++;
    return orig(...args);
  });
  syncBuiltinESMExports();
  try { fn(); } finally { fs.readFileSync = orig; syncBuiltinESMExports(); }
  return n;
};
const firstReads = counted(() => rng.sealExistingThreads([process.env.CACHE_A]));
const secondReads = counted(() => rng.sealExistingThreads([process.env.CACHE_B]));
const createdA = JSON.parse(orig(join(dir, process.env.CACHE_NAME_A), "utf8")).created;
const createdB = JSON.parse(orig(join(dir, process.env.CACHE_NAME_B), "utf8")).created;
console.log("RESULT:" + JSON.stringify({ firstReads, secondReads, createdA, createdB }));
`;
    const child = spawnSync(process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", childCode],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CACHE_DIR: dir, CACHE_A: a, CACHE_B: b,
          CACHE_NAME_A: nameA, CACHE_NAME_B: nameB,
        },
      });
    assert.equal(child.status, 0, "cold-start child failed: " + (child.stderr || ""));
    const line = (child.stdout || "").split("\n").find(value => value.startsWith("RESULT:"));
    assert.ok(line, "the child reported a structured result");
    const result = JSON.parse(line.slice("RESULT:".length)) as { firstReads: number; secondReads: number; createdA: boolean; createdB: boolean };

    // The first seal rebuilt the cache by reading the whole directory; the
    // second seal hit that freshly rebuilt cache in a single read.
    assert.ok(result.firstReads >= 3, "the cold start scanned every on-disk receipt");
    assert.equal(result.secondReads, 1, "the rebuilt cache serves the next seal with one read");
    assert.equal(result.createdA, true);
    assert.equal(result.createdB, true);
    assert.equal(parse(join(dir, nameA)).created, true);
    assert.equal(parse(join(dir, nameB)).created, true);

    assert.ok(fs.existsSync(join(dir, tomb)), "the tombstone must not be deleted");
    assert.equal(parse(join(dir, tomb)).created, true);
    assert.deepEqual(fs.readdirSync(dir).sort(), before, "the cold-start rebuild never deletes receipts");
    const lookups = { n: 0 }, creates = { n: 0 };
    assertNoResurrection(dir, lookups, creates);
    assert.equal(creates.n, 0, "no duplicate creation on a tombstone replay");
    assert.equal(lookups.n, 1, "one tombstone replay lookup");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
