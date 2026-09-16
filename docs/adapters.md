# Adapter guide + LOC comparison

## How to add an adapter

1. Create `adapters/<name>/index.ts` with two functions:
   - `send<Name>(config, text)` — official send API only.
   - `toIngress(nativeEvent)` — map to `{ origin, nativeId, lang, body }`
     or return `null` for non-message events.
2. POST ingress events to core `POST /ingress`.
3. Poll core `GET /outbox?channel=<name>&after=<seq>` for outbound work —
   it serves undecided sendable lines only (hub/cowork sends and
   whitelisted relay copies; record-only copies never appear; sends you
   already acked are folded out). Report every outcome to
   `POST /outbox/ack`, with the platform-assigned `nativeId` on success so
   the core can drop your own send when it comes back through ingress.
   Keep a per-id dedupe on your side: never execute a messageId twice.
   If the ack itself fails after a successful send, keep it and retry
   the ack — never re-send to find out. Advance your inbound cursor only
   after the core accepted the post.
   With `CORE_AUTH_TOKEN` set on the core, send `Authorization: Bearer`.
4. Never add protocol reversing, packet capture, or unofficial endpoints.
   Closed messengers are notification-listener / accessibility-API only.

The adapter file is pure (map + send); the process that runs the loop is
the *executor*. `adapters/discord/runner.ts` is the reference executor:
outbox poll → send → ack, channel poll → ingress, edge pacing with floors,
metadata-only logs. The kakao listener app is the same shape on a phone.

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
