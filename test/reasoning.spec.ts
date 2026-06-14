import { describe, it, expect } from 'vitest';
import {
  extractReasoningFieldText,
  splitLeadingThinkBlock,
  stripLeadingThinkOpenTag,
} from '../src/shared/reasoning';

describe('extractReasoningFieldText', () => {
  it('prefers reasoning_content', () => {
    expect(extractReasoningFieldText({ reasoning_content: 'rc', reasoning: 'r' })).toBe('rc');
  });

  it('falls back to a reasoning string', () => {
    expect(extractReasoningFieldText({ reasoning: 'r' })).toBe('r');
  });

  it('reads reasoning object content/text/summary', () => {
    expect(extractReasoningFieldText({ reasoning: { text: 'rt' } })).toBe('rt');
    expect(extractReasoningFieldText({ reasoning: { summary: 'rs' } })).toBe('rs');
  });

  it('reads reasoning_details array joined by blank lines', () => {
    expect(
      extractReasoningFieldText({ reasoning_details: [{ text: 'a' }, { text: 'b' }] }),
    ).toBe('a\n\nb');
  });

  it('returns undefined when no reasoning is present', () => {
    expect(extractReasoningFieldText({ content: 'hi' })).toBeUndefined();
    expect(extractReasoningFieldText('not an object')).toBeUndefined();
  });

  it('ignores empty reasoning strings', () => {
    expect(extractReasoningFieldText({ reasoning_content: '' })).toBeUndefined();
  });
});

describe('splitLeadingThinkBlock', () => {
  it('splits a complete leading think block', () => {
    const result = splitLeadingThinkBlock('<think>I should answer with pong.</think>\n\npong');
    expect(result).toEqual({ reasoning: 'I should answer with pong.', answer: 'pong' });
  });

  it('tolerates leading whitespace', () => {
    expect(splitLeadingThinkBlock('  <think>r</think>a')).toEqual({ reasoning: 'r', answer: 'a' });
  });

  it('returns undefined without a leading think tag', () => {
    expect(splitLeadingThinkBlock('hello <think>x</think>')).toBeUndefined();
  });

  it('returns undefined for an unterminated think block', () => {
    expect(splitLeadingThinkBlock('<think>still thinking')).toBeUndefined();
  });
});

describe('stripLeadingThinkOpenTag', () => {
  it('strips a leading open tag', () => {
    expect(stripLeadingThinkOpenTag('<think>partial')).toBe('partial');
  });

  it('returns undefined when there is no open tag', () => {
    expect(stripLeadingThinkOpenTag('partial')).toBeUndefined();
  });
});
