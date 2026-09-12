# Architecture — 4 layers

```
┌─────────────────────────────────────────────┐
│ L1 Adapters  telegram · discord · slack     │  official APIs only
│              kakao-listener (P3, separate)  │  notification + RemoteInput
├─────────────────────────────────────────────┤
│ L2 Core      schema → gate → router         │  origin/lang/body/ts
│              bindings (channel → lang)      │  data, not code
├─────────────────────────────────────────────┤
│ L3 Translate pluggable interface            │  OpenAI-compatible default
│              back-translation for the gate  │
├─────────────────────────────────────────────┤
│ L4 Gate + Ledger  hold on risk patterns     │  verdicts in local JSONL
│              hub confirmation → fan-out     │
└─────────────────────────────────────────────┘
```

Message flow:

1. Adapter maps a native event to `GatewayMessage { id, origin, lang, body, ts }`.
2. Core drops the event when `id` is a known echo of our own send.
3. Hub outbound passes the gate: risky patterns hold for confirmation
   with a back-translation; the verdict is ledger-logged either way.
4. Router fans out to every bound channel except the origin, translating
   into each channel's bound language.
5. Every in/out/gate step appends a JSONL ledger entry (local file only).
