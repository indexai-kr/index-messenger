import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hub send -> gate -> approval -> outbox, as one path. Real server,
// isolated ledger, passthrough translator (`[lang] text`).
const BINDINGS = { hub: "ko", discord: "en", telegram: "ja" };
type Json = Record<string, unknown>;

interface Core {
  base: string;
  dir: string;
  child: ChildProcess;
}

async function spawnCore(dir: string, port: number, relay: unknown[] = []): Promise<Core> {
  await writeFile(join(dir, "bindings.json"), JSON.stringify(BINDINGS));
  await writeFile(join(dir, "relay.json"), JSON.stringify(relay));
  const child = spawn("node", ["./server.ts"], {
    cwd: process.cwd(),
    stdio: "ignore",
    env: {
      ...process.env,
      PORT: String(port),
      BINDINGS_PATH: join(dir, "bindings.json"),
      LEDGER_PATH: join(dir, "ledger.jsonl"),
      RELAY_PATH: join(dir, "relay.json"),
      HUB_ORIGIN: "http://localhost:5173",
      TRANSLATE_API_KEY: "",
      HOST: "127.0.0.1",
      CORE_AUTH_TOKEN: "",
    },
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return { base, dir, child };
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

async function outbox(base: string, channel: string): Promise<Array<{ messageId: string; body: string }>> {
  const r = await fetch(`${base}/outbox?channel=${channel}&since=0`);
  return ((await r.json()) as { items: Array<{ messageId: string; body: string }> }).items;
}

async function pendingIds(base: string): Promise<string[]> {
  const r = await fetch(`${base}/pending`);
  return ((await r.json()) as { items: Array<{ id: string }> }).items.map((i) => i.id);
}

async function ledger(dir: string): Promise<Json[]> {
  const raw = await readFile(join(dir, "ledger.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Json);
}

describe("hub send path", () => {
  const PORT = 8797;
  let core: Core | null = null;

  before(async () => {
    const dir = await mkdtemp(join(tmpdir(), "send-"));
    core = await spawnCore(dir, PORT);
  });
  after(async () => {
    if (core) {
      await stop(core.child);
      await rm(core.dir, { recursive: true, force: true });
    }
  });

  it("a plain sentence is translated and lands in every channel's outbox", async () => {
    const r = await post(core!.base, "/send", { body: "오늘 점심 뭐 먹지?", lang: "ko" });
    assert.equal(r.status, 200);
    assert.equal(r.json.held, false);
    const id = r.json.id as string;
    assert.match(id, /^hub:/);
    const discord = await outbox(core!.base, "discord");
    const item = discord.find((i) => i.messageId === `${id}->discord`);
    assert.ok(item, "send must reach the discord outbox");
    assert.equal(item?.body, "[en] 오늘 점심 뭐 먹지?");
    assert.ok((await outbox(core!.base, "telegram")).some((i) => i.messageId === `${id}->telegram`));
    const lines = await ledger(core!.dir);
    assert.equal(lines.find((e) => e.direction === "in" && e.messageId === id)?.channel, "hub");
    assert.equal(lines.find((e) => e.direction === "gate" && e.messageId === id)?.verdict, "pass");
  });

  it("a risky sentence is held; confirm releases exactly the reviewed translations", async () => {
    const r = await post(core!.base, "/send", { body: "내일 3시에 120,000원 보내줘", lang: "ko" });
    assert.equal(r.json.held, true);
    const id = r.json.id as string;
    const trips = r.json.roundTrips as Array<{ channel: string; translated: string; backTranslation: string }>;
    const reviewed = trips.find((t) => t.channel === "discord");
    assert.ok(reviewed);
    assert.equal(reviewed?.translated, "[en] 내일 3시에 120,000원 보내줘");
    assert.equal(reviewed?.backTranslation, "[ko] [en] 내일 3시에 120,000원 보내줘");
    assert.ok(!(await outbox(core!.base, "discord")).some((i) => i.messageId === `${id}->discord`), "held: nothing out");
    assert.ok((await pendingIds(core!.base)).includes(id));

    const c = await post(core!.base, "/confirm", { id });
    assert.equal(c.status, 200);
    assert.deepEqual((c.json.channels as string[]).sort(), ["discord", "telegram"]);
    const out = (await outbox(core!.base, "discord")).find((i) => i.messageId === `${id}->discord`);
    assert.equal(out?.body, reviewed?.translated, "what was approved is what is sent");
    assert.ok(!(await pendingIds(core!.base)).includes(id));
    const again = await post(core!.base, "/confirm", { id });
    assert.equal(again.status, 404, "an approval is consumed once");
  });

  it("reject drops the held text: verdict on record, nothing out", async () => {
    const r = await post(core!.base, "/send", { body: "계좌로 50,000원", lang: "ko" });
    const id = r.json.id as string;
    const j = await post(core!.base, "/reject", { id });
    assert.equal(j.json.rejected, true);
    assert.ok(!(await outbox(core!.base, "discord")).some((i) => i.messageId.startsWith(`${id}->`)));
    assert.ok(!(await pendingIds(core!.base)).includes(id));
    const lines = await ledger(core!.dir);
    assert.equal(lines.find((e) => e.verdict === "rejected" && e.messageId === id)?.channel, "hub");
    assert.equal((await post(core!.base, "/confirm", { id })).status, 404);
  });

  it("two sends in the same millisecond get distinct ids", async () => {
    const [a, b] = await Promise.all([
      post(core!.base, "/send", { body: "하나", lang: "ko" }),
      post(core!.base, "/send", { body: "둘", lang: "ko" }),
    ]);
    assert.notEqual(a.json.id, b.json.id);
  });

  it("rejects an empty draft", async () => {
    assert.equal((await post(core!.base, "/send", { body: "   ", lang: "ko" })).status, 400);
  });
});

describe("held sends survive a restart", () => {
  const PORT = 8798;
  let dir = "";
  let child: ChildProcess | null = null;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "restart-"));
  });
  after(async () => {
    if (child) await stop(child);
    await rm(dir, { recursive: true, force: true });
  });

  it("pending is rebuilt from the ledger and confirms after restart", async () => {
    let core = await spawnCore(dir, PORT, [{ from: "discord", to: "telegram" }]);
    child = core.child;
    const hub = await post(core.base, "/send", { body: "내일 5만원", lang: "ko" });
    const hubId = hub.json.id as string;
    assert.equal(hub.json.held, true);
    // A relay hold too: discord -> telegram is whitelisted and risky.
    await post(core.base, "/ingress", { origin: "discord", nativeId: "r-1", lang: "en", body: "meet at 10:30" });
    const relayId = "discord:r-1->telegram";
    // A hold that was already decided must not come back.
    const decided = await post(core.base, "/send", { body: "모레 3시", lang: "ko" });
    await post(core.base, "/reject", { id: decided.json.id });
    assert.deepEqual((await pendingIds(core.base)).sort(), [relayId, hubId].sort());

    await stop(core.child);
    core = await spawnCore(dir, PORT, [{ from: "discord", to: "telegram" }]);
    child = core.child;
    assert.deepEqual((await pendingIds(core.base)).sort(), [relayId, hubId].sort(), "restored, decided one excluded");

    const c = await post(core.base, "/confirm", { id: hubId });
    assert.equal(c.status, 200);
    const out = (await outbox(core.base, "discord")).find((i) => i.messageId === `${hubId}->discord`);
    assert.equal(out?.body, "[en] 내일 5만원", "restored copy is the reviewed string");
    const rc = await post(core.base, "/confirm", { id: relayId });
    assert.equal(rc.json.released, "telegram");
    assert.ok((await outbox(core.base, "telegram")).some((i) => i.messageId === relayId));
    assert.deepEqual(await pendingIds(core.base), []);
  });
});
