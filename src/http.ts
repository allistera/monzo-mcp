export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

export class HttpTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`HTTP request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "HttpTimeoutError";
  }
}

/**
 * Run an HTTP request with a deadline that covers both headers and body reads.
 * The response handler runs before the deadline is cleared so a stalled body
 * cannot leave the caller waiting indefinitely.
 */
export async function fetchWithTimeout<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  handleResponse: (response: Response) => Promise<T>,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const callerSignal = init.signal;
  let timedOut = false;

  const onCallerAbort = () => {
    controller.abort(callerSignal?.reason);
  };
  if (callerSignal) {
    if (callerSignal.aborted) {
      onCallerAbort();
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const url = input instanceof Request ? input.url : String(input);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    return await handleResponse(response);
  } catch (error) {
    if (timedOut) {
      throw new HttpTimeoutError(url, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
