import { RawModelConnection } from './types';

/**
 * Raw connection arrays from each configuration scope, in increasing priority.
 * Later scopes override earlier ones when ids collide.
 */
export interface ScopedConnections {
  global?: unknown;
  workspace?: unknown;
  workspaceFolder?: unknown;
}

function asArray(value: unknown): RawModelConnection[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is RawModelConnection => typeof v === 'object' && v !== null);
}

/**
 * Merge connection arrays from all scopes into a single ordered list.
 *
 * Order of priority: global < workspace < workspaceFolder. When the same id
 * appears in multiple scopes, the highest-priority scope wins and keeps the
 * position of its first occurrence. Entries without a usable string id are
 * passed through unmerged (validation rejects them later).
 */
export function mergeScopes(scopes: ScopedConnections): RawModelConnection[] {
  const ordered = [
    ...asArray(scopes.global),
    ...asArray(scopes.workspace),
    ...asArray(scopes.workspaceFolder),
  ];

  // Later entries (higher priority) override earlier ones by id.
  const byId = new Map<string, RawModelConnection>();
  const noId: RawModelConnection[] = [];
  for (const entry of ordered) {
    const id = entry.id;
    if (typeof id === 'string') {
      byId.set(id, entry);
    } else {
      noId.push(entry);
    }
  }

  return [...byId.values(), ...noId];
}
