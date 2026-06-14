import { SseLineBuffer, parseSseLine } from '../../shared/sse';
import { AnthropicThinkingBlock } from './request';

export type AnthropicStreamEvent =
  | { kind: 'content'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'toolCall'; id: string; name: string; arguments: string }
  | { kind: 'usage'; usage: AnthropicUsage }
  | { kind: 'error'; message: string };

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}

interface BlockState {
  type: 'text' | 'tool_use' | 'thinking';
  toolId?: string;
  toolName?: string;
  toolArgs: string;
  thinking: string;
  signature: string;
}

/**
 * Parses an Anthropic Messages SSE stream into normalized events. Anthropic
 * frames each piece of content as an indexed block with start/delta/stop
 * events; we accumulate `input_json_delta` for tool calls and
 * `thinking_delta`/`signature_delta` for reasoning, and finalize on
 * `content_block_stop`. The completed `thinking` blocks (with signatures) are
 * exposed via `thinkingBlocks()` so the adapter can persist them for replay.
 */
export class AnthropicStreamParser {
  private lineBuffer = new SseLineBuffer();
  private blocks = new Map<number, BlockState>();
  private completedThinking: AnthropicThinkingBlock[] = [];
  private done = false;

  constructor(private readonly onParseError?: (line: string, err: unknown) => void) {}

  push(chunk: string): AnthropicStreamEvent[] {
    if (this.done) return [];
    const events: AnthropicStreamEvent[] = [];
    for (const line of this.lineBuffer.push(chunk)) {
      this.handleLine(line, events);
    }
    return events;
  }

  end(): AnthropicStreamEvent[] {
    if (this.done) return [];
    const events: AnthropicStreamEvent[] = [];
    const rest = this.lineBuffer.flush();
    if (rest.trim()) this.handleLine(rest, events);
    this.done = true;
    return events;
  }

  /** The completed thinking blocks seen so far, for replay marker persistence. */
  thinkingBlocks(): AnthropicThinkingBlock[] {
    return this.completedThinking;
  }

  private handleLine(line: string, events: AnthropicStreamEvent[]): void {
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

  private handleEvent(event: Record<string, unknown>, events: AnthropicStreamEvent[]): void {
    const type = event.type;
    switch (type) {
      case 'content_block_start': {
        const index = event.index as number;
        const block = event.content_block as Record<string, unknown> | undefined;
        const blockType = block?.type;
        if (blockType === 'tool_use') {
          this.blocks.set(index, {
            type: 'tool_use',
            toolId: typeof block?.id === 'string' ? block.id : '',
            toolName: typeof block?.name === 'string' ? block.name : '',
            toolArgs: '',
            thinking: '',
            signature: '',
          });
        } else if (blockType === 'thinking') {
          this.blocks.set(index, {
            type: 'thinking',
            toolArgs: '',
            thinking: typeof block?.thinking === 'string' ? block.thinking : '',
            signature: '',
          });
        } else {
          this.blocks.set(index, { type: 'text', toolArgs: '', thinking: '', signature: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const index = event.index as number;
        const delta = event.delta as Record<string, unknown> | undefined;
        const block = this.blocks.get(index);
        if (!delta || !block) break;
        const deltaType = delta.type;
        if (deltaType === 'text_delta' && typeof delta.text === 'string') {
          events.push({ kind: 'content', text: delta.text });
        } else if (deltaType === 'input_json_delta' && typeof delta.partial_json === 'string') {
          block.toolArgs += delta.partial_json;
        } else if (deltaType === 'thinking_delta' && typeof delta.thinking === 'string') {
          block.thinking += delta.thinking;
          events.push({ kind: 'thinking', text: delta.thinking });
        } else if (deltaType === 'signature_delta' && typeof delta.signature === 'string') {
          block.signature += delta.signature;
        }
        break;
      }
      case 'content_block_stop': {
        const index = event.index as number;
        const block = this.blocks.get(index);
        if (!block) break;
        if (block.type === 'tool_use') {
          events.push({
            kind: 'toolCall',
            id: block.toolId ?? '',
            name: block.toolName ?? '',
            arguments: block.toolArgs,
          });
        } else if (block.type === 'thinking') {
          const tb: AnthropicThinkingBlock = { type: 'thinking', thinking: block.thinking };
          if (block.signature) tb.signature = block.signature;
          this.completedThinking.push(tb);
        }
        this.blocks.delete(index);
        break;
      }
      case 'message_delta': {
        const usage = (event.usage ?? (event.delta as Record<string, unknown>)?.usage) as
          | AnthropicUsage
          | undefined;
        if (usage) events.push({ kind: 'usage', usage });
        break;
      }
      case 'error': {
        const err = event.error as Record<string, unknown> | undefined;
        const message = typeof err?.message === 'string' ? err.message : 'Anthropic stream error';
        events.push({ kind: 'error', message });
        break;
      }
      case 'message_start':
      case 'message_stop':
      case 'ping':
      default:
        break;
    }
  }
}
