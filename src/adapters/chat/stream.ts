import { SseLineBuffer, parseSseLine } from '../../shared/sse';
import { extractReasoningFieldText } from '../../shared/reasoning';

/** Normalized events emitted by the chat stream parser. */
export type ChatStreamEvent =
  | { kind: 'content'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'toolCall'; id: string; name: string; arguments: string }
  | { kind: 'usage'; usage: ChatUsage };

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Parses an OpenAI-compatible Chat Completions SSE stream into normalized
 * events. Tool-call deltas are accumulated by index and flushed on
 * finish_reason (`tool_calls`/`stop`) or `[DONE]`. Usage is kept as the latest
 * seen value and emitted once at the end. A malformed chunk is skipped, not
 * fatal. Mirrors the DeepSeek reference client's SSE handling.
 */
export class ChatStreamParser {
  private lineBuffer = new SseLineBuffer();
  private pending = new Map<number, PendingToolCall>();
  private latestUsage: ChatUsage | undefined;
  private done = false;

  constructor(private readonly onParseError?: (line: string, err: unknown) => void) {}

  /** Feed a decoded chunk; returns the events it produced. */
  push(chunk: string): ChatStreamEvent[] {
    if (this.done) return [];
    const events: ChatStreamEvent[] = [];
    for (const line of this.lineBuffer.push(chunk)) {
      this.handleLine(line, events);
      if (this.done) break;
    }
    return events;
  }

  /** Call when the stream ends; flushes remaining tool calls and usage. */
  end(): ChatStreamEvent[] {
    if (this.done) return [];
    const events: ChatStreamEvent[] = [];
    const rest = this.lineBuffer.flush();
    if (rest.trim()) this.handleLine(rest, events);
    this.flush(events);
    this.done = true;
    return events;
  }

  private handleLine(line: string, events: ChatStreamEvent[]): void {
    const parsed = parseSseLine(line);
    if (!parsed) return;
    if (parsed.done) {
      this.flush(events);
      this.done = true;
      return;
    }
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(parsed.data!) as Record<string, unknown>;
    } catch (err) {
      this.onParseError?.(parsed.data!, err);
      return;
    }

    const usage = chunk.usage as ChatUsage | undefined;
    if (usage) this.latestUsage = usage;

    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) return;

    const delta = choice.delta as Record<string, unknown> | undefined;
    if (delta) {
      const reasoning = extractReasoningFieldText(delta);
      if (reasoning) events.push({ kind: 'thinking', text: reasoning });

      const content = delta.content;
      if (typeof content === 'string' && content) {
        events.push({ kind: 'content', text: content });
      }

      const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          this.accumulateToolCall(tc);
        }
      }
    }

    const finish = choice.finish_reason;
    if (finish === 'tool_calls' || finish === 'stop') {
      this.flushToolCalls(events);
    }
  }

  private accumulateToolCall(tc: Record<string, unknown>): void {
    const index = typeof tc.index === 'number' ? tc.index : 0;
    let pending = this.pending.get(index);
    if (!pending) {
      const id = typeof tc.id === 'string' ? tc.id : '';
      if (!id) return; // First delta for an index must carry the id.
      pending = { id, name: '', arguments: '' };
      this.pending.set(index, pending);
    }
    const fn = tc.function as Record<string, unknown> | undefined;
    if (fn) {
      if (typeof fn.name === 'string') pending.name += fn.name;
      if (typeof fn.arguments === 'string') pending.arguments += fn.arguments;
    }
  }

  private flushToolCalls(events: ChatStreamEvent[]): void {
    for (const tc of this.pending.values()) {
      events.push({ kind: 'toolCall', id: tc.id, name: tc.name, arguments: tc.arguments });
    }
    this.pending.clear();
  }

  private flush(events: ChatStreamEvent[]): void {
    this.flushToolCalls(events);
    if (this.latestUsage) {
      events.push({ kind: 'usage', usage: this.latestUsage });
      this.latestUsage = undefined;
    }
  }
}
