import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as atomic from "./atomic.ts";
import { newThreadRequest, TaskCreateReceipts } from "./task-create-receipts.ts";

// Captured before any spy replaces the namespace property: fault-injection tests
// need a way to let selected writes through to the real atomic implementation.
const realWriteFileAtomic = atomic.writeFileAtomic;

const request = newThreadRequest({ title: "Stable", createId: "new-conversation-fixture-id", messageFingerprint: "a".repeat(64) })!;
describe("durable new-conversation creation receipts (wired into bot and channel task routes)", () => {
  let dir: string;
  const tasks = new Map<string, { threadId: string }>();
  const lookup = (id: string) => tasks.get(id);
  const create = vi.fn((threadId: string) => { const task = { threadId }; tasks.set(threadId, task); return task; });
  const authorize = vi.fn();
  const scope = ["bot", "target-a", "session-a"];
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-create-receipts-")); tasks.clear(); create.mockClear(); authorize.mockClear(); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
  it("replays the stored task after reconstructing the receipt registry", () => {
    const first = new TaskCreateReceipts(dir).run(scope, request, lookup, create, authorize);
    const second = new TaskCreateReceipts(dir).run(scope, request, lookup, create, authorize);
    expect(first.replayed).toBe(false);
    expect(second).toEqual({ task: first.task, replayed: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(first.task.threadId);
  });
  it("resumes a reservation left before task creation", () => {
    const interrupted = vi.fn((_id: string) => { throw new Error("synthetic interrupted create"); });
    expect(() => new TaskCreateReceipts(dir).run(scope, request, lookup, interrupted, authorize)).toThrow("synthetic interrupted create");
    const reserved = interrupted.mock.calls[0]![0];
    expect(new TaskCreateReceipts(dir).run(scope, request, lookup, create, authorize).task.threadId).toBe(reserved);
  });
  it("replays a task committed before the receipt was completed", () => {
    const interrupted = (id: string) => { create(id); throw new Error("synthetic response loss"); };
    expect(() => new TaskCreateReceipts(dir).run(scope, request, lookup, interrupted, authorize)).toThrow("synthetic response loss");
    expect(new TaskCreateReceipts(dir).run(scope, request, lookup, create, authorize).replayed).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("refuses a different fingerprint, access denial, or a deleted task without creating another", () => {
    const receipts = new TaskCreateReceipts(dir);
    const first = receipts.run(scope, request, lookup, create, authorize);
    expect(() => receipts.run(scope, { ...request, fingerprint: "b".repeat(64) }, lookup, create, authorize)).toThrow(/another new conversation/);
    expect(() => receipts.run(scope, request, lookup, create, () => { throw new Error("denied"); })).toThrow("denied");
    tasks.delete(first.task.threadId);
    expect(() => receipts.run(scope, request, lookup, create, authorize)).toThrow(/no longer exists/);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("keeps target and authenticated session namespaces separate", () => {
    const receipts = new TaskCreateReceipts(dir);
    const ids = [scope, ["bot", "target-b", "session-a"], ["bot", "target-a", "session-b"], ["channel", "target-a", "session-a"]].map(key =>
      receipts.run(key, request, lookup, create, authorize).task.threadId);
    expect(new Set(ids).size).toBe(4);
  });
  it("fails closed if a durable receipt is damaged", () => {
    const receipts = new TaskCreateReceipts(dir);
    receipts.run(scope, request, lookup, create, authorize);
    writeFileSync(join(dir, readdirSync(dir)[0]!), "{}");
    expect(() => receipts.run(scope, request, lookup, create, authorize)).toThrow(/Invalid stored/);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("rejects keyed requests with malformed identity, fingerprint, or privilege-changing fields", () => {
    expect(newThreadRequest({ title: "Legacy" })).toBeUndefined();
    expect(() => newThreadRequest({ createId: "short", messageFingerprint: "a".repeat(64) })).toThrow();
    expect(() => newThreadRequest({ createId: request.createId, messageFingerprint: "bad" })).toThrow();
    expect(() => newThreadRequest({ createId: request.createId, messageFingerprint: "a".repeat(64), approvalMode: "full" })).toThrow();
  });

  // I10 (V2 §3.5): storage faults must fail closed with a stable error code and never
  // fall back to an unkeyed create. A truncated/unparseable receipt is a storage fault.
  it("fails closed with a stable 409 when a stored receipt is unparseable", () => {
    const receipts = new TaskCreateReceipts(dir);
    receipts.run(scope, request, lookup, create, authorize);
    writeFileSync(join(dir, readdirSync(dir)[0]!), '{"threadId":"truncated"');
    let status: number | undefined;
    try {
      receipts.run(scope, request, lookup, create, authorize);
    } catch (error) {
      status = (error as { status?: number }).status;
    }
    expect(status).toBe(409);
    expect(create).toHaveBeenCalledTimes(1);
  });

  // A crashed atomic write leaves a *.tmp sibling; the reservation is keyed by the
  // exact digest.json name, so leftovers must not affect replay or create a second task.
  it("ignores orphaned atomic-write temp files and still replays", () => {
    const receipts = new TaskCreateReceipts(dir);
    const first = receipts.run(scope, request, lookup, create, authorize);
    const receiptName = readdirSync(dir).find(name => name.endsWith(".json"))!;
    writeFileSync(join(dir, `${receiptName}.4242.deadbeef.tmp`), "partial");
    writeFileSync(join(dir, "orphan.9999.cafe.tmp"), "{}");
    const second = receipts.run(scope, request, lookup, create, authorize);
    expect(second.task.threadId).toBe(first.task.threadId);
    expect(second.replayed).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  // If the receipt directory cannot even be prepared, no task may be created: falling
  // back to an unkeyed create here would defeat idempotency exactly when storage is unwell.
  it("fails closed without creating when the receipt directory cannot be prepared", () => {
    const blocker = join(dir, "occupied-file");
    writeFileSync(blocker, "occupied");
    const receipts = new TaskCreateReceipts(join(blocker, "receipts"));
    expect(() => receipts.run(scope, request, lookup, create, authorize)).toThrow();
    expect(create).toHaveBeenCalledTimes(0);
  });

  // I07 (V2 §3.5): the idempotency key is the creation key, never the title. A
  // same-title request with a different key must not collide, deleting one task must
  // not leak into another, and a fresh key can rebuild while the old key stays a tombstone.
  it("keeps distinct creation keys separate and lets a fresh key rebuild after deletion", () => {
    const receipts = new TaskCreateReceipts(dir);
    const secondRequest = newThreadRequest({ title: "Stable", createId: "new-conversation-fixture-id-2", messageFingerprint: "a".repeat(64) })!;
    const first = receipts.run(scope, request, lookup, create, authorize);
    const second = receipts.run(scope, secondRequest, lookup, create, authorize);
    expect(second.task.threadId).not.toBe(first.task.threadId);
    expect(tasks.size).toBe(2);

    tasks.delete(second.task.threadId);
    expect(() => receipts.run(scope, secondRequest, lookup, create, authorize)).toThrow(/no longer exists/);
    const thirdRequest = newThreadRequest({ title: "Stable", createId: "new-conversation-fixture-id-3", messageFingerprint: "a".repeat(64) })!;
    const rebuilt = receipts.run(scope, thirdRequest, lookup, create, authorize);
    expect(rebuilt.replayed).toBe(false);
    expect(rebuilt.task.threadId).not.toBe(first.task.threadId);
    expect(rebuilt.task.threadId).not.toBe(second.task.threadId);
    expect(tasks.size).toBe(2);
  });

  // I07: an unfinished (pre-commit) receipt whose task vanished is a resumable
  // reservation, NOT a tombstone. Only a committed receipt for a missing task is one.
  it("resumes an unfinished reservation whose task is missing instead of treating it as deleted", () => {
    const receipts = new TaskCreateReceipts(dir);
    receipts.run(scope, request, lookup, create, authorize);
    const receiptFile = join(dir, readdirSync(dir).find(name => name.endsWith(".json"))!);
    const reservedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    // Simulate a backup/restore that rolls the committed receipt back to its pre-commit form.
    tasks.clear();
    writeFileSync(receiptFile, JSON.stringify({ threadId: reservedId, fingerprint: request.fingerprint, created: false }));
    const resumed = receipts.run(scope, request, lookup, create, authorize);
    expect(resumed.task.threadId).toBe(reservedId);
    expect(resumed.replayed).toBe(false);
    expect(tasks.size).toBe(1);
  });

  // I07: a cancelled/interrupted create must resume exactly once. No duplicate task,
  // no resurrection, and a later replay must not call create again.
  it("replays an interrupted creation exactly once without spawning an extra task", () => {
    const receipts = new TaskCreateReceipts(dir);
    const interrupted = vi.fn((_id: string) => { throw new Error("cancelled"); });
    expect(() => receipts.run(scope, request, lookup, interrupted, authorize)).toThrow("cancelled");
    expect(tasks.size).toBe(0);
    const reserved = interrupted.mock.calls[0]![0];
    const resumed = receipts.run(scope, request, lookup, create, authorize);
    expect(resumed.task.threadId).toBe(reserved);
    expect(resumed.replayed).toBe(false);
    expect(tasks.size).toBe(1);
    const replay = receipts.run(scope, request, lookup, create, authorize);
    expect(replay.replayed).toBe(true);
    expect(tasks.size).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  // I10 (V2 §3.5): a failed reservation write is a real IO fault. It must surface the
  // native, code-bearing error (stable for callers to map) and must NEVER fall back to
  // an unkeyed create, which would defeat idempotency exactly when storage is unwell.
  it("fails closed with the native storage error when the reservation write fails", () => {
    const fault = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    vi.spyOn(atomic, "writeFileAtomic").mockImplementation(() => { throw fault; });
    const receipts = new TaskCreateReceipts(dir);
    let caught: unknown;
    try { receipts.run(scope, request, lookup, create, authorize); } catch (error) { caught = error; }
    expect(caught).toBe(fault);
    expect((caught as { code?: string }).code).toBe("ENOSPC");
    expect(create).toHaveBeenCalledTimes(0);
    expect(tasks.size).toBe(0);
    expect(readdirSync(dir).some(name => name.endsWith(".json"))).toBe(false);
  });

  // I10: if committing the created flag fails after the task already exists, the next
  // replay must converge safely (authorize + repair the flag) without a second create.
  it("recovers safely when committing the created flag fails after the task exists", () => {
    const fault = Object.assign(new Error("EIO: commit failed"), { code: "EIO" });
    let writes = 0;
    const spy = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((file, data, options) => {
      writes += 1;
      if (writes === 2) throw fault;
      return realWriteFileAtomic(file, data, options);
    });
    const receipts = new TaskCreateReceipts(dir);
    expect(() => receipts.run(scope, request, lookup, create, authorize)).toThrow(fault);
    expect(tasks.size).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    spy.mockRestore();

    const replay = receipts.run(scope, request, lookup, create, authorize);
    expect(replay.replayed).toBe(true);
    expect(replay.task.threadId).toBe([...tasks.keys()][0]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(tasks.size).toBe(1);
    const receiptFile = join(dir, readdirSync(dir).find(name => name.endsWith(".json"))!);
    expect(JSON.parse(readFileSync(receiptFile, "utf8")).created).toBe(true);
  });

  // I10: restoring an older pre-commit backup while the task still exists must converge
  // into a replay and repair the flag, rather than creating a duplicate conversation.
  it("fails closed when sealing an existing thread before deletion fails", () => {
    const receipts = new TaskCreateReceipts(dir);
    const first = receipts.run(scope, request, lookup, create, authorize);
    const file = join(dir, readdirSync(dir).find(name => name.endsWith(".json"))!);
    writeFileSync(file, JSON.stringify({ threadId: first.task.threadId, fingerprint: request.fingerprint, created: false }));
    const fault = Object.assign(new Error("EIO: seal failed"), { code: "EIO" });
    const spy = vi.spyOn(atomic, "writeFileAtomic").mockImplementation(() => { throw fault; });
    expect(() => receipts.sealExistingThreads([first.task.threadId])).toThrow(fault);
    expect(JSON.parse(readFileSync(file, "utf8")).created).toBe(false);
    expect(lookup(first.task.threadId)).toBe(first.task);
    spy.mockRestore();
    receipts.sealExistingThreads([first.task.threadId]);
    expect(JSON.parse(readFileSync(file, "utf8")).created).toBe(true);
    tasks.delete(first.task.threadId);
    expect(() => receipts.run(scope, request, lookup, create, authorize)).toThrow(/no longer exists/);
  });

  it("does not seal unrelated unfinished reservations", () => {
    const receipts = new TaskCreateReceipts(dir);
    const interrupted = vi.fn((_id: string) => { throw new Error("interrupted"); });
    expect(() => receipts.run(scope, request, lookup, interrupted, authorize)).toThrow("interrupted");
    receipts.sealExistingThreads(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
    expect(receipts.run(scope, request, lookup, create, authorize).task.threadId).toBe(interrupted.mock.calls[0]![0]);
  });

  it("converges a restored pre-commit backup into a replay without duplicating the task", () => {
    const receipts = new TaskCreateReceipts(dir);
    const first = receipts.run(scope, request, lookup, create, authorize);
    const receiptFile = join(dir, readdirSync(dir).find(name => name.endsWith(".json"))!);
    writeFileSync(receiptFile, JSON.stringify({ threadId: first.task.threadId, fingerprint: request.fingerprint, created: false }));
    const replay = receipts.run(scope, request, lookup, create, authorize);
    expect(replay.replayed).toBe(true);
    expect(replay.task.threadId).toBe(first.task.threadId);
    expect(create).toHaveBeenCalledTimes(1);
    expect(tasks.size).toBe(1);
    expect(JSON.parse(readFileSync(receiptFile, "utf8")).created).toBe(true);
  });
});
