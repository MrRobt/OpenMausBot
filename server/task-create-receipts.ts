// New-thread sends are two HTTP operations. Reserve the conversation before creating it,
// so a lost create response or a process restart cannot allocate another conversation.
// The server's data-directory lease ensures only one server writes these synchronous receipts.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { RequestAuth } from "./request-auth.ts";
import { parseSendId } from "./send-idempotency.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hex = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const refusal = (message: string, status: number): never => { throw Object.assign(new Error(message), { status }); };
type Receipt = { threadId: string; fingerprint: string; created: boolean };

/** Only the ordinary CLI new-thread creation is keyed. It cannot change folders, approval mode, or other settings. */
export function newThreadRequest(body: Record<string, unknown>): { createId: string; fingerprint: string } | undefined {
  if (body.createId === undefined && body.messageFingerprint === undefined) return;
  const createId = parseSendId(body.createId as string);
  if (!createId || typeof body.messageFingerprint !== "string" || !hex.test(body.messageFingerprint) ||
      Object.keys(body).some(key => !["title", "createId", "messageFingerprint"].includes(key)) ||
      (body.title !== undefined && typeof body.title !== "string")) {
    return refusal("Invalid keyed new conversation request", 400);
  }
  return { createId, fingerprint: digest([body.title ?? null, body.messageFingerprint]) };
}

export function createReceiptActor(auth: RequestAuth): string {
  // Never share a replay receipt between distinct authenticated sessions or trust levels.
  return auth.kind === "session" ? "session:" + auth.session.id :
    auth.companionDevice ? "companion:" + auth.companionDevice :
    auth.trust === "service" ? "loopback:service" : "loopback:owner";
}

export class TaskCreateReceipts {
  private readonly dir: string;
  private readonly reservedHere = new Map<string, string>();
  constructor(dir = join(DATA_DIR, "task-create-receipts")) { this.dir = dir; }

  private rememberReservation(threadId: string, file: string): void {
    this.reservedHere.set(threadId, file);
    if (this.reservedHere.size > 4096) this.reservedHere.delete(this.reservedHere.keys().next().value!);
  }

  /** Seal reservations of existing threads before deletion; a failed seal must prevent deletion. */
  sealExistingThreads(threadIds: readonly string[]): void {
    if (!threadIds.length) return;
    const ids = new Set(threadIds);
    // A reservation allocated by this leased process has a known receipt path.
    // Re-read it before sealing; never treat the cache as a durable receipt.
    for (const id of ids) {
      const file = this.reservedHere.get(id);
      if (!file) continue;
      // A cached path is only a hint; the disk is the single source of truth.
      // A deleted/unreadable cached file, malformed JSON, or a shape mismatch
      // drops the stale entry and falls back to the authoritative full scan,
      // exactly like a cache miss. The scan revalidates every on-disk receipt,
      // so damaged receipts still fail closed with 409 and genuine IO faults are
      // still rethrown as native errors: no fail-closed / 409 invariant changes.
      let receipt: Receipt | undefined;
      try {
        receipt = JSON.parse(readFileSync(file, "utf8")) as Receipt;
      } catch {
        receipt = undefined;
      }
      if (!receipt || typeof receipt.threadId !== "string" || !uuid.test(receipt.threadId) ||
          typeof receipt.fingerprint !== "string" || !hex.test(receipt.fingerprint) || typeof receipt.created !== "boolean") {
        this.reservedHere.delete(id);
        continue;
      }
      if (receipt.threadId !== id) {
        this.reservedHere.delete(id);
        continue;
      }
      if (!receipt.created) writeFileAtomic(file, JSON.stringify({ ...receipt, created: true }), { mode: 0o600 });
      ids.delete(id);
    }
    if (!ids.size) return;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const candidates = new Map<string, string | null>();
    const pending: Array<{ file: string; receipt: Receipt }> = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = join(this.dir, name);
      const raw = readFileSync(file, "utf8");
      let receipt: Receipt;
      try {
        receipt = JSON.parse(raw) as Receipt;
      } catch {
        return refusal("Invalid stored conversation creation receipt", 409);
      }
      if (!receipt || typeof receipt.threadId !== "string" || !uuid.test(receipt.threadId) ||
          typeof receipt.fingerprint !== "string" || !hex.test(receipt.fingerprint) || typeof receipt.created !== "boolean") {
        return refusal("Invalid stored conversation creation receipt", 409);
      }
      const id = receipt.threadId;
      if (candidates.has(id)) candidates.set(id, null);
      else if (candidates.size < 4096) candidates.set(id, file);
      if (ids.has(id) && !receipt.created) pending.push({ file, receipt });
    }
    // An unreadable mapping could belong to any unresolved target. Validate the
    // entire scan before sealing its reservations or publishing cached paths.
    for (const { file, receipt } of pending) {
      writeFileAtomic(file, JSON.stringify({ ...receipt, created: true }), { mode: 0o600 });
    }
    for (const [id, file] of candidates) {
      if (file === null) this.reservedHere.delete(id);
      else this.rememberReservation(id, file);
    }
  }

  run<T extends { threadId: string }>(
    scope: readonly string[], request: { createId: string; fingerprint: string },
    lookup: (id: string) => T | null | undefined,
    create: (id: string) => T | null,
    authorize: (id: string) => void,
  ): { task: T; replayed: boolean } {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, digest([...scope, request.createId]) + ".json");
    let receipt: Receipt;
    let raw: string | undefined;
    // A read failure other than "missing" is a genuine storage fault: fail closed by
    // rethrowing (EACCES/ENOSPC stay distinguishable) rather than risking an unkeyed create.
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (raw === undefined) {
      receipt = { threadId: randomUUID(), fingerprint: request.fingerprint, created: false };
      writeFileAtomic(file, JSON.stringify(receipt), { mode: 0o600 });
      this.rememberReservation(receipt.threadId, file);
    } else {
      // Parsing and shape checks are also storage faults, but must surface a stable
      // status so callers can map them consistently instead of leaking a SyntaxError.
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return refusal("Invalid stored conversation creation receipt", 409);
      }
      receipt = parsed as Receipt;
      if (!receipt || typeof receipt.threadId !== "string" || !uuid.test(receipt.threadId) ||
          typeof receipt.fingerprint !== "string" || !hex.test(receipt.fingerprint) || typeof receipt.created !== "boolean") {
        return refusal("Invalid stored conversation creation receipt", 409);
      }
    }
    if (receipt.fingerprint !== request.fingerprint) return refusal("sendId already belongs to another new conversation request", 409);
    const found = lookup(receipt.threadId);
    if (found) {
      authorize(found.threadId);
      if (!receipt.created) writeFileAtomic(file, JSON.stringify({ ...receipt, created: true }), { mode: 0o600 });
      return { task: found, replayed: true };
    }
    // A receipt for a deleted task is a tombstone, not permission to resurrect it.
    if (receipt.created) return refusal("The conversation for this sendId no longer exists", 409);
    const task = create(receipt.threadId);
    if (!task || task.threadId !== receipt.threadId) return refusal("Could not create the reserved conversation", 500);
    writeFileAtomic(file, JSON.stringify({ ...receipt, created: true }), { mode: 0o600 });
    return { task, replayed: false };
  }
}
