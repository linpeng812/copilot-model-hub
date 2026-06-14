import * as vscode from 'vscode';
import { ModelConnection } from '../config/types';

/**
 * Context passed to an adapter for a single response. Adapters translate VS
 * Code request messages into an upstream request, stream the upstream
 * response, and report parts back through `progress`.
 */
export interface AdapterRequest {
  connection: ModelConnection;
  apiKey: string;
  modelInfo: vscode.LanguageModelChatInformation;
  messages: readonly vscode.LanguageModelChatRequestMessage[];
  options: vscode.ProvideLanguageModelChatResponseOptions;
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  token: vscode.CancellationToken;
}

/** A protocol adapter turns VS Code requests into upstream calls. */
export interface ProtocolAdapter {
  readonly protocol: ModelConnection['protocol'];
  /** Execute one streaming response, reporting parts via `request.progress`. */
  send(request: AdapterRequest): Promise<void>;
}
