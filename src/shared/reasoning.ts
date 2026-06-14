/**
 * Reasoning extraction and inline `<think>` handling. Upstreams disagree on where reasoning lives
 * (`reasoning_content`, `reasoning` string/object, `reasoning_details`), and
 * some inline a `<think>...</think>` block in normal content. These helpers
 * normalize both.
 */

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

type Obj = Record<string, unknown>;

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function extractDetailPartText(value: unknown): string | undefined {
  if (!isObj(value)) return undefined;
  for (const key of ['text', 'content', 'summary']) {
    const t = nonEmptyString(value[key]);
    if (t) return t;
  }
  if (Array.isArray(value.parts)) {
    const joined = value.parts
      .map(extractDetailPartText)
      .filter((t): t is string => !!t)
      .join('\n\n');
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
}

function extractReasoningDetailsText(value: unknown): string | undefined {
  if (typeof value === 'string') return nonEmptyString(value);
  if (Array.isArray(value)) {
    const joined = value
      .map(extractDetailPartText)
      .filter((t): t is string => !!t)
      .join('\n\n');
    return joined.length > 0 ? joined : undefined;
  }
  if (isObj(value)) return extractDetailPartText(value);
  return undefined;
}

/**
 * Extract reasoning text from a message/delta object, trying the known field
 * shapes in priority order: `reasoning_content` > `reasoning` (string or
 * object) > `reasoning_details`.
 */
export function extractReasoningFieldText(value: unknown): string | undefined {
  if (!isObj(value)) return undefined;

  const direct = nonEmptyString(value.reasoning_content) ?? nonEmptyString(value.reasoning);
  if (direct) return direct;

  if (isObj(value.reasoning)) {
    for (const key of ['content', 'text', 'summary']) {
      const t = nonEmptyString(value.reasoning[key]);
      if (t) return t;
    }
  }

  if (value.reasoning_details !== undefined) {
    const t = extractReasoningDetailsText(value.reasoning_details);
    if (t) return t;
  }

  return undefined;
}

export interface ThinkSplit {
  reasoning: string;
  answer: string;
}

/**
 * If `text` begins (after optional whitespace) with a complete
 * `<think>...</think>` block, return the reasoning and the trailing answer.
 * Returns undefined when there is no leading think block or it is not yet
 * closed.
 */
export function splitLeadingThinkBlock(text: string): ThinkSplit | undefined {
  const after = text.trimStart();
  if (!after.startsWith(THINK_OPEN)) return undefined;
  const bodyStart = after.indexOf(THINK_OPEN) + THINK_OPEN.length;
  const closeRel = after.indexOf(THINK_CLOSE, bodyStart);
  if (closeRel < 0) return undefined;
  const reasoning = after.slice(bodyStart, closeRel).trim();
  const answer = after.slice(closeRel + THINK_CLOSE.length).replace(/^[\r\n\t ]+/, '');
  return { reasoning, answer };
}

/**
 * If `text` begins (after optional whitespace) with an opening `<think>` tag,
 * return everything after it (trimmed). Used to enter reasoning mode before
 * the closing tag has arrived.
 */
export function stripLeadingThinkOpenTag(text: string): string | undefined {
  const after = text.trimStart();
  if (!after.startsWith(THINK_OPEN)) return undefined;
  return after.slice(THINK_OPEN.length).trim();
}
