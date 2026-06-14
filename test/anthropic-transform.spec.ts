import { describe, it, expect } from 'vitest';
import {
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelDataPart,
  LanguageModelChatMessageRole as Role,
  LanguageModelChatToolMode as ToolMode,
} from './mocks/vscode';
import {
  buildRequestBody,
  convertMessages,
  resolveMaxTokens,
} from '../src/adapters/anthropic/request';
import { AnthropicStreamParser, AnthropicStreamEvent } from '../src/adapters/anthropic/stream';
import { createReplayMarkerPart } from '../src/provider/replay';
import { ModelConnection } from '../src/config/types';

const conn = (overrides: Partial<ModelConnection> = {}): ModelConnection => ({
  id: 'claude',
  name: 'Claude',
  protocol: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  model: 'claude-x',
  secretKey: 'k',
  ...overrides,
});

const msg = (role: number, content: unknown[]) => ({ role, content }) as never;
const options = (tools?: unknown[], toolMode = ToolMode.Auto) =>
  ({ tools, toolMode }) as never;

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n`;
}

function collect(chunks: string[]): { events: AnthropicStreamEvent[]; parser: AnthropicStreamParser } {
  const parser = new AnthropicStreamParser();
  const events: AnthropicStreamEvent[] = [];
  for (const c of chunks) events.push(...parser.push(c));
  events.push(...parser.end());
  return { events, parser };
}

describe('anthropic convertMessages', () => {
  it('extracts system messages to the top level', () => {
    const { system, messages } = convertMessages(
      [
        msg(Role.System, [new LanguageModelTextPart('be helpful')]),
        msg(Role.User, [new LanguageModelTextPart('hi')]),
      ],
      false,
    );
    expect(system).toBe('be helpful');
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('maps tool calls to tool_use blocks', () => {
    const { messages } = convertMessages(
      [msg(Role.Assistant, [new LanguageModelToolCallPart('c1', 'get_weather', { city: 'sf' })])],
      false,
    );
    expect(messages[0].content[0]).toEqual({
      type: 'tool_use',
      id: 'c1',
      name: 'get_weather',
      input: { city: 'sf' },
    });
  });

  it('maps tool results to a following user message with tool_result', () => {
    const { messages } = convertMessages(
      [msg(Role.User, [new LanguageModelToolResultPart('c1', [new LanguageModelTextPart('72F')])])],
      false,
    );
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '72F' }] },
    ]);
  });

  it('replays prior thinking blocks (with signature) from the marker', () => {
    const blocks = [{ type: 'thinking', thinking: 'I reasoned', signature: 'sig123' }];
    const marker = createReplayMarkerPart({ raw: blocks });
    const { messages } = convertMessages(
      [
        msg(Role.Assistant, [
          new LanguageModelDataPart(marker.data, marker.mimeType),
          new LanguageModelTextPart('answer'),
        ]),
      ],
      true,
    );
    expect(messages[0].content[0]).toEqual({
      type: 'thinking',
      thinking: 'I reasoned',
      signature: 'sig123',
    });
    expect(messages[0].content[1]).toEqual({ type: 'text', text: 'answer' });
  });

  it('does not replay thinking blocks for non-thinking models', () => {
    const marker = createReplayMarkerPart({ raw: [{ type: 'thinking', thinking: 'x' }] });
    const { messages } = convertMessages(
      [msg(Role.Assistant, [new LanguageModelDataPart(marker.data, marker.mimeType), new LanguageModelTextPart('a')])],
      false,
    );
    expect(messages[0].content).toEqual([{ type: 'text', text: 'a' }]);
  });
});

describe('anthropic resolveMaxTokens', () => {
  it('defaults to 4096 when unset', () => {
    expect(resolveMaxTokens(conn())).toBe(4096);
  });

  it('prefers context.output', () => {
    expect(resolveMaxTokens(conn({ context: { output: 8000 } }))).toBe(8000);
  });

  it('prefers request.maxTokens over context.output', () => {
    expect(resolveMaxTokens(conn({ request: { maxTokens: 2000 }, context: { output: 8000 } }))).toBe(
      2000,
    );
  });

  it('raises max_tokens above the thinking budget plus margin', () => {
    // budget 12000, max 4096 -> must exceed budget
    expect(resolveMaxTokens(conn({ context: { output: 4096 } }), 12000)).toBe(12000 + 1024);
  });
});

describe('anthropic buildRequestBody', () => {
  it('builds a minimal streaming request', () => {
    const body = buildRequestBody(
      conn(),
      [msg(Role.User, [new LanguageModelTextPart('hi')])],
      options(),
    );
    expect(body.model).toBe('claude-x');
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toHaveLength(1);
  });

  it('includes tools and thinking when enabled', () => {
    const body = buildRequestBody(
      conn({
        capabilities: { thinking: true },
        thinking: { type: 'anthropic-thinking', defaultBudgetTokens: 8000 },
        context: { output: 4096 },
      }),
      [msg(Role.User, [new LanguageModelTextPart('hi')])],
      options([{ name: 'f', description: 'd', inputSchema: { type: 'object' } }]),
    );
    expect(body.tools).toEqual([{ name: 'f', description: 'd', input_schema: { type: 'object' } }]);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8000 });
    expect(body.max_tokens).toBeGreaterThan(8000);
  });

  it('treats a budget of 0 as thinking disabled', () => {
    const body = buildRequestBody(
      conn({ capabilities: { thinking: true }, thinking: { defaultBudgetTokens: 0 } }),
      [msg(Role.User, [new LanguageModelTextPart('hi')])],
      options(),
    );
    expect(body.thinking).toBeUndefined();
  });

  it('omits tools when capabilities.tools is false', () => {
    const body = buildRequestBody(
      conn({ capabilities: { tools: false } }),
      [msg(Role.User, [new LanguageModelTextPart('hi')])],
      options([{ name: 'f', inputSchema: {} }]),
    );
    expect(body.tools).toBeUndefined();
  });
});

describe('AnthropicStreamParser', () => {
  it('emits text deltas', () => {
    const { events } = collect([
      sse({ type: 'message_start' }),
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
      sse({ type: 'content_block_stop', index: 0 }),
    ]);
    expect(events.filter((e) => e.kind === 'content')).toEqual([
      { kind: 'content', text: 'Hel' },
      { kind: 'content', text: 'lo' },
    ]);
  });

  it('accumulates tool_use input_json_delta and emits on stop', () => {
    const { events } = collect([
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'c1', name: 'get_weather' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"ci' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ty":"sf"}' } }),
      sse({ type: 'content_block_stop', index: 0 }),
    ]);
    expect(events.filter((e) => e.kind === 'toolCall')).toEqual([
      { kind: 'toolCall', id: 'c1', name: 'get_weather', arguments: '{"city":"sf"}' },
    ]);
  });

  it('accumulates thinking and signature, exposing completed blocks', () => {
    const { events, parser } = collect([
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'I think ' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'therefore' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
      sse({ type: 'content_block_stop', index: 0 }),
    ]);
    expect(events.filter((e) => e.kind === 'thinking')).toEqual([
      { kind: 'thinking', text: 'I think ' },
      { kind: 'thinking', text: 'therefore' },
    ]);
    expect(parser.thinkingBlocks()).toEqual([
      { type: 'thinking', thinking: 'I think therefore', signature: 'sig' },
    ]);
  });

  it('emits usage from message_delta', () => {
    const { events } = collect([
      sse({ type: 'message_delta', usage: { input_tokens: 10, output_tokens: 5 } }),
    ]);
    expect(events.filter((e) => e.kind === 'usage')).toEqual([
      { kind: 'usage', usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
  });

  it('surfaces error events', () => {
    const { events } = collect([
      sse({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }),
    ]);
    expect(events).toEqual([{ kind: 'error', message: 'overloaded' }]);
  });

  it('handles two tool_use blocks at different indices', () => {
    const { events } = collect([
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'first' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }),
      sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'b', name: 'second' } }),
      sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }),
      sse({ type: 'content_block_stop', index: 0 }),
      sse({ type: 'content_block_stop', index: 1 }),
    ]);
    const ids = events.filter((e) => e.kind === 'toolCall').map((e) => (e as { id: string }).id);
    expect(ids).toEqual(['a', 'b']);
  });
});
