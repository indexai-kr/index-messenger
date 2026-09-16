import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Ingress durability against a scripted OpenAI-compatible translator:
// the original is persisted before translation, a provider failure
// leaves the id retryable (not "duplicate"), a concurrent duplicate is
// told "processing", and the retryable state survives a restart.
const BINDINGS = { hub: "ko", discord: "en" };
type Json = Record<string, unknown>;

interface Fake {
  server: Server;
  url: string;
  calls: number;
  failNext: number;
  delayMs: number;
}

async function startFakeTranslator(port: number): Promise<Fake> {
  const fake: Fake = { server: createServer(), url: `http://127.0.0.1:${port}/v1`, calls: 0, failNext: 0, delayMs: 0 };
  fake.server.on("request", async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    fake.calls += 1;
    if (fake.delayMs > 0) await new Promise((r) => setTimeout(r, fake.delayMs));
    if (fake.failNext > 0) {
      fake.failNext -= 1;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "overloaded" }));
      return;
    }
    const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
    const system = body.messages[0]?.content ?? "";
    const to = /to (\w+)\./.exec(system)?.[1] ?? "?";
    const text = body.messages[1]?.content ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: `<${to}> ${text}` } }] }));
  });
  await new Promise<void>((r) => fake.server.listen(port, "127.0.0.1", r));
  return fake;
}

interface Core {
  base: string;
  child: ChildProcess;
}

async function spawnCore(dir: string, port: number, translatorUrl: string): Promise<Core> {
  await writeFile(join(dir, "bindings.json"), JSON.stringify(BINDINGS));
  const child = spawn("node", ["./server.ts"], {
    cwd: process.cwd(),
    stdio: "ignore",
    env: {
      ...process.env,
      PORT: String(port),
      BINDINGS_PATH: join(dir, "bindings.json"),
      LEDGER_PATH: join(dir, "ledger.jsonl"),
      RELAY_PATH: "",
      HUB_ORIGIN: "http://localhost:5173",
      TRANSLATE_API_KEY: "test",
      TRANSLATE_BASE_URL: translatorUrl,
      TRANSLATE_MODEL: "fake",
      HOST: "127.0.0.1",
      CORE_AUTH_TOKEN: "",
    },
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return { base, child };
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("test server never ready");
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await exited;
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: Json }> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Json };
}

async function ledger(dir: string): Promise<Json[]> {
  const raw = await readFile(join(dir, "ledger.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Json);
}

async function outboxIds(base: string, channel: string): Promise<string[]> {
  const r = await fetch(`${base}/outbox?channel=${channel}&since=0`);
  return ((await r.json()) as { items: Array<{ messageId: string }> }).items.map((i) => i.messageId);
}

describe("ingress durability", () => {
  const PORT = 8799;
  const FAKE_PORT = 8800;
  let dir = "";
  let fake: Fake | null = null;
  let core: Core | null = null;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ingress-retry-"));
    fake = await startFakeTranslator(FAKE_PORT);
    core = await spawnCore(dir, PORT, fake.url);
  });
  after(async () => {
    if (core) await stop(core.child);
    await new Promise<void>((r) => fake?.server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  const msg = { origin: "discord", nativeId: "dur-1", lang: "en", body: "hello there" };

  it("a provider 503 keeps the original and leaves the id retryable, not duplicate", async () => {
    fake!.failNext = 1;
    const first = await post(core!.base, "/ingress", msg);
    assert.equal(first.status, 503);
    assert.equal(first.json.retryable, true);
    assert.equal(first.json.code, "http-503");
    let lines = await ledger(dir);
    const original = lines.filter((e) => e.direction === "in" && e.messageId === "discord:dur-1" && e.verdict === undefined);
    assert.equal(original.length, 1, "original persisted before translation");
    assert.equal(original[0]?.body, "hello there");
    assert.equal(lines.find((e) => e.messageId === "discord:dur-1" && e.verdict === "failed")?.body, "http-503");
    assert.deepEqual(await outboxIds(core!.base, "hub"), [], "nothing fanned out");

    const second = await post(core!.base, "/ingress", msg);
    assert.equal(second.status, 200, "retry resumes at translation");
    assert.equal(second.json.resumed, true);
    assert.notEqual(second.json.duplicate, true);
    assert.ok((await outboxIds(core!.base, "hub")).includes("discord:dur-1->hub"));
    lines = await ledger(dir);
    assert.equal(
      lines.filter((e) => e.direction === "in" && e.messageId === "discord:dur-1" && e.verdict === undefined).length,
      1,
      "original recorded once",
    );
    const third = await post(core!.base, "/ingress", msg);
    assert.equal(third.json.duplicate, true, "done: further requests are duplicates");
  });

  it("a concurrent request for the same id is told processing, and runs once", async () => {
    fake!.delayMs = 400;
    const calls = fake!.calls;
    const m = { origin: "discord", nativeId: "dur-2", lang: "en", body: "at the same time" };
    const [a, b] = await Promise.all([post(core!.base, "/ingress", m), post(core!.base, "/ingress", m)]);
    fake!.delayMs = 0;
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 202]);
    assert.equal(fake!.calls - calls, 1, "one translation, not two");
    const fresh = (await ledger(dir)).filter((e) => e.direction === "in" && e.messageId === "discord:dur-2" && e.verdict === undefined);
    assert.equal(fresh.length, 1);
  });

  it("retryable state survives a restart", async () => {
    fake!.failNext = 1;
    const m = { origin: "discord", nativeId: "dur-3", lang: "en", body: "after restart" };
    assert.equal((await post(core!.base, "/ingress", m)).status, 503);
    await stop(core!.child);
    core = await spawnCore(dir, PORT, fake!.url);
    const retry = await post(core.base, "/ingress", m);
    assert.equal(retry.status, 200, "rebuilt from the in|failed marker");
    assert.equal(retry.json.resumed, true);
    assert.ok((await outboxIds(core.base, "hub")).includes("discord:dur-3->hub"));
    // And a done id stays done across the restart.
    assert.equal((await post(core.base, "/ingress", msg)).json.duplicate, true);
  });
});
