export { createProgram, runCli } from './program.js';
export { loadConfig, type HiMcpConfig } from './config.js';
export {
  analyzeSource,
  compileSource,
  fingerprintAnalysis,
  reviewOperationSelection,
  AnalysisReviewStaleError,
  OperationSelectionError,
  PipelineError,
  type AnalyzeResult,
  type CompilePipelineOptions,
  type CompilePipelineResult,
  type ReviewedOperationSelection,
} from './pipeline.js';
export { createSourceAdapterRegistry } from './source-registry.js';
export { SourceAdapterSelectionError } from '@hi-mcp/source-adapter-core';
export * from './contract-diff.js';
export * from './connection-profile.js';
export * from './profile-credentials.js';
