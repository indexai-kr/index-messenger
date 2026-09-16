import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Trust boundary + idempotency + consumption receipts, against a real
// server on an isolated ledger (production ledger untouched).
describe("cowork trust boundary", () => {
  const PORT = 8792;
  const CORE = `http://localhost:${PORT}`;
  let dir = "";
  let srv: ChildProcess | null = null;

  async function waitHealth(): Promise<void> {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`${CORE}/health`);
        if (r.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("test server never ready");
  }

  async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${CORE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  }

  async function ledger(): Promise<Array<Record<string, unknown>>> {
    const raw = await readFile(join(dir, "ledger.jsonl"), "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ingress-"));
    srv = spawn("node", ["./server.ts"], {
      cwd: process.cwd(),
      stdio: "ignore",
      env: {
        ...process.env,
        PORT: String(PORT),
        BINDINGS_PATH: "./bindings.example.json",
        LEDGER_PATH: join(dir, "ledger.jsonl"),
        HUB_ORIGIN: "http://localhost:5173",
      },
    });
    await waitHealth();
  });

  after(async () => {
    srv?.kill();
    await rm(dir, { recursive: true, force: true });
  });

  it("strips client trust fields, tags origin=cowork, logs the strip", async () => {
    const r = await post("/cowork/ingress", {
      nativeId: "cw-strip-1",
      lang: "ko",
      body: "hello",
      origin: "telegram",
      verdict: "delivered",
      approved: true,
    });
    assert.equal(r.status, 200);
    const routed = r.json as { origin?: string; stripped?: string[] };
    assert.equal(routed.origin, "cowork");
    assert.ok(routed.stripped?.includes("origin"));
    assert.ok(routed.stripped?.includes("verdict"));
    assert.ok(routed.stripped?.includes("approved"));
    const lines = await ledger();
    const strip = lines.find((e) => e.verdict === "stripped");
    assert.ok(strip);
    assert.equal(strip?.channel, "cowork");
    assert.match(String(strip?.body), /origin/);
  });

  it("executes a retried id once and logs the duplicate receipt", async () => {
    const first = await post("/ingress", {
      origin: "hub",
      nativeId: "idem-retry-1",
      lang: "ko",
      body: "ping",
    });
    assert.ok(Array.isArray(first.json.targets));
    // Network timeout retry: same id again.
    const second = await post("/ingress", {
      origin: "hub",
      nativeId: "idem-retry-1",
      lang: "ko",
      body: "ping",
    });
    assert.equal(second.json.duplicate, true);
    const lines = await ledger();
    const fresh = lines.filter((e) => e.messageId === "hub:idem-retry-1" && e.verdict === undefined);
    const dups = lines.filter((e) => e.messageId === "hub:idem-retry-1" && e.verdict === "duplicate");
    assert.equal(fresh.length, 1);
    assert.equal(dups.length, 1);
    const outs = lines.filter(
      (e) => typeof e.messageId === "string" && (e.messageId as string).startsWith("hub:idem-retry-1->"),
    );
    assert.equal(outs.length, (first.json.targets as unknown[]).length);
  });

  it("keeps seen (consumed) apart from delivered (sent)", async () => {
    const s = await post("/outbox/seen", { messageId: "k:seen-1", channel: "kakao", consumer: "cowork-desk" });
    assert.equal(s.json.seen, true);
    const lines = await ledger();
    const states = lines.filter((e) => e.messageId === "k:seen-1").map((e) => e.verdict);
    assert.deepEqual(states, ["seen"]);
    assert.ok(!states.includes("delivered"));
  });

  it("never serves ack lines back as send items (outbox echo repro)", async () => {
    const since = Date.now();
    const first = await post("/ingress", {
      origin: "hub",
      nativeId: "echo-guard-1",
      lang: "ko",
      body: "hi",
    });
    assert.ok(Array.isArray(first.json.targets));
    const get = async (since: number): Promise<{ items: Array<{ messageId: string }> }> => {
      const r = await fetch(`${CORE}/outbox?channel=telegram&since=${since}`);
      return (await r.json()) as { items: Array<{ messageId: string }> };
    };
    const before = await get(since);
    const item = before.items.find((i) => i.messageId === "hub:echo-guard-1->telegram");
    assert.ok(item, "fresh send item must be listed");
    // A read receipt does not decide the send: still served.
    await post("/outbox/seen", { messageId: item.messageId, channel: "telegram", consumer: "t" });
    assert.deepEqual((await get(since)).items.map((i) => i.messageId), [item.messageId], "seen is not a result");
    // Deliver it: the send is decided and disappears from the queue, and
    // the ack line itself is never served as a send item.
    await post("/outbox/ack", { messageId: item.messageId, channel: "telegram", ok: true });
    const after = await get(since);
    assert.deepEqual(after.items, [], "delivered send is folded out of the queue");
    const fromZero = await get(0);
    assert.ok(!fromZero.items.some((i) => i.messageId === item.messageId), "folded regardless of cursor");
  });
});
