# HiMCP 사용 가이드

[English](usage-guide.md) | **한국어**

HiMCP는 API 계약을 분석하고, 사용자가 검토한 operation만 검증 가능한 MCP tool로 내보내는 로컬 도구입니다. 이 문서는 웹 콘솔을 기준으로 source 준비부터 AI 도구 연결까지 설명합니다.

> HiMCP는 초기 알파입니다. 실제 시스템에 연결하기 전에 source, operation, 실행 origin, 인증 이름과 부작용을 모두 검토하세요.

## 1. 설치하고 로컬 콘솔 열기

요구 사항은 Node.js 22 이상과 pnpm 11입니다.

```bash
corepack enable
pnpm install
pnpm build
pnpm web
```

브라우저에서 다음 주소를 엽니다.

- 콘솔: [http://127.0.0.1:4173](http://127.0.0.1:4173)
- 인앱 사용 가이드: [http://127.0.0.1:4173/guide](http://127.0.0.1:4173/guide)

`HIMCP_WEB_PORT`로 포트를, `HIMCP_WEB_DATA_DIR`로 managed artifact 디렉터리를 바꿀 수 있습니다. 서버는 설정과 관계없이 loopback이 아닌 주소에 bind하지 않습니다.

## 2. 어떤 API를 등록할 수 있나요?

지원 형식은 화면에 고정된 API 카탈로그가 아니라 실행 중인 source adapter registry에서 결정됩니다. 현재 기본 registry는 다음 경로를 제공합니다.

- OpenAPI 3.x 문서는 그대로 분석합니다.
- OpenAPI가 없는 HTTP API는 declarative HTTP manifest로 method, path, server, request/response schema, auth와 risk를 명시합니다.
- 새로운 계약 형식은 source adapter를 추가해 같은 정규화·검증 pipeline에 연결할 수 있습니다.

따라서 REST뿐 아니라 명시적인 HTTP 요청으로 표현할 수 있는 GraphQL, SOAP/XML, form, JSON, text, canonical base64 body 등의 operation도 manifest로 등록할 수 있습니다. 반면 native gRPC, WebSocket, SDK 전용 호출, 임의 스크립트 실행처럼 현재 검증된 HTTP 실행 모델로 표현되지 않는 transport는 자동으로 우회 실행하지 않고 거부합니다.

중요한 원칙은 "모든 입력을 무조건 실행"하는 것이 아니라, 계약으로 표현하고 검증할 수 있는 API를 동적으로 adapter에 연결하는 것입니다.

## 3. 시작 전에 준비할 것

다음 중 하나를 준비합니다.

- OpenAPI 3.x JSON 또는 YAML 문서
- HTTP manifest JSON 또는 YAML 문서
- 콘솔이 현재 API에서 제공하는 repository 예제

Source에는 API key, token, cookie 값, 고객 데이터나 운영 비밀을 넣지 마세요. Source에서 파생한 schema와 설명은 검증 artifact에 남을 수 있습니다. 인증은 4단계에서 실제 값이 아닌 **환경 변수 이름**만 연결합니다.

## 4. 5단계로 MCP 연결 만들기

### STEP 1. API source 등록

1. 계약을 편집기에 붙여넣거나 UTF-8 JSON/YAML 파일을 업로드합니다.
2. `자동 감지`를 사용하거나, 자동 감지가 모호할 때 현재 registry가 제공하는 adapter ID를 명시적으로 선택합니다.
3. 표시 파일명과 source 용량을 확인한 뒤 `API 분석`을 누릅니다.

가이드 페이지의 repository 예제 버튼은 서버가 반환한 예제 목록에서 동적으로 생성됩니다. 예제를 선택하면 source 단계로 이동하고 해당 계약을 불러옵니다.

### STEP 2. 분석 결과와 operation 선택

분석 결과에서 문서 fingerprint, server origin, 인증 scheme, 진단과 정규화된 operation을 확인합니다. 모든 operation은 처음에 선택되며 다음 기능으로 MCP에 필요한 범위를 줄일 수 있습니다.

- operation ID, 요약, 설명, method, path와 tag 검색
- 분석 결과에서 동적으로 생성한 HTTP method와 tag 필터
- 포함됨/제외됨 상태 필터
- 개별 checkbox 또는 현재 결과/전체 범위 일괄 선택과 해제

기존에 등록한 release가 있다면 `저장된 release와 계약 비교`에서 기준을 선택할 수 있습니다. 서버는 저장된 release를 다시 검증하고 현재 source를 다시 정규화한 뒤 결정론적 baseline을 만들어 비교합니다. 목적지·인증·위험 정책은 보안 재검토, 요청/응답·입출력 스키마와 삭제는 호환성 영향, 기준 release에 없던 capability는 신규로 구분합니다. 비교는 선택 상태를 바꾸지 않습니다. 특히 subset release와 비교한 `신규`는 과거 source에 정말 없었다는 뜻이 아니라 기준 release에 포함되지 않았다는 뜻일 수 있습니다.

큰 계약에서도 브라우저 상태는 `전체 포함/제외` 기본값과 그 반대인 operation만 보관하는 sparse selection으로 관리됩니다. Operation 표는 실제 가변 높이를 측정해 현재 화면, overscan, 키보드 focus 대상에 필요한 행만 DOM에 렌더링합니다. 단, `현재 결과 선택/해제`는 화면에 렌더링된 행만이 아니라 검색과 필터에 맞는 전체 결과에 적용됩니다. 방향키, Home/End, Page Up/Down으로 checkbox focus를 이동할 수 있으며, resize observation을 사용할 수 없는 브라우저에서는 전체 목록으로 안전하게 fallback합니다.

선택은 UI 표시 옵션이 아니라 compiler input allowlist입니다. 서버는 source를 다시 분석하고 review fingerprint와 exact operation ID를 검증합니다. 0개 선택, 중복·unknown ID, 오래된 분석 결과는 등록하지 않습니다.

#### 반복해서 쓰는 선택을 프리셋으로 저장하기

1. 필요한 operation을 선택하고 프리셋 이름을 입력합니다.
2. `현재 선택 저장`을 누릅니다.
3. 같은 source를 다시 분석했을 때 `선택 프리셋`에서 이름을 고르고 `적용`을 누릅니다.
4. 적용 직후 선택이 예상과 다르면 `적용 취소`로 직전 상태를 복구합니다.

프리셋은 필터 규칙이 아니라 **저장 시점의 exact operation ID allowlist**입니다. 저장 요청도 서버가 source를 다시 분석하고 등록과 동일한 selection verifier를 통과해야 합니다. 같은 이름·같은 분석에서 다른 선택으로 덮어쓰지 않으며, 변경하려면 기존 프리셋을 두 번 확인해 삭제한 뒤 새 선택을 저장합니다.

프리셋 목록은 이름, 포함 개수와 fingerprint metadata만 가져옵니다. 수만 개 ID를 가진 여러 revision이 브라우저 메모리에 동시에 쌓이지 않도록, `적용`할 때 현재 analysis fingerprint와 목록에서 받은 selection fingerprint가 모두 일치하는 exact 프리셋 한 건의 ID만 지연 로드합니다.

같은 discovery scope에서 analysis fingerprint가 다른 기존 프리셋은 `이전 분석 · 적용 불가`로 보이며 직접 적용할 수 없습니다. `재검토`를 누르면 서버가 현재 source와 scope, 현재 analysis fingerprint, 저장된 selection fingerprint를 다시 확인하고, 이전 선택 ID 중 현재에도 같은 ID로 존재하는 항목만 후보로 보여줍니다. `재검토 후보 불러오기`는 별도의 명시적 동작이며, 과거에 선택하지 않았던 현재 operation은 모두 제외합니다. 같은 ID라도 계약이 바뀌었을 수 있으므로 위 release 비교와 operation 계약을 확인한 뒤 새 프리셋을 저장해야 합니다. 비슷한 ID를 추정하거나 새 operation을 자동 포함하지 않습니다.

Discovery scope는 adapter, source kind, 정규화된 표시 파일명·title, canonical document-level origin으로 만든 비권한성 lookup key입니다. root origin이 없을 때만 operation origin 집합을 fallback으로 사용합니다. version이나 operation만 바뀌면 이전 프리셋을 stale로 찾을 수 있지만, 파일명·title·root origin이 바뀌면 다른 API lineage로 보고 새 scope를 시작합니다. 같은 identity hint를 재사용해 관련 없는 stale 프리셋이 보이더라도 exact analysis fingerprint 검증 없이는 적용되지 않습니다.

### STEP 3. 실행 계약 검토

선택한 각 capability에서 다음 정보를 확인합니다.

- MCP tool 이름, 제목과 설명
- HTTP method, path와 exact server
- input/output JSON Schema
- 필요한 인증 scheme
- side effect, risk와 confirmation 요구 여부
- source provenance

제외한 operation은 release와 compilation evidence, MCP `tools/list`에 포함되지 않습니다.

### STEP 4. 연결 정책 승인

1. AI 도구에서 구분할 표시 이름과 선택 설명을 입력합니다.
2. release에서 파생한 모든 exact origin을 하나씩 확인합니다.
3. credential binding마다 실제 비밀값이 아닌 환경 변수 이름만 입력합니다.
4. 쓰기·삭제 등 confirmation이 필요한 tool의 정책을 검토합니다.
5. 평문 HTTP origin이 있다면 전송 위험을 별도로 승인합니다.

Origin은 hostname만이 아니라 scheme, host와 port가 모두 일치해야 합니다. Profile에 포함되지 않은 목적지는 runtime에서 허용되지 않습니다.

### STEP 5. MCP 설정 내보내기

마지막 화면에서 product-neutral `mcpServers` JSON을 복사하거나 다운로드합니다. 이 descriptor는 검증된 profile을 실행하는 launcher 정보만 포함하고 credential 값은 포함하지 않습니다.

## 5. AI 도구에 연결하기

AI 도구마다 설정 파일 위치와 UI는 다르므로 HiMCP는 특정 제품 경로를 하드코딩하지 않습니다. 콘솔이 생성한 descriptor를 authoritative 설정으로 사용하세요.

1. 내보낸 JSON의 `mcpServers` 항목을 사용 중인 AI 도구의 MCP 설정에 병합합니다.
2. 마지막 화면의 `필요한 환경 변수` 이름마다 값을 secret-aware 실행 환경에 주입합니다.
3. AI 도구 또는 MCP host process를 재시작합니다.
4. host의 tool 목록에서 선택한 operation만 보이는지 확인합니다.
5. 쓰기 또는 삭제 tool은 승인 정책과 실제 upstream 영향을 확인한 뒤 호출합니다.

설정 파일 위치, 환경 변수 전달 방식과 MCP reload 방법은 사용하는 AI 도구의 최신 문서를 확인하세요. Descriptor 안의 실행 파일이나 profile 경로를 임의로 바꾸면 startup identity 검증이 실패할 수 있습니다.

## 6. 정상 연결 확인

정상적인 연결은 다음 조건을 만족합니다.

- MCP initialize가 성공합니다.
- `tools/list`에 선택한 capability만 나타납니다.
- 제외한 tool을 이름으로 직접 호출해도 runtime이 unknown capability로 거부합니다.
- 인증 값이 필요한 경우 profile에 선언된 이름의 환경 변수만 읽습니다.
- 실행 대상은 profile에서 승인한 exact origin과 일치합니다.

Repository 테스트는 전체 API를 분석한 뒤 일부 operation만 release로 컴파일하고, 실제 JSON-lines stdio MCP transport에서 initialize와 `tools/list`를 수행합니다. 제외한 tool 호출이 HTTP executor에 도달하기 전에 실패하는 경계도 함께 검증합니다.

## 7. 자주 발생하는 문제

| 증상                             | 확인할 내용                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `API 분석`이 비활성화됨          | source가 비어 있지 않은지, 파일명이 있는지, 화면에 표시된 용량 제한을 넘지 않았는지 확인합니다.        |
| 자동 감지가 실패함               | source 형식과 버전을 확인하고, 현재 adapter 목록에서 명시적인 source type을 선택합니다.                |
| 등록 버튼이 비활성화됨           | operation을 하나 이상 선택하고 error severity diagnostic을 해결합니다.                                 |
| stale 분석 오류가 발생함         | source가 분석 뒤 바뀌었습니다. 현재 source로 다시 분석하고 선택을 검토합니다.                          |
| 프리셋을 적용할 수 없음          | `이전 분석 · 적용 불가`이면 재검토 후보를 불러오고 현재 계약을 확인한 뒤 새 프리셋을 저장합니다.       |
| 같은 이름의 프리셋 저장이 충돌함 | 프리셋은 덮어쓰지 않습니다. 기존 항목을 확인 후 삭제하거나 다른 이름으로 현재 exact 선택을 저장합니다. |
| HTTP origin 승인이 필요함        | 평문 전송을 피할 수 있는지 먼저 확인하고, 불가피한 로컬 개발 환경에서만 위험을 명시적으로 승인합니다.  |
| AI 도구에 tool이 보이지 않음     | descriptor 병합 위치, profile 경로, 필요한 환경 변수와 host 재시작 여부를 확인합니다.                  |
| 호출 시 credential 오류가 발생함 | 실제 값이 descriptor나 profile이 아니라 MCP host process 환경에 주입되었는지 확인합니다.               |
| 제외한 tool이 호출되지 않음      | 의도한 동작입니다. source를 다시 분석하고 operation을 포함한 새 release/profile을 만드세요.            |

## 8. 로컬 보안 경계

웹 콘솔은 원격 운영 서비스가 아니라 loopback 전용 설정 도구입니다.

- 공개 reverse proxy나 외부 hosting에 연결하지 않습니다.
- source 원문은 request 범위에서 처리하고 콘솔 managed artifact에 저장하지 않습니다.
- release, profile, descriptor와 selection preset은 기본적으로 `.himcp/console` 아래 owner-only 권한으로 저장합니다.
- 프리셋은 `.himcp/console/selection-presets/<scope>/<preset>/preset.json`에 저장되며 exact operation ID와 fingerprint는 포함하지만 raw source, schema, origin, auth contract, credential 이름이나 값은 포함하지 않습니다.
- 브라우저에는 credential 값, 임의 launcher command, 실행 모듈 선택이나 임의 output path 필드가 없습니다.
- POST와 DELETE를 포함한 모든 mutation 요청은 loopback Host, exact same-origin과 process별 CSRF token을 검증합니다.
- 이 경계는 단일 OS 사용자용입니다. 같은 사용자 권한으로 실행되는 다른 process가 managed artifact를 변경하는 것까지 막는 저장소는 아닙니다.

더 자세한 경계는 [Security model](security-model.md)과 [Architecture](architecture.md)를 참고하세요.

## 모바일 화면

같은 가이드와 workflow를 별도 모바일 DOM 없이 반응형 레이아웃으로 제공합니다. 작은 화면에서도 메뉴와 CTA는 44px 이상의 터치 영역을 유지하고, 가로 스크롤 없이 단계 카드를 한 열로 표시합니다.
