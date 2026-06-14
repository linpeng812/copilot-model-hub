import { describe, it, expect } from 'vitest';
import { ChatStreamParser, ChatStreamEvent } from '../src/adapters/chat/stream';
import { SseLineBuffer, parseSseLine } from '../src/shared/sse';

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n`;
}

function collect(chunks: string[]): ChatStreamEvent[] {
  const parser = new ChatStreamParser();
  const events: ChatStreamEvent[] = [];
  for (const c of chunks) events.push(...parser.push(c));
  events.push(...parser.end());
  return events;
}

describe('SseLineBuffer', () => {
  it('keeps a partial line buffered across pushes', () => {
    const buf = new SseLineBuffer();
    expect(buf.push('data: {"a":')).toEqual([]);
    expect(buf.push('1}\n')).toEqual(['data: {"a":1}']);
  });

  it('flushes the remainder', () => {
    const buf = new SseLineBuffer();
    buf.push('tail');
    expect(buf.flush()).toBe('tail');
  });
});

describe('parseSseLine', () => {
  it('skips blank lines and comments', () => {
    expect(parseSseLine('')).toBeUndefined();
    expect(parseSseLine(': keep-alive')).toBeUndefined();
  });

  it('recognizes [DONE]', () => {
    expect(parseSseLine('data: [DONE]')).toEqual({ done: true });
    expect(parseSseLine('data:[DONE]')).toEqual({ done: true });
  });

  it('extracts data payloads with or without a leading space', () => {
    expect(parseSseLine('data: {"x":1}')).toEqual({ done: false, data: '{"x":1}' });
    expect(parseSseLine('data:{"x":1}')).toEqual({ done: false, data: '{"x":1}' });
  });
});

describe('ChatStreamParser', () => {
  it('emits content deltas in order', () => {
    const events = collect([
      sse({ choices: [{ delta: { content: 'Hel' } }] }),
      sse({ choices: [{ delta: { content: 'lo' } }] }),
      'data: [DONE]\n',
    ]);
    expect(events.filter((e) => e.kind === 'content')).toEqual([
      { kind: 'content', text: 'Hel' },
      { kind: 'content', text: 'lo' },
    ]);
  });

  it('joins tool_call deltas by index across chunks', () => {
    const events = collect([
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'weather' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n',
    ]);
    const calls = events.filter((e) => e.kind === 'toolCall');
    expect(calls).toEqual([{ kind: 'toolCall', id: 'c1', name: 'get_weather', arguments: '{"a":1}' }]);
  });

  it('handles multiple tool calls in one chunk arriving out of order', () => {
    const events = collect([
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 1, id: 'b', function: { name: 'second', arguments: '{}' } },
                { index: 0, id: 'a', function: { name: 'first', arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
      'data: [DONE]\n',
    ]);
    const calls = events.filter((e) => e.kind === 'toolCall').map((e) => (e as { id: string }).id);
    expect(calls.sort()).toEqual(['a', 'b']);
  });

  it('keeps only the last usage and emits it once at the end', () => {
    const events = collect([
      sse({ choices: [{ delta: { content: 'x' } }], usage: { prompt_tokens: 1 } }),
      sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      'data: [DONE]\n',
    ]);
    const usage = events.filter((e) => e.kind === 'usage');
    expect(usage).toHaveLength(1);
    expect((usage[0] as { usage: { prompt_tokens: number } }).usage.prompt_tokens).toBe(10);
  });

  it('reassembles a JSON payload split across chunk boundaries', () => {
    const parser = new ChatStreamParser();
    const events: ChatStreamEvent[] = [];
    events.push(...parser.push('data: {"choices":[{"delta":{"con'));
    events.push(...parser.push('tent":"hi"}}]}\n'));
    events.push(...parser.end());
    expect(events.filter((e) => e.kind === 'content')).toEqual([{ kind: 'content', text: 'hi' }]);
  });

  it('skips a malformed chunk without aborting the stream', () => {
    let parseErrors = 0;
    const parser = new ChatStreamParser(() => parseErrors++);
    const events: ChatStreamEvent[] = [];
    events.push(...parser.push('data: {not json}\n'));
    events.push(...parser.push(sse({ choices: [{ delta: { content: 'ok' } }] })));
    events.push(...parser.end());
    expect(parseErrors).toBe(1);
    expect(events.filter((e) => e.kind === 'content')).toEqual([{ kind: 'content', text: 'ok' }]);
  });

  it('maps reasoning_content and reasoning to thinking events', () => {
    const events = collect([
      sse({ choices: [{ delta: { reasoning_content: 'think1' } }] }),
      sse({ choices: [{ delta: { reasoning: 'think2' } }] }),
      'data: [DONE]\n',
    ]);
    expect(events.filter((e) => e.kind === 'thinking')).toEqual([
      { kind: 'thinking', text: 'think1' },
      { kind: 'thinking', text: 'think2' },
    ]);
  });

  it('flushes pending tool calls when the stream ends without [DONE]', () => {
    const parser = new ChatStreamParser();
    const events: ChatStreamEvent[] = [];
    events.push(
      ...parser.push(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] } }] })),
    );
    // No [DONE]; the connection just ends.
    events.push(...parser.end());
    expect(events.filter((e) => e.kind === 'toolCall')).toHaveLength(1);
  });

  it('ignores data after [DONE]', () => {
    const events = collect([
      'data: [DONE]\n',
      sse({ choices: [{ delta: { content: 'ignored' } }] }),
    ]);
    expect(events.filter((e) => e.kind === 'content')).toEqual([]);
  });
});
