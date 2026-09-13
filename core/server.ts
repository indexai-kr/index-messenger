import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { Router, type BindingTable } from "./router.ts";
import { Ledger } from "./ledger.ts";
import { inspect } from "./gate.ts";
import {
  OpenAICompatibleProvider,
  PassthroughProvider,
} from "./translate/index.ts";
import { makeMessage, type SenderInfo } from "./schema.ts";

export interface ServerConfig {
  port: number;
  bindingsPath: string;
  ledgerPath: string;
  hubOrigin: string;
  /**
   * Relay whitelist file (JSON array of `{from, to}` channel pairs).
   * Absent or empty means every derived send is record-only.
   */
  relayPath?: string;
}

// One directional channel pair whose derived sends may actually go out.
export interface RelayPair {
  from: string;
  to: string;
}

// Send policy for one `out` copy. The hub is a display sink — its copies
// are read by the hub screen, never executed by anyone, so they stay
// verdict-less regardless of origin.
export type OutPolicy = "send" | "relay" | "record-only";

const HUB = "hub";
const COWORK = "cowork";

export function outPolicy(origin: string, channel: string, relay: RelayPair[]): OutPolicy {
  if (channel === HUB) return "send";
  if (origin === HUB || origin === COWORK) return "send";
  if (relay.some((pair) => pair.from === origin && pair.to === channel)) return "relay";
  return "record-only";
}

// Whitelist loader: missing path -> locked (empty). A malformed file is a
// configuration error and must fail loudly, never silently open or close.
export async function loadRelay(path: string | undefined): Promise<RelayPair[]> {
  if (!path) return [];
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`relay file ${path}: expected a JSON array`);
  return parsed.map((entry, index) => {
    const o = entry as Record<string, unknown>;
    if (typeof o?.from !== "string" || typeof o?.to !== "string") {
      throw new Error(`relay file ${path}: entry ${index} needs string from/to`);
    }
    return { from: o.from, to: o.to };
  });
}

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") as string);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// Sender objects arrive from adapter toIngress mapping. Structurally
// validated so malformed input degrades to "unknown sender", never a crash.
function asSender(value: unknown): SenderInfo | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.platform !== "string" || typeof o.id !== "string" || typeof o.displayName !== "string") {
    return undefined;
  }
  return { platform: o.platform, id: o.id, displayName: o.displayName };
}

// Trust fields live on the server side only. A client that ships them in
// a cowork request gets them stripped (never honored, never 400) and the
// strip itself is ledger-logged.
const TRUST_FIELDS = [
  "origin",
  "verdict",
  "approved",
  "delivered",
  "translatedBody",
  "translatedLang",
  "direction",
  "ts",
];

