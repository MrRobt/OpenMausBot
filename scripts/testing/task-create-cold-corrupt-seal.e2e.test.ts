import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../control-omb.ts";
import { removeTempDir } from "../../server/testing/cleanup.ts";

it.each(["bot", "channel"] as const)("refuses %s deletion after restart when receipt ownership cannot be established", async (kind) => {
  const first = await launchVerificationServer();
  let second: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  try {
    let url = first.info.url;
    const port = Number(new URL(url).port);
    expect(port).not.toBe(8799);
    const { bot } = await runControlOmb(["new-bot", "--name", "Cold corrupt fixture", "--url", url]) as { bot: { id: string } };
    const target = kind === "bot" ? bot.id :
      (await runControlOmb(["new-channel", "--name", "Cold corrupt room", "--members", bot.id, "--url", url]) as { channel: { id: string } }).channel.id;
    const route = "/api/" + (kind === "bot" ? "bots" : "groups") + "/" + target + "/tasks";
    const post = async (endpoint: string, body: object) => {
      const response = await fetch(url + endpoint, { method: "POST", headers: { origin: url, "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as { task?: { threadId: string; createdAt: number }; deleted?: string[] } };
    };
    const request = { title: "Cold corrupt fixture", createId: "cold-corrupt-fixture-id", messageFingerprint: "a".repeat(64) };
    const created = await post(route, request);
    expect(created.status).toBe(201);
    const id = created.body.task?.threadId;
    expect(id).toBeTruthy();
    const dir = join(first.info.dataDir, "task-create-receipts");
    const names = readdirSync(dir).filter(name => name.endsWith(".json"));
    expect(names).toHaveLength(1);
    const path = join(dir, names[0]!);
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    await first.close(false);
    writeFileSync(path, "{");
    second = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined,
      { dataDir: first.info.dataDir, port });
    url = second.info.url;
    let rejected;
    try {
      rejected = await post(route + "/delete", { threadIds: [id] });
    } finally {
      writeFileSync(path, JSON.stringify({ ...receipt, created: false }));
    }
    expect(rejected.status).toBe(409);
    expect(rejected.body.deleted).toBeUndefined();
    const replay = await post(route, request);
    expect(replay.status).toBe(201);
    expect(replay.body.task).toMatchObject({ threadId: id, createdAt: created.body.task?.createdAt });
    const removed = await post(route + "/delete", { threadIds: [id] });
    expect(removed.status).toBe(200);
    expect(removed.body.deleted).toContain(id);
    expect((await post(route, request)).status).toBe(409);
  } finally {
    await second?.close();
    await first.close(false);
    await removeTempDir(first.info.dataDir);
  }
}, 180_000);
