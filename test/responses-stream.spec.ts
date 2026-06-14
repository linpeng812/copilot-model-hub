import { describe, it, expect } from 'vitest';
import { ResponsesStreamParser, ResponsesStreamEvent } from '../src/adapters/responses/stream';

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n`;
}

function collect(chunks: string[]): ResponsesStreamEvent[] {
  const parser = new ResponsesStreamParser();
  const events: ResponsesStreamEvent[] = [];
  for (const c of chunks) events.push(...parser.push(c));
  events.push(...parser.end());
  return events;
}

describe('ResponsesStreamParser', () => {
  it('emits output_text deltas as content', () => {
    const events = collect([
      sse({ type: 'response.created' }),
      sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } }),
      sse({ type: 'response.output_text.delta', output_index: 0, delta: 'Hel' }),
      sse({ type: 'response.output_text.delta', output_index: 0, delta: 'lo' }),
      sse({ type: 'response.completed', response: {} }),
    ]);
    expect(events.filter((e) => e.kind === 'content')).toEqual([
      { kind: 'content', text: 'Hel' },
      { kind: 'content', text: 'lo' },
    ]);
  });

  it('emits reasoning_summary_text deltas as thinking', () => {
    const events = collect([
      sse({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'hmm' }),
      sse({ type: 'response.completed', response: {} }),
    ]);
    expect(events.filter((e) => e.kind === 'thinking')).toEqual([{ kind: 'thinking', text: 'hmm' }]);
  });

  it('accumulates function_call arguments and finalizes on item.done', () => {
    const events = collect([
      sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'get_weather' } }),
      sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"ci' }),
      sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: 'ty":"sf"}' }),
      sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'get_weather' } }),
      sse({ type: 'response.completed', response: {} }),
    ]);
    expect(events.filter((e) => e.kind === 'toolCall')).toEqual([
      { kind: 'toolCall', callId: 'c1', name: 'get_weather', arguments: '{"city":"sf"}' },
    ]);
  });

  it('prefers finalized arguments from item.done when provided', () => {
    const events = collect([
      sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'f' } }),
      sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{"x":1}' } }),
      sse({ type: 'response.completed', response: {} }),
    ]);
    expect(events.filter((e) => e.kind === 'toolCall')).toEqual([
      { kind: 'toolCall', callId: 'c1', name: 'f', arguments: '{"x":1}' },
    ]);
  });

  it('tracks two tool calls at different output indices', () => {
    const events = collect([
      sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'a', name: 'first' } }),
      sse({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'b', name: 'second' } }),
      sse({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{}' }),
      sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' }),
      sse({ type: 'response.output_item.done', output_index: 0, item: {} }),
      sse({ type: 'response.output_item.done', output_index: 1, item: {} }),
      sse({ type: 'response.completed', response: {} }),
    ]);
    const ids = events.filter((e) => e.kind === 'toolCall').map((e) => (e as { callId: string }).callId);
    expect(ids).toEqual(['a', 'b']);
  });

  it('reports usage once from response.completed', () => {
    const events = collect([
      sse({ type: 'response.output_text.delta', output_index: 0, delta: 'x' }),
      sse({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }),
    ]);
    const usage = events.filter((e) => e.kind === 'usage');
    expect(usage).toEqual([{ kind: 'usage', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }]);
  });

  it('surfaces response.failed as an error event', () => {
    const events = collect([
      sse({ type: 'response.failed', response: { error: { message: 'model overloaded' } } }),
    ]);
    expect(events).toEqual([{ kind: 'error', message: 'model overloaded' }]);
  });

  it('reassembles a JSON event split across chunk boundaries', () => {
    const parser = new ResponsesStreamParser();
    const events: ResponsesStreamEvent[] = [];
    events.push(...parser.push('data: {"type":"response.output_text.delta","output_'));
    events.push(...parser.push('index":0,"delta":"hi"}\n'));
    events.push(...parser.end());
    expect(events.filter((e) => e.kind === 'content')).toEqual([{ kind: 'content', text: 'hi' }]);
  });

  it('skips a malformed event without aborting the stream', () => {
    let parseErrors = 0;
    const parser = new ResponsesStreamParser(() => parseErrors++);
    const events: ResponsesStreamEvent[] = [];
    events.push(...parser.push('data: {bad}\n'));
    events.push(...parser.push(sse({ type: 'response.output_text.delta', output_index: 0, delta: 'ok' })));
    events.push(...parser.end());
    expect(parseErrors).toBe(1);
    expect(events.filter((e) => e.kind === 'content')).toEqual([{ kind: 'content', text: 'ok' }]);
  });

  it('ignores events after response.completed', () => {
    const events = collect([
      sse({ type: 'response.completed', response: {} }),
      sse({ type: 'response.output_text.delta', output_index: 0, delta: 'ignored' }),
    ]);
    expect(events.filter((e) => e.kind === 'content')).toEqual([]);
  });
});
