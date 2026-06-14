import * as vscode from 'vscode';
import { ConnectionRegistry } from '../config/registry';
import { SecretManager } from '../secrets/manager';
import { AdapterRouter } from './router';
import { TokenEstimator } from './tokens';
import { MultiProvider } from './index';

const VENDOR = 'copilot-model-hub';

export interface RegisteredProvider {
  provider: MultiProvider;
  /** Reload connections from config and refresh the model picker. */
  reload(): void;
  dispose(): void;
}

/**
 * Registers the unified provider under the `copilot-model-hub` vendor and
 * returns handles to reload and dispose it.
 */
export function registerProvider(
  context: vscode.ExtensionContext,
  registry: ConnectionRegistry,
  secrets: SecretManager,
  router: AdapterRouter,
  tokens: TokenEstimator,
): RegisteredProvider {
  const provider = new MultiProvider(registry, secrets, router, tokens);

  const registration = vscode.lm.registerLanguageModelChatProvider(VENDOR, provider);

  // Refresh the picker when a key is added or removed.
  const secretSub = secrets.onDidChange(() => provider.refresh());

  context.subscriptions.push(registration, secretSub, { dispose: () => provider.dispose() });

  return {
    provider,
    reload: () => {
      registry.reload();
      provider.refresh();
    },
    dispose: () => {
      provider.setActive(false);
      registration.dispose();
    },
  };
}
