/**
 * Normalizes upstream error bodies into a single message string and maps HTTP
 * status codes to user-facing reasons. Error body shapes vary widely across
 * providers (standard OpenAI `{error:{message}}`, MiniMax `base_resp`, top-level
 * `detail`, bare strings), mirroring cc-switch `chat_error_to_response_error`.
 */

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** Extract a human-readable message from an arbitrary upstream error body. */
export function extractUpstreamErrorMessage(body: unknown): string {
  if (body === undefined || body === null) {
    return 'Upstream returned an empty error response';
  }
  if (typeof body === 'string') {
    return str(body) ?? 'Upstream error';
  }
  if (!isObj(body)) {
    return 'Upstream error';
  }

  const source = isObj(body.error) ? body.error : body;

  const message =
    str(source.message) ??
    str(source.detail) ??
    str((source as Obj).status_msg) ??
    (isObj(source.base_resp) ? str(source.base_resp.status_msg) : undefined) ??
    str(body.detail);

  if (message) return message;

  // Last resort: serialize so the user has something to debug. Never includes
  // the API key (it is not part of the response body).
  try {
    return JSON.stringify(body);
  } catch {
    return 'Upstream error';
  }
}

/** Map an HTTP status to a short user-facing reason. */
export function describeHttpStatus(status: number): string {
  if (status === 401 || status === 403) return 'authentication failed (check API key)';
  if (status === 404) return 'endpoint not found (check baseUrl and protocol)';
  if (status === 429) return 'rate limited by upstream';
  if (status >= 500) return `upstream server error (HTTP ${status})`;
  return `upstream returned HTTP ${status}`;
}

/** An error carrying an HTTP status for upstream failures. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/** Build an UpstreamError from a failed Response and its (best-effort) body. */
export function upstreamErrorFromResponse(status: number, body: unknown): UpstreamError {
  const detail = extractUpstreamErrorMessage(body);
  const reason = describeHttpStatus(status);
  return new UpstreamError(`${reason}: ${detail}`, status);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
