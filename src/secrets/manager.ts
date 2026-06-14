import * as vscode from 'vscode';
import { ModelConnection } from '../config/types';

/**
 * Stores and retrieves per-connection API keys in VS Code SecretStorage.
 * Keys are addressed by `connection.secretKey` (derived from id by default,
 * or shared across connections when explicitly set).
 */
export class SecretManager {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  get onDidChange(): vscode.Event<vscode.SecretStorageChangeEvent> {
    return this.secrets.onDidChange;
  }

  async getApiKey(connection: ModelConnection): Promise<string | undefined> {
    const value = await this.secrets.get(connection.secretKey);
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  }

  async hasApiKey(connection: ModelConnection): Promise<boolean> {
    return (await this.getApiKey(connection)) !== undefined;
  }

  async setApiKey(connection: ModelConnection, apiKey: string): Promise<void> {
    await this.secrets.store(connection.secretKey, apiKey.trim());
  }

  async setApiKeyByKey(secretKey: string, apiKey: string): Promise<void> {
    await this.secrets.store(secretKey, apiKey.trim());
  }

  async deleteApiKey(connection: ModelConnection): Promise<void> {
    await this.secrets.delete(connection.secretKey);
  }
}
