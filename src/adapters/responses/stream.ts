import { SseLineBuffer, parseSseLine } from '../../shared/sse';

export type ResponsesStreamEvent =
  | { kind: 'content'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'toolCall'; callId: string; name: string; arguments: string }
  | { kind: 'usage'; usage: ResponsesUsage }
  | { kind: 'error'; message: string };

export interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

interface ToolItemState {
  callId: string;
  name: string;
  arguments: string;
}

/**
 * Parses an OpenAI Responses SSE event stream into normalized events.
 *
 * Unlike Chat Completions' flat delta accumulation, the Responses stream is a
 * stateful sequence of typed events keyed by `output_index`. We track each
 * output item (text / reasoning / function_call) independently, accumulate
 * `function_call_arguments.delta` per item, and finalize tool calls on
 * `output_item.done`. Usage is taken from the terminal `response.completed`
 * event. Mirrors the `ChatToResponsesState` structure from cc-switch in
 * reverse (we consume Responses events rather than produce them).
 */
export class ResponsesStreamParser {
  private lineBuffer = new SseLineBuffer();
  private tools = new Map<number, ToolItemState>();
  private done = false;

  constructor(private readonly onParseError?: (line: string, err: unknown) => void) {}

  push(chunk: string): ResponsesStreamEvent[] {
    if (this.done) return [];
    const events: ResponsesStreamEvent[] = [];
    for (const line of this.lineBuffer.push(chunk)) {
      this.handleLine(line, events);
    }
    return events;
  }

  end(): ResponsesStreamEvent[] {
    if (this.done) return [];
    const events: ResponsesStreamEvent[] = [];
    const rest = this.lineBuffer.flush();
    if (rest.trim()) this.handleLine(rest, events);
    this.done = true;
    return events;
  }

  private handleLine(line: string, events: ResponsesStreamEvent[]): void {
    const parsed = parseSseLine(line);
    if (!parsed || parsed.done) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(parsed.data!) as Record<string, unknown>;
    } catch (err) {
      this.onParseError?.(parsed.data!, err);
      return;
    }
    this.handleEvent(event, events);
  }

  private handleEvent(event: Record<string, unknown>, events: ResponsesStreamEvent[]): void {
    const type = event.type as string | undefined;
    if (!type) return;

    switch (type) {
      case 'response.output_item.added': {
        const index = event.output_index as number;
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === 'function_call') {
          this.tools.set(index, {
            callId: typeof item.call_id === 'string' ? item.call_id : '',
            name: typeof item.name === 'string' ? item.name : '',
            arguments: typeof item.arguments === 'string' ? item.arguments : '',
          });
        }
        break;
      }
      case 'response.output_text.delta': {
        const delta = event.delta;
        if (typeof delta === 'string' && delta) events.push({ kind: 'content', text: delta });
        break;
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const delta = event.delta;
        if (typeof delta === 'string' && delta) events.push({ kind: 'thinking', text: delta });
        break;
      }
      case 'response.function_call_arguments.delta': {
        const index = event.output_index as number;
        const delta = event.delta;
        const tool = this.tools.get(index);
        if (tool && typeof delta === 'string') tool.arguments += delta;
        break;
      }
      case 'response.output_item.done': {
        const index = event.output_index as number;
        const item = event.item as Record<string, unknown> | undefined;
        const tool = this.tools.get(index);
        if (tool) {
          // Prefer the finalized item fields when present.
          const callId = (typeof item?.call_id === 'string' && item.call_id) || tool.callId;
          const name = (typeof item?.name === 'string' && item.name) || tool.name;
          const args = typeof item?.arguments === 'string' && item.arguments ? item.arguments : tool.arguments;
          events.push({ kind: 'toolCall', callId, name, arguments: args });
          this.tools.delete(index);
        }
        break;
      }
      case 'response.completed': {
        const response = event.response as Record<string, unknown> | undefined;
        const usage = response?.usage as ResponsesUsage | undefined;
        if (usage) events.push({ kind: 'usage', usage });
        this.done = true;
        break;
      }
      case 'response.failed':
      case 'error': {
        const response = event.response as Record<string, unknown> | undefined;
        const err = (response?.error ?? event.error) as Record<string, unknown> | undefined;
        const message =
          typeof err?.message === 'string' ? err.message : 'Responses stream error';
        events.push({ kind: 'error', message });
        this.done = true;
        break;
      }
      default:
        break;
    }
  }
}
