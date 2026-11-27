import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../control-omb.ts";
import { removeTempDir } from "../../server/testing/cleanup.ts";
import { freePortBlock } from "../../server/testing/ports.ts";

const exec = promisify(execFile);
const sendTo = async (url: string, args: string[]): Promise<Record<string, any>> =>
  JSON.parse((await exec(process.execPath, ["--experimental-strip-types", "server/openmausbot.ts", "send", ...args, "--url", url, "--json"], { timeout: 60_000 })).stdout);
const sendChannelTo = async (url: string, args: string[]): Promise<Record<string, any>> =>
  JSON.parse((await exec(process.execPath, ["--experimental-strip-types", "server/openmausbot.ts", "send-channel", ...args, "--url", url, "--json"], { timeout: 60_000 })).stdout);

it("rejects malformed send ids on the real CLI without creating a task", async () => {
  const fixture = await launchVerificationServer();
  try {
    const created = await runControlOmb(["new-bot", "--name", "Invalid send id fixture", "--url", fixture.info.url]) as { bot: { id: string } };
    const taskCount = async () => {
      const fleet = await fetch(fixture.info.url + "/api/bots?messages=0").then(r => r.json()) as { bots: Array<{id: string; tasks: Array<{threadId: string}>}> };
      return fleet.bots.find(b => b.id === created.bot.id)?.tasks.length;
    };
    const before = await taskCount();
    for (const verb of ["send", "run"]) {
      const args = ["--experimental-strip-types", "server/openmausbot.ts", verb, created.bot.id, "Must not run", "--task", "new", "--send-id", "short", "--url", fixture.info.url, "--json"];
      try {
        await exec(process.execPath, args, { timeout: 60_000 });
        throw new Error("malformed send id unexpectedly accepted");
      } catch (error) {
        expect((error as { code?: number }).code).toBe(2);
        expect(JSON.parse((error as { stdout: string }).stdout).error).toContain("--send-id");
      }
      expect(await taskCount()).toBe(before);
    }
  } finally {
    await fixture.close();
  }
}, 60_000);

it("reuses the newly created bot thread for the same CLI send id, even across CLI processes", async () => {
  const fixture = await launchVerificationServer();
  try {
    expect(new URL(fixture.info.url).port).not.toBe("8799");
    const created = await runControlOmb(["new-bot", "--name", "Idempotency fixture", "--url", fixture.info.url]) as { bot: { id: string } };
    const args = [created.bot.id, "Same request", "--task", "new", "--title", "Stable title", "--send-id", "new-thread-send-id-fixture"];
    const send = async (a: string[]) => JSON.parse((await exec(process.execPath, ["--experimental-strip-types", "server/openmausbot.ts", "send", ...a, "--url", fixture.info.url, "--json"], { timeout: 60_000 })).stdout);
    const [first, second] = await Promise.all([send(args), send(args)]);
    expect(second.taskId).toBe(first.taskId);
    expect(second.messageId).toBe(first.messageId);
    const fixed = await send(["--thread", first.taskId, "Same request", "--send-id", "new-thread-send-id-fixture"]);
    expect(fixed.taskId).toBe(first.taskId);
    expect(fixed.messageId).toBe(first.messageId);
    await expect(send([created.bot.id, "Different request", "--task", "new", "--title", "Stable title", "--send-id", "new-thread-send-id-fixture"])).rejects.toThrow();
    const fleet = await fetch(fixture.info.url + "/api/bots?messages=0").then(r => r.json()) as { bots: Array<{id: string; tasks: Array<{threadId: string}>}> };
    expect(fleet.bots.find(b => b.id === created.bot.id)?.tasks).toHaveLength(2);
  } finally {
    await fixture.close();
  }
}, 60_000);

