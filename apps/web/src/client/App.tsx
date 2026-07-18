import {
  Activity,
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Check,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  CloudUpload,
  Code2,
  Database,
  Download,
  FileCode2,
  FileJson2,
  GitCompareArrows,
  Info,
  KeyRound,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Save,
  Search,
  Server,
  ShieldCheck,
  SquareTerminal,
  TriangleAlert,
  Trash2,
  Undo2,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import {
  useEffect,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from 'react';

import type {
  AnalysisResponse,
  CapabilitySummary,
  ConnectionRequest,
  ConnectionResponse,
  ConsoleDiagnostic,
  ConsoleSample,
  ConsoleStatus,
  ContractDiffResponse,
  RegistrationDetail,
  RegistrationSummary,
  SelectionPresetSummary,
  SelectionPresetReviewResponse,
  SourceRequest,
} from '../shared/contracts.js';
import { ConsoleApiError, consoleApi } from './api.js';
import { GuidePage } from './GuidePage.js';
import { OperationExplorer } from './OperationExplorer.js';
import {
  createOperationSelection,
  includedOperationIds,
  isOperationIncluded,
  replaceOperationSelection,
  updateOperationSelection as applyOperationSelectionUpdate,
  type OperationSelection,
} from './operation-selection.js';
import { workflowStages as stages, type WorkflowStage as Stage } from './workflow.js';

type BusyAction = 'boot' | 'sample' | 'analyze' | 'register' | 'load' | 'connect' | null;
type AppView = 'workflow' | 'guide';

function viewFromPathname(pathname: string): AppView {
  return pathname.replace(/\/+$/, '') === '/guide' ? 'guide' : 'workflow';
}

function pathForView(view: AppView): string {
  return view === 'guide' ? '/guide' : '/';
}

const emptySource: SourceRequest = {
  source: '',
  filename: 'api-contract.yaml',
  sourceType: 'auto',
};

interface ConsoleErrorState {
  readonly message: string;
  readonly code?: string;
  readonly requestId?: string;
  readonly diagnostics?: readonly ConsoleDiagnostic[];
}

interface ConnectionDraft {
  readonly displayName: string;
  readonly description: string;
  readonly confirmation: 'per-call' | 'process';
  readonly allowInsecureHttp: boolean;
  readonly credentialEnvironment: Readonly<Record<string, string>>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function compactFingerprint(value: string): string {
  const digest = value.replace(/^sha256:/, '');
  return `${digest.slice(0, 10)}…${digest.slice(-8)}`;
}

function dateTime(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function isEnvironmentVariableName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function contractImpactLabel(impact: ContractDiffResponse['operations'][number]['impact']): string {
  switch (impact) {
    case 'security-review':
      return '보안 재검토';
    case 'breaking':
      return '호환성 영향';
    case 'additive':
      return '신규';
    case 'metadata-review':
      return '설명 변경';
    default:
      return '동일';
  }
}

function contractAreaLabel(
  area: ContractDiffResponse['operations'][number]['areas'][number],
): string {
  const labels: Readonly<Record<typeof area, string>> = {
    'tool-metadata': '도구 설명',
    'schema-annotations': '스키마 설명',
    'input-schema': '입력 스키마',
    'output-schema': '출력 스키마',
    authentication: '인증',
    risk: '위험 정책',
    destination: '실행 목적지',
    'request-binding': '요청 바인딩',
    'response-contract': '응답 계약',
  };
  return labels[area];
}

function diagnosticIcon(severity: ConsoleDiagnostic['severity']): LucideIcon {
  if (severity === 'error') return XCircle;
  if (severity === 'warning') return TriangleAlert;
  return Info;
}

function errorState(error: unknown): ConsoleErrorState {
  if (error instanceof ConsoleApiError) {
    return {
      message: error.message,
      code: error.code,
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      ...(error.diagnostics === undefined ? {} : { diagnostics: error.diagnostics }),
    };
  }
  return { message: '예상하지 못한 오류가 발생했습니다. 다시 시도해 주세요.' };
}

function SummaryMetric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly value: string | number;
  readonly detail?: string;
}) {
  return (
    <div className="metric-card">
      <span className="metric-icon" aria-hidden="true">
        <Icon size={19} strokeWidth={1.9} />
      </span>
      <div>
        <span className="metric-label">{label}</span>
        <strong>{value}</strong>
        {detail ? <small>{detail}</small> : null}
      </div>
    </div>
  );
}

function Diagnostics({ diagnostics }: { readonly diagnostics: readonly ConsoleDiagnostic[] }) {
  if (diagnostics.length === 0) {
    return (
      <div className="empty-inline success-inline">
        <CheckCircle2 size={18} aria-hidden="true" />
        <span>보고된 진단이 없습니다.</span>
      </div>
    );
  }

  return (
    <ul className="diagnostic-list">
      {diagnostics.map((diagnostic, index) => {
        const Icon = diagnosticIcon(diagnostic.severity);
        const location = [
          diagnostic.location?.pointer,
          diagnostic.location?.line === undefined ? undefined : `line ${diagnostic.location.line}`,
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <li
            className={`diagnostic diagnostic-${diagnostic.severity}`}
            key={`${diagnostic.code}-${index}`}
          >
            <Icon size={18} aria-hidden="true" />
            <div>
              <div className="diagnostic-heading">
                <strong>{diagnostic.code}</strong>
                <span>{diagnostic.severity}</span>
              </div>
              <p>{diagnostic.message}</p>
              {location ? <code>{location}</code> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function MethodBadge({ method }: { readonly method: string }) {
  return <span className={`method-badge method-${method.toLowerCase()}`}>{method}</span>;
}

function RiskBadge({ capability }: { readonly capability: CapabilitySummary }) {
  const label = capability.risk.requiresConfirmation
    ? '확인 필요'
    : capability.risk.level === 'read'
      ? '읽기'
      : capability.risk.level;
  return (
    <span
      className={`risk-badge ${capability.risk.requiresConfirmation ? 'risk-confirm' : `risk-${capability.risk.level}`}`}
    >
      {label}
    </span>
  );
}

function FlowStepper({ stage }: { readonly stage: Stage }) {
  return (
    <nav className="flow-navigation" aria-label="API 연결 진행 단계">
      <div className="mobile-progress">
        <span>
          현재 단계 {stage}/{stages.length} · {stages[stage - 1]?.label}
        </span>
        <span
          className="mobile-progress-track"
          role="progressbar"
          aria-label="API 연결 진행률"
          aria-valuemin={1}
          aria-valuemax={stages.length}
          aria-valuenow={stage}
        >
          <span style={{ width: `${(stage / stages.length) * 100}%` }} />
        </span>
      </div>
      <ol className="flow-stepper">
        {stages.map((item) => {
          const complete = item.number < stage;
          const active = item.number === stage;
          return (
            <li
              className={active ? 'step-active' : complete ? 'step-complete' : ''}
              key={item.number}
              aria-current={active ? 'step' : undefined}
              aria-label={`${item.number}단계 ${item.label}${active ? ', 현재 단계' : complete ? ', 완료' : ''}`}
            >
              <span className="step-number" aria-hidden="true">
                {complete ? <Check size={15} strokeWidth={2.5} /> : item.number}
              </span>
              <span className="step-copy">
                <small>STEP {item.number}</small>
                <span className="step-long">{item.label}</span>
                <span className="step-short">{item.shortLabel}</span>
              </span>
              {item.number < 5 ? <span className="step-line" aria-hidden="true" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function ErrorSummary({ state }: { readonly state: ConsoleErrorState }) {
  return (
    <div className="error-summary" role="alert" tabIndex={-1}>
      <AlertCircle size={21} aria-hidden="true" />
      <div>
        <strong>요청을 완료하지 못했습니다</strong>
        <p>{state.message}</p>
        {state.code || state.requestId ? (
          <small>
            {[state.code, state.requestId ? `request ${state.requestId}` : undefined]
              .filter(Boolean)
              .join(' · ')}
          </small>
        ) : null}
        {state.diagnostics && state.diagnostics.length > 0 ? (
          <div className="error-diagnostics">
            <Diagnostics diagnostics={state.diagnostics} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BusyLabel({ children }: { readonly children: ReactNode }) {
  return (
    <>
      <LoaderCircle className="spin" size={18} aria-hidden="true" />
      {children}
    </>
  );
}

export function App() {
  const [view, setView] = useState<AppView>(() =>
    typeof window === 'undefined' ? 'workflow' : viewFromPathname(window.location.pathname),
  );
  const [stage, setStage] = useState<Stage>(1);
  const [status, setStatus] = useState<ConsoleStatus>();
  const [samples, setSamples] = useState<readonly ConsoleSample[]>([]);
  const [registrations, setRegistrations] = useState<readonly RegistrationSummary[]>([]);
  const [source, setSource] = useState<SourceRequest>(emptySource);
  const [selectedSample, setSelectedSample] = useState('');
  const [analysis, setAnalysis] = useState<AnalysisResponse>();
  const [operationSelection, setOperationSelection] = useState<OperationSelection>(() =>
    createOperationSelection(0),
  );
  const [operationQuery, setOperationQuery] = useState('');
  const [operationMethod, setOperationMethod] = useState('');
  const [operationTag, setOperationTag] = useState('');
  const [operationVisibility, setOperationVisibility] = useState<'' | 'included' | 'excluded'>('');
  const [selectionPresets, setSelectionPresets] = useState<readonly SelectionPresetSummary[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [presetName, setPresetName] = useState('');
  const [presetBusy, setPresetBusy] = useState<
    'load' | 'save' | 'apply' | 'review' | 'delete' | null
  >(null);
  const [presetNotice, setPresetNotice] = useState('');
  const [presetUndo, setPresetUndo] = useState<OperationSelection>();
  const [presetReview, setPresetReview] = useState<SelectionPresetReviewResponse>();
  const [deleteArmedPresetId, setDeleteArmedPresetId] = useState('');
  const [baselineRegistrationId, setBaselineRegistrationId] = useState('');
  const [contractDiff, setContractDiff] = useState<ContractDiffResponse>();
  const [contractDiffBusy, setContractDiffBusy] = useState(false);
  const [registration, setRegistration] = useState<RegistrationDetail>();
  const [selectedCapabilityId, setSelectedCapabilityId] = useState<string>();
  const [capabilityQuery, setCapabilityQuery] = useState('');
  const [approvedOrigins, setApprovedOrigins] = useState<ReadonlySet<string>>(new Set());
  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft>({
    displayName: '',
    description: '',
    confirmation: 'per-call',
    allowInsecureHttp: false,
    credentialEnvironment: {},
  });
  const [connection, setConnection] = useState<ConnectionResponse>();
  const [busy, setBusy] = useState<BusyAction>('boot');
  const [error, setError] = useState<ConsoleErrorState>();
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const stageHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousStageRef = useRef<Stage>(stage);
  const previousViewRef = useRef<AppView>(view);
  const sourceRevisionRef = useRef(0);
  const presetRequestRef = useRef(0);
  const contractDiffRequestRef = useRef(0);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const loadedStatus = await consoleApi.getStatus();
        const [loadedSamples, loadedRegistrations] = await Promise.all([
          consoleApi.getSamples(),
          consoleApi.getRegistrations(),
        ]);
        if (!active) return;
        setStatus(loadedStatus);
        setSamples(loadedSamples);
        setRegistrations(loadedRegistrations);
      } catch (caught) {
        if (active) setError(errorState(caught));
      } finally {
        if (active) setBusy(null);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (error !== undefined) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    const syncView = () => setView(viewFromPathname(window.location.pathname));
    window.addEventListener('popstate', syncView);
    return () => window.removeEventListener('popstate', syncView);
  }, []);

  useEffect(() => {
    document.title = view === 'guide' ? '사용 가이드 · HiMCP' : 'HiMCP · Local Console';
    if (previousViewRef.current === view) return;
    previousViewRef.current = view;
    if (view === 'workflow') {
      const frame = window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('#page-title')?.focus({ preventScroll: true });
        window.scrollTo({ top: 0, behavior: 'auto' });
      });
      return () => window.cancelAnimationFrame(frame);
    }
    return undefined;
  }, [view]);

  useEffect(() => {
    if (previousStageRef.current === stage) return;
    previousStageRef.current = stage;
    const frame = window.requestAnimationFrame(() => {
      stageHeadingRef.current?.focus({ preventScroll: true });
      const reducedMotion =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [stage]);

  const sourceBytes = new TextEncoder().encode(source.source).length;
  const hasBlockingDiagnostics =
    analysis?.diagnostics.some(({ severity }) => severity === 'error') ?? false;
  const operationMethods = useMemo(
    () => [...new Set(analysis?.operations.map(({ method }) => method) ?? [])].sort(),
    [analysis],
  );
  const operationTags = useMemo(
    () => [...new Set(analysis?.operations.flatMap(({ tags }) => tags) ?? [])].sort(),
    [analysis],
  );
  const deferredOperationQuery = useDeferredValue(operationQuery);
  const operationSearchIndex = useMemo(
    () =>
      analysis?.operations.map((operation) => ({
        operation,
        searchText: [
          operation.id,
          operation.operationId,
          operation.summary,
          operation.description,
          operation.method,
          operation.path,
          ...operation.tags,
        ]
          .filter((value): value is string => value !== undefined)
          .join(' ')
          .toLocaleLowerCase(),
      })) ?? [],
    [analysis],
  );
  const filteredOperations = useMemo(() => {
    const query = deferredOperationQuery.trim().toLocaleLowerCase();
    return operationSearchIndex.flatMap(({ operation, searchText }) => {
      if (operationMethod !== '' && operation.method !== operationMethod) return [];
      if (operationTag !== '' && !operation.tags.includes(operationTag)) return [];
      const included = isOperationIncluded(operationSelection, operation.id);
      if (operationVisibility === 'included' && !included) return [];
      if (operationVisibility === 'excluded' && included) return [];
      if (query !== '' && !searchText.includes(query)) return [];
      return [operation];
    });
  }, [
    deferredOperationQuery,
    operationMethod,
    operationSearchIndex,
    operationSelection,
    operationTag,
    operationVisibility,
  ]);
  const operationSearchPending = deferredOperationQuery !== operationQuery;
  const selectedOperationCount = operationSelection.selectedCount;
  const operationSelectionDisabled = busy !== null || presetBusy === 'apply';
  const exactSelectionPresets = selectionPresets.filter(
    ({ compatibility }) => compatibility === 'exact',
  );
  const staleSelectionPresets = selectionPresets.filter(
    ({ compatibility }) => compatibility === 'stale',
  );
  const selectedPreset = selectionPresets.find(({ id }) => id === selectedPresetId);
  const selectedBaselineRegistration = registrations.find(
    ({ id }) => id === baselineRegistrationId,
  );
  const changedContractOperations =
    contractDiff?.operations.filter(({ kind }) => kind !== 'unchanged') ?? [];
  const normalizedPresetName = presetName.normalize('NFKC').trim();
  const presetNameBytes = new TextEncoder().encode(normalizedPresetName).length;
  const presetNameInvalid =
    normalizedPresetName === '' ||
    (status !== undefined && presetNameBytes > status.limits.maxSelectionPresetNameBytes);
  const filteredCapabilities = useMemo(() => {
    const query = capabilityQuery.trim().toLocaleLowerCase();
    if (!registration || query === '') return registration?.capabilities ?? [];
    return registration.capabilities.filter((capability) =>
      [
        capability.name,
        capability.title,
        capability.description,
        capability.method,
        capability.path,
      ]
        .join(' ')
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [capabilityQuery, registration]);
  const selectedCapability =
    filteredCapabilities.find(({ id }) => id === selectedCapabilityId) ?? filteredCapabilities[0];
  const sourceTooLarge = status !== undefined && sourceBytes > status.limits.maxSourceBytes;
  const sourceFilenameMissing = source.filename.trim() === '';
  const sourceCanAnalyze =
    status !== undefined &&
    source.source.trim() !== '' &&
    !sourceTooLarge &&
    !sourceFilenameMissing;
  const allOriginsApproved =
    registration !== undefined &&
    registration.registration.origins.length > 0 &&
    registration.registration.origins.every((origin) => approvedOrigins.has(origin));
  const hasInsecureOrigin =
    registration?.registration.origins.some((origin) => origin.startsWith('http://')) ?? false;
  const environmentNamesValid = Object.values(connectionDraft.credentialEnvironment).every(
    isEnvironmentVariableName,
  );
  const policyIssues = [
    ...(connectionDraft.displayName.trim() === '' ? ['표시 이름을 입력하세요.'] : []),
    ...(!allOriginsApproved ? ['모든 실행 origin을 확인하고 승인하세요.'] : []),
    ...(!environmentNamesValid ? ['환경 변수 이름 형식을 확인하세요.'] : []),
    ...(hasInsecureOrigin && !connectionDraft.allowInsecureHttp
      ? ['평문 HTTP 전송 위험을 확인하세요.']
      : []),
  ];
  const connectionReady = policyIssues.length === 0;
  const descriptorText = connection ? JSON.stringify(connection.descriptor, null, 2) : '';
  const hasActiveWorkflow =
    stage > 1 ||
    source.source.trim() !== '' ||
    selectedSample !== '' ||
    registration !== undefined ||
    connection !== undefined;

  function navigateTo(nextView: AppView): void {
    if (nextView === view) return;
    window.history.pushState({ view: nextView }, '', pathForView(nextView));
    setView(nextView);
  }

  function showError(caught: unknown): void {
    setError(errorState(caught));
  }

  function resetSelectionPresets(): void {
    presetRequestRef.current += 1;
    setSelectionPresets([]);
    setSelectedPresetId('');
    setPresetName('');
    setPresetBusy(null);
    setPresetNotice('');
    setPresetUndo(undefined);
    setPresetReview(undefined);
    setDeleteArmedPresetId('');
  }

  function resetContractDiff(): void {
    contractDiffRequestRef.current += 1;
    setContractDiff(undefined);
    setContractDiffBusy(false);
  }

  async function loadSelectionPresets(result: AnalysisResponse): Promise<void> {
    const requestSequence = ++presetRequestRef.current;
    setPresetBusy('load');
    setPresetNotice('');
    try {
      const presets = await consoleApi.getSelectionPresets(
        result.sourceScopeId,
        result.analysisFingerprint,
      );
      if (requestSequence !== presetRequestRef.current) return;
      setSelectionPresets(presets);
      setSelectedPresetId((current) =>
        presets.some(({ id }) => id === current)
          ? current
          : (presets.find(({ compatibility }) => compatibility === 'exact')?.id ??
            presets[0]?.id ??
            ''),
      );
    } catch (caught) {
      if (requestSequence === presetRequestRef.current) showError(caught);
    } finally {
      if (requestSequence === presetRequestRef.current) setPresetBusy(null);
    }
  }

  async function compareContract(): Promise<void> {
    if (!analysis || baselineRegistrationId === '') return;
    const requestSequence = ++contractDiffRequestRef.current;
    const requestedSourceRevision = sourceRevisionRef.current;
    const baselineId = baselineRegistrationId;
    setContractDiffBusy(true);
    setContractDiff(undefined);
    setError(undefined);
    try {
      const diff = await consoleApi.getContractDiff({
        ...source,
        baselineRegistrationId: baselineId,
        reviewedAnalysisFingerprint: analysis.analysisFingerprint,
      });
      if (
        requestSequence !== contractDiffRequestRef.current ||
        requestedSourceRevision !== sourceRevisionRef.current
      ) {
        return;
      }
      if (
        diff.baseline.releaseId !== baselineId ||
        diff.current.documentFingerprint !== analysis.document.fingerprint ||
        diff.current.operationCount !== analysis.operations.length
      ) {
        throw new ConsoleApiError(
          '계약 변경 결과가 현재 분석 및 기준 release와 일치하지 않습니다.',
          'CONTRACT_DIFF_MISMATCH',
        );
      }
      setContractDiff(diff);
    } catch (caught) {
      if (requestSequence === contractDiffRequestRef.current) showError(caught);
    } finally {
      if (requestSequence === contractDiffRequestRef.current) setContractDiffBusy(false);
    }
  }

  function updateSource(next: Partial<SourceRequest>): void {
    sourceRevisionRef.current += 1;
    setSource((current) => ({ ...current, ...next }));
    setAnalysis(undefined);
    setOperationSelection(createOperationSelection(0));
    setOperationQuery('');
    setOperationMethod('');
    setOperationTag('');
    setOperationVisibility('');
    resetSelectionPresets();
    resetContractDiff();
    setRegistration(undefined);
    setConnection(undefined);
    setError(undefined);
  }

  async function loadSample(id: string): Promise<void> {
    setSelectedSample(id);
    if (id === '') return;
    setBusy('sample');
    setError(undefined);
    try {
      const loaded = await consoleApi.getSample(id);
      sourceRevisionRef.current += 1;
      setSource(loaded);
      setAnalysis(undefined);
      setOperationSelection(createOperationSelection(0));
      setOperationQuery('');
      setOperationMethod('');
      setOperationTag('');
      setOperationVisibility('');
      resetSelectionPresets();
      resetContractDiff();
      setRegistration(undefined);
      setConnection(undefined);
    } catch (caught) {
      showError(caught);
    } finally {
      setBusy(null);
    }
  }

  async function acceptFile(file: File): Promise<void> {
    if (status && file.size > status.limits.maxSourceBytes) {
      setError({
        message: `파일이 ${formatBytes(status.limits.maxSourceBytes)} 제한을 초과했습니다.`,
        code: 'SOURCE_TOO_LARGE',
      });
      return;
    }
    try {
      const content = await file.text();
      updateSource({ source: content, filename: file.name, sourceType: 'auto' });
      setSelectedSample('');
    } catch {
      setError({ message: 'UTF-8 텍스트 파일을 읽지 못했습니다.', code: 'FILE_READ_FAILED' });
    }
  }

  async function analyzeSource(): Promise<void> {
    if (source.source.trim() === '') {
      setError({ message: '분석할 API source를 붙여넣거나 업로드하세요.', code: 'SOURCE_EMPTY' });
      return;
    }
    setBusy('analyze');
    setError(undefined);
    const requestedRevision = sourceRevisionRef.current;
    const requestedSource = source;
    try {
      const result = await consoleApi.analyze(requestedSource);
      if (requestedRevision !== sourceRevisionRef.current) return;
      setAnalysis(result);
      setOperationSelection(createOperationSelection(result.operations.length));
      setOperationQuery('');
      setOperationMethod('');
      setOperationTag('');
      setOperationVisibility('');
      resetSelectionPresets();
      resetContractDiff();
      setBaselineRegistrationId(
        registrations.find(
          ({ title, sourceKind }) =>
            title === result.document.title && sourceKind === result.document.sourceKind,
        )?.id ??
          registrations[0]?.id ??
          '',
      );
      setStage(2);
      void loadSelectionPresets(result);
    } catch (caught) {
      if (requestedRevision === sourceRevisionRef.current) showError(caught);
    } finally {
      setBusy(null);
    }
  }

  function initializePolicy(detail: RegistrationDetail): void {
    setApprovedOrigins(new Set());
    setConnectionDraft({
      displayName: detail.registration.title,
      description: '',
      confirmation: 'per-call',
      allowInsecureHttp: false,
      credentialEnvironment: Object.fromEntries(
        detail.registration.credentialBindings.map((binding) => [
          binding.environmentVariable,
          binding.environmentVariable,
        ]),
      ),
    });
    setConnection(undefined);
    setSelectedCapabilityId(detail.capabilities[0]?.id);
  }

  async function registerSource(): Promise<void> {
    if (!analysis || selectedOperationCount === 0) {
      setError({
        message: 'MCP 도구로 포함할 operation을 하나 이상 선택하세요.',
        code: 'OPERATION_SELECTION_EMPTY',
      });
      return;
    }
    const reviewedOperationIds = includedOperationIds(
      operationSelection,
      analysis.operations.map(({ id }) => id),
    );
    setBusy('register');
    setError(undefined);
    try {
      const detail = await consoleApi.createRegistration({
        ...source,
        reviewedAnalysisFingerprint: analysis.analysisFingerprint,
        includedOperationIds: reviewedOperationIds,
      });
      setRegistration(detail);
      initializePolicy(detail);
      setRegistrations(await consoleApi.getRegistrations());
      setStage(3);
    } catch (caught) {
      showError(caught);
    } finally {
      setBusy(null);
    }
  }

  async function openRegistration(id: string): Promise<void> {
    setBusy('load');
    setError(undefined);
    try {
      const detail = await consoleApi.getRegistration(id);
      setAnalysis(undefined);
      setOperationSelection(createOperationSelection(0));
      setOperationQuery('');
      setOperationMethod('');
      setOperationTag('');
      setOperationVisibility('');
      resetSelectionPresets();
      setRegistration(detail);
      initializePolicy(detail);
      setStage(3);
    } catch (caught) {
      showError(caught);
    } finally {
      setBusy(null);
    }
  }

  function updateOperationSelection(operationIds: readonly string[], included: boolean): void {
    setOperationSelection((current) =>
      applyOperationSelectionUpdate(current, operationIds, included),
    );
    setError(undefined);
  }

  async function saveSelectionPreset(): Promise<void> {
    if (
      !analysis ||
      !status ||
      presetNameInvalid ||
      selectedOperationCount === 0 ||
      hasBlockingDiagnostics
    ) {
      return;
    }
    const operationIds = analysis.operations.map(({ id }) => id);
    setPresetBusy('save');
    setPresetNotice('');
    setError(undefined);
    const requestSequence = ++presetRequestRef.current;
    try {
      const saved = await consoleApi.createSelectionPreset({
        ...source,
        name: normalizedPresetName,
        reviewedAnalysisFingerprint: analysis.analysisFingerprint,
        includedOperationIds: includedOperationIds(operationSelection, operationIds),
      });
      const presets = await consoleApi.getSelectionPresets(
        analysis.sourceScopeId,
        analysis.analysisFingerprint,
      );
      if (requestSequence !== presetRequestRef.current) return;
      setSelectionPresets(presets);
      setSelectedPresetId(saved.preset.id);
      setPresetName('');
      setPresetNotice(
        saved.created ? '현재 선택을 새 프리셋으로 저장했습니다.' : '동일한 프리셋을 확인했습니다.',
      );
    } catch (caught) {
      if (requestSequence === presetRequestRef.current) showError(caught);
    } finally {
      if (requestSequence === presetRequestRef.current) setPresetBusy(null);
    }
  }

  async function applySelectionPreset(): Promise<void> {
    if (!analysis || selectedPreset?.compatibility !== 'exact') return;
    const preset = selectedPreset;
    const previousSelection = operationSelection;
    const requestedSourceRevision = sourceRevisionRef.current;
    const requestSequence = ++presetRequestRef.current;
    setPresetBusy('apply');
    setPresetNotice('');
    setError(undefined);
    try {
      const detail = await consoleApi.getSelectionPreset(
        analysis.sourceScopeId,
        preset.id,
        analysis.analysisFingerprint,
        preset.selectionFingerprint,
      );
      if (
        requestSequence !== presetRequestRef.current ||
        requestedSourceRevision !== sourceRevisionRef.current
      ) {
        return;
      }
      if (
        detail.compatibility !== 'exact' ||
        detail.id !== preset.id ||
        detail.sourceScopeId !== analysis.sourceScopeId ||
        detail.analysisFingerprint !== analysis.analysisFingerprint ||
        detail.selectionFingerprint !== preset.selectionFingerprint ||
        detail.documentFingerprint !== analysis.document.fingerprint ||
        detail.sourceOperationCount !== analysis.operations.length ||
        detail.includedOperationCount !== preset.includedOperationCount ||
        detail.includedOperationIds.length !== detail.includedOperationCount
      ) {
        throw new ConsoleApiError(
          '선택 프리셋 상세가 현재 분석 및 목록 snapshot과 일치하지 않습니다.',
          'SELECTION_PRESET_DETAIL_MISMATCH',
        );
      }
      const nextSelection = replaceOperationSelection(
        analysis.operations.map(({ id }) => id),
        detail.includedOperationIds,
      );
      setPresetUndo(previousSelection);
      setOperationSelection(nextSelection);
      setPresetReview(undefined);
      setPresetNotice(`“${preset.name}” 프리셋을 적용했습니다.`);
    } catch (caught) {
      if (requestSequence === presetRequestRef.current) {
        showError(caught);
        if (
          caught instanceof ConsoleApiError &&
          ['SELECTION_PRESET_STALE', 'SELECTION_PRESET_CHANGED'].includes(caught.code)
        ) {
          setPresetBusy(null);
          void loadSelectionPresets(analysis);
        }
      }
    } finally {
      if (requestSequence === presetRequestRef.current) setPresetBusy(null);
    }
  }

  async function reviewStaleSelectionPreset(): Promise<void> {
    if (!analysis || selectedPreset?.compatibility !== 'stale') return;
    const preset = selectedPreset;
    const requestedSourceRevision = sourceRevisionRef.current;
    const requestSequence = ++presetRequestRef.current;
    setPresetBusy('review');
    setPresetNotice('');
    setPresetReview(undefined);
    setError(undefined);
    try {
      const review = await consoleApi.reviewSelectionPreset(analysis.sourceScopeId, preset.id, {
        ...source,
        reviewedAnalysisFingerprint: analysis.analysisFingerprint,
        selectionFingerprint: preset.selectionFingerprint,
      });
      if (
        requestSequence !== presetRequestRef.current ||
        requestedSourceRevision !== sourceRevisionRef.current
      ) {
        return;
      }
      const currentIds = analysis.operations.map(({ id }) => id);
      const currentIdSet = new Set(currentIds);
      const candidateSet = new Set(review.candidateOperationIds);
      const missingSet = new Set(review.missingOperationIds);
      const unselectedSet = new Set(review.unselectedCurrentOperationIds);
      const snapshotMatches =
        review.preset.id === preset.id &&
        review.preset.selectionFingerprint === preset.selectionFingerprint &&
        review.currentAnalysisFingerprint === analysis.analysisFingerprint &&
        candidateSet.size === review.candidateOperationIds.length &&
        missingSet.size === review.missingOperationIds.length &&
        unselectedSet.size === review.unselectedCurrentOperationIds.length &&
        review.candidateOperationIds.every((id) => currentIdSet.has(id)) &&
        review.missingOperationIds.every((id) => !currentIdSet.has(id)) &&
        review.unselectedCurrentOperationIds.every((id) => currentIdSet.has(id)) &&
        currentIds.every((id) => candidateSet.has(id) !== unselectedSet.has(id));
      if (!snapshotMatches) {
        throw new ConsoleApiError(
          '프리셋 재검토 결과가 현재 분석 및 목록 snapshot과 일치하지 않습니다.',
          'SELECTION_PRESET_REVIEW_MISMATCH',
        );
      }
      setPresetReview(review);
      setPresetNotice('이전 선택과 현재 operation ID의 교집합을 재검토하세요.');
    } catch (caught) {
      if (requestSequence === presetRequestRef.current) showError(caught);
    } finally {
      if (requestSequence === presetRequestRef.current) setPresetBusy(null);
    }
  }

  function applyPresetReviewCandidates(): void {
    if (!analysis || !presetReview || presetReview.candidateOperationIds.length === 0) return;
    setPresetUndo(operationSelection);
    setOperationSelection(
      replaceOperationSelection(
        analysis.operations.map(({ id }) => id),
        presetReview.candidateOperationIds,
      ),
    );
    setPresetNotice(
      `“${presetReview.preset.name}”의 재검토 후보 ${presetReview.candidateOperationIds.length}개를 불러왔습니다. 이전에 선택하지 않은 현재 operation은 제외했습니다.`,
    );
  }

  function undoSelectionPreset(): void {
    if (presetUndo === undefined) return;
    setOperationSelection(presetUndo);
    setPresetUndo(undefined);
    setPresetNotice('프리셋 적용 전 선택으로 되돌렸습니다.');
  }

  async function deleteSelectionPreset(): Promise<void> {
    if (!analysis || selectedPreset === undefined) return;
    if (deleteArmedPresetId !== selectedPreset.id) {
      setDeleteArmedPresetId(selectedPreset.id);
      setPresetNotice(`“${selectedPreset.name}” 삭제를 확인하려면 삭제 버튼을 한 번 더 누르세요.`);
      return;
    }
    setPresetBusy('delete');
    setPresetNotice('');
    setError(undefined);
    const requestSequence = ++presetRequestRef.current;
    try {
      await consoleApi.deleteSelectionPreset(analysis.sourceScopeId, selectedPreset.id);
      const presets = await consoleApi.getSelectionPresets(
        analysis.sourceScopeId,
        analysis.analysisFingerprint,
      );
      if (requestSequence !== presetRequestRef.current) return;
      setSelectionPresets(presets);
      setSelectedPresetId(
        presets.find(({ compatibility }) => compatibility === 'exact')?.id ?? presets[0]?.id ?? '',
      );
      setDeleteArmedPresetId('');
      setPresetNotice(`“${selectedPreset.name}” 프리셋을 삭제했습니다.`);
    } catch (caught) {
      if (requestSequence === presetRequestRef.current) showError(caught);
    } finally {
      if (requestSequence === presetRequestRef.current) setPresetBusy(null);
    }
  }

  function toggleOrigin(origin: string): void {
    setApprovedOrigins((current) => {
      const next = new Set(current);
      if (next.has(origin)) next.delete(origin);
      else next.add(origin);
      return next;
    });
  }

  async function createConnection(): Promise<void> {
    if (!registration) return;
    if (connectionDraft.displayName.trim() === '') {
      setError({
        message: 'AI 도구에서 구분할 표시 이름을 입력하세요.',
        code: 'DISPLAY_NAME_REQUIRED',
      });
      return;
    }
    if (!allOriginsApproved) {
      setError({
        message: 'Release에서 파생된 모든 실행 origin을 각각 확인하고 승인하세요.',
        code: 'ORIGIN_REVIEW_INCOMPLETE',
      });
      return;
    }
    if (hasInsecureOrigin && !connectionDraft.allowInsecureHttp) {
      setError({
        message: 'HTTP origin을 사용하려면 평문 전송 위험을 명시적으로 승인하세요.',
        code: 'HTTP_REVIEW_REQUIRED',
      });
      return;
    }
    if (!environmentNamesValid) {
      setError({
        message: 'Credential binding에는 유효한 환경 변수 이름 형식만 입력하세요.',
        code: 'ENVIRONMENT_VARIABLE_INVALID',
      });
      return;
    }
    const request: ConnectionRequest = {
      displayName: connectionDraft.displayName,
      ...(connectionDraft.description.trim() === ''
        ? {}
        : { description: connectionDraft.description.trim() }),
      approvedOrigins: [...approvedOrigins],
      allowInsecureHttp: connectionDraft.allowInsecureHttp,
      confirmation: connectionDraft.confirmation,
      credentialEnvironment: connectionDraft.credentialEnvironment,
    };
    setBusy('connect');
    setError(undefined);
    try {
      const created = await consoleApi.createConnection(registration.registration.id, request);
      setConnection(created);
      setStage(5);
    } catch (caught) {
      showError(caught);
    } finally {
      setBusy(null);
    }
  }

  async function copyDescriptor(): Promise<void> {
    try {
      await navigator.clipboard.writeText(descriptorText);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1_800);
    } catch {
      setError({ message: '클립보드에 복사하지 못했습니다.', code: 'CLIPBOARD_FAILED' });
    }
  }

  function downloadDescriptor(): void {
    if (!connection) return;
    const blob = new Blob([`${descriptorText}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${connection.profile.id}.mcp.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function startOver(): void {
    sourceRevisionRef.current += 1;
    setStage(1);
    setSource(emptySource);
    setSelectedSample('');
    setAnalysis(undefined);
    setOperationSelection(createOperationSelection(0));
    setOperationQuery('');
    setOperationMethod('');
    setOperationTag('');
    setOperationVisibility('');
    resetSelectionPresets();
    resetContractDiff();
    setBaselineRegistrationId('');
    setRegistration(undefined);
    setConnection(undefined);
    setApprovedOrigins(new Set());
    setError(undefined);
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        본문으로 건너뛰기
      </a>
      <header className="app-header">
        <div className="header-inner">
          <a
            className="brand"
            href="/"
            onClick={(event) => {
              event.preventDefault();
              navigateTo('workflow');
            }}
            aria-label="HiMCP 콘솔"
          >
            <span className="brand-mark" aria-hidden="true">
              <Code2 size={21} strokeWidth={2.2} />
            </span>
            <span>
              <strong>HiMCP</strong>
              <small>Local Console</small>
            </span>
          </a>
          <nav className="header-navigation" aria-label="주요 메뉴">
            <a
              href="/"
              aria-current={view === 'workflow' ? 'page' : undefined}
              onClick={(event) => {
                event.preventDefault();
                navigateTo('workflow');
              }}
            >
              콘솔
            </a>
            <a
              href="/guide"
              aria-current={view === 'guide' ? 'page' : undefined}
              onClick={(event) => {
                event.preventDefault();
                navigateTo('guide');
              }}
            >
              사용 가이드
            </a>
          </nav>
          <div
            className="header-status"
            aria-label={status ? '로컬 런타임 연결됨' : '런타임 확인 중'}
            aria-live="polite"
          >
            <span className={`runtime-dot ${status ? 'online' : ''}`} aria-hidden="true" />
            <span className="runtime-label">
              {status ? '로컬 런타임 연결됨' : '런타임 확인 중'}
            </span>
            <span className="runtime-label-short" aria-hidden="true">
              {status ? '연결됨' : '확인 중'}
            </span>
            {status ? <code>v{status.application.version}</code> : null}
          </div>
        </div>
      </header>

      <main id="main-content">
        {view === 'guide' ? (
          <GuidePage
            status={status}
            samples={samples}
            hasActiveWorkflow={hasActiveWorkflow}
            onOpenWorkflow={() => navigateTo('workflow')}
            onOpenSample={(sampleId) => {
              navigateTo('workflow');
              void loadSample(sampleId);
            }}
          />
        ) : (
          <>
            <section
              className={`page-intro ${stage > 1 ? 'page-intro-compact' : ''}`}
              aria-labelledby="page-title"
            >
              <div>
                <p className="eyebrow">VERIFIED API → MCP WORKFLOW</p>
                <h1 id="page-title" tabIndex={-1}>
                  API를 검토 가능한 MCP 도구로 연결하세요
                </h1>
                <p>
                  OpenAPI 또는 HTTP 매니페스트를 분석하고, 실행 계약과 보안 정책을 직접 검토한 뒤 AI
                  도구용 설정을 내보냅니다.
                </p>
              </div>
              <div className="local-boundary">
                <LockKeyhole size={20} aria-hidden="true" />
                <div>
                  <strong>이 기기에서만 실행</strong>
                  <span>{status?.runtime.dataDirectory ?? '로컬 저장소 확인 중'}</span>
                </div>
              </div>
            </section>

            <FlowStepper stage={stage} />

            {error ? (
              <div ref={errorRef} tabIndex={-1} className="focus-target">
                <ErrorSummary state={error} />
              </div>
            ) : null}

            <div className="stage-live" role="status" aria-live="polite">
              {busy && busy !== 'boot'
                ? '요청을 처리하고 있습니다.'
                : `${stage}단계 ${stages[stage - 1]?.label}`}
            </div>

            {stage === 1 ? (
              <section className="workflow-section" aria-labelledby="source-heading">
                <div className="section-heading">
                  <div>
                    <span className="section-kicker">STEP 1</span>
                    <h2 id="source-heading" ref={stageHeadingRef} tabIndex={-1}>
                      API source 등록
                    </h2>
                    <p>
                      계약을 붙여넣거나 업로드하세요. 어댑터는 현재 registry에서 동적으로
                      가져옵니다.
                    </p>
                  </div>
                  <div className="adapter-count">
                    <Layers3 size={17} aria-hidden="true" />
                    {status?.adapters.length ?? 0}개 adapter 사용 가능
                  </div>
                </div>

                <div className="source-grid">
                  <div className="panel source-panel">
                    <div className="panel-heading compact-heading">
                      <div>
                        <h3>API 계약</h3>
                        <p>JSON 또는 YAML 텍스트</p>
                      </div>
                      <span
                        id="source-size-help"
                        aria-live="polite"
                        className={sourceTooLarge ? 'byte-over' : ''}
                      >
                        {formatBytes(sourceBytes)} /{' '}
                        {formatBytes(status?.limits.maxSourceBytes ?? 0)}
                        {sourceTooLarge ? ' · 제한 초과' : ''}
                      </span>
                    </div>
                    <label className="field-label" htmlFor="source-filename">
                      표시 파일명
                    </label>
                    <input
                      id="source-filename"
                      value={source.filename}
                      maxLength={255}
                      aria-invalid={sourceFilenameMissing || undefined}
                      aria-describedby={sourceFilenameMissing ? 'source-filename-error' : undefined}
                      onChange={(event) => updateSource({ filename: event.target.value })}
                      spellCheck={false}
                    />
                    {sourceFilenameMissing ? (
                      <p className="field-error" id="source-filename-error">
                        표시 파일명을 입력하세요.
                      </p>
                    ) : null}
                    <label className="sr-only" htmlFor="source-editor">
                      JSON 또는 YAML API source
                    </label>
                    <textarea
                      id="source-editor"
                      className="source-editor"
                      value={source.source}
                      aria-invalid={sourceTooLarge || undefined}
                      aria-describedby="source-size-help"
                      onChange={(event) => updateSource({ source: event.target.value })}
                      placeholder={'openapi: 3.1.0\ninfo:\n  title: My API\n  version: 1.0.0\n...'}
                      spellCheck={false}
                    />
                    <div
                      className={`file-drop ${dragging ? 'file-drop-active' : ''}`}
                      onDragEnter={(event) => {
                        event.preventDefault();
                        setDragging(true);
                      }}
                      onDragOver={(event) => event.preventDefault()}
                      onDragLeave={(event) => {
                        event.preventDefault();
                        if (event.currentTarget === event.target) setDragging(false);
                      }}
                      onDrop={(event: DragEvent<HTMLDivElement>) => {
                        event.preventDefault();
                        setDragging(false);
                        const file = event.dataTransfer.files[0];
                        if (file) void acceptFile(file);
                      }}
                    >
                      <CloudUpload size={20} aria-hidden="true" />
                      <span>파일을 여기에 놓거나</span>
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        파일 선택
                      </button>
                      <input
                        ref={fileInputRef}
                        className="sr-only"
                        type="file"
                        tabIndex={-1}
                        aria-label="API source 파일 선택"
                        accept=".json,.yaml,.yml,application/json,text/yaml,application/yaml"
                        onChange={(event: ChangeEvent<HTMLInputElement>) => {
                          const file = event.target.files?.[0];
                          if (file) void acceptFile(file);
                          event.target.value = '';
                        }}
                      />
                    </div>
                  </div>

                  <aside className="panel source-settings" aria-label="분석 설정">
                    <div className="panel-heading compact-heading">
                      <div>
                        <h3>분석 설정</h3>
                        <p>자동 감지는 유일한 일치만 선택합니다.</p>
                      </div>
                      <Activity size={20} aria-hidden="true" />
                    </div>
                    <label className="field-label" htmlFor="source-adapter">
                      Source adapter
                    </label>
                    <select
                      id="source-adapter"
                      value={source.sourceType ?? 'auto'}
                      onChange={(event) => updateSource({ sourceType: event.target.value })}
                      disabled={!status}
                    >
                      <option value="auto">자동 감지</option>
                      {status?.adapters.map((adapter) => (
                        <option value={adapter} key={adapter}>
                          {adapter}
                        </option>
                      ))}
                    </select>
                    <p className="field-help">
                      모호하거나 일치하지 않으면 임의로 실행 계약을 만들지 않습니다.
                    </p>

                    <label className="field-label" htmlFor="sample-source">
                      Repository 예제
                    </label>
                    <select
                      id="sample-source"
                      value={selectedSample}
                      onChange={(event) => void loadSample(event.target.value)}
                      disabled={busy === 'sample'}
                    >
                      <option value="">예제 선택…</option>
                      {samples.map((sample) => (
                        <option value={sample.id} key={sample.id}>
                          {sample.name}
                        </option>
                      ))}
                    </select>

                    <div className="security-note">
                      <ShieldCheck size={19} aria-hidden="true" />
                      <div>
                        <strong>비밀값을 넣지 마세요</strong>
                        <p>
                          API 키·토큰·고객 데이터는 source에 포함하지 않습니다. 원문은 저장하지
                          않습니다.
                        </p>
                      </div>
                    </div>

                    <button
                      className="primary-button analyze-button"
                      type="button"
                      onClick={() => void analyzeSource()}
                      disabled={busy !== null || !sourceCanAnalyze}
                    >
                      {busy === 'analyze' ? (
                        <BusyLabel>API 계약 분석 중</BusyLabel>
                      ) : (
                        <>
                          <Search size={18} aria-hidden="true" />
                          API 분석
                        </>
                      )}
                    </button>
                  </aside>
                </div>

                <section className="saved-section" aria-labelledby="saved-heading">
                  <div className="saved-heading-row">
                    <div>
                      <h3 id="saved-heading">기존 등록</h3>
                      <p>저장된 release는 열 때마다 identity를 다시 검증합니다.</p>
                    </div>
                    <button
                      className="icon-text-button"
                      type="button"
                      onClick={() => {
                        setBusy('load');
                        void consoleApi
                          .getRegistrations()
                          .then(setRegistrations)
                          .catch(showError)
                          .finally(() => setBusy(null));
                      }}
                      disabled={busy !== null}
                    >
                      <RefreshCw size={16} aria-hidden="true" />
                      새로고침
                    </button>
                  </div>
                  {busy === 'boot' ? (
                    <div className="saved-empty">
                      <BusyLabel>로컬 저장소 확인 중</BusyLabel>
                    </div>
                  ) : registrations.length === 0 ? (
                    <div className="saved-empty">
                      <Database size={22} aria-hidden="true" />
                      <span>아직 등록된 API가 없습니다.</span>
                    </div>
                  ) : (
                    <div className="registration-grid">
                      {registrations.map((item) => (
                        <button
                          className="registration-card"
                          type="button"
                          key={item.id}
                          onClick={() => void openRegistration(item.id)}
                        >
                          <span className="registration-icon">
                            <FileJson2 size={20} aria-hidden="true" />
                          </span>
                          <span className="registration-main">
                            <strong>{item.title}</strong>
                            <small>
                              {item.sourceKind}
                              {item.sourceVersion ? ` ${item.sourceVersion}` : ''}
                            </small>
                          </span>
                          <span className="registration-meta">
                            <strong>{item.capabilityCount}</strong>
                            <small>
                              {item.capabilityCount === item.sourceOperationCount
                                ? 'tools'
                                : `/ ${item.sourceOperationCount} tools`}
                            </small>
                          </span>
                          <ArrowRight size={17} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              </section>
            ) : null}

            {stage === 2 && analysis ? (
              <section className="workflow-section" aria-labelledby="analysis-heading">
                <div className="section-heading">
                  <div>
                    <span className="section-kicker">STEP 2</span>
                    <h2 id="analysis-heading" ref={stageHeadingRef} tabIndex={-1}>
                      분석 결과
                    </h2>
                    <p>
                      <strong>{analysis.adapterId}</strong> adapter가 source를 정규화했습니다. 실행
                      계약을 만들기 전에 감지 결과와 진단을 확인하세요.
                    </p>
                  </div>
                  <span className="status-badge success-badge">
                    <CheckCircle2 size={16} /> 정규화 완료
                  </span>
                </div>

                <div className="metrics-grid">
                  <SummaryMetric
                    icon={FileCode2}
                    label="API"
                    value={analysis.document.title}
                    detail={analysis.document.sourceKind}
                  />
                  <SummaryMetric
                    icon={SquareTerminal}
                    label="Operations"
                    value={`${selectedOperationCount} / ${analysis.document.operationCount}`}
                    detail="MCP 도구로 포함"
                  />
                  <SummaryMetric
                    icon={Server}
                    label="Origins"
                    value={analysis.document.serverOrigins.length}
                    detail="검토할 목적지"
                  />
                  <SummaryMetric
                    icon={KeyRound}
                    label="Auth schemes"
                    value={analysis.document.authSchemeCount}
                    detail="credential metadata"
                  />
                </div>

                <section className="contract-diff-panel" aria-labelledby="contract-diff-title">
                  <div className="contract-diff-heading">
                    <span className="contract-diff-icon" aria-hidden="true">
                      <GitCompareArrows size={19} />
                    </span>
                    <div>
                      <h3 id="contract-diff-title">저장된 release와 계약 비교</h3>
                      <p>
                        기준 release에 포함된 capability와 현재 source의 결정론적 계약을 비교합니다.
                      </p>
                    </div>
                  </div>
                  <div className="contract-diff-controls">
                    <label>
                      <span>기준 release</span>
                      <select
                        aria-label="계약 비교 기준 release"
                        value={baselineRegistrationId}
                        onChange={(event) => {
                          setBaselineRegistrationId(event.target.value);
                          resetContractDiff();
                        }}
                        disabled={contractDiffBusy || registrations.length === 0}
                      >
                        {registrations.length === 0 ? (
                          <option value="">저장된 release 없음</option>
                        ) : null}
                        {registrations.map((item) => (
                          <option value={item.id} key={item.id}>
                            {item.title} · {item.capabilityCount}개 · {dateTime(item.createdAt)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() => void compareContract()}
                      disabled={
                        busy !== null ||
                        contractDiffBusy ||
                        selectedBaselineRegistration === undefined
                      }
                    >
                      {contractDiffBusy ? (
                        <BusyLabel>비교 중</BusyLabel>
                      ) : (
                        <>
                          <GitCompareArrows size={17} aria-hidden="true" /> 변경 비교
                        </>
                      )}
                    </button>
                  </div>
                  {contractDiff ? (
                    <div className="contract-diff-result" aria-live="polite">
                      <div className="contract-diff-summary">
                        <span>
                          <strong>{contractDiff.summary.securityReview}</strong> 보안 재검토
                        </span>
                        <span>
                          <strong>{contractDiff.summary.breaking}</strong> 호환성 영향
                        </span>
                        <span>
                          <strong>{contractDiff.summary.added}</strong> 신규
                        </span>
                        <span>
                          <strong>{contractDiff.summary.unchanged}</strong> 동일
                        </span>
                      </div>
                      {changedContractOperations.length === 0 ? (
                        <div className="empty-inline success-inline">
                          <CheckCircle2 size={18} aria-hidden="true" />
                          <span>기준 release와 달라진 capability 계약이 없습니다.</span>
                        </div>
                      ) : (
                        <>
                          <ul className="contract-change-list">
                            {changedContractOperations.slice(0, 50).map((change) => {
                              const operation = change.after ?? change.before;
                              return (
                                <li
                                  className={`contract-change change-${change.impact}`}
                                  key={change.operationId}
                                >
                                  <span className="contract-impact">
                                    {contractImpactLabel(change.impact)}
                                  </span>
                                  <div>
                                    <strong>
                                      {operation?.title ?? operation?.name ?? change.operationId}
                                    </strong>
                                    <span className="contract-change-target">
                                      {operation ? <MethodBadge method={operation.method} /> : null}
                                      <code>{operation?.path ?? change.operationId}</code>
                                    </span>
                                    <small>
                                      {change.kind === 'added'
                                        ? '기준 release에 없으며 자동 선택하지 않습니다.'
                                        : change.kind === 'removed'
                                          ? '현재 source에서 사라졌습니다.'
                                          : change.areas.map(contractAreaLabel).join(' · ')}
                                    </small>
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                          {changedContractOperations.length > 50 ? (
                            <small className="contract-diff-overflow">
                              나머지 {changedContractOperations.length - 50}개 변경은 CLI JSON
                              결과에서 확인할 수 있습니다.
                            </small>
                          ) : null}
                        </>
                      )}
                    </div>
                  ) : (
                    <p className="contract-diff-placeholder">
                      {registrations.length === 0
                        ? '비교할 기준 release를 먼저 등록하세요.'
                        : '기준을 선택하고 현재 분석과의 보안·호환성 영향을 확인하세요.'}
                    </p>
                  )}
                </section>

                <div className="analysis-grid">
                  <div className="panel table-panel">
                    <div className="panel-heading compact-heading">
                      <div>
                        <h3>정규화된 operations</h3>
                        <p>Method와 path는 source-authoritative입니다.</p>
                      </div>
                      <code title={analysis.document.fingerprint}>
                        {compactFingerprint(analysis.document.fingerprint)}
                      </code>
                    </div>
                    <div className="operation-controls">
                      <div className="operation-filters" aria-label="Operation 필터">
                        <label className="operation-search">
                          <Search size={16} aria-hidden="true" />
                          <span className="sr-only">Operation 검색</span>
                          <input
                            value={operationQuery}
                            onChange={(event) => setOperationQuery(event.target.value)}
                            placeholder="이름, ID, path, tag 검색"
                            disabled={busy !== null}
                            aria-busy={operationSearchPending || undefined}
                          />
                        </label>
                        <label>
                          <span className="sr-only">HTTP Method 필터</span>
                          <select
                            aria-label="HTTP Method 필터"
                            value={operationMethod}
                            onChange={(event) => setOperationMethod(event.target.value)}
                            disabled={busy !== null}
                          >
                            <option value="">모든 Method</option>
                            {operationMethods.map((method) => (
                              <option value={method} key={method}>
                                {method}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span className="sr-only">포함 상태 필터</span>
                          <select
                            aria-label="포함 상태 필터"
                            value={operationVisibility}
                            onChange={(event) =>
                              setOperationVisibility(
                                event.target.value as '' | 'included' | 'excluded',
                              )
                            }
                            disabled={busy !== null}
                          >
                            <option value="">모든 포함 상태</option>
                            <option value="included">포함됨</option>
                            <option value="excluded">제외됨</option>
                          </select>
                        </label>
                        <label>
                          <span className="sr-only">Tag 필터</span>
                          <select
                            aria-label="Tag 필터"
                            value={operationTag}
                            onChange={(event) => setOperationTag(event.target.value)}
                            disabled={busy !== null}
                          >
                            <option value="">모든 Tag</option>
                            {operationTags.map((tag) => (
                              <option value={tag} key={tag}>
                                {tag}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div className="operation-selection-row">
                        <output aria-live="polite" aria-atomic="true">
                          <strong>{selectedOperationCount}</strong> / {analysis.operations.length}개
                          선택
                        </output>
                        <div className="operation-bulk-actions">
                          <button
                            type="button"
                            onClick={() =>
                              updateOperationSelection(
                                filteredOperations.map(({ id }) => id),
                                true,
                              )
                            }
                            disabled={
                              operationSelectionDisabled ||
                              operationSearchPending ||
                              filteredOperations.length === 0
                            }
                          >
                            현재 결과 선택
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              updateOperationSelection(
                                filteredOperations.map(({ id }) => id),
                                false,
                              )
                            }
                            disabled={
                              operationSelectionDisabled ||
                              operationSearchPending ||
                              filteredOperations.length === 0
                            }
                          >
                            현재 결과 해제
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              updateOperationSelection(
                                analysis.operations.map(({ id }) => id),
                                true,
                              )
                            }
                            disabled={operationSelectionDisabled}
                          >
                            전체 선택
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              updateOperationSelection(
                                analysis.operations.map(({ id }) => id),
                                false,
                              )
                            }
                            disabled={operationSelectionDisabled}
                          >
                            전체 해제
                          </button>
                        </div>
                      </div>
                      <p
                        className={`selection-help ${selectedOperationCount === 0 ? 'selection-help-error' : ''}`}
                        id="operation-selection-help"
                      >
                        {selectedOperationCount === 0
                          ? '최소 1개 operation을 선택하세요.'
                          : `${analysis.operations.length - selectedOperationCount}개 operation은 release와 MCP 도구 목록에서 제외됩니다.`}
                      </p>
                    </div>
                    <section
                      className="selection-presets"
                      aria-labelledby="selection-presets-title"
                    >
                      <div className="selection-presets-heading">
                        <span className="selection-presets-icon" aria-hidden="true">
                          <Bookmark size={18} />
                        </span>
                        <div>
                          <h4 id="selection-presets-title">선택 프리셋</h4>
                          <p>현재 분석과 정확히 일치하는 operation ID만 다시 적용합니다.</p>
                        </div>
                      </div>
                      <div className="selection-preset-apply-row">
                        <label>
                          <span className="sr-only">저장된 선택 프리셋</span>
                          <select
                            aria-label="저장된 선택 프리셋"
                            value={selectedPresetId}
                            onChange={(event) => {
                              setSelectedPresetId(event.target.value);
                              setPresetNotice('');
                              setPresetReview(undefined);
                              setDeleteArmedPresetId('');
                            }}
                            disabled={presetBusy !== null || selectionPresets.length === 0}
                          >
                            {selectionPresets.length === 0 ? (
                              <option value="">
                                {presetBusy === 'load' ? '프리셋 확인 중…' : '저장된 프리셋 없음'}
                              </option>
                            ) : null}
                            {exactSelectionPresets.length > 0 ? (
                              <optgroup label="현재 분석과 일치">
                                {exactSelectionPresets.map((preset) => (
                                  <option value={preset.id} key={preset.id}>
                                    {preset.name} · {preset.includedOperationCount}개
                                  </option>
                                ))}
                              </optgroup>
                            ) : null}
                            {staleSelectionPresets.length > 0 ? (
                              <optgroup label="이전 분석 · 적용 불가">
                                {staleSelectionPresets.map((preset) => (
                                  <option value={preset.id} key={preset.id}>
                                    {preset.name} · stale
                                  </option>
                                ))}
                              </optgroup>
                            ) : null}
                          </select>
                        </label>
                        <button
                          type="button"
                          onClick={() =>
                            void (selectedPreset?.compatibility === 'stale'
                              ? reviewStaleSelectionPreset()
                              : applySelectionPreset())
                          }
                          disabled={
                            busy !== null || presetBusy !== null || selectedPreset === undefined
                          }
                        >
                          {presetBusy === 'apply' ? (
                            <BusyLabel>적용 중</BusyLabel>
                          ) : presetBusy === 'review' ? (
                            <BusyLabel>재검토 중</BusyLabel>
                          ) : selectedPreset?.compatibility === 'stale' ? (
                            '재검토'
                          ) : (
                            '적용'
                          )}
                        </button>
                        <button
                          className="icon-only-button danger-icon-button"
                          type="button"
                          aria-label={
                            deleteArmedPresetId === selectedPreset?.id
                              ? '선택한 프리셋 삭제 확인'
                              : '선택한 프리셋 삭제'
                          }
                          title={
                            deleteArmedPresetId === selectedPreset?.id
                              ? '삭제 확인'
                              : '선택한 프리셋 삭제'
                          }
                          onClick={() => void deleteSelectionPreset()}
                          disabled={busy !== null || presetBusy !== null || !selectedPreset}
                        >
                          {presetBusy === 'delete' ? (
                            <LoaderCircle className="spin" size={16} aria-hidden="true" />
                          ) : deleteArmedPresetId === selectedPreset?.id ? (
                            <span>확인</span>
                          ) : (
                            <Trash2 size={16} aria-hidden="true" />
                          )}
                        </button>
                      </div>
                      <div className="selection-preset-save-row">
                        <label>
                          <span className="sr-only">새 선택 프리셋 이름</span>
                          <input
                            value={presetName}
                            onChange={(event) => setPresetName(event.target.value)}
                            placeholder="예: 읽기 도구 기본 범위"
                            aria-label="새 선택 프리셋 이름"
                            aria-invalid={presetName !== '' && presetNameInvalid ? true : undefined}
                            disabled={presetBusy !== null}
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => void saveSelectionPreset()}
                          disabled={
                            busy !== null ||
                            presetBusy !== null ||
                            presetNameInvalid ||
                            hasBlockingDiagnostics ||
                            selectedOperationCount === 0
                          }
                        >
                          {presetBusy === 'save' ? (
                            <LoaderCircle className="spin" size={16} aria-hidden="true" />
                          ) : (
                            <Save size={16} aria-hidden="true" />
                          )}
                          현재 선택 저장
                        </button>
                        {presetUndo ? (
                          <button
                            type="button"
                            onClick={undoSelectionPreset}
                            disabled={presetBusy !== null}
                          >
                            <Undo2 size={16} aria-hidden="true" /> 적용 취소
                          </button>
                        ) : null}
                      </div>
                      <div className="selection-preset-meta">
                        <small>
                          이름 {formatBytes(presetNameBytes)} /{' '}
                          {formatBytes(status?.limits.maxSelectionPresetNameBytes ?? 0)}
                          {staleSelectionPresets.length > 0
                            ? ` · 이전 분석 프리셋 ${staleSelectionPresets.length}개`
                            : ''}
                        </small>
                        <span role="status" aria-live="polite">
                          {selectedPreset?.compatibility === 'stale' && presetNotice === ''
                            ? '선택한 프리셋은 이전 분석에 속해 적용할 수 없습니다.'
                            : presetNotice}
                        </span>
                      </div>
                      {presetReview ? (
                        <div className="selection-preset-review">
                          <div>
                            <strong>이전 선택을 현재 계약에서 다시 검토</strong>
                            <p>
                              같은 ID로 남은 {presetReview.candidateOperationIds.length}개만 후보로
                              가져옵니다. 현재 계약 변경 여부는 위 release 비교에서 확인하세요.
                            </p>
                          </div>
                          <dl>
                            <div>
                              <dt>재검토 후보</dt>
                              <dd>{presetReview.candidateOperationIds.length}</dd>
                            </div>
                            <div>
                              <dt>사라진 선택</dt>
                              <dd>{presetReview.missingOperationIds.length}</dd>
                            </div>
                            <div>
                              <dt>기존에 미선택</dt>
                              <dd>{presetReview.unselectedCurrentOperationIds.length}</dd>
                            </div>
                          </dl>
                          {presetReview.missingOperationIds.length > 0 ? (
                            <small>
                              현재 source에 없는 ID:{' '}
                              {presetReview.missingOperationIds.slice(0, 5).join(', ')}
                              {presetReview.missingOperationIds.length > 5 ? ' 외' : ''}
                            </small>
                          ) : null}
                          <button
                            type="button"
                            onClick={applyPresetReviewCandidates}
                            disabled={
                              presetBusy !== null || presetReview.candidateOperationIds.length === 0
                            }
                          >
                            재검토 후보 {presetReview.candidateOperationIds.length}개 불러오기
                          </button>
                        </div>
                      ) : null}
                    </section>
                    <OperationExplorer
                      operations={filteredOperations}
                      selection={operationSelection}
                      disabled={operationSelectionDisabled}
                      onToggle={(operationId, included) =>
                        updateOperationSelection([operationId], included)
                      }
                    />
                  </div>
                  <aside className="panel diagnostics-panel">
                    <div className="panel-heading compact-heading">
                      <div>
                        <h3>Diagnostics</h3>
                        <p>{analysis.diagnostics.length}개 결과</p>
                      </div>
                    </div>
                    <Diagnostics diagnostics={analysis.diagnostics} />
                  </aside>
                </div>

                <div className="sticky-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setStage(1)}
                    disabled={presetBusy === 'apply'}
                  >
                    <ArrowLeft size={18} /> Source 수정
                  </button>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => void registerSource()}
                    aria-describedby="operation-selection-help"
                    disabled={
                      busy !== null ||
                      presetBusy === 'apply' ||
                      hasBlockingDiagnostics ||
                      selectedOperationCount === 0
                    }
                  >
                    {busy === 'register' ? (
                      <BusyLabel>Release 검증 중</BusyLabel>
                    ) : (
                      <>
                        <ShieldCheck size={18} /> 선택한 {selectedOperationCount}개 검증하고 등록{' '}
                        <ArrowRight size={18} />
                      </>
                    )}
                  </button>
                </div>
              </section>
            ) : null}

            {stage === 3 && registration ? (
              <section className="workflow-section" aria-labelledby="review-heading">
                <div className="section-heading">
                  <div>
                    <span className="section-kicker">STEP 3</span>
                    <h2 id="review-heading" ref={stageHeadingRef} tabIndex={-1}>
                      실행 계약 검토
                    </h2>
                    <p>
                      원본 {registration.registration.sourceOperationCount}개 중 선택한{' '}
                      {registration.registration.capabilityCount}개 capability의 입력, 출력, 목적지,
                      인증과 위험도를 확인하세요.
                    </p>
                  </div>
                  <a className="artifact-link" href={registration.artifactUrls.release} download>
                    <Download size={16} /> Release JSON
                  </a>
                </div>

                <div className="release-strip">
                  <div>
                    <small>Release</small>
                    <strong>{registration.registration.title}</strong>
                  </div>
                  <div>
                    <small>Tools</small>
                    <strong>
                      {registration.registration.capabilityCount} /{' '}
                      {registration.registration.sourceOperationCount}
                    </strong>
                  </div>
                  <div>
                    <small>Fingerprint</small>
                    <code title={registration.registration.fingerprint}>
                      {compactFingerprint(registration.registration.fingerprint)}
                    </code>
                  </div>
                  <div>
                    <small>Created</small>
                    <span>{dateTime(registration.registration.createdAt)}</span>
                  </div>
                </div>

                <div className="capability-toolbar">
                  <label className="search-field">
                    <Search size={17} aria-hidden="true" />
                    <span className="sr-only">Capability 검색</span>
                    <input
                      value={capabilityQuery}
                      onChange={(event) => setCapabilityQuery(event.target.value)}
                      placeholder="Tool name, method, path 검색"
                    />
                  </label>
                  <span>
                    {filteredCapabilities.length} / {registration.capabilities.length}
                  </span>
                </div>

                <div className="capability-layout">
                  <div
                    className="panel capability-list"
                    role="tablist"
                    aria-label="Capability 목록"
                    aria-orientation="vertical"
                  >
                    {filteredCapabilities.map((capability, index) => (
                      <button
                        type="button"
                        role="tab"
                        id={`capability-tab-${index}`}
                        aria-selected={selectedCapability?.id === capability.id}
                        aria-controls="capability-detail-panel"
                        tabIndex={selectedCapability?.id === capability.id ? 0 : -1}
                        className={`capability-row ${selectedCapability?.id === capability.id ? 'capability-selected' : ''}`}
                        onClick={() => setSelectedCapabilityId(capability.id)}
                        onKeyDown={(event) => {
                          const tabs = Array.from(
                            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                              '[role="tab"]',
                            ) ?? [],
                          );
                          const current = tabs.indexOf(event.currentTarget);
                          const nextIndex =
                            event.key === 'ArrowDown'
                              ? (current + 1) % tabs.length
                              : event.key === 'ArrowUp'
                                ? (current - 1 + tabs.length) % tabs.length
                                : event.key === 'Home'
                                  ? 0
                                  : event.key === 'End'
                                    ? tabs.length - 1
                                    : -1;
                          if (nextIndex < 0) return;
                          event.preventDefault();
                          const next = filteredCapabilities[nextIndex];
                          if (next) setSelectedCapabilityId(next.id);
                          tabs[nextIndex]?.focus();
                        }}
                        key={capability.id}
                      >
                        <span className="capability-row-top">
                          <strong>{capability.title}</strong>
                          <RiskBadge capability={capability} />
                        </span>
                        <span className="capability-request">
                          <MethodBadge method={capability.method} />
                          <code>{capability.path}</code>
                        </span>
                        <span className="capability-description">{capability.description}</span>
                      </button>
                    ))}
                    {filteredCapabilities.length === 0 ? (
                      <div className="no-results">검색 결과가 없습니다.</div>
                    ) : null}
                  </div>

                  {selectedCapability ? (
                    <article
                      className="panel capability-detail"
                      id="capability-detail-panel"
                      role="tabpanel"
                      aria-labelledby={`capability-tab-${filteredCapabilities.findIndex(({ id }) => id === selectedCapability.id)}`}
                      tabIndex={0}
                    >
                      <div className="detail-heading">
                        <div>
                          <span className="tool-name">{selectedCapability.name}</span>
                          <h3>{selectedCapability.title}</h3>
                        </div>
                        <RiskBadge capability={selectedCapability} />
                      </div>
                      <p className="detail-description">{selectedCapability.description}</p>
                      <dl className="contract-grid">
                        <div>
                          <dt>Request</dt>
                          <dd>
                            <MethodBadge method={selectedCapability.method} />{' '}
                            <code>{selectedCapability.path}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>Authentication</dt>
                          <dd>
                            {selectedCapability.authRequired
                              ? selectedCapability.authSchemes.join(', ') || '필수'
                              : '필요 없음'}
                          </dd>
                        </div>
                        <div>
                          <dt>Side effect</dt>
                          <dd>{selectedCapability.risk.sideEffect}</dd>
                        </div>
                        <div>
                          <dt>Confirmation</dt>
                          <dd>
                            {selectedCapability.risk.requiresConfirmation
                              ? '런타임 승인 필요'
                              : '추가 승인 없음'}
                          </dd>
                        </div>
                      </dl>
                      <div className="server-contract">
                        <Server size={17} aria-hidden="true" />
                        <div>
                          <strong>실행 목적지</strong>
                          {selectedCapability.servers.map((server) => (
                            <code key={server}>{server}</code>
                          ))}
                        </div>
                      </div>
                      <details>
                        <summary>
                          Input schema <ChevronDown className="summary-chevron" size={16} />
                        </summary>
                        <pre>{JSON.stringify(selectedCapability.inputSchema, null, 2)}</pre>
                      </details>
                      <details>
                        <summary>
                          Output schema <ChevronDown className="summary-chevron" size={16} />
                        </summary>
                        <pre>{JSON.stringify(selectedCapability.outputSchema ?? {}, null, 2)}</pre>
                      </details>
                      <details>
                        <summary>
                          Source provenance <ChevronDown className="summary-chevron" size={16} />
                        </summary>
                        <pre>{JSON.stringify(selectedCapability.provenance, null, 2)}</pre>
                      </details>
                    </article>
                  ) : null}
                </div>

                <div className="contract-note">
                  <ShieldCheck size={19} />
                  <p>
                    <strong>Source-authoritative contract</strong> Method, path, server, 인증, wire
                    serialization은 모델이나 UI가 변경하지 않습니다.
                  </p>
                </div>
                <div className="sticky-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => (analysis ? setStage(2) : setStage(1))}
                  >
                    <ArrowLeft size={18} /> 이전
                  </button>
                  <button className="primary-button" type="button" onClick={() => setStage(4)}>
                    연결 정책 만들기 <ArrowRight size={18} />
                  </button>
                </div>
              </section>
            ) : null}

            {stage === 4 && registration ? (
              <section className="workflow-section" aria-labelledby="policy-heading">
                <div className="section-heading">
                  <div>
                    <span className="section-kicker">STEP 4</span>
                    <h2 id="policy-heading" ref={stageHeadingRef} tabIndex={-1}>
                      연결 정책 만들기
                    </h2>
                    <p>모든 실행 목적지와 인증 이름, 확인 정책을 명시적으로 검토합니다.</p>
                  </div>
                  <span className="review-counter">
                    {approvedOrigins.size}/{registration.registration.origins.length} origins 승인
                  </span>
                </div>

                <div className="policy-layout">
                  <div className="policy-main">
                    <section className="panel policy-section" aria-labelledby="identity-heading">
                      <div className="policy-heading">
                        <span className="policy-number">1</span>
                        <div>
                          <h3 id="identity-heading">연결 이름</h3>
                          <p>AI 도구에서 구분할 로컬 표시 정보입니다.</p>
                        </div>
                      </div>
                      <div className="two-fields">
                        <label htmlFor="connection-display-name">
                          <span className="field-label">표시 이름</span>
                          <input
                            id="connection-display-name"
                            value={connectionDraft.displayName}
                            maxLength={128}
                            aria-invalid={connectionDraft.displayName.trim() === '' || undefined}
                            aria-describedby={
                              connectionDraft.displayName.trim() === ''
                                ? 'connection-display-name-error'
                                : undefined
                            }
                            onChange={(event) =>
                              setConnectionDraft((current) => ({
                                ...current,
                                displayName: event.target.value,
                              }))
                            }
                          />
                          {connectionDraft.displayName.trim() === '' ? (
                            <span className="field-error" id="connection-display-name-error">
                              표시 이름을 입력하세요.
                            </span>
                          ) : null}
                        </label>
                        <label>
                          <span className="field-label">설명 (선택)</span>
                          <input
                            value={connectionDraft.description}
                            maxLength={4_096}
                            onChange={(event) =>
                              setConnectionDraft((current) => ({
                                ...current,
                                description: event.target.value,
                              }))
                            }
                          />
                        </label>
                      </div>
                    </section>

                    <section className="panel policy-section" aria-labelledby="origins-heading">
                      <div className="policy-heading">
                        <span className="policy-number">2</span>
                        <div>
                          <h3 id="origins-heading">실행 origin 검토</h3>
                          <p>Release에서 파생된 모든 목적지를 빠짐없이 승인해야 합니다.</p>
                        </div>
                      </div>
                      <div className="origin-list">
                        {registration.registration.origins.map((origin) => (
                          <label
                            className={`origin-card ${approvedOrigins.has(origin) ? 'origin-approved' : ''}`}
                            key={origin}
                          >
                            <input
                              type="checkbox"
                              checked={approvedOrigins.has(origin)}
                              onChange={() => toggleOrigin(origin)}
                            />
                            <span className="checkbox-visual" aria-hidden="true">
                              <Check size={14} />
                            </span>
                            <Server size={19} aria-hidden="true" />
                            <span>
                              <strong>{origin}</strong>
                              <small>
                                {origin.startsWith('https://') ? 'TLS 연결' : '평문 HTTP 연결'}
                              </small>
                            </span>
                          </label>
                        ))}
                      </div>
                      {hasInsecureOrigin ? (
                        <label className="danger-confirmation">
                          <input
                            type="checkbox"
                            checked={connectionDraft.allowInsecureHttp}
                            onChange={(event) =>
                              setConnectionDraft((current) => ({
                                ...current,
                                allowInsecureHttp: event.target.checked,
                              }))
                            }
                          />
                          <span>
                            <strong>평문 HTTP 위험을 이해하고 허용합니다</strong>
                            <small>
                              Credential과 요청 데이터가 전송 구간에서 보호되지 않을 수 있습니다.
                            </small>
                          </span>
                        </label>
                      ) : null}
                    </section>

                    <section className="panel policy-section" aria-labelledby="credentials-heading">
                      <div className="policy-heading">
                        <span className="policy-number">3</span>
                        <div>
                          <h3 id="credentials-heading">Credential 환경 변수</h3>
                          <p>값은 입력하지 않습니다. 런타임이 읽을 환경 변수 이름만 설정합니다.</p>
                        </div>
                      </div>
                      {registration.registration.credentialBindings.length === 0 ? (
                        <div className="empty-inline">
                          <CheckCircle2 size={18} />
                          <span>이 release에는 정적 credential binding이 없습니다.</span>
                        </div>
                      ) : (
                        <div className="credential-list">
                          {registration.registration.credentialBindings.map((binding, index) => {
                            const environmentName =
                              connectionDraft.credentialEnvironment[binding.environmentVariable] ??
                              '';
                            const environmentNameValid = isEnvironmentVariableName(environmentName);
                            const inputId = `credential-environment-${index}`;
                            const errorId = `${inputId}-error`;
                            return (
                              <div
                                className="credential-row"
                                key={`${binding.scheme}-${binding.location}-${binding.parameterName}`}
                              >
                                <div className="credential-contract">
                                  <KeyRound size={18} />
                                  <span>
                                    <strong>{binding.scheme}</strong>
                                    <small>
                                      {binding.location} · {binding.parameterName}
                                      {binding.prefix ? ` · prefix ${binding.prefix.trim()}` : ''}
                                    </small>
                                  </span>
                                </div>
                                <label htmlFor={inputId}>
                                  <span className="field-label">환경 변수 이름</span>
                                  <input
                                    id={inputId}
                                    className="mono-input"
                                    value={environmentName}
                                    aria-invalid={!environmentNameValid || undefined}
                                    aria-describedby={!environmentNameValid ? errorId : undefined}
                                    onChange={(event) =>
                                      setConnectionDraft((current) => ({
                                        ...current,
                                        credentialEnvironment: {
                                          ...current.credentialEnvironment,
                                          [binding.environmentVariable]: event.target.value,
                                        },
                                      }))
                                    }
                                    spellCheck={false}
                                  />
                                  {!environmentNameValid ? (
                                    <span className="field-error" id={errorId}>
                                      영문자 또는 밑줄로 시작하고 영문자·숫자·밑줄만 사용하세요.
                                    </span>
                                  ) : null}
                                </label>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <div className="security-note compact-note">
                        <LockKeyhole size={18} />
                        <div>
                          <strong>환경 변수 이름 전용</strong>
                          <p>
                            모든 입력은 환경 변수 이름으로 해석됩니다. 실제 credential 값을 붙여
                            넣지 마세요.
                          </p>
                        </div>
                      </div>
                    </section>

                    <section
                      className="panel policy-section"
                      aria-labelledby="confirmation-heading"
                    >
                      <div className="policy-heading">
                        <span className="policy-number">4</span>
                        <div>
                          <h3 id="confirmation-heading">확인 정책</h3>
                          <p>Side effect가 가능한 tool의 런타임 승인 방식을 선택합니다.</p>
                        </div>
                      </div>
                      <div className="confirmation-options">
                        <label
                          className={`confirmation-card ${connectionDraft.confirmation === 'per-call' ? 'confirmation-selected' : ''}`}
                        >
                          <input
                            type="radio"
                            name="confirmation"
                            value="per-call"
                            checked={connectionDraft.confirmation === 'per-call'}
                            onChange={() =>
                              setConnectionDraft((current) => ({
                                ...current,
                                confirmation: 'per-call',
                              }))
                            }
                          />
                          <span className="radio-visual" />
                          <ShieldCheck size={21} />
                          <span>
                            <strong>호출별 확인 필요</strong>
                            <small>
                              권장. 현재 stdio launcher에는 승인 UI가 없어 확인 필요 도구는
                              차단됩니다.
                            </small>
                          </span>
                        </label>
                        <label
                          className={`confirmation-card confirmation-risky ${connectionDraft.confirmation === 'process' ? 'confirmation-selected' : ''}`}
                        >
                          <input
                            type="radio"
                            name="confirmation"
                            value="process"
                            checked={connectionDraft.confirmation === 'process'}
                            onChange={() =>
                              setConnectionDraft((current) => ({
                                ...current,
                                confirmation: 'process',
                              }))
                            }
                          />
                          <span className="radio-visual" />
                          <TriangleAlert size={21} />
                          <span>
                            <strong>Process 전체 승인</strong>
                            <small>
                              이 process의 모든 확인 필요 호출을 승인합니다. 모든 tool과 caller를
                              검토한 경우에만 사용하세요.
                            </small>
                          </span>
                        </label>
                      </div>
                    </section>
                  </div>

                  <aside className="panel policy-summary">
                    <h3>정책 요약</h3>
                    <dl>
                      <div>
                        <dt>Release</dt>
                        <dd>{registration.registration.title}</dd>
                      </div>
                      <div>
                        <dt>Capabilities</dt>
                        <dd>
                          {registration.registration.capabilityCount}/
                          {registration.registration.sourceOperationCount}
                        </dd>
                      </div>
                      <div>
                        <dt>Origins</dt>
                        <dd className={allOriginsApproved ? 'summary-ready' : ''}>
                          {approvedOrigins.size}/{registration.registration.origins.length}
                        </dd>
                      </div>
                      <div>
                        <dt>Credentials</dt>
                        <dd>{registration.registration.credentialBindings.length}</dd>
                      </div>
                      <div>
                        <dt>Confirmation</dt>
                        <dd>{connectionDraft.confirmation}</dd>
                      </div>
                    </dl>
                    <div
                      className={`readiness ${connectionReady ? 'readiness-ready' : ''}`}
                      id="connection-readiness"
                      role="status"
                      aria-live="polite"
                    >
                      {connectionReady ? <CheckCircle2 size={19} /> : <AlertCircle size={19} />}
                      <span>
                        {connectionReady
                          ? '내보내기 준비됨'
                          : `${policyIssues.length}개 검토 항목 남음`}
                      </span>
                    </div>
                    {!connectionReady ? (
                      <ul className="readiness-list">
                        {policyIssues.map((issue) => (
                          <li key={issue}>{issue}</li>
                        ))}
                      </ul>
                    ) : null}
                  </aside>
                </div>

                <div className="sticky-actions">
                  <button className="secondary-button" type="button" onClick={() => setStage(3)}>
                    <ArrowLeft size={18} /> 실행 계약
                  </button>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => void createConnection()}
                    aria-describedby="connection-readiness"
                    disabled={busy !== null || !connectionReady}
                  >
                    {busy === 'connect' ? (
                      <BusyLabel>Profile 검증 중</BusyLabel>
                    ) : (
                      <>
                        <ShieldCheck size={18} /> MCP 연결 생성 <ArrowRight size={18} />
                      </>
                    )}
                  </button>
                </div>
              </section>
            ) : null}

            {stage === 5 && registration && connection ? (
              <section className="workflow-section export-section" aria-labelledby="export-heading">
                <div className="export-success">
                  <div className="completion-mark" aria-hidden="true">
                    <Check size={24} strokeWidth={2.4} />
                  </div>
                  <div className="export-heading-copy">
                    <span className="section-kicker">STEP 5</span>
                    <h2 id="export-heading" ref={stageHeadingRef} tabIndex={-1}>
                      MCP 연결 설정이 준비되었습니다
                    </h2>
                    <p>
                      검증된 profile을 실행하는 product-neutral `mcpServers` 설정입니다. Credential
                      값은 포함되지 않습니다.
                    </p>
                  </div>
                </div>

                <div className="export-layout">
                  <div className="panel code-panel">
                    <div className="code-heading">
                      <div>
                        <FileJson2 size={19} />
                        <span>
                          <strong>mcpServers.json</strong>
                          <small>Shell-free launcher descriptor</small>
                        </span>
                      </div>
                      <span className="verified-label">
                        <ShieldCheck size={15} /> 검증됨
                      </span>
                    </div>
                    <pre>
                      <code>{descriptorText}</code>
                    </pre>
                    <div className="code-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => void copyDescriptor()}
                      >
                        {copyState === 'copied' ? (
                          <CheckCircle2 size={18} />
                        ) : (
                          <Clipboard size={18} />
                        )}
                        {copyState === 'copied' ? '복사됨' : '설정 복사'}
                      </button>
                      <button className="primary-button" type="button" onClick={downloadDescriptor}>
                        <Download size={18} /> JSON 다운로드
                      </button>
                    </div>
                  </div>

                  <aside className="panel export-summary">
                    <h3>연결 정보</h3>
                    <dl>
                      <div>
                        <dt>Profile</dt>
                        <dd>
                          <code>{connection.profile.id}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Fingerprint</dt>
                        <dd>
                          <code title={connection.profile.fingerprint}>
                            {compactFingerprint(connection.profile.fingerprint)}
                          </code>
                        </dd>
                      </div>
                      <div>
                        <dt>Confirmation</dt>
                        <dd>{connection.profile.confirmation}</dd>
                      </div>
                    </dl>
                    <h4>필요한 환경 변수</h4>
                    {connection.requiredEnvironmentVariables.length === 0 ? (
                      <p className="muted-copy">설정할 credential이 없습니다.</p>
                    ) : (
                      <ul className="environment-list">
                        {connection.requiredEnvironmentVariables.map((name) => (
                          <li key={name}>
                            <KeyRound size={15} />
                            <code>{name}</code>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="security-note compact-note">
                      <LockKeyhole size={18} />
                      <div>
                        <strong>Credential 값 없음</strong>
                        <p>값은 AI 도구를 실행하는 secret-aware 환경에서 별도로 주입하세요.</p>
                      </div>
                    </div>
                    <div className="artifact-buttons">
                      <a href={connection.artifactUrls.profile} download>
                        <Download size={16} /> Profile
                      </a>
                      <a href={connection.artifactUrls.descriptor} download>
                        <Download size={16} /> Descriptor
                      </a>
                    </div>
                  </aside>
                </div>

                <div className="next-steps panel">
                  <SquareTerminal size={22} />
                  <div>
                    <strong>AI 도구에 연결하기</strong>
                    <p>
                      위 JSON을 MCP host 설정에 추가하고, 표시된 환경 변수를 host process에
                      주입하세요. 시작 시 profile과 release가 다시 검증됩니다.
                    </p>
                  </div>
                </div>
                <div className="final-actions">
                  <button className="secondary-button" type="button" onClick={() => setStage(4)}>
                    <ArrowLeft size={18} /> 정책 수정
                  </button>
                  <button className="text-button" type="button" onClick={startOver}>
                    다른 API 등록
                  </button>
                </div>
              </section>
            ) : null}
          </>
        )}
      </main>

      <footer>
        <span>HiMCP · local-first API capability compiler</span>
        <span>Source text is transient · credential fields accept environment names only.</span>
      </footer>
    </div>
  );
}
