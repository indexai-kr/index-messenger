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
   into each channel's bound language (`bindings[channel]` is the language
   of that channel's user; it also overrides the lang an adapter claims on
   ingress).
5. Every in/out/gate step appends a JSONL ledger entry (local file only).
6. Each `out` copy gets a send policy before an executor ever sees it
   (see *Relay* below). Executors (the kakao listener, the discord runner)
   only ever read `GET /outbox`, which serves sendable lines and nothing
   else.

## Relay — which derived copies may actually leave

Default is locked. A copy of an inbound message (origin = some channel,
not the hub) is written to the ledger for the converged view and marked
`verdict: record-only`: it shows up on the hub screen, it never reaches
`/outbox`, no executor sends it. Only hub- and cowork-originated copies
are sendable. This is the "hub-originated sends only" rule as code, not
as convention.

A relay whitelist (`RELAY_PATH`, JSON array of directional
`{from, to}` pairs, default `[]`) names the one exception: a copy whose
`(origin -> channel)` pair is listed becomes sendable and is server-tagged
`origin: relay` so it can never be mistaken for a hub send. Pairs are
one-way; a two-way bridge lists both:

```json
[{ "from": "kakao", "to": "discord" }, { "from": "discord", "to": "kakao" }]
```

The whitelist opens a named corridor, not the building. Nothing is ever
auto-forwarded because two channels happen to be bound; every open pair
is an explicit line in a file the operator wrote.

Relay copies bypass nothing:

- **Gate.** Risk patterns in the source or in the translated text write
  `gate|hold` and park the copy; `POST /confirm {id}` releases it as the
  same sendable line it would otherwise have been. Nothing leaves before.
- **Pacing.** Executors keep their edge limits (kakao: same-room interval,
  quiet hours, daily cap; discord: min gap, daily cap) regardless of
  origin.
- **Ledger.** Source and translation are recorded together, plus the
  policy decision and, on delivery, the platform-assigned native id.

Loop guard: an executor acks a delivered send with the `nativeId` the
platform assigned. The core remembers `<channel>:<nativeId>` (rebuilt
from the ledger on restart); when that message is read back through
`/ingress` it is dropped as `verdict: echo` — receipt only, no fan-out,
no re-relay. The discord adapter additionally drops bot-authored
messages before they reach the core.
