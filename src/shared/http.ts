import type { CancellationToken } from 'vscode';
import { ModelConnection } from '../config/types';
import { UpstreamError, upstreamErrorFromResponse, isAbortError } from './errors';

export interface StreamRequest {
  connection: ModelConnection;
  apiKey: string;
  /** Path appended to baseUrl, with a single leading slash. */
  path: string;
  /** Auth scheme: bearer for OpenAI-style, x-api-key for Anthropic. */
  auth: 'bearer' | 'x-api-key';
  /** Extra headers merged after the connection headers (e.g. anthropic-version). */
  headers?: Record<string, string>;
  body: unknown;
  token: CancellationToken;
}

/**
 * POST a JSON body and return the response stream reader. Applies the
 * connection's configured headers, auth, and timeout, and wires the VS Code
 * cancellation token to an AbortController. Throws UpstreamError on non-2xx.
 */
export async function postStream(
  req: StreamRequest,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const { connection, apiKey, path, auth, body, token } = req;

  const controller = new AbortController();
  const cancelSub = token.onCancellationRequested(() => controller.abort());
  if (token.isCancellationRequested) controller.abort();

  const timeoutMs = connection.request?.timeoutMs;
  const timeout = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...connection.headers,
    ...req.headers,
  };
  if (auth === 'bearer') {
    headers['authorization'] = `Bearer ${apiKey}`;
  } else {
    headers['x-api-key'] = apiKey;
  }

  try {
    const response = await fetch(`${connection.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      let parsed: unknown;
      try {
        const text = await response.text();
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      } catch {
        parsed = undefined;
      }
      throw upstreamErrorFromResponse(response.status, parsed);
    }

    if (!response.body) {
      throw new UpstreamError('Upstream returned no response body');
    }

    return response.body.getReader();
  } finally {
    if (timeout) clearTimeout(timeout);
    cancelSub.dispose();
  }
}

export { isAbortError };
