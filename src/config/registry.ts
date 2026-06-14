import * as vscode from 'vscode';
import { ModelConnection } from './types';
import { validateConnection } from './validate';
import { mergeScopes } from './scope';
import { getLogger } from '../runtime/logger';

const CONFIG_SECTION = 'copilotModelHub';
const CONNECTIONS_KEY = 'connections';

export interface ConnectionRegistry {
  list(): ModelConnection[];
  getByModelId(modelId: string): ModelConnection | undefined;
  reload(): void;
}

/**
 * Reads `copilotModelHub.connections` across all scopes, validates and
 * normalizes each entry, and exposes the resulting connections. Invalid
 * entries are dropped with a logged warning (graceful degradation) so one bad
 * connection never takes down the rest.
 */
export class ConfigConnectionRegistry implements ConnectionRegistry {
  private connections: ModelConnection[] = [];
  private byId = new Map<string, ModelConnection>();

  constructor() {
    this.reload();
  }

  list(): ModelConnection[] {
    return this.connections;
  }

  getByModelId(modelId: string): ModelConnection | undefined {
    return this.byId.get(modelId);
  }

  reload(): void {
    const log = getLogger();
    const inspected = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .inspect<unknown>(CONNECTIONS_KEY);

    const merged = mergeScopes({
      global: inspected?.globalValue,
      workspace: inspected?.workspaceValue,
      workspaceFolder: inspected?.workspaceFolderValue,
    });

    const valid: ModelConnection[] = [];
    const seenIds = new Set<string>();

    for (const raw of merged) {
      const { connection, errors } = validateConnection(raw);
      if (!connection) {
        log.warn(`Skipping invalid connection: ${errors.join('; ')}`);
        continue;
      }
      if (seenIds.has(connection.id)) {
        log.warn(`Skipping duplicate connection id "${connection.id}"`);
        continue;
      }
      seenIds.add(connection.id);
      valid.push(connection);
    }

    this.connections = valid;
    this.byId = new Map(valid.map((c) => [c.id, c]));
    log.info(`Loaded ${valid.length} connection(s)`);
  }
}
