export type WorkflowStage = 1 | 2 | 3 | 4 | 5;

export interface WorkflowStageDefinition {
  readonly number: WorkflowStage;
  readonly label: string;
  readonly shortLabel: string;
  readonly guideTitle: string;
  readonly guideDescription: string;
}

/**
 * Shared workflow copy keeps the console stepper and the user guide in sync.
 */
export const workflowStages: readonly WorkflowStageDefinition[] = [
  {
    number: 1,
    label: 'API source',
    shortLabel: 'Source',
    guideTitle: '계약 불러오기',
    guideDescription: 'JSON·YAML 계약을 붙여넣거나 파일과 동적으로 제공되는 예제를 선택합니다.',
  },
  {
    number: 2,
    label: '분석 결과',
    shortLabel: '분석',
    guideTitle: '도구 범위 선택',
    guideDescription:
      '큰 계약도 검색·필터링하고, 현재 분석에 고정된 선택 프리셋으로 MCP에 필요한 항목만 남깁니다.',
  },
  {
    number: 3,
    label: '실행 계약',
    shortLabel: '검토',
    guideTitle: '실행 계약 검토',
    guideDescription: '입출력 schema, method, path, 목적지, 인증과 위험도를 확인합니다.',
  },
  {
    number: 4,
    label: '연결 정책',
    shortLabel: '정책',
    guideTitle: '연결 정책 승인',
    guideDescription: '정확한 origin과 환경 변수 이름, confirmation 정책을 직접 승인합니다.',
  },
  {
    number: 5,
    label: 'MCP 내보내기',
    shortLabel: '내보내기',
    guideTitle: 'AI 도구에 연결',
    guideDescription: '검증된 profile을 실행하는 product-neutral MCP 설정을 내보냅니다.',
  },
];
