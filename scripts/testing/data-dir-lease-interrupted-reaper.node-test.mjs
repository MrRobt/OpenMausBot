import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { acquireDataDirLease } from "../../electron/data-dir-lease.mjs";

const moduleUrl = new URL("../../electron/data-dir-lease.mjs", import.meta.url).href;
const run = (source) => promisify(execFile)(process.execPath, ["--input-type=module", "--eval", source], { timeout: 60000 });

test("an interrupted live reaper blocks contenders, then exactly one successor wins after its death", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-interrupted-reaper-"));
  const path = join(dir, "openmausbot-server.lease");
  let reaper;
  let reaperClosed;
  try {
    await run(`
      const { acquireDataDirLease } = await import(${JSON.stringify(moduleUrl)});
      acquireDataDirLease(${JSON.stringify(dir)});
      process.exit(0);
    `);
    const stale = readFileSync(path, "utf8");
    reaper = spawn(process.execPath, ["--input-type=module", "--eval", `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const original = fs.unlinkSync;
      fs.unlinkSync = (name) => {
        if (name === ${JSON.stringify(path)}) {
          fs.writeSync(1, "reaper-ready\\n");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
          throw new Error("fixture did not interrupt recovery");
        }
        return original(name);
      };
      syncBuiltinESMExports();
      const { acquireDataDirLease } = await import(${JSON.stringify(moduleUrl)});
      acquireDataDirLease(${JSON.stringify(dir)});
    `], { stdio: ["ignore", "pipe", "pipe"] });
    reaperClosed = once(reaper, "close");
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("reaper readiness timeout")), 30000);
      reaper.once("error", error => { clearTimeout(timer); reject(error); });
      reaper.once("exit", () => { clearTimeout(timer); reject(new Error("reaper exited early")); });
      reaper.stdout.once("data", chunk => { clearTimeout(timer); resolve(String(chunk)); });
    });
    assert.match(ready, /reaper-ready/);
    assert.equal(readFileSync(path, "utf8"), stale);
    assert.equal(readdirSync(dir).filter(name => name.includes(".reap-") && !name.includes(".candidate-")).length, 1);
    assert.throws(() => acquireDataDirLease(dir), /already being recovered/);
    assert.equal(readFileSync(path, "utf8"), stale);
    assert.equal(reaper.kill("SIGKILL"), true);
    await reaperClosed;

    const racers = await Promise.all(Array.from({ length: 4 }, (_, i) => run(`
      import { existsSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const { acquireDataDirLease } = await import(${JSON.stringify(moduleUrl)});
      const dir = ${JSON.stringify(dir)};
      const deadline = Date.now() + 30000;
      const mark = (stage) => writeFileSync(join(dir, "racer-${i}-" + stage), "");
      const barrier = async (stage) => {
        while (!Array.from({ length: 4 }, (_, j) => existsSync(join(dir, "racer-" + j + "-" + stage))).every(Boolean)) {
          if (Date.now() > deadline) throw new Error("barrier timeout: " + stage);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      };
      mark("ready");
      await barrier("ready");
      let lease;
      let result;
      try {
        lease = acquireDataDirLease(dir);
        result = { acquired: true };
      } catch (error) {
        result = { acquired: false, message: String(error.message) };
      }
      mark("attempted");
      try {
        await barrier("attempted");
        if (lease) result.released = lease.release();
        console.log(JSON.stringify(result));
      } finally {
        lease?.release();
      }
    `)));
    const results = racers.map(({ stdout }) => JSON.parse(stdout));
    const winners = results.filter(r => r.acquired);
    assert.equal(winners.length, 1);
    assert.equal(winners[0].released, true);
    for (const result of results.filter(r => !r.acquired)) {
      assert.match(result.message, /already using this data directory|already being recovered/i);
    }
    const final = acquireDataDirLease(dir);
    assert.equal(final.release(), true);
    console.log(JSON.stringify({ liveReaperBlocked: true, racers: 4, winners: winners.length, reacquired: true }));
  } finally {
    if (reaper && reaper.exitCode === null && reaper.signalCode === null) reaper.kill("SIGKILL");
    if (reaperClosed) await reaperClosed;
    rmSync(dir, { recursive: true, force: true });
  }
});
