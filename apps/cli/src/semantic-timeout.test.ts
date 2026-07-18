import { describe, expect, it } from 'vitest';

import { SemanticStageTimeoutError, runSemanticStage } from './semantic-timeout.js';

describe('runSemanticStage', () => {
  it('returns successful provider work before the deadline', async () => {
    await expect(runSemanticStage('discovery', 50, async () => 'ready')).resolves.toBe('ready');
  });

  it('rejects and aborts when provider work ignores completion', async () => {
    let observedSignal: AbortSignal | undefined;
    await expect(
      runSemanticStage('compilation', 5, async (signal) => {
        observedSignal = signal;
        return new Promise<never>(() => undefined);
      }),
    ).rejects.toBeInstanceOf(SemanticStageTimeoutError);
    expect(observedSignal?.aborted).toBe(true);
  });
});
