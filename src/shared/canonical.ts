/**
 * Canonical JSON helpers.
 *
 * Tool arguments and outputs are canonicalized (object keys sorted, whitespace
 * removed) so that semantically identical payloads produce identical strings —
 * important for stable cache keys and for strict upstreams that reject loose
 * JSON. Plain (non-JSON) strings are passed through untouched.
 */

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** Recursively sort object keys. Arrays keep their order. */
export function canonicalizeValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value && typeof value === 'object') {
    const sorted: { [k: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalizeValue(value[key]);
    }
    return sorted;
  }
  return value;
}

/** Serialize a value to canonical (sorted-key, compact) JSON. */
export function canonicalJsonString(value: JsonValue): string {
  return JSON.stringify(canonicalizeValue(value));
}

/**
 * Parse and re-serialize a JSON string canonically. If it does not parse as
 * JSON, return the original string unchanged.
 */
export function canonicalizeJsonStringIfParseable(text: string): string {
  try {
    return canonicalJsonString(JSON.parse(text) as JsonValue);
  } catch {
    return text;
  }
}

/**
 * Canonicalize a tool `arguments` string. Empty strings become `"{}"` because
 * strict upstreams reject `arguments: ""` but accept an empty object.
 */
export function canonicalizeToolArgumentsStr(args: string): string {
  const trimmed = args.trim();
  if (trimmed === '') return '{}';
  return canonicalizeJsonStringIfParseable(trimmed);
}
