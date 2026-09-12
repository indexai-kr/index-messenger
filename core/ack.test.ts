import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Verdict separation: rehearsals must never share the delivered state.
// Spins a real server against an isolated ledger (production ledger untouched).
describe("outbox ack verdicts", () => {
  const PORT = 8791;
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

  async function ack(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${CORE}/outbox/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  }

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ack-"));
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

  it("records delivered, failed and dry-run as three distinct verdicts", async () => {
    const d = await ack({ messageId: "k:1", channel: "kakao", ok: true });
    const f = await ack({ messageId: "k:2", channel: "kakao", ok: false, error: "no-notification-for-room" });
    const r = await ack({ messageId: "k:3", channel: "kakao", ok: true, mode: "dry-run" });
    assert.equal(d.json.verdict, "delivered");
    assert.equal(f.json.verdict, "failed");
    assert.equal(r.json.verdict, "dry-run");
    assert.notEqual(r.json.verdict, d.json.verdict);
  });

  it("rejects ack without identity", async () => {
    const bad = await ack({ channel: "kakao" });
    assert.equal(bad.status, 400);
  });
});
