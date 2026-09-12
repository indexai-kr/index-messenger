// Common message schema shared by hub, core and all adapters.
// Transport-agnostic: every adapter maps its native event to this shape.

export type ChannelId = string;

// Sender identity captured at the ingress edge (adapter-mapped).
// Optional: historic ledger lines predate it and stay sender-less.
export interface SenderInfo {
  platform: string;
  id: string;
  displayName: string;
}

export interface GatewayMessage {
  /** Stable dedup key: `${origin}:${nativeId}`. Echo suppression relies on it. */
  id: string;
  /** Channel that produced the message (e.g. "hub", "telegram", "discord"). */
  origin: ChannelId;
  /** BCP-47 language tag of `body` as received (e.g. "ko", "ja", "en"). */
  lang: string;
  /** Original body, never mutated by the pipeline. */
  body: string;
  /** Unix epoch milliseconds, set by the ingress edge. */
  ts: number;
  /** Who sent it, when known. Absent for pre-sender ledger history. */
  sender?: SenderInfo;
}

export interface RoutedMessage extends GatewayMessage {
  /** Per-target translated copies. */
  targets: TranslatedCopy[];
}

export interface TranslatedCopy {
  channel: ChannelId;
  lang: string;
  body: string;
}

export function makeMessage(
  origin: ChannelId,
  nativeId: string,
  lang: string,
  body: string,
  ts: number = Date.now(),
  sender?: SenderInfo,
): GatewayMessage {
  return { id: `${origin}:${nativeId}`, origin, lang, body, ts, sender };
}
