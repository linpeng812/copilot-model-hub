import {
  ConnectionProtocol,
  ModelCapabilities,
  ModelConnection,
  ModelContext,
  RawModelConnection,
  RequestDefaults,
  defaultSecretKey,
} from './types';

// Must start with a letter/digit; may then contain letters, digits, dots,
// underscores and hyphens. Dots are allowed so version-style ids like
// "rightcode-gpt-5.5" work; the id is only used as a Map key, a VS Code model
// id, and (by default) a SecretStorage key suffix, none of which restrict these
// characters. Spaces and slashes stay disallowed to keep ids path/key-safe.
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const PROTOCOLS: ConnectionProtocol[] = ['chat', 'responses', 'anthropic'];

export interface ValidationResult {
  connection?: ModelConnection;
  errors: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strip trailing slashes; keep the rest of the path intact. */
export function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '');
}

function isValidHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function parseCapabilities(value: unknown, errors: string[]): ModelCapabilities | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push('capabilities must be an object');
    return undefined;
  }
  const out: ModelCapabilities = {};
  for (const key of ['tools', 'vision', 'thinking'] as const) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') {
      errors.push(`capabilities.${key} must be a boolean`);
      continue;
    }
    out[key] = v;
  }
  return out;
}

function parseContext(value: unknown, errors: string[]): ModelContext | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push('context must be an object');
    return undefined;
  }
  const out: ModelContext = {};
  for (const key of ['input', 'output'] as const) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) {
      errors.push(`context.${key} must be a positive number`);
      continue;
    }
    out[key] = v;
  }
  return out;
}

function parseRequest(value: unknown, errors: string[]): RequestDefaults | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push('request must be an object');
    return undefined;
  }
  const out: RequestDefaults = {};
  const numericFields: Array<[keyof RequestDefaults, number]> = [
    ['temperature', -Infinity],
    ['topP', -Infinity],
    ['maxTokens', 0],
    ['timeoutMs', 1],
    ['maxRetries', 0],
  ];
  for (const [key, min] of numericFields) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
      errors.push(`request.${key} is invalid`);
      continue;
    }
    out[key] = v;
  }
  return out;
}

function parseHeaders(value: unknown, errors: string[]): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push('headers must be an object');
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') {
      errors.push(`headers.${k} must be a string`);
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * Validate and normalize a single raw connection.
 * Returns the connection when valid, or a list of errors when not.
 */
export function validateConnection(raw: RawModelConnection): ValidationResult {
  const errors: string[] = [];

  const id = raw.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    errors.push(
      `id "${String(id)}" is invalid (must match ${ID_PATTERN.source}; start with a letter or digit, then letters, digits, dots, underscores or hyphens)`,
    );
  }

  const name = raw.name;
  if (typeof name !== 'string' || name.trim() === '') {
    errors.push('name is required');
  }

  const protocol = raw.protocol;
  if (typeof protocol !== 'string' || !PROTOCOLS.includes(protocol as ConnectionProtocol)) {
    errors.push(`protocol must be one of ${PROTOCOLS.join(', ')}`);
  }

  const baseUrlRaw = raw.baseUrl;
  let baseUrl = '';
  if (typeof baseUrlRaw !== 'string' || baseUrlRaw.trim() === '') {
    errors.push('baseUrl is required');
  } else {
    baseUrl = normalizeBaseUrl(baseUrlRaw.trim());
    if (!isValidHttpUrl(baseUrl)) {
      errors.push(`baseUrl "${baseUrlRaw}" is not a valid http(s) URL`);
    }
  }

  const model = raw.model;
  if (typeof model !== 'string' || model.trim() === '') {
    errors.push('model is required');
  }

  let secretKey: string | undefined;
  if (raw.secretKey === undefined) {
    secretKey = typeof id === 'string' ? defaultSecretKey(id) : undefined;
  } else if (typeof raw.secretKey === 'string' && raw.secretKey.trim() !== '') {
    secretKey = raw.secretKey.trim();
  } else {
    errors.push('secretKey, when provided, must be a non-empty string');
  }

  const capabilities = parseCapabilities(raw.capabilities, errors);
  const context = parseContext(raw.context, errors);
  const request = parseRequest(raw.request, errors);
  const headers = parseHeaders(raw.headers, errors);

  let thinking: Record<string, unknown> | undefined;
  if (raw.thinking !== undefined) {
    if (isPlainObject(raw.thinking)) {
      thinking = raw.thinking;
    } else {
      errors.push('thinking must be an object');
    }
  }

  let pricing: Record<string, unknown> | undefined;
  if (raw.pricing !== undefined) {
    if (isPlainObject(raw.pricing)) {
      pricing = raw.pricing;
    } else {
      errors.push('pricing must be an object');
    }
  }

  if (errors.length > 0) {
    return { errors };
  }

  const connection: ModelConnection = {
    id: id as string,
    name: name as string,
    protocol: protocol as ConnectionProtocol,
    baseUrl,
    model: model as string,
    secretKey: secretKey as string,
  };
  if (headers) connection.headers = headers;
  if (capabilities) connection.capabilities = capabilities;
  if (context) connection.context = context;
  if (request) connection.request = request;
  if (thinking) connection.thinking = thinking;
  if (pricing) connection.pricing = pricing;

  return { connection, errors: [] };
}
