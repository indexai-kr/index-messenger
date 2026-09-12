# Adapter guide + LOC comparison

## How to add an adapter

1. Create `adapters/<name>/index.ts` with two functions:
   - `send<Name>(config, text)` — official send API only.
   - `toIngress(nativeEvent)` — map to `{ origin, nativeId, lang, body }`
     or return `null` for non-message events.
2. POST ingress events to core `POST /ingress`.
3. Poll core `GET /ledger` (or accept fan-out callbacks) for outbound work,
   then call `markEmitted`-equivalent dedup on your side if you keep a queue.
4. Never add protocol reversing, packet capture, or unofficial endpoints.
   Closed messengers are notification-listener / accessibility-API only.

## LOC comparison (measured with `wc -l`, comments included)

| Adapter | Method | LOC | Status |
|---|---|---:|---|
| telegram | official Bot API | 65 (+53 discover helper) | P1 implemented |
| discord | official REST API | 42 | P1 implemented |
| slack | official Web API | 37 | P2 implemented |
| kakao-listener | Android notification + RemoteInput (`apps/kakao-listener`) | 523 Kotlin | P3 implemented, device test pending |

The asymmetry between the three one-file official adapters above and the
separate-app closed-platform adapter is the documented evidence for the
declaration's barrier argument: open APIs take dozens of lines, closed
ones take an app.
