import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLoopback } from "./server.ts";

// Access control: with CORE_AUTH_TOKEN set, every endpoint but /health
// needs the bearer; without a token the core only listens on loopback.

type Json = Record<string, unknown>;

async function waitHealth(base: string): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function spawnCore(dir: string, port: number, extra: NodeJS.ProcessEnv): ChildProcess {
  return spawn("node", ["./server.ts"], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      BINDINGS_PATH: "./bindings.example.json",
      LEDGER_PATH: join(dir, "ledger.jsonl"),
      HUB_ORIGIN: "http://localhost:5173",
      TRANSLATE_API_KEY: "",
      RELAY_PATH: "",
      HOST: "127.0.0.1",
      CORE_AUTH_TOKEN: "",
      ...extra,
    },
  });
}

describe("core auth", () => {
  const PORT = 8795;
  const BASE = `http://127.0.0.1:${PORT}`;
  const TOKEN = "test-token-abc";
  let dir = "";
  let srv: ChildProcess | null = null;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "auth-"));
    srv = spawnCore(dir, PORT, { CORE_AUTH_TOKEN: TOKEN });
    assert.ok(await waitHealth(BASE), "server never ready");
  });

  after(async () => {
    srv?.kill();
    await rm(dir, { recursive: true, force: true });
  });

  async function post(path: string, body: unknown, token?: string): Promise<{ status: number; json: Json }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    const r = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Json };
  }

  it("/health stays open and reports that auth is on", async () => {
    const r = await fetch(`${BASE}/health`);
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as Json).auth, true);
  });

  it("rejects state endpoints without or with a wrong bearer", async () => {
    const ingress = { origin: "hub", nativeId: "auth-1", lang: "ko", body: "hi" };
    assert.equal((await post("/ingress", ingress)).status, 401);
    assert.equal((await post("/ingress", ingress, "wrong")).status, 401);
    assert.equal((await post("/confirm", { id: "x" })).status, 401);
    assert.equal((await fetch(`${BASE}/ledger`)).status, 401);
    assert.equal((await fetch(`${BASE}/outbox?channel=discord&since=0`)).status, 401);
    assert.equal((await fetch(`${BASE}/bindings`)).status, 401);
    // Nothing reached the ledger.
    const led = await fetch(`${BASE}/ledger`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.deepEqual(await led.json(), []);
  });

  it("accepts the right bearer", async () => {
    const r = await post("/ingress", { origin: "hub", nativeId: "auth-2", lang: "ko", body: "hi" }, TOKEN);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.targets));
    const led = await fetch(`${BASE}/ledger`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(led.status, 200);
  });

  it("rejects oversized bodies before parsing", async () => {
    const r = await post("/ingress", { origin: "hub", nativeId: "big", lang: "ko", body: "x".repeat(70 * 1024) }, TOKEN);
    assert.equal(r.status, 413);
  });
});

describe("core bind policy", () => {
  it("loopback detection", () => {
    assert.equal(isLoopback("127.0.0.1"), true);
    assert.equal(isLoopback("::1"), true);
    assert.equal(isLoopback("0.0.0.0"), false);
    assert.equal(isLoopback("192.168.0.37"), false);
  });

  it("refuses a non-loopback host without a token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bind-"));
    const child = spawnCore(dir, 8796, { HOST: "0.0.0.0", CORE_AUTH_TOKEN: "" });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    await rm(dir, { recursive: true, force: true });
    assert.notEqual(code, 0);
    assert.match(stderr, /CORE_AUTH_TOKEN/);
  });
});
