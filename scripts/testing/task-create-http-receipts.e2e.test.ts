import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../control-omb.ts";

it("keeps HTTP and CLI creation receipts compatible and fails closed on corrupt receipts", async () => {
  const fixture = await launchVerificationServer();
  try {
    const url = fixture.info.url;
    expect(new URL(url).port).not.toBe("8799");
    const { bot } = await runControlOmb(["new-bot", "--name", "HTTP receipt fixture", "--url", url]) as { bot: { id: string } };
    const post = async (body: object) => {
      const response = await fetch(url + "/api/bots/" + bot.id + "/tasks", {
        method: "POST", headers: { origin: url, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as { task?: { threadId: string; createdAt: number }; error?: string } };
    };
    const count = async () => {
      const fleet = await fetch(url + "/api/bots?messages=0").then(r => r.json()) as { bots: Array<{ id: string; tasks: unknown[] }> };
      return fleet.bots.find(b => b.id === bot.id)!.tasks.length;
    };
    const before = await count();
    const message = "HTTP CLI receipt";
    const keyed = { title: "HTTP CLI", createId: "http-cli-receipt-fixture", messageFingerprint: createHash("sha256").update(JSON.stringify([message])).digest("hex") };
    for (const invalid of [{ createId: keyed.createId }, { ...keyed, approvalMode: "full" }, { ...keyed, messageFingerprint: "bad" }]) {
      const result = await post(invalid);
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.status).toBeLessThan(500);
      expect(await count()).toBe(before);
    }
    const first = await post(keyed);
    expect(first.status).toBe(201);
    expect(first.body.task?.threadId).toBeTruthy();
    expect(typeof first.body.task?.createdAt).toBe("number");
    const replay = await post(keyed);
    expect(replay.status).toBe(201);
    expect(replay.body.task?.threadId).toBe(first.body.task?.threadId);
    expect(replay.body.task?.createdAt).toBe(first.body.task?.createdAt);
    const sent = await runControlOmb(["send", bot.id, message, "--task", "new", "--title", keyed.title, "--send-id", keyed.createId, "--url", url]) as { taskId: string; messageId: string };
    expect(sent.taskId).toBe(first.body.task?.threadId);
    expect(sent.messageId).toBeTruthy();
    expect(await count()).toBe(before + 1);
    expect((await post({ ...keyed, messageFingerprint: "b".repeat(64) })).status).toBe(409);
    const dir = join(fixture.info.dataDir, "task-create-receipts");
    const files = readdirSync(dir).filter(name => name.endsWith(".json"));
    expect(files).toHaveLength(1);
    const path = join(dir, files[0]!);
    const original = readFileSync(path, "utf8");
    try {
      writeFileSync(path, '{"threadId":');
      expect((await post(keyed)).status).toBe(409);
      expect(await count()).toBe(before + 1);
      const stored = JSON.parse(original) as { threadId: string; fingerprint: string; created: boolean };
      for (const malformed of [
        { ...stored, threadId: [stored.threadId], created: false },
        { ...stored, fingerprint: [stored.fingerprint] },
      ]) {
        writeFileSync(path, JSON.stringify(malformed));
        const rejected = await post(keyed);
        expect(rejected.status).toBe(409);
        expect(rejected.body.error).toContain("Invalid stored conversation creation receipt");
        expect(await count()).toBe(before + 1);
      }
    } finally {
      writeFileSync(path, original);
    }
    expect((await post(keyed)).body.task?.threadId).toBe(sent.taskId);
    const legacy = await post({ title: keyed.title });
    expect(legacy.status).toBe(201);
    expect(legacy.body.task?.threadId).not.toBe(sent.taskId);
    expect(await count()).toBe(before + 2);
  } finally {
    await fixture.close();
  }
}, 120_000);
