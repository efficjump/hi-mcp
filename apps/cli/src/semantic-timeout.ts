export class SemanticStageTimeoutError extends Error {
  constructor(stage: string, timeoutMs: number) {
    super(`Semantic ${stage} exceeded the configured ${timeoutMs}ms timeout.`);
    this.name = 'SemanticStageTimeoutError';
  }
}

/** Bounds a provider-backed stage even when trusted adapter code fails to honor AbortSignal. */
export async function runSemanticStage<T>(
  stage: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('Semantic stage timeout must be a supported positive integer.');
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException('Semantic stage timed out.', 'TimeoutError'));
      reject(new SemanticStageTimeoutError(stage, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
