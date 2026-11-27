import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newThreadRequest, TaskCreateReceipts } from "../../server/task-create-receipts.ts";

const scope = ["bot", "shape-fixture", "loopback:owner"];
const request = newThreadRequest({ title: "Fixture", createId: "shape-fixture-key", messageFingerprint: "a".repeat(64) })!;
const threadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const file = createHash("sha256").update(JSON.stringify([...scope, request.createId])).digest("hex") + ".json";

for (const [name, shape] of [
  ["array threadId", { threadId: [threadId], fingerprint: request.fingerprint, created: false }],
  ["array fingerprint", { threadId, fingerprint: [request.fingerprint], created: false }],
  ["non-boolean created", { threadId, fingerprint: request.fingerprint, created: 0 }],
] as const) {
  test("rejects malformed stored receipt before lookup or creation: " + name, () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-receipt-shape-"));
    try {
      writeFileSync(join(dir, file), JSON.stringify(shape));
      let lookups = 0;
      let creates = 0;
      const lookup = (_id: string) => { lookups++; return undefined; };
      const create = (id: string) => { creates++; return { threadId: id }; };
      assert.throws(() => new TaskCreateReceipts(dir).run(scope, request, lookup, create, () => {}), { status: 409, message: "Invalid stored conversation creation receipt" });
      assert.equal(lookups, 0);
      assert.equal(creates, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
