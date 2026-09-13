import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Relay whitelist + record-only policy, against real servers on isolated
// ledgers (production ledger untouched). Bindings model the live
// experiment: kakao speaks English, discord speaks Korean.
const BINDINGS = { hub: "ko", telegram: "ja", discord: "ko", slack: "en", kakao: "en" };

type Json = Record<string, unknown>;

interface Core {
  base: string;
  dir: string;
  child: ChildProcess;
}

async function startCore(port: number, relay?: unknown): Promise<Core> {
  const dir = await mkdtemp(join(tmpdir(), `relay-${port}-`));
  await writeFile(join(dir, "bindings.json"), JSON.stringify(BINDINGS));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    BINDINGS_PATH: join(dir, "bindings.json"),
    LEDGER_PATH: join(dir, "ledger.jsonl"),
    HUB_ORIGIN: "http://localhost:5173",
    TRANSLATE_API_KEY: "",
    RELAY_PATH: "",
  };
  if (relay !== undefined) {
    await writeFile(join(dir, "relay.json"), JSON.stringify(relay));
    env.RELAY_PATH = join(dir, "relay.json");
  }
  const child = spawn("node", ["./server.ts"], { cwd: process.cwd(), stdio: "ignore", env });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return { base, dir, child };
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("test server never ready");
}

async function stopCore(core: Core | null): Promise<void> {
  core?.child.kill();
  if (core) await rm(core.dir, { recursive: true, force: true });
}

async function post(base: string, path: string, body: unknown): Promise<Json> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await r.json()) as Json;
}

async function outbox(base: string, channel: string): Promise<string[]> {
  const r = await fetch(`${base}/outbox?channel=${channel}&since=0`);
  const j = (await r.json()) as { items: Array<{ messageId: string }> };
  return j.items.map((i) => i.messageId);
}

async function ledger(core: Core): Promise<Json[]> {
  const raw = await readFile(join(core.dir, "ledger.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Json);
}

function outLine(lines: Json[], messageId: string): Json | undefined {
  return lines.find((e) => e.direction === "out" && e.messageId === messageId);
}

describe("relay locked (no whitelist)", () => {
  let core: Core | null = null;
  before(async () => {
    core = await startCore(8793);
  });
  after(async () => stopCore(core));

  it("derived copies are record-only and never served by /outbox", async () => {
    const r = await post(core!.base, "/ingress", { origin: "kakao", nativeId: "k-1", lang: "en", body: "hello" });
    const policies = r.policies as Array<{ channel: string; policy: string }>;
    assert.equal(policies.find((p) => p.channel === "discord")?.policy, "record-only");
    assert.equal(policies.find((p) => p.channel === "hub")?.policy, "send");
    const lines = await ledger(core!);
    const discord = outLine(lines, "kakao:k-1->discord");
    assert.equal(discord?.verdict, "record-only");
    assert.equal(discord?.origin, "kakao");
    assert.equal(outLine(lines, "kakao:k-1->hub")?.verdict, undefined, "hub display copy stays verdict-less");
    assert.ok(!(await outbox(core!.base, "discord")).includes("kakao:k-1->discord"));
    assert.ok(!(await outbox(core!.base, "telegram")).includes("kakao:k-1->telegram"));
  });

  it("hub-originated copies stay sendable, tagged origin=hub", async () => {
    await post(core!.base, "/ingress", { origin: "hub", nativeId: "h-1", lang: "ko", body: "안녕" });
    assert.ok((await outbox(core!.base, "discord")).includes("hub:h-1->discord"));
    assert.equal(outLine(await ledger(core!), "hub:h-1->discord")?.origin, "hub");
  });
});

describe("relay kakao <-> discord", () => {
  let core: Core | null = null;
  before(async () => {
    core = await startCore(8794, [
      { from: "kakao", to: "discord" },
      { from: "discord", to: "kakao" },
    ]);
  });
  after(async () => stopCore(core));

  it("kakao -> discord goes out tagged origin=relay; unregistered pairs stay record-only", async () => {
    const r = await post(core!.base, "/ingress", { origin: "kakao", nativeId: "k-2", lang: "en", body: "hi there" });
    const policies = r.policies as Array<{ channel: string; policy: string }>;
    assert.equal(policies.find((p) => p.channel === "discord")?.policy, "relay");
    assert.equal(policies.find((p) => p.channel === "telegram")?.policy, "record-only");
    assert.ok((await outbox(core!.base, "discord")).includes("kakao:k-2->discord"));
    assert.ok(!(await outbox(core!.base, "telegram")).includes("kakao:k-2->telegram"));
    const lines = await ledger(core!);
    const sent = outLine(lines, "kakao:k-2->discord");
    assert.equal(sent?.origin, "relay");
    assert.equal(sent?.verdict, undefined);
    assert.equal(sent?.lang, "ko", "translated into the discord user's language");
    assert.equal(outLine(lines, "kakao:k-2->telegram")?.verdict, "record-only");
  });

  it("discord -> kakao goes out tagged origin=relay", async () => {
    await post(core!.base, "/ingress", { origin: "discord", nativeId: "d-2", lang: "ko", body: "잘 지내니" });
    assert.ok((await outbox(core!.base, "kakao")).includes("discord:d-2->kakao"));
    const sent = outLine(await ledger(core!), "discord:d-2->kakao");
    assert.equal(sent?.origin, "relay");
    assert.equal(sent?.lang, "en");
  });

  it("telegram -> discord is not whitelisted and stays record-only", async () => {
    await post(core!.base, "/ingress", { origin: "telegram", nativeId: "t-2", lang: "ja", body: "こんにちは" });
    assert.ok(!(await outbox(core!.base, "discord")).includes("telegram:t-2->discord"));
    assert.equal(outLine(await ledger(core!), "telegram:t-2->discord")?.verdict, "record-only");
  });
});
