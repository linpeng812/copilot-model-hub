import { describe, it, expect } from 'vitest';
import { validateConnection, normalizeBaseUrl } from '../src/config/validate';
import { mergeScopes } from '../src/config/scope';
import { defaultSecretKey } from '../src/config/types';

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes', () => {
    expect(normalizeBaseUrl('https://api.x.com/v1/')).toBe('https://api.x.com/v1');
    expect(normalizeBaseUrl('https://api.x.com/v1///')).toBe('https://api.x.com/v1');
  });

  it('leaves a clean url untouched', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com');
  });
});

describe('validateConnection', () => {
  const base = {
    id: 'deepseek-pro',
    name: 'DeepSeek Pro',
    protocol: 'chat',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
  };

  it('accepts a minimal valid connection and derives secretKey', () => {
    const { connection, errors } = validateConnection({ ...base });
    expect(errors).toEqual([]);
    expect(connection?.secretKey).toBe(defaultSecretKey('deepseek-pro'));
    expect(connection?.baseUrl).toBe('https://api.deepseek.com');
  });

  it('normalizes baseUrl trailing slash', () => {
    const { connection } = validateConnection({ ...base, baseUrl: 'https://api.x.com/v1/' });
    expect(connection?.baseUrl).toBe('https://api.x.com/v1');
  });

  it('allows ids with dots, underscores and hyphens', () => {
    expect(validateConnection({ ...base, id: 'rightcode-gpt-5.5' }).connection?.id).toBe(
      'rightcode-gpt-5.5',
    );
    expect(validateConnection({ ...base, id: 'deep_seek' }).connection?.id).toBe('deep_seek');
    expect(validateConnection({ ...base, id: 'deep.seek' }).connection?.id).toBe('deep.seek');
  });

  it('derives a SecretStorage key from an id containing dots', () => {
    const { connection } = validateConnection({ ...base, id: 'rightcode-gpt-5.5' });
    expect(connection?.secretKey).toBe('copilotModelHub.connection.rightcode-gpt-5.5.apiKey');
  });

  it('rejects ids with illegal characters or a bad leading character', () => {
    expect(validateConnection({ ...base, id: '-lead' }).connection).toBeUndefined();
    expect(validateConnection({ ...base, id: '.lead' }).connection).toBeUndefined();
    expect(validateConnection({ ...base, id: 'has space' }).connection).toBeUndefined();
    expect(validateConnection({ ...base, id: 'has/slash' }).connection).toBeUndefined();
    expect(validateConnection({ ...base, id: 'UPPER' }).connection).toBeUndefined();
  });

  it('rejects an unknown protocol', () => {
    const { connection, errors } = validateConnection({ ...base, protocol: 'grpc' });
    expect(connection).toBeUndefined();
    expect(errors.some((e) => e.includes('protocol'))).toBe(true);
  });

  it('rejects a non-http baseUrl', () => {
    const { connection } = validateConnection({ ...base, baseUrl: 'ftp://x.com' });
    expect(connection).toBeUndefined();
  });

  it('rejects a missing model', () => {
    const { connection } = validateConnection({ ...base, model: undefined });
    expect(connection).toBeUndefined();
  });

  it('honors an explicit secretKey for key sharing', () => {
    const { connection } = validateConnection({
      ...base,
      secretKey: 'copilotModelHub.connection.shared.apiKey',
    });
    expect(connection?.secretKey).toBe('copilotModelHub.connection.shared.apiKey');
  });

  it('rejects an empty explicit secretKey', () => {
    const { connection } = validateConnection({ ...base, secretKey: '   ' });
    expect(connection).toBeUndefined();
  });

  it('parses capabilities, context and request defaults', () => {
    const { connection } = validateConnection({
      ...base,
      capabilities: { tools: true, vision: false, thinking: true },
      context: { input: 128000, output: 64000 },
      request: { temperature: 0.7, maxTokens: 4096, timeoutMs: 30000 },
    });
    expect(connection?.capabilities).toEqual({ tools: true, vision: false, thinking: true });
    expect(connection?.context).toEqual({ input: 128000, output: 64000 });
    expect(connection?.request?.maxTokens).toBe(4096);
  });

  it('rejects invalid nested field types', () => {
    expect(validateConnection({ ...base, capabilities: { tools: 'yes' } }).connection).toBeUndefined();
    expect(validateConnection({ ...base, context: { input: 0 } }).connection).toBeUndefined();
    expect(validateConnection({ ...base, request: { maxTokens: -5 } }).connection).toBeUndefined();
  });
});

describe('mergeScopes', () => {
  const mk = (id: string, name: string) => ({
    id,
    name,
    protocol: 'chat',
    baseUrl: 'https://x.com',
    model: 'm',
  });

  it('concatenates connections from all scopes', () => {
    const merged = mergeScopes({
      global: [mk('a', 'A')],
      workspace: [mk('b', 'B')],
    });
    expect(merged.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('lets higher-priority scope override by id', () => {
    const merged = mergeScopes({
      global: [mk('a', 'global-A')],
      workspaceFolder: [mk('a', 'folder-A')],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('folder-A');
  });

  it('ignores non-array scope values', () => {
    expect(mergeScopes({ global: 'nope', workspace: undefined })).toEqual([]);
  });

  it('keeps entries without an id for downstream validation to reject', () => {
    const merged = mergeScopes({ global: [{ name: 'no id' }] });
    expect(merged).toHaveLength(1);
  });
});