it("replays the same new-conversation key after a real server restart", async () => {
  const first = await launchVerificationServer();
  let second: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  try {
    const port = Number(new URL(first.info.url).port);
    expect(port).not.toBe(8799);
    const created = await runControlOmb(["new-bot", "--name", "Restart fixture", "--url", first.info.url]) as { bot: { id: string } };
    const args = [created.bot.id, "Restart request", "--task", "new", "--title", "Restart title", "--send-id", "restart-thread-send-id-01"];
    const before = await sendTo(first.info.url, args);
    const threadsBefore = (await runControlOmb(["bots", "--url", first.info.url]) as { bots: Array<{ tasks: Array<{ threadId: string }> }> })
      .bots.find(b => b.id === created.bot.id)!.tasks.map(t => t.threadId);
    await first.close(false);
    second = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined,
      { dataDir: first.info.dataDir, port });
    const after = await sendTo(second.info.url, args);
    expect(second.info.dataDir).toBe(first.info.dataDir);
    expect(Number(new URL(second.info.url).port)).toBe(port);
    expect(after.taskId).toBe(before.taskId);
    expect(after.messageId).toBe(before.messageId);
    const threadsAfter = (await runControlOmb(["bots", "--url", second.info.url]) as { bots: Array<{ tasks: Array<{ threadId: string }> }> })
      .bots.find(b => b.id === created.bot.id)!.tasks.map(t => t.threadId);
    expect(threadsAfter).toEqual(threadsBefore);
  } finally {
    await second?.close();
    await removeTempDir(first.info.dataDir);
  }
}, 180_000);

it("reuses the newly created channel thread for the same channel send id", async () => {
  const fixture = await launchVerificationServer();
  try {
    expect(new URL(fixture.info.url).port).not.toBe("8799");
    const bot = await runControlOmb(["new-bot", "--name", "Room member fixture", "--url", fixture.info.url]) as { bot: { id: string } };
    const channel = await runControlOmb(["new-channel", "--name", "Idempotent room", "--members", bot.bot.id, "--url", fixture.info.url]) as { channel: { id: string } };
    const args = ["--channel", channel.channel.id, "Room request", "--task", "new", "--title", "Room title", "--send-id", "room-thread-send-id-01"];
    const [first, second] = await Promise.all([sendChannelTo(fixture.info.url, args), sendChannelTo(fixture.info.url, args)]);
    expect(second.taskId).toBe(first.taskId);
    expect(second.messageId).toBe(first.messageId);
    await expect(sendChannelTo(fixture.info.url,
      ["--channel", channel.channel.id, "Different room request", "--task", "new", "--title", "Room title", "--send-id", "room-thread-send-id-01"])).rejects.toThrow();
  } finally {
    await fixture.close();
  }
}, 120_000);

it("does not resurrect a deleted conversation when the creation key is replayed", async () => {
  const fixture = await launchVerificationServer();
  try {
    const created = await runControlOmb(["new-bot", "--name", "Tombstone fixture", "--url", fixture.info.url]) as { bot: { id: string } };
    const args = [created.bot.id, "Delete me", "--task", "new", "--title", "Tombstone title", "--send-id", "tombstone-thread-send-id-01"];
    const first = await sendTo(fixture.info.url, args);
    const count = async () => {
      const fleet = await fetch(fixture.info.url + "/api/bots?messages=0").then(r => r.json()) as { bots: Array<{ id: string; tasks: Array<{ threadId: string }> }> };
      return fleet.bots.find(b => b.id === created.bot.id)!.tasks.length;
    };
    const before = await count();
    const remove = async () => {
      const response = await fetch(`${fixture.info.url}/api/bots/${created.bot.id}/tasks/delete`, {
        method: "POST", headers: { "content-type": "application/json", origin: fixture.info.url },
        body: JSON.stringify({ threadIds: [first.taskId] }),
      });
      expect(response.ok).toBe(true);
      return response.json() as Promise<{ deleted: string[]; refused: Array<{ threadId: string; reason: string }> }>;
    };
    let result = await remove();
    if (result.refused.some(r => r.reason === "busy")) {
      await runControlOmb(["wait", "--bot", created.bot.id, "--task", first.taskId, "--timeout", "30", "--url", fixture.info.url]);
      result = await remove();
    }
    expect(result.deleted).toContain(first.taskId);
    expect(result.refused).toHaveLength(0);
    expect(await count()).toBe(before - 1);
    await expect(sendTo(fixture.info.url, args)).rejects.toThrow();
    expect(await count()).toBe(before - 1);
  } finally {
    await fixture.close();
  }
}, 120_000);

it("refuses a second server that reuses the same data directory", async () => {
  const first = await launchVerificationServer();
  try {
    const otherPort = await freePortBlock([0, 1]);
    expect(otherPort).not.toBe(8799);
    await expect(launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined,
      { dataDir: first.info.dataDir, port: otherPort })).rejects.toThrow(/verification server|did not become ready|exited/i);
    const health = await fetch(first.info.url + "/api/health");
    expect(health.status).toBe(200);
  } finally {
    await first.close();
  }
}, 180_000);
