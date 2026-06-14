import * as vscode from 'vscode';
import { REPLAY_MARKER_MIME, REPLAY_MARKER_WRITER_ID } from './consts';

/**
 * Replay markers. A marker is a
 * `LanguageModelDataPart` we attach to our own assistant turns so that, on the
 * next turn, we can recover reasoning (and vision) text that VS Code does not
 * round-trip. Format: `{writerId}\{prefix}{base64url(json)}`.
 */

const ENCODED_JSON_PREFIX = 'json:';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface ReplayMarkerMetadata {
  reasoningText?: string;
  visionText?: string;
  /**
   * Protocol-specific replay payload preserved verbatim across turns — e.g.
   * Anthropic `thinking` blocks (with `signature`) or Responses `reasoning`
   * items, which the upstream rejects the request without.
   */
  raw?: unknown;
}

export interface ReplayMarkerParseResult {
  valid: boolean;
  reasoningText?: string;
  visionText?: string;
  raw?: unknown;
}

export function hasReplayMarkerMetadata(metadata: ReplayMarkerMetadata): boolean {
  return Boolean(metadata.reasoningText || metadata.visionText || metadata.raw !== undefined);
}

export function createReplayMarkerPart(
  metadata: ReplayMarkerMetadata,
): vscode.LanguageModelDataPart {
  const payload: Record<string, unknown> = {};
  if (metadata.visionText) payload.vision = { text: metadata.visionText };
  if (metadata.reasoningText) payload.reasoning = { text: metadata.reasoningText };
  if (metadata.raw !== undefined) payload.raw = metadata.raw;
  const json = JSON.stringify(payload);
  const encoded = `${ENCODED_JSON_PREFIX}${Buffer.from(json, 'utf8').toString('base64url')}`;
  return new vscode.LanguageModelDataPart(
    new TextEncoder().encode(`${REPLAY_MARKER_WRITER_ID}\\${encoded}`),
    REPLAY_MARKER_MIME,
  );
}

function parseData(data: Uint8Array): ReplayMarkerParseResult {
  const decoded = new TextDecoder().decode(data);
  const sep = decoded.indexOf('\\');
  if (sep < 0) return { valid: false };
  // Accept our own writer id; tolerate other prefixes for forward-compat.
  const payloadRaw = decoded.slice(sep + 1);

  let json: string;
  if (payloadRaw.startsWith(ENCODED_JSON_PREFIX)) {
    const b64 = payloadRaw.slice(ENCODED_JSON_PREFIX.length);
    if (!b64 || !BASE64URL_PATTERN.test(b64)) return { valid: false };
    try {
      json = Buffer.from(b64, 'base64url').toString('utf8');
    } catch {
      return { valid: false };
    }
  } else {
    json = payloadRaw;
  }

  try {
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false };
    const obj = value as Record<string, unknown>;
    const vision = obj.vision as { text?: unknown } | undefined;
    const reasoning = obj.reasoning as { text?: unknown } | undefined;
    return {
      valid: true,
      visionText: typeof vision?.text === 'string' && vision.text ? vision.text : undefined,
      reasoningText:
        typeof reasoning?.text === 'string' && reasoning.text ? reasoning.text : undefined,
      raw: 'raw' in obj ? obj.raw : undefined,
    };
  } catch {
    return { valid: false };
  }
}

/** Find and parse the first replay marker in a message, if any. */
export function parseFirstReplayMarker(
  message: vscode.LanguageModelChatRequestMessage,
): ReplayMarkerParseResult | undefined {
  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelDataPart && part.mimeType === REPLAY_MARKER_MIME) {
      return parseData(part.data);
    }
  }
  return undefined;
}
