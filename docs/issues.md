# Issue register (mirrors to GitHub Issues once the repo is pushed)

## #1 구조 토큰 보존 유실 (CLOSED 2026-09-17 — 게이트가 원문↔번역 토큰을 대조)

- 발견: P1 실측 에코 20연속 (2026-09-12), 원장 대조 확정.
  Discord 영어 팬아웃 20건 중 13건에서 `[P1 echo NN/20]` 접두 태그가
  번역 중 유실됨 (7건 보존). 동일 원문의 Telegram 일본어는 20/20 보존.
- 예시 (원장 기록):
  - 원문: `[P1 echo 04/20] 잘 도착하면 성공`
  - Discord 영어: `If it arrives well, it's a success.` (태그 유실)
  - Telegram 일본어: `[P1 echo 04/20] 無事に到着すれば成功` (태그 보존)
- 영향: 태그·번호·단위·금액·날짜 같은 구조 토큰이 번역에서 떨어지면,
  역번역 게이트도 떨어진 것을 기준으로 판단하게 된다. 관문이 눈감은
  봉투를 도장 찍는 셈이다.
- 결정: 코드는 지금 고치지 않는다 (P2 작업 범위). 공개 로드맵 P2 게이트
  기준에 "구조 토큰 보존 검증(태그·번호·단위·금액·날짜)"을 명기한다.
- 재현: `POST /ingress {origin:"hub", nativeId, lang:"ko", body:"[TAG] ..."}` →
  targets 중 discord(en) 복사본에서 `[TAG]` 유무 확인.
- 해결 (2026-09-17, `core/gate.ts` `tokensPreserved`/`inspectCopy`): 발신 가능한
  모든 복사본에 대해 원문과 번역의 숫자(구분자 제거)·대괄호 태그를 대조한다.
  태그 유실, 금액 환산(`5만원 → 50,000 KRW`), 번역이 만들어낸 숫자는
  `matched: tokens`로 hold. 역번역은 검토 증거로만 남고 판정은 이 대조가 한다.
  회귀: `core/gate.test.ts` "structural tokens" (이 이슈의 사례 포함).

## #2 허브 첫 폴링 500 (CLOSED 2026-09-13 — 1회 재시도 + 로딩 표시)

- 발견: P2-0 재실측. 헤드리스 촬영 1차 시도에서 허브 화면에 연결 오류가 떴다.
- 같은 시점 프록시 직접 조회는 200이었고, settling 후 재촬영은 정상 렌더됐다.
- 추정 원인: 콜드스타트 타이밍 (기동 직후 첫 폴링 실패), 현 UI는 실패 시 재시도 없이 에러 상태를 유지한다.
- 결정: 코드는 지금 고치지 않는다 (공개 로드맵 P4 범위).
- 해결 (P4): `hub/src/api.ts`의 모든 호출에 정확히 1회 재시도, `App.tsx`에
  로딩 표시 추가, 2회 연속 실패 시에만 오류 표시. 테스트
  `hub/src/api.test.ts` 2건(재시도 성공·무한 재시도 없음). 무한 재시도 없음.

## #4 승인 게이트 우회 — /confirm 본문 치환·인증 부재 (CLOSED 2026-09-17)

- 발견: 2026-09-16 검토 보고서 + 마스터 지적. `/confirm`이 요청의 `body`를
  재검사 없이 그대로 out 행에 썼고, 서버에 인증이 없어 도달 가능한 누구든
  검토한 문장을 다른 문장으로 바꿔 발신 대기열에 넣을 수 있었다.
- 해결: `/confirm`·`/reject`는 id만 받는다(body는 400). 승인은 저장된 검토
  문자열에만 성립. `HOST` 기본 loopback, LAN 개방은 `CORE_AUTH_TOKEN` 필수,
  토큰 설정 시 `/health` 외 전 경로 Bearer 검사, 본문 64 KB 상한.
  회귀: `core/relay.test.ts` "confirm binds to the reviewed text",
  `core/auth.test.ts`.

## #5 허브 발신 미연결·재시도 유실·게이트 우회·outbox 미접힘·카톡 재시도 우회 (CLOSED 2026-09-17)

- 발견: 2026-09-16 검토 보고서 P0 5건. 코드 대조로 전부 확인.
- 해결 커밋 순서: `/confirm` id 전용 → 인증·바인딩 → `/send`→outbox 통합
  경로 + `/pending`·`/reject` + 재시작 복구 → 전 경로 공통 게이트·정규식
  확장·토큰 대조 → 접수 내구성(원본 선저장·503 retryable·202 processing)
  + 실행기 커서/ack 보류 → `/outbox` 결과 접기·`seq` 커서·`/ledger?after=`
  → 카톡 `attempt()` 단일 경로(재시도도 dry-run·pacing·recordSend 통과,
  냉각 대기는 시도 횟수 미소모, 큐 초과는 `queue-overflow`로 보고, 단일
  poll loop).
- 남은 것(별도 이슈로 분리 예정): SQLite 원장, Discord Gateway 수신·SSE,
  번역 호출 공유·전역 동시성, 다중 방 결박, 카톡 수신 ID 안정화, traceId
  계측. 카톡 앱 변경은 실기기 재현 전.

## #3 getParcelableArray deprecated (OPEN, helper scope, no code fix)

- Location: apps/kakao-listener KakaoListener.kt message bundling (extras.getParcelableArray).
- Status: deprecated API in use; typed overload exists on newer platforms. Left as-is per directive — replacement needs an SDK to verify against, and this environment has none.
- Fix when an SDK-capable machine is available; keep behavior (multi-message burst injection) identical.
