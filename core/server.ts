import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { Router, type BindingTable } from "./router.ts";
import { Ledger, type LedgerEntry } from "./ledger.ts";
import { inspect, inspectCopy } from "./gate.ts";
import { pLimit } from "./p-limit.ts";
import {
  OpenAICompatibleProvider,
  PassthroughProvider,
} from "./translate/index.ts";
import { makeMessage, type GatewayMessage, type RoutedMessage, type SenderInfo } from "./schema.ts";

export interface ServerConfig {
  port: number;
  /**
   * Listen address. Defaults to loopback: the core is reachable from
   * this machine only unless an operator opens it on purpose. A
   * non-loopback host requires `authToken`.
   */
  host?: string;
  /**
   * Shared bearer token. When set, every endpoint except /health requires
   * `authorization: Bearer <token>`. Executors, the hub proxy and the
   * phone app carry it; the browser never sees it (the Vite proxy adds it).
   */
  authToken?: string;
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

// Request bodies are small JSON documents. Anything bigger is rejected
// before parsing so a client cannot exhaust memory through the ledger.
const MAX_BODY_BYTES = 64 * 1024;

class BodyTooLarge extends Error {
  constructor() {
    super(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    this.name = "BodyTooLarge";
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") as string);
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

function bearerOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1];
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

// One held send. `source` is the untranslated original and `matched` the
// patterns that held it — both are review context, not send data.
export type Pending =
  | {
      /** One held copy on its way to one channel (relay, hub or cowork origin). */
      kind: "copy";
      to: string;
      body: string;
      lang: string;
      sender?: SenderInfo;
      origin: string;
      source: string;
      matched: string[];
    }
  | {
      /** A hub draft held as a whole: every channel copy waits together. */
      kind: "draft";
      body: string;
      lang: string;
      copies: Array<{ channel: string; lang: string; body: string }>;
      source: string;
      matched: string[];
    };

// Ledger origin tag of a draft's gate lines. Distinct from "hub" (an
// individual hub-originated copy) so a restart can tell the two apart.
const DRAFT = "draft";

interface RoundTrip {
  channel: string;
  lang: string;
  translated: string;
  backTranslation: string;
  translateMs: number;
  backMs: number;
}

function pendingView(id: string, held: Pending): Record<string, unknown> {
  return held.kind === "copy"
    ? {
        id,
        kind: "copy",
        to: held.to,
        origin: held.origin,
        lang: held.lang,
        body: held.body,
        source: held.source,
        matched: held.matched,
        sender: held.sender,
      }
    : { id, kind: "draft", lang: held.lang, source: held.source, matched: held.matched, copies: held.copies };
}

// Hub-originated ids: millisecond time plus a per-process counter, so two
// sends in the same millisecond never collide.
let hubSeq = 0;
function nextHubNativeId(): string {
  hubSeq = (hubSeq + 1) % 1000;
  return `${Date.now()}-${String(hubSeq).padStart(3, "0")}`;
}

// Rebuild the pending map from the ledger: every gate|hold line whose id
// has no later confirmed/rejected line is still waiting. Copy holds are
// keyed by their out id; draft holds (origin=draft) are grouped per draft
// under the draft id, one copy per channel line. Legacy hub holds that
// predate the origin tag are not resurrected — they were never
// confirmable across a restart, and they belong to no live screen.
export function rebuildPending(history: LedgerEntry[]): Map<string, Pending> {
  const decided = new Set<string>();
  for (const e of history) {
    if (e.direction === "gate" && (e.verdict === "confirmed" || e.verdict === "rejected")) decided.add(e.messageId);
  }
  const out = new Map<string, Pending>();
  const drafts = new Map<string, Pending & { kind: "draft" }>();
  for (const e of history) {
    if (e.direction !== "gate" || e.verdict !== "hold" || e.origin === undefined) continue;
    const arrow = e.messageId.lastIndexOf("->");
    if (arrow < 0) continue;
    if (e.origin === DRAFT) {
      const draftId = e.messageId.slice(0, arrow);
      if (decided.has(draftId)) continue;
      let draft = drafts.get(draftId);
      if (draft === undefined) {
        draft = { kind: "draft", body: "", lang: "", copies: [], source: "", matched: [] };
        drafts.set(draftId, draft);
      }
      draft.copies = draft.copies.filter((c) => c.channel !== e.channel);
      draft.copies.push({ channel: e.channel, lang: e.lang, body: e.body });
      continue;
    }
    if (decided.has(e.messageId)) continue;
    const sourceId = e.messageId.slice(0, arrow);
    const inbound = history.find((h) => h.direction === "in" && h.messageId === sourceId && h.verdict === undefined);
    out.set(e.messageId, {
      kind: "copy",
      to: e.channel,
      body: e.body,
      lang: e.lang,
      sender: e.sender,
      origin: e.origin,
      source: inbound?.body ?? "",
      matched: [],
    });
  }
  // The draft's own text is its inbound hub line.
  for (const [draftId, draft] of drafts) {
    const inbound = history.find((e) => e.direction === "in" && e.channel === HUB && e.messageId === draftId);
    draft.body = inbound?.body ?? "";
    draft.lang = inbound?.lang ?? "";
    draft.source = draft.body;
    out.set(draftId, draft);
  }
  return out;
}

// Ids whose original was persisted but whose fan-out never happened: an
// in|failed marker exists and no `id->channel` line does. A retry for
// such an id resumes at translation.
export function rebuildRetryable(history: LedgerEntry[]): Set<string> {
  const failed = new Set<string>();
  for (const e of history) if (e.direction === "in" && e.verdict === "failed") failed.add(e.messageId);
  if (failed.size === 0) return failed;
  for (const e of history) {
    const arrow = e.messageId.lastIndexOf("->");
    if (arrow > 0) failed.delete(e.messageId.slice(0, arrow));
  }
  return failed;
}

// Short, content-free error label for the ledger and the response.
function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const http = /http (\d{3})/.exec(message);
  if (http) return `http-${http[1]}`;
  if (/abort|timeout/i.test(message)) return "timeout";
  return error instanceof Error ? error.name : "error";
}

// Thin HTTP wiring over the core pipeline. Adapter processes POST native
// events here; the hub polls/reads state here. No secrets in code.
export async function startServer(config: ServerConfig): Promise<void> {
  const host = config.host ?? "127.0.0.1";
  const authToken = config.authToken ?? "";
  if (!isLoopback(host) && authToken === "") {
    throw new Error(
      `refusing to listen on ${host} without CORE_AUTH_TOKEN: a non-loopback core must authenticate its callers`,
    );
  }
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
  // Held sends awaiting /confirm or /reject. A "relay" entry is one
  // derived copy (origin:native->channel) released as-is; a "fanout"
  // entry is a hub draft whose per-channel translations were already
  // produced and shown for review — confirmation releases exactly those
  // strings, it never translates again. The map is a cache: the ledger
  // is the record, and the map is rebuilt from it at startup so a
  // restart loses no approval.
  const pending = new Map<string, Pending>();

  // Fan-out recorder shared by every ingress path. Policy per copy:
  //   send        hub/cowork-originated, or a hub display copy -> sendable
  //   relay       derived, but (origin -> channel) is whitelisted -> sendable,
  //               server-tagged origin=relay so it is never mistaken for a
  //               hub send
  //   record-only every other derived copy: written to the ledger for the
  //               converged view, carries a verdict so /outbox never serves
  //               it. This is the "hub-originated sends only" rule in code.
  // Every copy that can actually leave — send or relay, any origin — goes
  // through the same gate: risk patterns in the source or the translated
  // text, or a structural token the translation lost, hold it (gate|hold
  // + pending) until POST /confirm releases it. The hub display copy is
  // read by the hub screen only and is never executed, so it is not held.
  async function recordFanout(
    msg: { id: string; origin: string; body: string },
    sender: SenderInfo | undefined,
    targets: Array<{ channel: string; lang: string; body: string }>,
    // `approved`: these copies were held, reviewed and confirmed. They are
    // written as sendable without a second inspection — the inspection
    // already happened on exactly these strings.
    approved = false,
  ): Promise<Array<{ channel: string; policy: OutPolicy | "held"; matched?: string[] }>> {
    const decisions: Array<{ channel: string; policy: OutPolicy | "held"; matched?: string[] }> = [];
    for (const copy of targets) {
      const policy = outPolicy(msg.origin, copy.channel, relay);
      const outId = `${msg.id}->${copy.channel}`;
      const origin = policy === "relay" ? "relay" : msg.origin;
      if (policy !== "record-only" && copy.channel !== HUB && !approved) {
        const matched = inspectCopy(msg.body, copy.body);
        if (matched.length > 0) {
          await ledger.append({
            ts: Date.now(),
            direction: "gate",
            channel: copy.channel,
            messageId: outId,
            lang: copy.lang,
            body: copy.body,
            translatedLang: copy.lang,
            translatedBody: copy.body,
            sender,
            origin,
            verdict: "hold",
          });
          pending.set(outId, {
            kind: "copy",
            to: copy.channel,
            body: copy.body,
            lang: copy.lang,
            sender,
            origin,
            source: msg.body,
            matched,
          });
          decisions.push({ channel: copy.channel, policy: "held", matched });
          continue;
        }
      }
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
        origin,
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
  // Ingress ids being processed right now / whose fan-out must be redone
  // (see runIngress for the state machine).
  const inflight = new Set<string>();
  const retryable = new Set<string>();
  try {
    const history = await ledger.readAll();
    for (const entry of history) {
      if (entry.direction === "in" && entry.verdict === undefined) {
        seenIngress.add(entry.messageId);
      }
      // Echo set: native ids of messages our executors actually created.
      // When one comes back through ingress it is our own send, not a
      // new message — dropped before translation, never re-relayed.
      if (entry.direction === "out" && entry.verdict === "delivered" && entry.nativeId) {
        router.markEmitted(`${entry.channel}:${entry.nativeId}`);
      }
    }
    for (const [id, held] of rebuildPending(history)) pending.set(id, held);
    for (const id of rebuildRetryable(history)) retryable.add(id);
    if (retryable.size > 0) console.log(`index-messenger core: ${retryable.size} ingress id(s) await a retry`);
    if (pending.size > 0) console.log(`index-messenger core: ${pending.size} held send(s) restored from the ledger`);
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

  // Ingress state machine, one id at a time:
  //   received   the original is in the ledger (in line) — from here on
  //              the id is idempotent and survives a restart
  //   processing translation + fan-out in flight (inflight set); a second
  //              request for the same id gets 202, never a second run
  //   done       fan-out lines written; further requests are duplicates
  //   failed     translation or a write failed after the original was
  //              persisted: an in|failed marker is written and the id is
  //              retryable — the next request for it resumes at
  //              translation without re-recording the original
  async function runIngress(
    msg: GatewayMessage,
    sender: SenderInfo | undefined,
    res: ServerResponse,
    extra: Record<string, unknown>,
  ): Promise<void> {
    if (inflight.has(msg.id)) {
      send(res, 202, { processing: true, messageId: msg.id });
      return;
    }
    const resume = retryable.has(msg.id);
    // Idempotency: nativeId is the key. A re-injected id executes
    // nothing — only the duplicate receipt is logged.
    if (seenIngress.has(msg.id) && !resume) {
      await noteDuplicate(msg.origin, msg.id);
      send(res, 200, { duplicate: true, messageId: msg.id });
      return;
    }
    inflight.add(msg.id);
    try {
      if (!resume && router.isEcho(msg)) {
        // Loop guard: this native id was created by one of our own
        // executors. Receipt only — no body, no fan-out, no relay.
        await ledger.append({
          ts: Date.now(),
          direction: "in",
          channel: msg.origin,
          messageId: msg.id,
          lang: "",
          body: "",
          verdict: "echo",
        });
        seenIngress.add(msg.id);
        send(res, 200, { dropped: "echo", messageId: msg.id });
        return;
      }
      if (!resume) {
        // Persist the original before any translation: from here the
        // message cannot be lost to a provider outage or a restart.
        await ledger.append({
          ts: msg.ts,
          direction: "in",
          channel: msg.origin,
          messageId: msg.id,
          lang: msg.lang,
          body: msg.body,
          sender,
        });
        seenIngress.add(msg.id);
      }
      let routed: RoutedMessage;
      try {
        routed = await router.route(msg);
      } catch (error) {
        // Translation failed after the original was persisted. Mark it
        // and keep the id retryable: the same request again resumes here.
        retryable.add(msg.id);
        await ledger.append({
          ts: Date.now(),
          direction: "in",
          channel: msg.origin,
          messageId: msg.id,
          lang: "",
          body: errorCode(error),
          verdict: "failed",
        });
        send(res, 503, { error: "translation failed", code: errorCode(error), messageId: msg.id, retryable: true });
        return;
      }
      const policies = await recordFanout(msg, sender, routed.targets);
      retryable.delete(msg.id);
      send(res, 200, { ...routed, ...extra, policies, ...(resume ? { resumed: true } : {}) });
    } finally {
      inflight.delete(msg.id);
    }
  }

  const server = createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", config.hubOrigin);
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (req.method === "GET" && req.url === "/health") {
        send(res, 200, { ok: true, auth: authToken !== "" });
        return;
      }
      // Everything past /health is state: reads of the ledger, sends,
      // approvals, bindings. With a token configured, all of it is gated.
      if (authToken !== "" && bearerOf(req) !== authToken) {
        send(res, 401, { error: "unauthorized" });
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
        const all = await ledger.readAll();
        // Logical-order reads: write order scrambles under parallel
        // fan-out, so integrity lives in sorted reads, not file order.
        all.sort((a, b) => a.ts - b.ts || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0));
        send(res, 200, all);
        return;
      }
      // Ingress from any adapter: { origin, nativeId, lang, body, sender? }
      if (req.method === "POST" && req.url === "/ingress") {
        const event = ((await readJson(req)) ?? {}) as Record<string, unknown>;
        if (typeof event.origin !== "string" || typeof event.nativeId !== "string" || typeof event.body !== "string") {
          send(res, 400, { error: "origin, nativeId and body are required" });
          return;
        }
        const sender = asSender(event.sender);
        // Language is a property of the channel's user, not of the client:
        // bindings[origin] wins over the claimed lang (the kakao listener
        // hardcodes ko; an English-speaking room still reads as English).
        const lang = router.getBindings()[event.origin] ?? (typeof event.lang === "string" ? event.lang : "");
        const msg = makeMessage(event.origin, event.nativeId, lang, event.body, Date.now(), sender);
        await runIngress(msg, sender, res, {});
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
        const msg = makeMessage(COWORK, raw.nativeId, raw.lang, raw.body, Date.now(), sender);
        if (stripped.length > 0) {
          await ledger.append({
            ts: Date.now(),
            direction: "in",
            channel: COWORK,
            messageId: msg.id,
            lang: "",
            body: `stripped: ${stripped.join(",")}`,
            verdict: "stripped",
          });
        }
        await runIngress(msg, sender, res, { stripped });
        return;
      }
      // Hub outbound: { body, lang }. One path for every hub sentence:
      // record the draft as an inbound hub line, translate per bound
      // channel, then either write the sendable out lines right away
      // (no risk pattern) or hold every copy — with its back-translation
      // for review — until /confirm releases exactly those strings.
      if (req.method === "POST" && req.url === "/send") {
        const event = ((await readJson(req)) ?? {}) as Record<string, unknown>;
        if (typeof event.body !== "string" || event.body.trim() === "" || typeof event.lang !== "string") {
          send(res, 400, { error: "body and lang are required" });
          return;
        }
        const hubLang = router.hubLang();
        const msg = makeMessage(HUB, nextHubNativeId(), event.lang, event.body, Date.now());
        const id = msg.id;
        const matched = inspect(event.body);
        // Translation legs run concurrently under a cap; one leg's error
        // aborts the rest (fail-fast) and the request 500s via the outer
        // catch. Nothing has been written yet at that point, so a retry
        // starts clean.
        const gateConcurrency = Math.max(1, Number(env("GATE_CONCURRENCY", "4")) || 4);
        const limit = pLimit(gateConcurrency);
        const abort = new AbortController();
        const leg = async (channel: string, lang: string): Promise<RoundTrip> => {
          if (lang === event.lang) {
            return { channel, lang, translated: msg.body, backTranslation: msg.body, translateMs: 0, backMs: 0 };
          }
          const t0 = Date.now();
          const translated = await translate.translate(msg.body, msg.lang, lang, abort.signal);
          const t1 = Date.now();
          // Back-translation is review evidence: only produced for a hold.
          const backTranslation =
            matched.length > 0 ? await translate.translate(translated, lang, hubLang, abort.signal) : "";
          const t2 = Date.now();
          return { channel, lang, translated, backTranslation, translateMs: t1 - t0, backMs: t2 - t1 };
        };
        let roundTrips: RoundTrip[];
        try {
          roundTrips = await Promise.all(
            Object.entries(router.getBindings())
              .filter(([channel]) => channel !== HUB)
              .map(([channel, lang]) => limit(() => leg(channel, lang))),
          );
        } catch (error) {
          abort.abort();
          throw error;
        }
        const copies = roundTrips.map((r) => ({ channel: r.channel, lang: r.lang, body: r.translated }));
        await ledger.append({
          ts: msg.ts,
          direction: "in",
          channel: HUB,
          messageId: id,
          lang: msg.lang,
          body: msg.body,
        });
        seenIngress.add(id);
        if (matched.length === 0) {
          await ledger.append({
            ts: Date.now(),
            direction: "gate",
            channel: HUB,
            messageId: id,
            lang: msg.lang,
            body: msg.body,
            origin: HUB,
            verdict: "pass",
          });
          // The source carried nothing risky, but a translation still can
          // (a lost tag, an invented number): those copies are held one
          // by one and show up in /pending.
          const policies = await recordFanout(msg, undefined, copies);
          const held = policies.some((p) => p.policy === "held");
          send(res, 200, { held, id, matched, roundTrips: [], policies });
          return;
        }
        // Hold: one gate line per channel carrying the exact string that
        // would go out and what it reads back as. These lines are what a
        // restart rebuilds the pending entry from.
        for (const r of roundTrips) {
          await ledger.append({
            ts: Date.now(),
            direction: "gate",
            channel: r.channel,
            messageId: `${id}->${r.channel}`,
            lang: r.lang,
            body: r.translated,
            translatedLang: hubLang,
            translatedBody: r.backTranslation,
            origin: DRAFT,
            verdict: "hold",
          });
        }
        pending.set(id, { kind: "draft", body: msg.body, lang: msg.lang, copies, source: msg.body, matched });
        send(res, 200, { held: true, id, matched, roundTrips });
        return;
      }
      // Approval inbox: every held send, hub drafts and relay copies alike.
      if (req.method === "GET" && req.url === "/pending") {
        send(res, 200, { items: [...pending.entries()].map(([id, held]) => pendingView(id, held)) });
        return;
      }
      // Confirmation binds to the exact text that was reviewed. The request
      // carries the pending id only: a body in the request is rejected,
      // never substituted, so a caller cannot approve one sentence and
      // release another. Edits go back through /send (re-inspect, re-hold).
      if (req.method === "POST" && req.url === "/confirm") {
        const event = ((await readJson(req)) ?? {}) as Record<string, unknown>;
        if (typeof event.id !== "string") {
          send(res, 400, { error: "id is required" });
          return;
        }
        if ("body" in event) {
          send(res, 400, { error: "confirm takes the pending id only; edit via /send" });
          return;
        }
        const held = pending.get(event.id);
        if (!held) {
          send(res, 404, { error: "unknown pending id" });
          return;
        }
        // Record first, forget last: if a write fails the entry stays
        // pending and the confirm can be retried.
        await ledger.append({
          ts: Date.now(),
          direction: "gate",
          channel: held.kind === "copy" ? held.to : HUB,
          messageId: event.id,
          lang: held.lang,
          body: held.body,
          origin: held.kind === "copy" ? held.origin : DRAFT,
          verdict: "confirmed",
        });
        let released: string[];
        if (held.kind === "copy") {
          // A confirmed copy becomes the sendable out line it would have
          // been without the hold — same shape, same /outbox path.
          await ledger.append({
            ts: Date.now(),
            direction: "out",
            channel: held.to,
            messageId: event.id,
            lang: held.lang,
            body: held.body,
            translatedLang: held.lang,
            translatedBody: held.body,
            sender: held.sender,
            origin: held.origin,
          });
          router.markEmitted(event.id);
          released = [held.to];
        } else {
          // The reviewed translations go out verbatim. No re-translation:
          // what was approved is what is sent.
          const msg = { id: event.id, origin: HUB, body: held.body };
          const policies = await recordFanout(msg, undefined, held.copies, true);
          released = policies.map((p) => p.channel);
        }
        pending.delete(event.id);
        send(res, 200, { confirmed: true, released: held.kind === "copy" ? held.to : undefined, channels: released });
        return;
      }
      // Rejection: the held text is dropped, nothing goes out, the verdict
      // is on record. Same id-only contract as /confirm.
      if (req.method === "POST" && req.url === "/reject") {
        const event = ((await readJson(req)) ?? {}) as Record<string, unknown>;
        if (typeof event.id !== "string") {
          send(res, 400, { error: "id is required" });
          return;
        }
        const held = pending.get(event.id);
        if (!held) {
          send(res, 404, { error: "unknown pending id" });
          return;
        }
        await ledger.append({
          ts: Date.now(),
          direction: "gate",
          channel: held.kind === "copy" ? held.to : HUB,
          messageId: event.id,
          lang: held.lang,
          body: "",
          origin: held.kind === "copy" ? held.origin : DRAFT,
          verdict: "rejected",
        });
        pending.delete(event.id);
        send(res, 200, { rejected: true });
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
          nativeId?: string;
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
        // Native id of the message the executor created on the platform.
        // Delivered acks only: it feeds the echo set so the same message
        // is dropped when the platform hands it back through ingress.
        const nativeId =
          verdict === "delivered" && typeof event.nativeId === "string" && event.nativeId !== ""
            ? event.nativeId
            : undefined;
        if (nativeId !== undefined) router.markEmitted(`${event.channel}:${nativeId}`);
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
          ...(nativeId !== undefined ? { nativeId } : {}),
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
      if (error instanceof BodyTooLarge) {
        send(res, 413, { error: error.message });
        return;
      }
      send(res, 500, { error: (error as Error).message });
    }
  });

  server.listen(config.port, host, () => {
    // Operator-visible policy state: which corridors are open, whether
    // callers must authenticate. Pairs only, no message data, no token.
    const corridors = relay.map((p) => `${p.from}->${p.to}`).join(",") || "none";
    console.log(
      `index-messenger core listening on ${host}:${config.port} (relay: ${corridors}, auth: ${authToken !== "" ? "token" : "none"})`,
    );
  });
}

if (process.argv[1]?.endsWith("server.ts")) {
  await startServer({
    port: Number(env("PORT", "8787")),
    host: env("HOST", "127.0.0.1"),
    authToken: env("CORE_AUTH_TOKEN", ""),
    bindingsPath: env("BINDINGS_PATH", "./bindings.example.json"),
    ledgerPath: env("LEDGER_PATH", "./data/ledger.jsonl"),
    hubOrigin: env("HUB_ORIGIN", "http://localhost:5173"),
    relayPath: env("RELAY_PATH", "") || undefined,
  });
}
