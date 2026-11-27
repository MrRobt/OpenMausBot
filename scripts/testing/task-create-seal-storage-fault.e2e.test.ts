import { readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../control-omb.ts";

it.each(["bot", "channel"] as const)("refuses %s thread deletion while receipt storage is inaccessible", async (kind) => {
  const fixture = await launchVerificationServer();
  try {
    const url = fixture.info.url;
    expect(new URL(url).port).not.toBe("8799");
    const { bot } = await runControlOmb(["new-bot", "--name", "Receipt storage fault", "--url", url]) as { bot: { id: string } };
    const target = kind === "bot" ? bot.id :
      (await runControlOmb(["new-channel", "--name", "Receipt storage fault room", "--members", bot.id, "--url", url]) as { channel: { id: string } }).channel.id;
    const route = url + "/api/" + (kind === "bot" ? "bots" : "groups") + "/" + target + "/tasks";
    const post = async (endpoint: string, body: object) => {
      const response = await fetch(endpoint, { method: "POST", headers: { origin: url, "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as { task?: { threadId: string; createdAt: number }; deleted?: string[] } };
    };
    const request = { title: "Storage fault fixture", createId: "seal-storage-fault-fixture", messageFingerprint: "a".repeat(64) };
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
    writeFileSync(path, JSON.stringify({ ...receipt, created: false }));
    const parked = dir + "-fixture-parked";
    renameSync(dir, parked);
    let obstruction = false;
    try {
      writeFileSync(dir, "fixture storage fault", { flag: "wx" });
      obstruction = true;
      const rejected = await post(route + "/delete", { threadIds: [id] });
      expect(rejected.status).toBe(500);
      expect(rejected.body.deleted).toBeUndefined();
    } finally {
      if (obstruction) unlinkSync(dir);
      renameSync(parked, dir);
    }
    expect(JSON.parse(readFileSync(path, "utf8")).created).toBe(false);
    const replay = await post(route, request);
    expect(replay.status).toBe(201);
    expect(replay.body.task?.threadId).toBe(id);
    expect(replay.body.task?.createdAt).toBe(created.body.task?.createdAt);
    const removed = await post(route + "/delete", { threadIds: [id] });
    expect(removed.status).toBe(200);
    expect(removed.body.deleted).toContain(id);
    expect((await post(route, request)).status).toBe(409);
  } finally {
    await fixture.close();
  }
}, 180_000);
