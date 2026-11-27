import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { TaskCreateReceipts, newThreadRequest } from "../../server/task-create-receipts.ts";

test("seals only the requested reservation and retains tombstones at 5000 receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "omb-receipt-capacity-"));
  const dir = join(root, "receipts");
  mkdirSync(dir);
  const scope = ["bot", "capacity-fixture", "loopback:owner"];
  const fingerprint = "a".repeat(64);
  const records = new Map<string, { threadId: string }>();
  const keys = ["capacity-target-fixture", "capacity-other-fixture"];
  const request = (key: string) => newThreadRequest({ title: "Fixture", createId: key, messageFingerprint: fingerprint })!;
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const names = keys.map(key => digest([...scope, key]) + ".json");
  const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
  try {
    for (let i = 0; i < 4998; i++) {
      const file = digest(["synthetic", i]) + ".json";
      writeFileSync(join(dir, file), JSON.stringify({ threadId: "cccccccc-cccc-4ccc-8ccc-" + i.toString(16).padStart(12, "0"), fingerprint, created: true }));
    }
    keys.forEach((key, i) => {
      writeFileSync(join(dir, names[i]!), JSON.stringify({ threadId: ids[i], fingerprint: request(key).fingerprint, created: false }));
      records.set(ids[i]!, { threadId: ids[i]! });
    });
    const before = readdirSync(dir).sort();
    const receipts = new TaskCreateReceipts(dir);
    const start = performance.now();
    receipts.sealExistingThreads([ids[0]!]);
    const sealMs = performance.now() - start;
    assert.equal(JSON.parse(readFileSync(join(dir, names[0]!), "utf8")).created, true);
    assert.equal(JSON.parse(readFileSync(join(dir, names[1]!), "utf8")).created, false);
    records.delete(ids[0]!);
    const lookup = (id: string) => records.get(id);
    const create = (_id: string): never => { throw new Error("unexpected duplicate create"); };
    const restored = new TaskCreateReceipts(dir);
    assert.throws(() => restored.run(scope, request(keys[0]!), lookup, create, () => {}), /no longer exists/);
    assert.equal(restored.run(scope, request(keys[1]!), lookup, create, () => {}).task.threadId, ids[1]);
    assert.deepEqual(readdirSync(dir).sort(), before);
    console.log(JSON.stringify({ receipts: before.length, sealMs: Math.round(sealMs), tombstoneRetained: true, unrelatedReplay: true }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
