import type { ChannelId, GatewayMessage, RoutedMessage } from "./schema.ts";
import type { TranslateProvider } from "./translate/index.ts";

// Channel -> bound language. Loaded from a JSON config file so the
// binding table stays data, not code.
export type BindingTable = Record<ChannelId, string>;

export interface RouterOptions {
  bindings: BindingTable;
  translate: TranslateProvider;
  /** Hub channel id. Replies converge here. Defaults to "hub". */
  hubChannel?: string;
}

// Echo suppression: every message id this gateway instance has emitted
// is remembered. Inbound traffic carrying a known id is dropped before
// translation so our own sends never loop back.
export class Router {
  private seen = new Set<string>();
  private bindings: BindingTable;
  private translate: TranslateProvider;
  private hubChannel: string;

  constructor(options: RouterOptions) {
    this.bindings = { ...options.bindings };
    this.translate = options.translate;
    this.hubChannel = options.hubChannel ?? "hub";
  }

  /** Mark an outbound id as ours. Called by the fan-out path after send. */
  markEmitted(id: string): void {
    this.seen.add(id);
  }

  /** True when this inbound message is our own echo. */
  isEcho(message: GatewayMessage): boolean {
    return this.seen.has(message.id);
  }

  setBindings(bindings: BindingTable): void {
    this.bindings = { ...bindings };
  }

  getBindings(): BindingTable {
    return { ...this.bindings };
  }

  /**
   * Fan out one inbound message to every bound channel except its origin.
   * Returns the routed copies; the caller performs the actual sends and
   * then calls `markEmitted` for each emitted id.
   */
  async route(message: GatewayMessage): Promise<RoutedMessage> {
    const targets = Object.entries(this.bindings).filter(
      ([channel]) => channel !== message.origin,
    );
    const copies = await Promise.all(
      targets.map(async ([channel, lang]) => ({
        channel,
        lang,
        body:
          lang === message.lang
            ? message.body
            : await this.translate.translate(message.body, message.lang, lang),
      })),
    );
    return { ...message, targets: copies };
  }

  /** Convenience: hub is the Korean convergence point. */
  hubLang(): string {
    return this.bindings[this.hubChannel] ?? "ko";
  }
}
