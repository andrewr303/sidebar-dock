// Retries for a model request that failed before the model said anything. A busy or briefly unreachable provider is
// tried again with a growing, jittered wait (the provider's Retry-After wins when it sends one); a request that already
// streamed text, thinking or a tool call is never sent again, because the person has seen part of that answer and a
// tool call may have run. Pure apart from the timer.

export const RETRY = Object.freeze({ attempts: 3, baseMs: 1000, maxMs: 30_000 });

const RETRYABLE_CODES = new Set(['rate_limit', 'provider_down', 'network', 'timeout', 'incomplete']);
const retryableStatus = status => status === 408 || status === 409 || status === 429 || status >= 500;

/** True for a failure another attempt may fix: a rate limit, a provider that is down or slow, a dropped connection. */
export function isRetryable(error) {
  if (!error || error.name === 'AbortError' || error.code === 'aborted') return false;
  // An exhausted quota or missing credit answers 429 too, and waiting does not change it.
  if (error.status === 429 && /quota|billing|credit|insufficient/i.test(String(error.detail || ''))) return false;
  if (Number.isInteger(error.status)) return retryableStatus(error.status);
  return RETRYABLE_CODES.has(error.code);
}

/** The wait before attempt `attempt + 1`, in milliseconds: Retry-After (seconds) when given, else half fixed and half jitter. */
export function backoffMs(attempt, error, { baseMs = RETRY.baseMs, maxMs = RETRY.maxMs, random = Math.random } = {}) {
  const after = Number(error?.retryAfter);
  if (Number.isFinite(after) && after > 0) return Math.min(maxMs, Math.ceil(after * 1000));
  const span = baseMs * 2 ** (attempt - 1);
  return Math.min(maxMs, Math.round(span / 2 + random() * (span / 2)));
}

/** A wait that ends early, with the signal's reason, when the person stops the run. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new DOMException('Stopped', 'AbortError')); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason || new DOMException('Stopped', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * withRetry(run, { attempts, baseMs, maxMs, signal, started, onRetry, wait, random }) -> run's result.
 * run(attempt) is called until it resolves. started(): true once the attempt produced output; such a failure is thrown
 * at once. onRetry({ attempt, delayMs, error }) is called before each wait.
 */
export async function withRetry(run, { attempts = RETRY.attempts, baseMs = RETRY.baseMs, maxMs = RETRY.maxMs, signal, started = () => false, onRetry, wait = sleep, random = Math.random } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run(attempt);
    } catch (error) {
      if (signal?.aborted || started() || attempt >= attempts || !isRetryable(error)) throw error;
      const delayMs = backoffMs(attempt, error, { baseMs, maxMs, random });
      try { onRetry?.({ attempt, delayMs, error }); } catch (failure) { console.error(failure); }
      await wait(delayMs, signal);
    }
  }
}
