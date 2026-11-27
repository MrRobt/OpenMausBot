import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../control-omb.ts";

it.each(["bot", "channel"] as const)("refuses to delete a known %s thread while its receipt is malformed", async (kind) => {
  const fixture = await launchVerificationServer();
  try {
    const url = fixture.info.url;
    expect(new URL(url).port).not.toBe("8799");
    const { bot } = await runControlOmb(["new-bot", "--name", "Corrupt seal fixture", "--url", url]) as { bot: { id: string } };
    const target = kind === "bot" ? bot.id :
      (await runControlOmb(["new-channel", "--name", "Corrupt seal room", "--members", bot.id, "--url", url]) as { channel: { id: string } }).channel.id;
    const route = url + "/api/" + (kind === "bot" ? "bots" : "groups") + "/" + target + "/tasks";
    const post = async (endpoint: string, body: object) => {
      const response = await fetch(endpoint, { method: "POST", headers: { origin: url, "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as { task?: { threadId: string; createdAt: number }; deleted?: string[] } };
    };
    const request = { title: "Corrupt seal fixture", createId: "corrupt-seal-fixture-id", messageFingerprint: "a".repeat(64) };
    const created = await post(route, request);
    expect(created.status).toBe(201);
    const id = created.body.task?.threadId;
    expect(id).toBeTruthy();
    const dir = join(fixture.info.dataDir, "task-create-receipts");
    const files = readdirSync(dir).filter(name => name.endsWith(".json"));
    expect(files).toHaveLength(1);
    const path = join(dir, files[0]!);
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    expect(receipt.threadId).toBe(id);
    writeFileSync(path, "{");
    let rejected;
    try {
      rejected = await post(route + "/delete", { threadIds: [id] });
    } finally {
      writeFileSync(path, JSON.stringify({ ...receipt, created: false }));
    }
    const recovered = await post(route, request);
    expect(rejected.status).toBe(409);
    expect(rejected.body.deleted).toBeUndefined();
    expect(recovered.status).toBe(201);
    expect(recovered.body.task).toMatchObject({ threadId: id, createdAt: created.body.task?.createdAt });
    const removed = await post(route + "/delete", { threadIds: [id] });
    expect(removed.status).toBe(200);
    expect(removed.body.deleted).toContain(id);
    expect((await post(route, request)).status).toBe(409);
  } finally {
    await fixture.close();
  }
}, 180_000);
