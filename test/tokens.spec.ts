import { describe, it, expect } from 'vitest';
import {
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelDataPart,
  LanguageModelThinkingPart,
} from './mocks/vscode';
import { TokenEstimator, estimateTokenCount } from '../src/provider/tokens';
import { REPLAY_MARKER_MIME } from '../src/provider/replay/consts';

const msg = (content: unknown[]) => ({ role: 1, content }) as never;

describe('estimateTokenCount', () => {
  it('estimates a plain string by chars/ratio', () => {
    // 40 chars / 4 = 10
    expect(estimateTokenCount('x'.repeat(40), 4)).toBe(10);
  });

  it('returns at least 1 token', () => {
    expect(estimateTokenCount('', 4)).toBe(1);
  });

  it('counts text parts', () => {
    expect(estimateTokenCount(msg([new LanguageModelTextPart('y'.repeat(20))]), 4)).toBe(5);
  });

  it('counts tool call parts (callId + name + json input)', () => {
    const part = new LanguageModelToolCallPart('id1', 'fn', { a: 1 });
    // 'id1'(3) + 'fn'(2) + '{"a":1}'(7) = 12 -> /4 = 3
    expect(estimateTokenCount(msg([part]), 4)).toBe(3);
  });

  it('recurses into tool result parts', () => {
    const inner = new LanguageModelTextPart('z'.repeat(12));
    const part = new LanguageModelToolResultPart('cid', [inner]);
    // 'cid'(3) + 12 = 15 -> ceil(15/4) = 4
    expect(estimateTokenCount(msg([part]), 4)).toBe(4);
  });

  it('counts replay marker data parts as zero', () => {
    const part = new LanguageModelDataPart(new Uint8Array(5000), REPLAY_MARKER_MIME);
    expect(estimateTokenCount(msg([part]), 4)).toBe(1); // floor to min 1
  });

  it('uses a capped heuristic for images', () => {
    const part = new LanguageModelDataPart(new Uint8Array(999999), 'image/png');
    // 1020 / 4 = 255
    expect(estimateTokenCount(msg([part]), 4)).toBe(255);
  });

  it('caps non-image data parts at 10000 chars', () => {
    const part = new LanguageModelDataPart(new Uint8Array(50000), 'application/pdf');
    // min(50000, 10000)/4 = 2500
    expect(estimateTokenCount(msg([part]), 4)).toBe(2500);
  });

  it('counts thinking parts (string and array)', () => {
    expect(estimateTokenCount(msg([new LanguageModelThinkingPart('a'.repeat(8))]), 4)).toBe(2);
    expect(
      estimateTokenCount(msg([new LanguageModelThinkingPart(['ab', 'cd', 'ef'])]), 4),
    ).toBe(2); // 6 chars / 4 -> ceil 2
  });
});

describe('TokenEstimator adaptive ratio', () => {
  it('defaults to 4.0 chars per token', () => {
    const est = new TokenEstimator();
    expect(est.ratioFor('c1')).toBe(4);
  });

  it('refines the ratio via EMA from observed usage', () => {
    const est = new TokenEstimator();
    // observed = 8000 chars / 1000 tokens = 8; EMA = 4*0.7 + 8*0.3 = 5.2
    est.observe('c1', 8000, 1000);
    expect(est.ratioFor('c1')).toBeCloseTo(5.2, 5);
  });

  it('ignores degenerate observations', () => {
    const est = new TokenEstimator();
    est.observe('c1', 0, 1000);
    est.observe('c1', 8000, 0);
    expect(est.ratioFor('c1')).toBe(4);
  });

  it('tracks ratios per connection independently', () => {
    const est = new TokenEstimator();
    est.observe('c1', 8000, 1000);
    expect(est.ratioFor('c2')).toBe(4);
  });
});
