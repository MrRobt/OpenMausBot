import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskCreateReceipts, newThreadRequest } from "../../server/task-create-receipts.ts";

test("seals a known reservation without reading unrelated historical receipts", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "omb-receipt-fast-seal-"));
  const scope = ["bot", "fast-seal-fixture", "loopback:owner"];
  const request = newThreadRequest({ title: "Fixture", createId: "fast-seal-fixture-id", messageFingerprint: "a".repeat(64) })!;
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const file = join(dir, digest([...scope, request.createId]) + ".json");
  const records = new Map<string, { threadId: string }>();
  const lookup = (id: string) => records.get(id);
  const create = (id: string) => { const task = { threadId: id }; records.set(id, task); return task; };
  try {
    for (let i = 0; i < 100; i++) {
      fs.writeFileSync(join(dir, digest(["synthetic", i]) + ".json"), JSON.stringify({
        threadId: "cccccccc-cccc-4ccc-8ccc-" + i.toString(16).padStart(12, "0"), fingerprint: "b".repeat(64), created: true,
      }));
    }
    const receipts = new TaskCreateReceipts(dir);
    const task = receipts.run(scope, request, lookup, create, () => {}).task;
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...record, created: false }));
    const originalRead = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = ((...args: Parameters<typeof originalRead>) => {
      if (typeof args[0] === "string" && args[0].startsWith(dir) && args[0].endsWith(".json")) reads++;
      return originalRead(...args);
    }) as typeof originalRead;
    syncBuiltinESMExports();
    try {
      receipts.sealExistingThreads([task.threadId]);
    } finally {
      fs.readFileSync = originalRead;
      syncBuiltinESMExports();
    }
    assert.equal(reads, 1, "a known thread should require one receipt read");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).created, true);
    records.delete(task.threadId);
    assert.throws(() => new TaskCreateReceipts(dir).run(scope, request, lookup, create, () => {}), /no longer exists/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
