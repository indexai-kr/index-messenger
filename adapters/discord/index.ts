// Discord adapter (official REST API only, P1).
// Outbound: POST /channels/{id}/messages. Inbound: gateway MESSAGE_CREATE
// forwarded to core /ingress by the runner (runner not included in LOC).

export interface DiscordConfig {
  botToken: string;
  channelId: string;
}

// Returns the id Discord assigned to the created message: the executor
// reports it in /outbox/ack so the core drops it as an echo when the
// same message is read back from the channel.
export async function sendDiscord(
  config: DiscordConfig,
  text: string,
): Promise<string | undefined> {
  const res = await fetch(
    `https://discord.com/api/v10/channels/${config.channelId}/messages`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bot ${config.botToken}`,
      },
      body: JSON.stringify({ content: text }),
    },
  );
  if (!res.ok) throw new Error(`discord send http ${res.status}`);
  const created = (await res.json()) as { id?: string };
  return created.id;
}

export interface DiscordAuthor {
  id?: string;
  username?: string;
  global_name?: string;
  bot?: boolean;
}

export interface DiscordEvent {
  id?: string;
  content?: string;
  author?: DiscordAuthor;
}

export interface IngressPayload {
  origin: string;
  nativeId: string;
  lang: string;
  body: string;
  sender?: { platform: string; id: string; displayName: string };
}

export function toIngress(event: DiscordEvent): IngressPayload | null {
  if (!event.content) return null;
  const author = event.author;
  // Belt to the core's echo set (suspenders): bot-authored messages are
  // our own sends or other automation, never a person to relay.
  if (author?.bot === true) return null;
  return {
    origin: "discord",
    nativeId: event.id ?? String(Date.now()),
    lang: "en",
    body: event.content,
    sender:
      author?.id !== undefined
        ? {
            platform: "discord",
            id: author.id,
            displayName: author.global_name ?? author.username ?? author.id,
          }
        : undefined,
  };
}
