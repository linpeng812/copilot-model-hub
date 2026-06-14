/** Supported upstream protocols. */
export type ConnectionProtocol = 'chat' | 'responses' | 'anthropic';

export interface ModelCapabilities {
  tools?: boolean;
  vision?: boolean;
  thinking?: boolean;
}

export interface ModelContext {
  /** Max input (context window) tokens. */
  input?: number;
  /** Max output tokens. */
  output?: number;
}

export interface RequestDefaults {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

/** Protocol-specific thinking/reasoning config. Shape varies per provider. */
export type ThinkingConfig = Record<string, unknown>;

/** Optional pricing metadata shown in the model picker. */
export type PricingConfig = Record<string, unknown>;

/**
 * A connection as written by the user in `copilotModelHub.connections`.
 * `secretKey` is optional here — it is derived from `id` when omitted.
 */
export interface RawModelConnection {
  id?: unknown;
  name?: unknown;
  protocol?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  secretKey?: unknown;
  headers?: unknown;
  capabilities?: unknown;
  context?: unknown;
  request?: unknown;
  thinking?: unknown;
  pricing?: unknown;
}

/**
 * A validated, normalized connection used throughout the extension.
 * `secretKey` is always resolved (derived from id when not explicit).
 */
export interface ModelConnection {
  id: string;
  name: string;
  protocol: ConnectionProtocol;
  baseUrl: string;
  model: string;
  secretKey: string;
  headers?: Record<string, string>;
  capabilities?: ModelCapabilities;
  context?: ModelContext;
  request?: RequestDefaults;
  thinking?: ThinkingConfig;
  pricing?: PricingConfig;
}

/** Derive the default SecretStorage key for a connection id. */
export function defaultSecretKey(id: string): string {
  return `copilotModelHub.connection.${id}.apiKey`;
}