// Thin HTTP wiring over the core pipeline. Adapter processes POST native
// events here; the hub polls/reads state here. No secrets in code.
export async function startServer(config: ServerConfig): Promise<void> {
  const bindingsRaw = await readFile(config.bindingsPath, "utf8");
  const bindings = JSON.parse(bindingsRaw) as BindingTable;
  const ledger = new Ledger(config.ledgerPath);

  const useRealTranslator = Boolean(env("TRANSLATE_API_KEY"));
  const translate = useRealTranslator
    ? new OpenAICompatibleProvider({
        baseUrl: env("TRANSLATE_BASE_URL", "https://api.example.com/v1"),
        apiKey: env("TRANSLATE_API_KEY"),
        model: env("TRANSLATE_MODEL", "gpt-4o-mini"),
      })
    : new PassthroughProvider();

  const router = new Router({ bindings, translate });
  const relay = await loadRelay(config.relayPath);
  const pending = new Map<string, { to: string; body: string; lang: string }>();

  // Fan-out recorder shared by every ingress path. Policy per copy:
  //   send        hub/cowork-originated, or a hub display copy -> sendable
  //   relay       derived, but (origin -> channel) is whitelisted -> sendable,
  //               server-tagged origin=relay so it is never mistaken for a
  //               hub send
  //   record-only every other derived copy: written to the ledger for the
  //               converged view, carries a verdict so /outbox never serves
  //               it. This is the "hub-originated sends only" rule in code.
  async function recordFanout(
    msg: { id: string; origin: string },
    sender: SenderInfo | undefined,
    targets: Array<{ channel: string; lang: string; body: string }>,
  ): Promise<Array<{ channel: string; policy: OutPolicy }>> {
    const decisions: Array<{ channel: string; policy: OutPolicy }> = [];
    for (const copy of targets) {
      const policy = outPolicy(msg.origin, copy.channel, relay);
      const outId = `${msg.id}->${copy.channel}`;
      await ledger.append({
        ts: Date.now(),
        direction: "out",
        channel: copy.channel,
        messageId: outId,
        lang: copy.lang,
        body: copy.body,
        translatedLang: copy.lang,
        translatedBody: copy.body,
        sender,
        origin: policy === "relay" ? "relay" : msg.origin,
        ...(policy === "record-only" ? { verdict: "record-only" } : {}),
      });
      router.markEmitted(outId);
      decisions.push({ channel: copy.channel, policy });
    }
    return decisions;
  }

  // Idempotency registry: every executed ingress id. Rebuilt from the
  // ledger at startup (fresh in-lines only — marker lines excluded) so a
  // restart cannot re-execute history.
  const seenIngress = new Set<string>();
  try {
    for (const entry of await ledger.readAll()) {
      if (entry.direction === "in" && entry.verdict === undefined) {
        seenIngress.add(entry.messageId);
      }
    }
  } catch {
    // Fresh ledger: nothing to rebuild.
  }

  async function noteDuplicate(channel: string, messageId: string): Promise<void> {
    await ledger.append({
      ts: Date.now(),
      direction: "in",
      channel,
      messageId,
      lang: "",
      body: "",
      verdict: "duplicate",
    });
  }

  const server = createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", config.hubOrigin);
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (req.method === "GET" && req.url === "/health") {
        send(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && req.url === "/bindings") {
        send(res, 200, router.getBindings());
        return;
      }
      if (req.method === "POST" && req.url === "/bindings") {
        const next = (await readJson(req)) as BindingTable;
        router.setBindings(next);
        send(res, 200, router.getBindings());
        return;
      }
      if (req.method === "GET" && req.url === "/ledger") {
        send(res, 200, await ledger.readAll());
        return;
      }
      // Ingress from any adapter: { origin, nativeId, lang, body, sender? }
      if (req.method === "POST" && req.url === "/ingress") {
        const event = (await readJson(req)) as {
          origin: string;
          nativeId: string;
          lang: string;
          body: string;
          sender?: unknown;
        };
        const sender = asSender(event.sender);
        // Language is a property of the channel's user, not of the client:
        // bindings[origin] wins over the claimed lang (the kakao listener
        // hardcodes ko; an English-speaking room still reads as English).
        const lang = router.getBindings()[event.origin] ?? event.lang;
        const msg = makeMessage(event.origin, event.nativeId, lang, event.body, Date.now(), sender);
        // Idempotency: nativeId is the key. A re-injected id executes
        // nothing — only the duplicate receipt is logged.
        if (seenIngress.has(msg.id)) {
          await noteDuplicate(msg.origin, msg.id);
          send(res, 200, { duplicate: true, messageId: msg.id });
          return;
        }
        seenIngress.add(msg.id);
        if (router.isEcho(msg)) {
          send(res, 200, { dropped: "echo" });
          return;
        }
        const routed = await router.route(msg);
        await ledger.append({
          ts: msg.ts,
          direction: "in",
          channel: msg.origin,
          messageId: msg.id,
          lang: msg.lang,
          body: msg.body,
          sender,
        });
        const policies = await recordFanout(msg, sender, routed.targets);
        send(res, 200, { ...routed, policies });
        return;
      }
      // Cowork ingress: same pipeline, but the origin is server-tagged.
      // The client's own origin/verdict/approval claims are stripped
      // (ignored, not rejected) and the strip is ledger-logged. Pass a
      // stable nativeId — it doubles as the idempotency key.
      if (req.method === "POST" && req.url === "/cowork/ingress") {
        const raw = ((await readJson(req)) ?? {}) as Record<string, unknown>;
        const stripped = TRUST_FIELDS.filter((k) => k in raw);
        if (
          typeof raw.nativeId !== "string" ||
          typeof raw.lang !== "string" ||
          typeof raw.body !== "string"
        ) {
          send(res, 400, { error: "nativeId, lang and body are required" });
          return;
        }
        const sender = asSender(raw.sender);
        const msg = makeMessage("cowork", raw.nativeId, raw.lang, raw.body, Date.now(), sender);
        if (stripped.length > 0) {
          await ledger.append({
            ts: Date.now(),
            direction: "in",
            channel: "cowork",
            messageId: msg.id,
            lang: "",
            body: `stripped: ${stripped.join(",")}`,
            verdict: "stripped",
          });
        }
        if (seenIngress.has(msg.id)) {
          await noteDuplicate("cowork", msg.id);
          send(res, 200, { duplicate: true, messageId: msg.id });
          return;
        }
        seenIngress.add(msg.id);
        const routed = await router.route(msg);
        await ledger.append({
          ts: msg.ts,
          direction: "in",
          channel: msg.origin,
          messageId: msg.id,
          lang: msg.lang,
          body: msg.body,
          sender,
        });
        const policies = await recordFanout(msg, sender, routed.targets);
        send(res, 200, { ...routed, stripped, policies });
        return;
      }
      // Hub outbound with gate: { body, lang }
      // Pass-through when no risk pattern matches. On hold, translate
      // per target channel (source -> channel lang -> hub lang) so the hub
      // screen shows a real round-trip back-translation per recipient.
      if (req.method === "POST" && req.url === "/send") {
        const event = (await readJson(req)) as { body: string; lang: string };
        const hubLang = router.hubLang();
        const matched = inspect(event.body);
        const id = `hub:${Date.now()}`;
        if (matched.length === 0) {
          await ledger.append({
            ts: Date.now(),
            direction: "gate",
            channel: "hub",
            messageId: id,
            lang: event.lang,
            body: event.body,
            verdict: "pass",
          });
          send(res, 200, { held: false, id, matched, roundTrips: [] });
          return;
        }
        const roundTrips: Array<{
          channel: string;
          lang: string;
          translated: string;
          backTranslation: string;
          translateMs: number;
          backMs: number;
        }> = [];
        for (const [channel, lang] of Object.entries(router.getBindings())) {
          if (channel === "hub") continue;
          if (lang === event.lang) {
            roundTrips.push({
              channel,
              lang,
              translated: event.body,
              backTranslation: event.body,
              translateMs: 0,
              backMs: 0,
            });
            await ledger.append({
              ts: Date.now(),
              direction: "gate",
              channel,
              messageId: `${id}->${channel}`,
              lang,
              body: event.body,
              translatedLang: hubLang,
              translatedBody: event.body,
              verdict: "hold",
            });
            continue;
          }
          const t0 = Date.now();
          const translated = await translate.translate(event.body, event.lang, lang);
          const t1 = Date.now();
          const backTranslation = await translate.translate(translated, lang, hubLang);
          const t2 = Date.now();
          roundTrips.push({
            channel,
            lang,
            translated,
            backTranslation,
            translateMs: t1 - t0,
            backMs: t2 - t1,
          });
          await ledger.append({
            ts: Date.now(),
            direction: "gate",
            channel,
            messageId: `${id}->${channel}`,
            lang,
            body: translated,
            translatedLang: hubLang,
            translatedBody: backTranslation,
            verdict: "hold",
          });
        }
        pending.set(id, { to: "fanout", body: event.body, lang: event.lang });
        send(res, 200, { held: true, id, matched, roundTrips });
        return;
      }
      if (req.method === "POST" && req.url === "/confirm") {
        const event = (await readJson(req)) as { id: string; body?: string };
        const held = pending.get(event.id);
        if (!held) {
          send(res, 404, { error: "unknown pending id" });
          return;
        }
        pending.delete(event.id);
        await ledger.append({
          ts: Date.now(),
          direction: "gate",
          channel: "hub",
          messageId: event.id,
          lang: held.lang,
          body: event.body ?? held.body,
          verdict: "confirmed",
        });
        send(res, 200, { confirmed: true });
        return;
      }
      // Outbox queue for poll-based executors (kakao-listener, discord runner).
      // Read-only view over the ledger: pending = verdict-less out entries
      // only. Result lines (delivered/failed/dry-run/seen/rate-limited…)
      // and record-only derived copies carry a verdict and are NEVER
      // emitted as send items — otherwise acks loop back into sends
      // (outbox echo) or inbound traffic auto-forwards. No new store.
      if (req.method === "GET" && typeof req.url === "string" && req.url.startsWith("/outbox")) {
        const query = new URL(req.url, "http://localhost");
        const channel = query.searchParams.get("channel") ?? "";
        const since = Number(query.searchParams.get("since") ?? "0");
        const all = await ledger.readAll();
        const items = all
          .filter((e) => e.direction === "out" && e.channel === channel && e.verdict === undefined && e.ts > since)
          .map((e) => ({ messageId: e.messageId, body: e.body, lang: e.lang, ts: e.ts, origin: e.origin }));
        send(res, 200, { items });
        return;
      }
      if (req.method === "POST" && req.url === "/outbox/ack") {
        const event = (await readJson(req)) as {
          messageId: string;
          channel: string;
          ok: boolean;
          error?: string;
          mode?: string;
        };
        if (typeof event.messageId !== "string" || typeof event.channel !== "string") {
          send(res, 400, { error: "messageId and channel are required" });
          return;
        }
        // Rehearsals must never share the delivered state: a dry run is
        // recorded as its own verdict so the ledger can tell "actually
        // sent" apart from "pretended to send".
        const verdict =
          event.mode === "dry-run" ? "dry-run" : event.ok ? "delivered" : "failed";
        await ledger.append({
          ts: Date.now(),
          direction: "out",
          channel: event.channel,
          messageId: event.messageId,
          lang: "",
          // Delivered carries no user content; failures carry the short
          // error code; dry runs carry nothing. No user content either way.
          body: event.ok && event.mode !== "dry-run" ? "" : (event.error ?? "failed"),
          verdict,
        });
        send(res, 200, { acked: true, verdict });
        return;
      }
      // Consumption receipt: "a consumer read this item". Deliberately NOT
      // a delivery result — acknowledged is not delivered. Delivery stays
      // on /outbox/ack (delivered/failed/dry-run); reads land here as
      // "seen" so delivered statistics can never mix the two.
      if (req.method === "POST" && req.url === "/outbox/seen") {
        const event = (await readJson(req)) as {
          messageId: string;
          channel: string;
          consumer?: string;
        };
        if (typeof event.messageId !== "string" || typeof event.channel !== "string") {
          send(res, 400, { error: "messageId and channel are required" });
          return;
        }
        await ledger.append({
          ts: Date.now(),
          direction: "out",
          channel: event.channel,
          messageId: event.messageId,
          lang: "",
          body: typeof event.consumer === "string" ? event.consumer : "",
          verdict: "seen",
        });
        send(res, 200, { seen: true });
        return;
      }
      send(res, 404, { error: "not found" });
    } catch (error) {
      send(res, 500, { error: (error as Error).message });
    }
  });

  server.listen(config.port, () => {
    console.log(`index-messenger core listening on :${config.port}`);
  });
}

if (process.argv[1]?.endsWith("server.ts")) {
  await startServer({
    port: Number(env("PORT", "8787")),
    bindingsPath: env("BINDINGS_PATH", "./bindings.example.json"),
    ledgerPath: env("LEDGER_PATH", "./data/ledger.jsonl"),
    hubOrigin: env("HUB_ORIGIN", "http://localhost:5173"),
    relayPath: env("RELAY_PATH", "") || undefined,
  });
}
