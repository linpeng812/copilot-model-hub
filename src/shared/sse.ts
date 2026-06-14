/**
 * Incremental SSE line parser. Feed it raw decoded chunks; it yields complete
 * lines, keeping any trailing partial line buffered until the next feed. This
 * is the cross-chunk safety that prevents half a JSON line from being parsed.
 */
export class SseLineBuffer {
  private buffer = '';

  /** Push a decoded string chunk; returns the complete lines it produced. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // The last element is a (possibly empty) partial line; keep it buffered.
    this.buffer = lines.pop() ?? '';
    return lines;
  }

  /** Return whatever remains buffered (call after the stream ends). */
  flush(): string {
    const rest = this.buffer;
    this.buffer = '';
    return rest;
  }
}

export interface SseDataEvent {
  /** True when the line was the `[DONE]` sentinel. */
  done: boolean;
  /** The JSON/text payload after `data: `, when not done. */
  data?: string;
}

/**
 * Interpret one SSE line. Returns undefined for blank lines, comments (`:`),
 * and non-`data:` fields, which callers should skip. `data: [DONE]` returns
 * `{ done: true }`.
 */
export function parseSseLine(line: string): SseDataEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return undefined;
  if (trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]') return { done: true };
  if (!trimmed.startsWith('data:')) return undefined;
  // Tolerate both `data: x` and `data:x`.
  const data = trimmed.slice(5).replace(/^ /, '');
  return { done: false, data };
}
