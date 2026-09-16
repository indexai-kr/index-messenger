// Outbound gate (P2): hold messages that carry high-risk patterns
// (amounts, times, dates, addresses) for human confirmation, or whose
// translation lost a structural token. Everything else passes — a bare
// number ("25", "20분 뒤") is not a reason to hold; it is a token that
// must survive translation, and tokensPreserved() enforces that. Typos
// are sent as translated, never corrected: the source is immutable.
// Every verdict is ledger-logged.

export type GateVerdict = "pass" | "hold";

export interface GateDecision {
  verdict: GateVerdict;
  /** Back-translation shown in the hub for confirmation. */
  backTranslation: string;
  matched: string[];
}

// Currency words that may follow a number. English words are guarded
// against running into a longer word ("wonder" is not "won").
const CURRENCY_AFTER =
  "(?:원|엔|달러|유로|위안|파운드|₩|¥|\\$|€|£|USD|KRW|JPY|EUR|GBP|CNY|dollars?|bucks|won|yen|euros?|pounds?|yuan)(?![A-Za-z])";
const CURRENCY_BEFORE = "(?:[$€£₩¥]|USD|KRW|JPY|EUR|GBP|CNY)\\s?";
const KO_SCALE = "(?:\\s*(?:만|천|백|억|조))*";

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "amount",
    re: new RegExp(
      `(?:${CURRENCY_BEFORE}\\d[\\d,.]*)|(?:\\d[\\d,.]*${KO_SCALE}\\s*${CURRENCY_AFTER})|(?:(?:^|[^\\d])(?:만|천|억|조)\\s*(?:원|엔|달러))`,
      "i",
    ),
  },
  {
    name: "time",
    re: /(\d{1,2}\s*시|\d{1,2}:\d{2}|내일|모레|오늘\s*(?:밤|저녁|아침|오후|오전)|다음\s?주|\d{1,2}\s?(?:am|pm)(?![a-z])|(?:^|[^a-z])at\s+\d{1,2}(?![\d:])|(?:^|[^a-z])(?:tomorrow|tonight|next\s+(?:week|month|mon|tue|wed|thu|fri|sat|sun))(?![a-z])|明日|明後日|来週|\d{1,2}時)/i,
  },
  {
    name: "date",
    re: /(\d{1,4}년|\d{1,2}월\s?\d{1,2}일|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:^|[^a-z])(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?![\d:])|\d{1,2}月\s?\d{1,2}日)/i,
  },
  { name: "address", re: /(시|구|동|로|길)\s*\d|https?:\/\/\S+/ },
];

export function inspect(text: string): string[] {
  return PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}

// Structural tokens: the parts of a sentence a translation must carry
// through unchanged. Numbers are compared as digit strings with grouping
// removed ("120,000" == "120000"); bracket tags ("[P1 echo 04/20]") are
// compared verbatim. Currency words are not normalised here — a changed
// currency shows up as a changed or missing number and holds.
export interface StructuralTokens {
  numbers: string[];
  tags: string[];
}

export function extractTokens(text: string): StructuralTokens {
  const numbers = (text.match(/\d[\d,.]*\d|\d/g) ?? []).map((n) => n.replace(/[,.]/g, "").replace(/^0+(?=\d)/, ""));
  const tags = text.match(/\[[^\]\n]{1,80}\]/g) ?? [];
  return { numbers, tags };
}

// True when every number and tag in the source is present in the
// translation, and the translation introduces no number of its own.
// A "[en] " passthrough prefix is a tag added by the translator, not by
// the sender, so added tags are tolerated; added numbers are not.
export function tokensPreserved(source: string, translated: string): boolean {
  const a = extractTokens(source);
  const b = extractTokens(translated);
  const multiset = (xs: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const an = multiset(a.numbers);
  const bn = multiset(b.numbers);
  for (const [n, count] of an) if ((bn.get(n) ?? 0) < count) return false;
  for (const [n, count] of bn) if ((an.get(n) ?? 0) < count) return false;
  for (const tag of a.tags) if (!translated.includes(tag)) return false;
  return true;
}

// Patterns that hold a translated copy: anything risky in the source or
// the translation, plus "tokens" when the translation lost or invented a
// structural token. Back-translation stays review evidence; this check is
// what actually decides.
export function inspectCopy(source: string, translated: string): string[] {
  const matched = new Set<string>([...inspect(source), ...inspect(translated)]);
  if (source !== translated && !tokensPreserved(source, translated)) matched.add("tokens");
  return [...matched];
}

export interface BackTranslator {
  (text: string, lang: string, hubLang: string): Promise<string>;
}

export async function decide(
  text: string,
  lang: string,
  hubLang: string,
  backTranslate: BackTranslator,
): Promise<GateDecision> {
  const matched = inspect(text);
  if (matched.length === 0) {
    return { verdict: "pass", backTranslation: text, matched };
  }
  const backTranslation = await backTranslate(text, lang, hubLang);
  return { verdict: "hold", backTranslation, matched };
}
