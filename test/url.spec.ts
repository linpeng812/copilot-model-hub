import { describe, it, expect } from 'vitest';
import { versionedPath } from '../src/shared/url';

describe('versionedPath', () => {
  it('inserts /v1 when the base URL has no path', () => {
    expect(versionedPath('https://api.host.com', '/messages')).toBe('/v1/messages');
  });

  it('does not double /v1 when the base URL already ends with it', () => {
    expect(versionedPath('https://api.host.com/v1', '/messages')).toBe('/messages');
  });

  it('detects a trailing /v1 under a deeper path', () => {
    expect(versionedPath('https://gw.host.com/api/v1', '/messages')).toBe('/messages');
  });

  it('inserts /v1 for a non-version path segment', () => {
    // /coding is not the version segment, so /v1 is still added.
    expect(versionedPath('https://qianfan.example.com/coding', '/messages')).toBe('/v1/messages');
  });

  it('tolerates a trailing slash on the base URL', () => {
    expect(versionedPath('https://api.host.com/v1/', '/messages')).toBe('/messages');
    expect(versionedPath('https://api.host.com/', '/messages')).toBe('/v1/messages');
  });

  it('normalizes an endpoint without a leading slash', () => {
    expect(versionedPath('https://api.host.com', 'messages')).toBe('/v1/messages');
  });

  it('supports a custom version segment', () => {
    expect(versionedPath('https://api.host.com', '/messages', 'v2')).toBe('/v2/messages');
    expect(versionedPath('https://api.host.com/v2', '/messages', 'v2')).toBe('/messages');
  });

  it('matches the packyapi case: base without /v1 yields /v1/messages', () => {
    expect(versionedPath('https://www.packyapi.com', '/messages')).toBe('/v1/messages');
  });
});
