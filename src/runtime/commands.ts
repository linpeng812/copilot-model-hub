import * as vscode from 'vscode';
import { ConnectionRegistry } from '../config/registry';
import { SecretManager } from '../secrets/manager';
import { ModelConnection } from '../config/types';
import { getLogger } from './logger';
import { versionedPath } from '../shared/url';

async function pickConnection(
  registry: ConnectionRegistry,
  placeHolder: string,
): Promise<ModelConnection | undefined> {
  const connections = registry.list();
  if (connections.length === 0) {
    vscode.window.showWarningMessage(
      'No connections configured. Add one under copilotModelHub.connections first.',
    );
    return undefined;
  }
  if (connections.length === 1) {
    return connections[0];
  }
  const picked = await vscode.window.showQuickPick(
    connections.map((c) => ({ label: c.name, description: `${c.protocol} · ${c.id}`, connection: c })),
    { placeHolder },
  );
  return picked?.connection;
}

async function setApiKey(registry: ConnectionRegistry, secrets: SecretManager): Promise<void> {
  const connection = await pickConnection(registry, 'Select a connection to set its API key');
  if (!connection) return;

  const apiKey = await vscode.window.showInputBox({
    prompt: `API key for ${connection.name}`,
    password: true,
    ignoreFocusOut: true,
  });
  if (apiKey === undefined) return;
  if (apiKey.trim() === '') {
    vscode.window.showWarningMessage('API key was empty; nothing saved.');
    return;
  }

  await secrets.setApiKey(connection, apiKey);
  vscode.window.showInformationMessage(`Saved API key for ${connection.name}.`);
}

/**
 * Minimal connectivity check: confirms the base URL is reachable and the key
 * is accepted, without depending on protocol adapters. Richer protocol-level
 * validation is layered in once adapters exist.
 */
async function testConnection(registry: ConnectionRegistry, secrets: SecretManager): Promise<void> {
  const connection = await pickConnection(registry, 'Select a connection to test');
  if (!connection) return;

  const apiKey = await secrets.getApiKey(connection);
  if (!apiKey) {
    vscode.window.showWarningMessage(
      `No API key set for ${connection.name}. Run "Set API Key" first.`,
    );
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Testing ${connection.name}...` },
    async () => {
      const result = await probeConnection(connection, apiKey);
      if (result.ok) {
        vscode.window.showInformationMessage(`${connection.name}: reachable and authenticated.`);
      } else {
        vscode.window.showErrorMessage(`${connection.name}: ${result.reason}`);
      }
    },
  );
}

interface ProbeResult {
  ok: boolean;
  reason?: string;
}

async function probeConnection(connection: ModelConnection, apiKey: string): Promise<ProbeResult> {
  const log = getLogger();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), connection.request?.timeoutMs ?? 15000);

  // A models-list endpoint is the cheapest auth check for chat/responses.
  // Anthropic has no public list endpoint, so we send a 1-token messages ping.
  const isAnthropic = connection.protocol === 'anthropic';
  const url = isAnthropic
    ? `${connection.baseUrl}${versionedPath(connection.baseUrl, '/messages')}`
    : `${connection.baseUrl}/models`;

  try {
    const headers: Record<string, string> = { ...connection.headers };
    let body: string | undefined;
    let method = 'GET';

    if (isAnthropic) {
      method = 'POST';
      headers['content-type'] = 'application/json';
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01';
      body = JSON.stringify({
        model: connection.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
    } else {
      headers['authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, { method, headers, body, signal: controller.signal });

    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'authentication failed (check API key)' };
    }
    if (response.status === 404) {
      return { ok: false, reason: `endpoint not found at ${url} (check baseUrl/protocol)` };
    }
    // A 200 with an HTML body means the path didn't match an API route and the
    // server fell back to its SPA/landing page — usually a wrong baseUrl path.
    const contentType = response.headers.get('content-type') ?? '';
    if (response.ok && contentType.includes('text/html')) {
      return {
        ok: false,
        reason: `got an HTML page from ${url}, not an API response (baseUrl path looks wrong)`,
      };
    }
    // Anthropic returns 400 for an invalid model but that still proves auth + reachability.
    if (response.ok || (isAnthropic && response.status === 400)) {
      return { ok: true };
    }
    return { ok: false, reason: `upstream returned HTTP ${response.status}` };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, reason: 'request timed out' };
    }
    log.error(`Test connection failed: ${String(err)}`);
    return { ok: false, reason: 'network error (check baseUrl and connectivity)' };
  } finally {
    clearTimeout(timeout);
  }
}

export function registerCommands(
  context: vscode.ExtensionContext,
  registry: ConnectionRegistry,
  secrets: SecretManager,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('copilotModelHub.setApiKey', () =>
      setApiKey(registry, secrets),
    ),
    vscode.commands.registerCommand('copilotModelHub.testConnection', () =>
      testConnection(registry, secrets),
    ),
    vscode.commands.registerCommand('copilotModelHub.openSettings', () =>
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'copilotModelHub.connections',
      ),
    ),
  );
}
