import * as vscode from 'vscode';
import { getLogger, disposeLogger } from './logger';
import { ConfigConnectionRegistry } from '../config/registry';
import { SecretManager } from '../secrets/manager';
import { registerCommands } from './commands';
import { AdapterRouter } from '../provider/router';
import { TokenEstimator } from '../provider/tokens';
import { registerProvider } from '../provider/register';
import { registerAdapters } from '../adapters';

const CONFIG_SECTION = 'copilotModelHub';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = getLogger();
  log.info('Copilot Model Hub activating');

  const registry = new ConfigConnectionRegistry();
  const secrets = new SecretManager(context.secrets);
  const router = new AdapterRouter();
  const tokens = new TokenEstimator();

  registerAdapters(router);

  registerCommands(context, registry, secrets);

  const registered = registerProvider(context, registry, secrets, router, tokens);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.connections`)) {
        log.info('Connections configuration changed; reloading');
        registered.reload();
      }
    }),
  );

  context.subscriptions.push({ dispose: () => disposeLogger() });
  log.info('Copilot Model Hub activated');
}

export function deactivate(): void {
  // Subscriptions registered on the context are disposed automatically.
}
