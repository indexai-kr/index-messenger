const BASE = "";

// Cold-start tolerance (issues #2): the very first poll can hit a proxy
// that is not ready yet. Exactly one retry, then the error stands —
// no infinite loops, no silent swallowing.
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let lastError: unknown = new Error("hub api unreachable");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${BASE}/api${path}`, {
        headers: { "content-type": "application/json" },
        ...init,
      });
      if (!res.ok) throw new Error(`hub api ${res.status}`);
      return (await res.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastError;
}

export interface LedgerEntry {
  ts: number;
  direction: string;
  channel: string;
  messageId: string;
  body: string;
  verdict?: string;
  sender?: { platform: string; id: string; displayName: string };
}

export interface RoundTrip {
  channel: string;
  lang: string;
  translated: string;
  backTranslation: string;
  translateMs: number;
  backMs: number;
}

export interface SendResult {
  held: boolean;
  id: string;
  matched: string[];
  roundTrips: RoundTrip[];
}

export interface PendingItem {
  id: string;
  kind: "relay" | "fanout";
  to?: string;
  lang: string;
  body?: string;
  source: string;
  matched: string[];
  copies?: Array<{ channel: string; lang: string; body: string }>;
  sender?: { platform: string; id: string; displayName: string };
}

export const api = {
  pending: () => call<{ items: PendingItem[] }>("/pending"),
  reject: (id: string) =>
    call<{ rejected: boolean }>("/reject", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
  health: () => call<{ ok: boolean }>("/health"),
  bindings: () => call<Record<string, string>>("/bindings"),
  saveBindings: (b: Record<string, string>) =>
    call<Record<string, string>>("/bindings", {
      method: "POST",
      body: JSON.stringify(b),
    }),
  ledger: () => call<LedgerEntry[]>("/ledger"),
  send: (body: string, lang: string) =>
    call<SendResult>("/send", {
      method: "POST",
      body: JSON.stringify({ body, lang }),
    }),
  // Approval is by id only: the server releases the text it held, never
  // a text supplied here.
  confirm: (id: string) =>
    call<{ confirmed: boolean }>("/confirm", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
};
