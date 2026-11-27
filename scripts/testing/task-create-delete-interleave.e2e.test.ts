import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../control-omb.ts";

it.each(["bot", "channel"] as const)("does not resurrect a deleted %s thread after an interrupted receipt commit", async (kind) => {
  const fixture = await launchVerificationServer();
  try {
    const url = fixture.info.url;
    expect(new URL(url).port).not.toBe("8799");
    const { bot } = await runControlOmb(["new-bot", "--name", "Delete interleave fixture", "--url", url]) as { bot: { id: string } };
    const target = kind === "bot" ? bot.id :
      (await runControlOmb(["new-channel", "--name", "Delete interleave room", "--members", bot.id, "--url", url]) as { channel: { id: string } }).channel.id;
    const route = url + "/api/" + (kind === "bot" ? "bots" : "groups") + "/" + target + "/tasks";
    const post = async (endpoint: string, body: object) => {
      const response = await fetch(endpoint, { method: "POST", headers: { origin: url, "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as { task?: { threadId: string }; deleted?: string[]; error?: string } };
    };
    const request = { title: "Pending receipt", createId: "delete-interleave-fixture", messageFingerprint: "a".repeat(64) };
    const created = await post(route, request);
    expect(created.status).toBe(201);
    const id = created.body.task?.threadId;
    expect(id).toBeTruthy();
    const dir = join(fixture.info.dataDir, "task-create-receipts");
    const names = readdirSync(dir).filter(name => name.endsWith(".json"));
    expect(names).toHaveLength(1);
    const path = join(dir, names[0]!);
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    expect(receipt.threadId).toBe(id);
    expect(receipt.created).toBe(true);
    writeFileSync(path, JSON.stringify({ ...receipt, created: false }));
    const removed = await post(route + "/delete", { threadIds: [id] });
    expect(removed.status).toBe(200);
    expect(removed.body.deleted).toContain(id);
    const replay = await post(route, request);
    expect(replay.status, JSON.stringify(replay.body)).toBe(409);
    expect(replay.body.task).toBeUndefined();
  } finally {
    await fixture.close();
  }
}, 120_000);
