import { splitLeadingThinkBlock, stripLeadingThinkOpenTag } from './reasoning';

const THINK_OPEN = '<think>';

export type InlineThinkMode = 'detecting' | 'reasoning' | 'text';

export type InlineThinkEmit =
  | { kind: 'reasoning'; text: string }
  | { kind: 'text'; text: string };

type PrefixDecision = 'need-more' | 'reasoning' | 'text';

/**
 * Decide whether a buffer's leading content is (or could become) a `<think>`
 * block. Returns `need-more` while the buffer is still a possible prefix of
 * `<think>`, so we wait for more deltas before committing.
 */
function leadingThinkPrefixDecision(buffer: string): PrefixDecision {
  const trimmed = buffer.trimStart();
  if (trimmed.length === 0) return 'need-more';
  if (trimmed.startsWith(THINK_OPEN)) return 'reasoning';
  if (THINK_OPEN.startsWith(trimmed)) return 'need-more';
  return 'text';
}

/**
 * A three-state machine (detecting → reasoning|text) that recovers reasoning
 * from models which inline it as a leading `<think>...</think>` block in normal
 * content instead of using a dedicated reasoning channel.
 *
 * Handles the `<think>` tag arriving split across chunk boundaries (the
 * "detecting" state buffers until it can decide) and emits clean reasoning/text
 * without ever leaking the tags downstream.
 */
export class InlineThinkDetector {
  private mode: InlineThinkMode = 'detecting';
  private buffer = '';

  /** Feed a content delta; returns the reasoning/text segments to emit. */
  push(delta: string): InlineThinkEmit[] {
    switch (this.mode) {
      case 'text':
        return delta ? [{ kind: 'text', text: delta }] : [];

      case 'reasoning':
        this.buffer += delta;
        return this.drainCompleteThinkBlock();

      case 'detecting': {
        this.buffer += delta;
        const decision = leadingThinkPrefixDecision(this.buffer);
        if (decision === 'need-more') return [];
        if (decision === 'reasoning') {
          this.mode = 'reasoning';
          return this.drainCompleteThinkBlock();
        }
        // Plain text after all — flush the buffer and switch to text mode.
        this.mode = 'text';
        const text = this.buffer;
        this.buffer = '';
        return text ? [{ kind: 'text', text }] : [];
      }
    }
  }

  /** Call when the content stream ends; flushes any buffered remainder. */
  end(): InlineThinkEmit[] {
    switch (this.mode) {
      case 'text':
        return [];
      case 'detecting': {
        this.mode = 'text';
        const text = this.buffer;
        this.buffer = '';
        return text ? [{ kind: 'text', text }] : [];
      }
      case 'reasoning': {
        // Unterminated think block: treat the buffered remainder as reasoning,
        // stripping the opening tag we already detected.
        const stripped = stripLeadingThinkOpenTag(this.buffer);
        const text = stripped ?? this.buffer;
        this.buffer = '';
        this.mode = 'text';
        return text ? [{ kind: 'reasoning', text }] : [];
      }
    }
  }

  private drainCompleteThinkBlock(): InlineThinkEmit[] {
    const split = splitLeadingThinkBlock(this.buffer);
    if (!split) return []; // Closing tag not here yet; keep buffering.
    this.mode = 'text';
    this.buffer = '';
    const emits: InlineThinkEmit[] = [];
    if (split.reasoning) emits.push({ kind: 'reasoning', text: split.reasoning });
    if (split.answer) emits.push({ kind: 'text', text: split.answer });
    return emits;
  }
}
