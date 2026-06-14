import { describe, it, expect } from 'vitest';
import {
  canonicalJsonString,
  canonicalizeJsonStringIfParseable,
  canonicalizeToolArgumentsStr,
  canonicalizeValue,
} from '../src/shared/canonical';

describe('canonicalJsonString', () => {
  it('sorts object keys', () => {
    expect(canonicalJsonString({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('sorts nested keys but preserves array order', () => {
    expect(canonicalJsonString({ z: [3, 1, 2], a: { d: 1, c: 2 } })).toBe(
      '{"a":{"c":2,"d":1},"z":[3,1,2]}',
    );
  });
});

describe('canonicalizeValue', () => {
  it('returns primitives unchanged', () => {
    expect(canonicalizeValue(5)).toBe(5);
    expect(canonicalizeValue('x')).toBe('x');
    expect(canonicalizeValue(null)).toBe(null);
  });
});

describe('canonicalizeJsonStringIfParseable', () => {
  it('canonicalizes parseable JSON', () => {
    expect(canonicalizeJsonStringIfParseable('{ "b": 2, "a": 1 }')).toBe('{"a":1,"b":2}');
  });

  it('returns non-JSON text unchanged', () => {
    expect(canonicalizeJsonStringIfParseable('plain text')).toBe('plain text');
  });
});

describe('canonicalizeToolArgumentsStr', () => {
  it('canonicalizes JSON-string tool payloads', () => {
    expect(canonicalizeToolArgumentsStr('{ "b": 2, "a": 1 }')).toBe('{"a":1,"b":2}');
  });

  it('maps empty arguments to an empty object', () => {
    expect(canonicalizeToolArgumentsStr('')).toBe('{}');
    expect(canonicalizeToolArgumentsStr('   ')).toBe('{}');
  });

  it('passes plain text through', () => {
    expect(canonicalizeToolArgumentsStr('not json')).toBe('not json');
  });
});
