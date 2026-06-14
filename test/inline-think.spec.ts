import { describe, it, expect } from 'vitest';
import { InlineThinkDetector, InlineThinkEmit } from '../src/shared/inline-think';

function run(chunks: string[]): InlineThinkEmit[] {
  const d = new InlineThinkDetector();
  const emits: InlineThinkEmit[] = [];
  for (const c of chunks) emits.push(...d.push(c));
  emits.push(...d.end());
  return emits;
}

describe('InlineThinkDetector', () => {
  it('passes plain text straight through', () => {
    expect(run(['Hello ', 'world'])).toEqual([
      { kind: 'text', text: 'Hello ' },
      { kind: 'text', text: 'world' },
    ]);
  });

  it('extracts a complete leading think block', () => {
    expect(run(['<think>reasoning</think>answer'])).toEqual([
      { kind: 'reasoning', text: 'reasoning' },
      { kind: 'text', text: 'answer' },
    ]);
  });

  it('handles a <think> tag split across chunks', () => {
    const emits = run(['<th', 'ink>secret', ' thoughts</think>', 'final']);
    expect(emits).toEqual([
      { kind: 'reasoning', text: 'secret thoughts' },
      { kind: 'text', text: 'final' },
    ]);
  });

  it('does not leak tags when content is plain but starts like a tag prefix', () => {
    // "<th" looks like a possible prefix, but "<th is here" resolves to text.
    const emits = run(['<th', ' is here']);
    expect(emits).toEqual([{ kind: 'text', text: '<th is here' }]);
  });

  it('treats an unterminated think block as reasoning at end', () => {
    expect(run(['<think>still going'])).toEqual([{ kind: 'reasoning', text: 'still going' }]);
  });

  it('streams reasoning before the closing tag arrives only once complete', () => {
    const d = new InlineThinkDetector();
    expect(d.push('<think>part1')).toEqual([]); // closing tag not seen yet
    const after = [...d.push(' part2</think>tail'), ...d.end()];
    expect(after).toEqual([
      { kind: 'reasoning', text: 'part1 part2' },
      { kind: 'text', text: 'tail' },
    ]);
  });

  it('tolerates leading whitespace before the think tag', () => {
    expect(run(['  <think>r</think>a'])).toEqual([
      { kind: 'reasoning', text: 'r' },
      { kind: 'text', text: 'a' },
    ]);
  });

  it('emits nothing for empty input', () => {
    expect(run([''])).toEqual([]);
  });
});
