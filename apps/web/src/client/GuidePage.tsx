import {
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  FileCode2,
  KeyRound,
  Layers3,
  ListChecks,
  LockKeyhole,
  PlugZap,
  Server,
  ShieldCheck,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { ConsoleSample, ConsoleStatus } from '../shared/contracts.js';
import { workflowStages } from './workflow.js';

interface GuidePageProps {
  readonly status: ConsoleStatus | undefined;
  readonly samples: readonly ConsoleSample[];
  readonly hasActiveWorkflow: boolean;
  readonly onOpenWorkflow: () => void;
  readonly onOpenSample: (sampleId: string) => void;
}

const guideStepIcons: readonly LucideIcon[] = [
  FileCode2,
  ListChecks,
  ClipboardCheck,
  ShieldCheck,
  PlugZap,
];

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '확인 중';
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

export function GuidePage({
  status,
  samples,
  hasActiveWorkflow,
  onOpenWorkflow,
  onOpenSample,
}: GuidePageProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  return (
    <section className="guide-page" aria-labelledby="guide-title">
      <div className="guide-hero">
        <div className="guide-hero-copy">
          <span className="section-kicker">LOCAL MCP SETUP GUIDE</span>
          <h1 id="guide-title" ref={headingRef} tabIndex={-1}>
            API 계약에서 필요한 도구만 안전하게 연결하세요
          </h1>
          <p>
            이 콘솔은 source를 해석해 임의 요청 도구를 만드는 대신, 검증 가능한 capability와
            최소권한 연결 정책을 단계별로 만듭니다. 처음이라면 아래 순서대로 진행하세요.
          </p>
          <button
            className="primary-button guide-primary-action"
            type="button"
            onClick={onOpenWorkflow}
          >
            {hasActiveWorkflow ? '진행 중인 작업으로 돌아가기' : 'API 연결 시작'}
            <ArrowRight size={18} aria-hidden="true" />
          </button>
        </div>

        <aside className="guide-runtime-card" aria-label="현재 로컬 콘솔 상태">
          <div className="guide-runtime-heading">
            <span className={`runtime-dot ${status ? 'online' : ''}`} aria-hidden="true" />
            <strong>{status ? '로컬 런타임 준비됨' : '로컬 런타임 확인 중'}</strong>
          </div>
          <dl>
            <div>
              <dt>Adapters</dt>
              <dd>{status?.adapters.length ?? 0}</dd>
            </div>
            <div>
              <dt>Source limit</dt>
              <dd>{formatBytes(status?.limits.maxSourceBytes)}</dd>
            </div>
            <div>
              <dt>Examples</dt>
              <dd>{samples.length}</dd>
            </div>
            <div>
              <dt>Runtime</dt>
              <dd>{status?.runtime.mode ?? '확인 중'}</dd>
            </div>
          </dl>
          <p>
            <LockKeyhole size={16} aria-hidden="true" />
            Source 원문은 request 범위에서만 처리되고 managed artifact에는 저장되지 않습니다.
          </p>
        </aside>
      </div>

      <section className="guide-section" aria-labelledby="guide-flow-title">
        <div className="guide-section-heading">
          <span>5단계 흐름</span>
          <h2 id="guide-flow-title">등록부터 AI 도구 연결까지</h2>
          <p>
            각 단계의 결과가 다음 단계의 검증 입력이 되며, 제외한 operation은 runtime tool에도 남지
            않습니다.
          </p>
        </div>
        <ol className="guide-step-grid" aria-label="API 연결 단계">
          {workflowStages.map((step, index) => {
            const Icon = guideStepIcons[index] ?? FileCode2;
            return (
              <li key={step.number}>
                <div className="guide-step-top">
                  <span className="guide-step-icon" aria-hidden="true">
                    <Icon size={19} strokeWidth={1.9} />
                  </span>
                  <span className="guide-step-index">{String(index + 1).padStart(2, '0')}</span>
                </div>
                <strong>{step.guideTitle}</strong>
                <p>{step.guideDescription}</p>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="guide-detail-grid">
        <section className="panel guide-panel" aria-labelledby="guide-source-title">
          <div className="guide-panel-heading">
            <span className="guide-panel-icon" aria-hidden="true">
              <Layers3 size={20} />
            </span>
            <div>
              <h2 id="guide-source-title">어떤 API를 등록할 수 있나요?</h2>
              <p>지원 형식은 고정 목록이 아니라 현재 source adapter registry에서 결정됩니다.</p>
            </div>
          </div>
          {status && status.adapters.length > 0 ? (
            <ul className="guide-adapter-list" aria-label="사용 가능한 source adapters">
              {status.adapters.map((adapter) => (
                <li key={adapter}>
                  <CheckCircle2 size={16} aria-hidden="true" />
                  <code>{adapter}</code>
                  <span>사용 가능</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="guide-muted">Adapter registry를 확인하고 있습니다.</p>
          )}
          <div className="guide-callout">
            <FileCode2 size={18} aria-hidden="true" />
            <p>
              표준 계약이 없는 API도 declarative HTTP manifest로 method, path, schema, auth, risk를
              명시하면 같은 검증 pipeline을 사용할 수 있습니다.
            </p>
          </div>
          {samples.length > 0 ? (
            <div className="guide-samples">
              <h3>Repository 예제로 시작</h3>
              <div>
                {samples.map((sample) => (
                  <button key={sample.id} type="button" onClick={() => onOpenSample(sample.id)}>
                    <span>{sample.name}</span>
                    <small>{sample.sourceType}</small>
                    <ArrowRight size={15} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <section className="panel guide-panel" aria-labelledby="guide-selection-title">
          <div className="guide-panel-heading">
            <span className="guide-panel-icon" aria-hidden="true">
              <ListChecks size={20} />
            </span>
            <div>
              <h2 id="guide-selection-title">도구 선택은 어떻게 동작하나요?</h2>
              <p>선택은 화면 표시가 아니라 compiler input allowlist입니다.</p>
            </div>
          </div>
          <ul className="guide-check-list">
            <li>분석 직후에는 모든 operation이 선택됩니다.</li>
            <li>검색·Method·Tag·포함 상태 필터는 현재 분석 결과에서 동적으로 만들어집니다.</li>
            <li>
              큰 목록은 보이는 행만 렌더링하지만, “현재 결과” 작업은 필터와 일치하는 전체
              operation에 적용됩니다.
            </li>
            <li>
              선택 프리셋은 현재 analysis fingerprint와 exact operation ID가 모두 일치할 때만
              적용되며 새 operation을 자동 포함하지 않습니다.
            </li>
            <li>
              저장된 release와 비교하면 목적지·인증·위험, 입출력 스키마와 요청·응답 계약 변경을 현재
              선택과 독립적으로 검토할 수 있습니다.
            </li>
            <li>0개 선택, 중복·unknown ID, 오래된 분석 결과는 서버가 거부합니다.</li>
            <li>선택한 capability만 release, origin, credential, tools/list에 포함됩니다.</li>
          </ul>
          <p className="guide-muted">
            프리셋은 source 원문이나 credential 없이 최대{' '}
            {status?.limits.maxSelectionPresetsPerSource ?? '확인 중'}개까지 owner-only managed
            artifact store에 보관됩니다. 목록은 개수와 fingerprint만 가져오고 적용할 exact 한 건의
            ID만 지연 로드합니다.
          </p>
          <div className="guide-selection-example" aria-label="Operation 선택 예시">
            <div>
              <span className="guide-checkbox checked" aria-hidden="true">
                ✓
              </span>
              <span>
                <strong>조회 operation</strong>
                <small>MCP tool에 포함</small>
              </span>
            </div>
            <div>
              <span className="guide-checkbox" aria-hidden="true" />
              <span>
                <strong>관리 operation</strong>
                <small>Release에서 제외</small>
              </span>
            </div>
          </div>
        </section>
      </div>

      <section className="panel guide-connect-section" aria-labelledby="guide-connect-title">
        <div className="guide-connect-copy">
          <span className="guide-panel-icon" aria-hidden="true">
            <SquareTerminal size={21} />
          </span>
          <div>
            <span className="section-kicker">QUICK START</span>
            <h2 id="guide-connect-title">로컬 콘솔을 실행하고 연결 설정 내보내기</h2>
            <p>
              Repository에서 처음 실행한다면 build 후 web console을 시작합니다. 콘솔 마지막 단계에서
              생성된 JSON을 사용하는 MCP host 설정에 추가하세요.
            </p>
          </div>
        </div>
        <div className="guide-command" aria-label="로컬 콘솔 실행 명령">
          <span>Terminal</span>
          <pre>
            <code>{`pnpm build\npnpm web`}</code>
          </pre>
        </div>
        <ol className="guide-connect-steps">
          <li>
            <span>1</span>
            <p>
              <strong>Descriptor 추가</strong>내보낸 <code>mcpServers</code> JSON을 host의 MCP
              설정에 병합합니다.
            </p>
          </li>
          <li>
            <span>2</span>
            <p>
              <strong>환경 변수 주입</strong>화면에 표시된 이름으로 credential 값을 host process에
              제공합니다.
            </p>
          </li>
          <li>
            <span>3</span>
            <p>
              <strong>Host 재시작</strong>시작 시 profile과 release identity가 다시 검증되고 선택
              tool만 노출됩니다.
            </p>
          </li>
        </ol>
      </section>

      <div className="guide-detail-grid">
        <section className="panel guide-panel" aria-labelledby="guide-security-title">
          <div className="guide-panel-heading">
            <span className="guide-panel-icon" aria-hidden="true">
              <ShieldCheck size={20} />
            </span>
            <div>
              <h2 id="guide-security-title">연결 전 확인사항</h2>
              <p>값이 아니라 계약과 이름을 검토합니다.</p>
            </div>
          </div>
          <ul className="guide-check-list guide-security-list">
            <li>Source에 API key, token, 고객 데이터를 넣지 않습니다.</li>
            <li>선택 프리셋에도 source 원문, schema, endpoint, credential이 저장되지 않습니다.</li>
            <li>표시된 모든 exact origin을 확인하고 필요한 대상만 승인합니다.</li>
            <li>Credential 필드에는 실제 값이 아닌 환경 변수 이름만 입력합니다.</li>
            <li>쓰기·삭제 tool의 confirmation 정책과 side effect를 확인합니다.</li>
          </ul>
        </section>

        <section className="panel guide-panel" aria-labelledby="guide-troubleshooting-title">
          <div className="guide-panel-heading">
            <span className="guide-panel-icon" aria-hidden="true">
              <Server size={20} />
            </span>
            <div>
              <h2 id="guide-troubleshooting-title">자주 확인하는 문제</h2>
              <p>오류는 임의 fallback 대신 현재 단계에서 멈춥니다.</p>
            </div>
          </div>
          <div className="guide-faq">
            <details>
              <summary>분석이 실패합니다</summary>
              <p>
                Source 문법, adapter 선택, 필수 server와 response 계약을 확인한 뒤 다시 분석합니다.
              </p>
            </details>
            <details>
              <summary>등록 버튼이 비활성화됩니다</summary>
              <p>최소 한 개 operation을 선택하고 error severity diagnostic이 없는지 확인합니다.</p>
            </details>
            <details>
              <summary>저장한 선택 프리셋을 적용할 수 없습니다</summary>
              <p>
                Source가 바뀌어 이전 분석(stale) 상태가 된 프리셋입니다. 재검토에서 같은 ID로 남은
                후보와 사라진 선택을 확인하고, 후보 불러오기를 명시적으로 선택한 뒤 현재 계약을
                검토해 새 프리셋을 저장하세요. 새 operation은 자동 포함되지 않습니다.
              </p>
            </details>
            <details>
              <summary>AI 도구에 tool이 보이지 않습니다</summary>
              <p>
                Descriptor 경로와 필요한 환경 변수 이름을 확인하고 MCP host process를 재시작합니다.
              </p>
            </details>
          </div>
        </section>
      </div>

      <div className="guide-final-action">
        <div>
          <KeyRound size={18} aria-hidden="true" />
          <p>
            <strong>비밀값은 artifact에 저장되지 않습니다.</strong>실제 credential은 AI 도구 실행
            환경에서만 주입하세요.
          </p>
        </div>
        <button className="primary-button" type="button" onClick={onOpenWorkflow}>
          {hasActiveWorkflow ? '작업으로 돌아가기' : '첫 API 등록하기'}
          <ArrowRight size={18} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
