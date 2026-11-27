import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../control-omb.ts";
import { removeTempDir } from "../../server/testing/cleanup.ts";

it("reclaims the crashed fixture lease and replays the same creation and message", async () => {
  const first = await launchVerificationServer();
  let second: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  try {
    const port = Number(new URL(first.info.url).port);
    expect(port).not.toBe(8799);
    const leasePath = join(first.info.dataDir, "openmausbot-server.lease");
    const owner = () => (JSON.parse(readFileSync(leasePath, "utf8")) as { pid: number }).pid;
    expect(owner()).toBe(first.info.pid);
    const created = await runControlOmb(["new-bot", "--name", "Crash receipt fixture", "--url", first.info.url]) as { bot: { id: string } };
    const send = async (url: string) => await runControlOmb([
      "send", created.bot.id, "Crash replay request", "--task", "new", "--title", "Crash replay",
      "--send-id", "crash-replay-fixture-01", "--url", url,
    ]) as { taskId: string; messageId: string };
    const before = await send(first.info.url);
    expect(before.taskId).toBeTruthy();
    expect(before.messageId).toBeTruthy();
    await runControlOmb(["wait", "--bot", created.bot.id, "--task", before.taskId, "--timeout", "30", "--url", first.info.url]);
    const exited = once(first.child, "exit");
    expect(first.child.kill("SIGKILL")).toBe(true);
    const [, signal] = await exited;
    expect(signal).toBe("SIGKILL");
    expect(owner()).toBe(first.info.pid);
    second = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined,
      { dataDir: first.info.dataDir, port });
    expect(owner()).toBe(second.info.pid);
    const after = await send(second.info.url);
    expect(after.taskId).toBe(before.taskId);
    expect(after.messageId).toBe(before.messageId);
    const fleet = await fetch(second.info.url + "/api/bots?messages=0").then(r => r.json()) as { bots: Array<{ id: string; tasks: Array<{ threadId: string }> }> };
    expect(fleet.bots.find(b => b.id === created.bot.id)?.tasks).toHaveLength(2);
  } finally {
    await second?.close();
    await first.close(false);
    await removeTempDir(first.info.dataDir);
  }
}, 180_000);
