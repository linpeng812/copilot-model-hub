/**
 * URL path helpers for upstream endpoint resolution.
 *
 * Some providers (notably Anthropic and its compatible gateways) expect the
 * API version segment `/v1` in the path, but their docs and clients like Claude
 * Code take a base URL *without* it and append `/v1/messages` themselves. To be
 * forgiving, we insert the version segment when the base URL does not already
 * end with it, while never doubling it for users who did include `/v1`.
 */

/**
 * Resolve a request path that should sit under a version segment (e.g. `/v1`),
 * accounting for whether the base URL already ends with that segment.
 *
 * @param baseUrl   The configured base URL (already trailing-slash-normalized).
 * @param endpoint  The endpoint below the version segment, e.g. `/messages`.
 * @param version   The version segment to ensure, defaults to `v1`.
 * @returns The path to append to baseUrl, with a single leading slash.
 *
 * Examples (version `v1`, endpoint `/messages`):
 *   https://api.host.com        -> /v1/messages
 *   https://api.host.com/v1     -> /messages       (base already has /v1)
 *   https://gw.host.com/api/v1  -> /messages       (base already ends with /v1)
 */
export function versionedPath(baseUrl: string, endpoint: string, version = 'v1'): string {
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  let path = '';
  try {
    path = new URL(baseUrl).pathname;
  } catch {
    // If baseUrl is not parseable, fall back to a simple suffix check; the
    // request will fail later with a clearer error anyway.
    path = baseUrl;
  }
  const trimmed = path.replace(/\/+$/, '');
  const alreadyVersioned =
    trimmed.endsWith(`/${version}`) || trimmed === `/${version}`;
  return alreadyVersioned ? normalizedEndpoint : `/${version}${normalizedEndpoint}`;
}
