// Discord executor: the one process that actually calls the Discord API.
//
// Outbound: polls core `GET /outbox?channel=discord` (sendable lines only —
// hub/cowork sends and whitelisted relay copies; record-only copies never
// appear there), sends through the official REST API, then reports the
// outcome to `POST /outbox/ack` together with the id Discord assigned so
// the core can drop that message as an echo when it is read back.
//
// Inbound: polls the channel's messages (official REST, no gateway
// socket) and posts every human message to `POST /ingress` as
// origin=discord. What the core does with it is policy, not this file.
//
// Pacing lives here at the adapter edge: minimum gap between sends and a
// daily cap, neither removable below their floors. Logging is metadata
// only — message ids, counts, error codes. Never a body.
//
// Run: node --env-file=.env --experimental-strip-types ./adapters/discord/runner.ts

import { sendDiscord, toIngress, type DiscordEvent } from "./index.ts";

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function num(name: string, fallback: number, min: number, max: number): number {
  const value = Number(env(name, String(fallback)));
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function log(line: string): void {
  console.log(`${new Date().toISOString()} discord-runner ${line}`);
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // "discord send http 429" -> "http-429"; anything else -> its class.
  const http = /http (\d{3})/.exec(message);
  if (http) return `http-${http[1]}`;
  return error instanceof Error ? error.name : "error";
}

export interface RunnerConfig {
  botToken: string;
  channelId: string;
  core: string;
  /** Core bearer token (CORE_AUTH_TOKEN). Empty when the core runs open on loopback. */
  coreToken: string;
  pollSecs: number;
  minGapSecs: number;
  dailyCap: number;
  /** Replay sendable lines that predate this process. Default: start at now. */
  backfill: boolean;
}

export function configFromEnv(): RunnerConfig {
  return {
    botToken: env("DISCORD_BOT_TOKEN"),
    channelId: env("DISCORD_CHANNEL_ID"),
    core: env("CORE_BASE_URL", "http://localhost:8787").replace(/\/+$/, ""),
    coreToken: env("CORE_AUTH_TOKEN", ""),
    pollSecs: num("DISCORD_POLL_SECS", 3, 1, 60),
    // Floors: never faster than one send per second, never more than
    // 2000 a day. Settings can slow it down, not remove the limits.
    minGapSecs: num("DISCORD_MIN_GAP_SECS", 2, 1, 600),
    dailyCap: num("DISCORD_DAILY_CAP", 200, 1, 2000),
    backfill: env("DISCORD_BACKFILL", "0") === "1",
  };
}

interface OutboxItem {
  messageId: string;
  body: string;
  lang: string;
  ts: number;
  origin?: string;
}

interface DiscordMessage extends DiscordEvent {
  id: string;
}

const MAX_SEEN = 1000;

export class DiscordRunner {
  private readonly cfg: RunnerConfig;
  private sinceTs: number;
  private seen: string[] = [];
  private lastSendTs = 0;
  private day = "";
  private sentToday = 0;
  private lastInboundId: string | undefined;

  // No parameter properties: Node's strip-only TypeScript mode rejects them.
  constructor(cfg: RunnerConfig) {
    this.cfg = cfg;
    this.sinceTs = cfg.backfill ? 0 : Date.now();
  }

  private coreHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.coreToken !== "") headers.authorization = `Bearer ${this.cfg.coreToken}`;
    return headers;
  }

  private async postCore(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.cfg.core}${path}`, {
      method: "POST",
      headers: this.coreHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`core ${path} http ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  private async ack(messageId: string, ok: boolean, error = "", nativeId?: string): Promise<void> {
    await this.postCore("/outbox/ack", { messageId, channel: "discord", ok, error, nativeId });
  }

  private remember(messageId: string): boolean {
    if (this.seen.includes(messageId)) return false;
    this.seen.push(messageId);
    if (this.seen.length > MAX_SEEN) this.seen.shift();
    return true;
  }

  private rollDay(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.sentToday = 0;
    }
  }

  /** One outbound pass. Returns the number of messages actually sent. */
  async outboundTick(): Promise<number> {
    const res = await fetch(`${this.cfg.core}/outbox?channel=discord&since=${this.sinceTs}`, {
      headers: this.coreHeaders(),
    });
    if (!res.ok) throw new Error(`core /outbox http ${res.status}`);
    const { items } = (await res.json()) as { items: OutboxItem[] };
    items.sort((a, b) => a.ts - b.ts);
    let sent = 0;
    for (const item of items) {
      if (item.ts > this.sinceTs) this.sinceTs = item.ts;
      // Never execute a messageId twice, even if the server serves it again.
      if (!this.remember(item.messageId)) continue;
      this.rollDay();
      if (this.sentToday >= this.cfg.dailyCap) {
        await this.ack(item.messageId, false, "daily-cap");
        log(`blocked ${item.messageId} daily-cap`);
        continue;
      }
      const wait = this.cfg.minGapSecs * 1000 - (Date.now() - this.lastSendTs);
      if (wait > 0) await sleep(wait);
      try {
        const nativeId = await sendDiscord(
          { botToken: this.cfg.botToken, channelId: this.cfg.channelId },
          item.body,
        );
        this.lastSendTs = Date.now();
        this.sentToday += 1;
        sent += 1;
        await this.ack(item.messageId, true, "", nativeId);
        log(`sent ${item.messageId} origin=${item.origin ?? "-"} native=${nativeId ?? "-"}`);
      } catch (error) {
        const code = errorCode(error);
        await this.ack(item.messageId, false, code);
        log(`failed ${item.messageId} ${code}`);
      }
    }
    return sent;
  }

  private async discordGet(url: string): Promise<DiscordMessage[]> {
    const res = await fetch(url, { headers: { authorization: `Bot ${this.cfg.botToken}` } });
    if (res.status === 429) {
      const body = (await res.json()) as { retry_after?: number };
      await sleep(Math.ceil((body.retry_after ?? 1) * 1000));
      throw new Error("discord read http 429");
    }
    if (!res.ok) throw new Error(`discord read http ${res.status}`);
    return (await res.json()) as DiscordMessage[];
  }

  /** One inbound pass. Returns the number of messages posted to /ingress. */
  async inboundTick(): Promise<number> {
    const base = `https://discord.com/api/v10/channels/${this.cfg.channelId}/messages`;
    if (this.lastInboundId === undefined) {
      // Start at now: channel history is not ours to replay.
      const latest = await this.discordGet(`${base}?limit=1`);
      this.lastInboundId = latest[0]?.id ?? "0";
      log(`inbound cursor set at ${this.lastInboundId}`);
      return 0;
    }
    const batch = await this.discordGet(`${base}?after=${this.lastInboundId}&limit=50`);
    batch.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    let posted = 0;
    for (const message of batch) {
      this.lastInboundId = message.id;
      const payload = toIngress(message);
      if (payload === null) continue;
      const result = await this.postCore("/ingress", payload);
      posted += 1;
      const outcome =
        typeof result.dropped === "string" ? result.dropped : result.duplicate === true ? "duplicate" : "routed";
      log(`ingress ${payload.nativeId} ${outcome}`);
    }
    return posted;
  }
}

if (process.argv[1]?.endsWith("runner.ts")) {
  const cfg = configFromEnv();
  if (!cfg.botToken || !cfg.channelId) {
    console.error("DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID are required (see .env.example)");
    process.exit(1);
  }
  const runner = new DiscordRunner(cfg);
  log(
    `start core=${cfg.core} channel=${cfg.channelId} poll=${cfg.pollSecs}s gap=${cfg.minGapSecs}s cap=${cfg.dailyCap}/day backfill=${cfg.backfill}`,
  );
  for (;;) {
    try {
      await runner.outboundTick();
    } catch (error) {
      log(`outbound error ${errorCode(error)}`);
    }
    try {
      await runner.inboundTick();
    } catch (error) {
      log(`inbound error ${errorCode(error)}`);
    }
    await sleep(cfg.pollSecs * 1000);
  }
}
