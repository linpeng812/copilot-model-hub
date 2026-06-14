import * as vscode from 'vscode';
import { ConnectionRegistry } from '../config/registry';
import { SecretManager } from '../secrets/manager';
import { TokenEstimator } from './tokens';
import { toChatInfo } from './info';
import { AdapterRouter } from './router';
import { getLogger } from '../runtime/logger';

/**
 * A single LanguageModelChatProvider that fans out across all configured
 * connections. Each connection appears as one model in the picker; the
 * protocol on the matched connection selects the adapter.
 */
export class MultiProvider implements vscode.LanguageModelChatProvider {
  private active = true;
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  /** Fired when the available set of models changes (config/secret updates). */
  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly secrets: SecretManager,
    private readonly router: AdapterRouter,
    private readonly tokens: TokenEstimator,
  ) {}

  /** Disable the provider so it reports no models (used on deactivate). */
  setActive(active: boolean): void {
    this.active = active;
    this.changeEmitter.fire();
  }

  /** Notify VS Code that the model list should be refreshed. */
  refresh(): void {
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    if (!this.active) return [];
    const connections = this.registry.list();
    const infos = await Promise.all(
      connections.map(async (connection) => {
        const hasKey = await this.secrets.hasApiKey(connection);
        return toChatInfo(connection, hasKey);
      }),
    );
    const log = getLogger();
    log.debug(
      `Reporting ${infos.length} model(s) to VS Code: ` +
        infos
          .map((i) => `${i.id}[toolCalling=${String(i.capabilities?.toolCalling)}]`)
          .join(', '),
    );
    return infos;
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const log = getLogger();
    const connection = this.registry.getByModelId(model.id);
    if (!connection) {
      throw new Error(`Unknown model "${model.id}". Its connection may have been removed.`);
    }

    const apiKey = await this.secrets.getApiKey(connection);
    if (!apiKey) {
      throw new Error(
        `No API key set for "${connection.name}". Run "Copilot Model Hub: Set API Key".`,
      );
    }

    const adapter = this.router.get(connection.protocol);
    log.debug(`Routing ${model.id} to ${connection.protocol} adapter`);

    try {
      await adapter.send({
        connection,
        apiKey,
        modelInfo: model,
        messages,
        options,
        progress,
        token,
      });
    } catch (err) {
      // VS Code shows a generic "no response" message and discards the error
      // detail, so log it here where the upstream status/reason is still intact.
      log.error(
        `Request to "${connection.name}" (${connection.protocol} @ ${connection.baseUrl}) failed: ${String(err)}`,
      );
      throw err;
    }
  }

  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    return this.tokens.estimate(model.id, text);
  }
}
