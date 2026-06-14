import * as vscode from 'vscode';
import { ModelConnection } from '../config/types';

/**
 * NOTE: Non-public API surface.
 *
 * `isUserSelectable`, `statusIcon`, and `configurationSchema` are not part of
 * the stable `vscode.LanguageModelChatInformation` typings yet, but are the
 * shape GitHub Copilot Chat consumes to render model-picker metadata and
 * per-model controls. All such fields are confined to this module so that, if
 * they change upstream, only advanced presentation degrades — basic chat does
 * not depend on them.
 */
type ModelPickerChatInformation = vscode.LanguageModelChatInformation & {
  readonly isUserSelectable?: boolean;
  readonly statusIcon?: vscode.ThemeIcon;
  readonly configurationSchema?: unknown;
};

const DEFAULT_MAX_INPUT = 128000;
const DEFAULT_MAX_OUTPUT = 8192;

function buildThinkingSchema() {
  return {
    properties: {
      reasoningEffort: {
        type: 'string',
        title: 'Thinking',
        enum: ['none', 'low', 'medium', 'high'],
        default: 'medium',
        group: 'navigation',
      },
    },
  } as const;
}

/** Map a validated connection to the model-picker information shape. */
export function toChatInfo(
  connection: ModelConnection,
  hasApiKey: boolean,
): ModelPickerChatInformation {
  const caps = connection.capabilities ?? {};
  const detail = hasApiKey
    ? `${connection.protocol} · ${connection.model}`
    : 'API key required — run "Copilot Model Hub: Set API Key"';

  return {
    id: connection.id,
    name: connection.name,
    family: connection.protocol,
    version: '1.0.0',
    detail,
    tooltip: detail,
    statusIcon: hasApiKey ? undefined : new vscode.ThemeIcon('warning'),
    maxInputTokens: connection.context?.input ?? DEFAULT_MAX_INPUT,
    maxOutputTokens: connection.context?.output ?? DEFAULT_MAX_OUTPUT,
    isUserSelectable: true,
    capabilities: {
      toolCalling: caps.tools ?? true,
      imageInput: caps.vision ?? false,
    },
    ...(caps.thinking ? { configurationSchema: buildThinkingSchema() } : {}),
  };
}
