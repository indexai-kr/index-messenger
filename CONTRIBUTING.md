# Contributing

English first for code and commit messages; Korean is welcome in issues.

## Setup

1. Copy `.env.example` to `.env` and fill in your own tokens. Never commit `.env`.
2. `npm install` at the repo root.
3. Core: `npm test --workspace @index-messenger/core`.
4. Hub: `npm run dev --workspace @index-messenger/hub`.

## Rules

- Public-grade material only. Do not bring in any internal INDEX specs,
  schemas, or wording.
- Official messenger APIs only. No protocol reversing, no unofficial
  endpoints — see `docs/adapters.md`.
- Every outbound behavior change must extend the echo test
  (`core/router.test.ts`) and keep the 20-message round trip loop-free.
- Gate pattern changes need 10 pass + 10 hold cases in `core/gate.test.ts`.
- ① No global auto-approve switch, ever. A pull request adding one —
  however framed — is rejected. Approval burden may be split by risk;
  approval itself is never delegated wholesale.
- ② Personal messenger adapters (including the KakaoTalk listener) stay
  free and non-commercial community property forever: no sale, no paid
  installation agency.
- ③ Patent-protected implementations (safe-latch, spacetime-coordinate
  constructs and the like) are never admitted to this repository. Such a
  pull request is rejected. Rationale: this repository structurally
  excludes patent implementations so that the Apache-2.0 patent grant
  stays bounded to contributions made inside it.
- Run the secret scan before every push (see README checklist).
