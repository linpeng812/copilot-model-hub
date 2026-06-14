import * as vscode from 'vscode';
import { REPLAY_MARKER_MIME } from './replay/consts';

const IMAGE_PART_ESTIMATED_CHARS = 1020;
const MAX_DATA_PART_CHARS = 10000;

const DEFAULT_CHARS_PER_TOKEN = 4.0;
const EMA_HISTORY_WEIGHT = 0.7;
const EMA_OBSERVED_WEIGHT = 0.3;

/**
 * `LanguageModelThinkingPart` is a proposed API not present in the stable
 * typings, so we match it structurally at runtime instead of by type.
 */
interface ThinkingPartLike {
  value: string | string[];
}

function isThinkingPart(part: unknown): part is ThinkingPartLike {
  const ctor = (vscode as Record<string, unknown>).LanguageModelThinkingPart;
  return (
    typeof ctor === 'function' &&
    part instanceof (ctor as new (...args: unknown[]) => object) &&
    'value' in (part as object)
  );
}

/** Estimate the character count for a single content part. */
function estimatePartChars(part: unknown): number {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value.length;
  }

  if (part instanceof vscode.LanguageModelToolCallPart) {
    let chars = part.callId.length + part.name.length;
    try {
      chars += JSON.stringify(part.input).length;
    } catch {
      chars += 2;
    }
    return chars;
  }

  if (part instanceof vscode.LanguageModelToolResultPart) {
    let chars = part.callId.length;
    if (Array.isArray(part.content)) {
      for (const item of part.content) {
        chars += estimatePartChars(item);
      }
    }
    return chars;
  }

  if (part instanceof vscode.LanguageModelDataPart) {
    const mime = part.mimeType;
    // Replay markers are not real assistant content; they cost no tokens.
    if (mime === REPLAY_MARKER_MIME) {
      return 0;
    }
    // Images are resolved to text by the vision pipeline before sending; raw
    // bytes would massively overestimate. Use a stable capped heuristic.
    if (mime.startsWith('image/')) {
      return IMAGE_PART_ESTIMATED_CHARS;
    }
    return Math.min(part.data?.byteLength ?? 0, MAX_DATA_PART_CHARS);
  }

  if (isThinkingPart(part)) {
    const value = part.value;
    if (typeof value === 'string') return value.length;
    if (Array.isArray(value)) return value.reduce((sum, s) => sum + s.length, 0);
    return 0;
  }

  if (part && typeof part === 'object') {
    try {
      return JSON.stringify(part).length;
    } catch {
      return 0;
    }
  }

  return 0;
}

export function estimateTokenCount(
  text: string | vscode.LanguageModelChatRequestMessage,
  charsPerToken: number,
): number {
  if (typeof text === 'string') {
    return Math.max(1, Math.ceil(text.length / charsPerToken));
  }
  if (!text?.content || !Array.isArray(text.content)) {
    return 1;
  }
  let totalChars = 0;
  for (const part of text.content) {
    totalChars += estimatePartChars(part);
  }
  return Math.max(1, Math.ceil(totalChars / charsPerToken));
}

/**
 * Tracks an adaptive chars-per-token ratio per connection, refined from
 * observed upstream usage via an exponential moving average. A poor ratio only
 * skews estimates slightly, so a shared default is a safe starting point.
 */
export class TokenEstimator {
  private ratios = new Map<string, number>();

  ratioFor(connectionId: string): number {
    return this.ratios.get(connectionId) ?? DEFAULT_CHARS_PER_TOKEN;
  }

  estimate(
    connectionId: string,
    text: string | vscode.LanguageModelChatRequestMessage,
  ): number {
    return estimateTokenCount(text, this.ratioFor(connectionId));
  }

  /** Refine the ratio for a connection from an observed request. */
  observe(connectionId: string, totalRequestChars: number, promptTokens: number): void {
    if (totalRequestChars <= 0 || promptTokens <= 0) return;
    const observed = totalRequestChars / promptTokens;
    const current = this.ratioFor(connectionId);
    this.ratios.set(
      connectionId,
      current * EMA_HISTORY_WEIGHT + observed * EMA_OBSERVED_WEIGHT,
    );
  }
}
