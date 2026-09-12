// Pluggable translation interface. The default implementation speaks to
// any OpenAI-compatible chat-completions endpoint via fetch — no vendor
// SDK, so the provider stays replaceable.

export interface TranslateProvider {
  translate(text: string, from: string, to: string): Promise<string>;
}

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export class OpenAICompatibleProvider implements TranslateProvider {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private timeoutMs: number;

  constructor(options: OpenAICompatibleOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  async translate(text: string, from: string, to: string): Promise<string> {
    if (from === to) return text;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: `Translate the user text from ${from} to ${to}. Reply with the translation only, no explanations.`,
            },
            { role: "user", content: text },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`translate http ${res.status}`);
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const out = data.choices?.[0]?.message?.content?.trim();
      if (!out) throw new Error("translate empty response");
      return out;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Deterministic stand-in for tests and offline demos.
export class PassthroughProvider implements TranslateProvider {
  async translate(text: string, from: string, to: string): Promise<string> {
    return `[${to}] ${text}`;
  }
}
