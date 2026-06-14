import * as vscode from 'vscode';
import { ModelConnection } from '../../config/types';
import { parseFirstReplayMarker } from '../../provider/replay';

/** Anthropic Messages wire types (the subset we produce). */
export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}
export interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

export interface AnthropicThinkingParam {
  type: 'enabled';
  budget_tokens: number;
}

export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  stream: true;
  temperature?: number;
  top_p?: number;
  thinking?: AnthropicThinkingParam;
}

const DEFAULT_MAX_TOKENS = 4096;
const THINKING_SAFETY_MARGIN = 1024;

function isThinkingPart(part: unknown): part is { value: string | string[] } {
  const ctor = (vscode as Record<string, unknown>).LanguageModelThinkingPart;
  return (
    typeof ctor === 'function' &&
    part instanceof (ctor as new (...a: unknown[]) => object) &&
    'value' in (part as object)
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

interface ConvertResult {
  system: string;
  messages: AnthropicMessage[];
}

/**
 * Resolve the thinking blocks to replay for an assistant turn. Anthropic
 * rejects interleaved-thinking tool conversations unless the previous
 * assistant `thinking` blocks (with their `signature`) are sent back verbatim,
 * so we recover them from our replay marker.
 */
function replayThinkingBlocks(
  message: vscode.LanguageModelChatRequestMessage,
): AnthropicThinkingBlock[] {
  const marker = parseFirstReplayMarker(message);
  if (!marker?.valid) return [];
  if (Array.isArray(marker.raw)) {
    return marker.raw.filter(
      (b): b is AnthropicThinkingBlock =>
        !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'thinking',
    );
  }
  return [];
}

/**
 * Convert VS Code messages to Anthropic messages, extracting the system prompt
 * to the top level and mapping tool calls/results to `tool_use`/`tool_result`
 * blocks. Tool results are emitted as a following user message, per the
 * Anthropic message model.
 */
export function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  isThinkingModel: boolean,
): ConvertResult {
  const systemParts: string[] = [];
  const result: AnthropicMessage[] = [];

  for (const message of messages) {
    const isAssistant = message.role === vscode.LanguageModelChatMessageRole.Assistant;
    const blocks: AnthropicContentBlock[] = [];
    const toolResults: AnthropicToolResultBlock[] = [];
    let text = '';

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        blocks.push({ type: 'tool_use', id: part.callId, name: part.name, input: part.input });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        let content = '';
        if (Array.isArray(part.content)) {
          for (const item of part.content) {
            if (item instanceof vscode.LanguageModelTextPart) content += item.value;
          }
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: part.callId,
          content: content || safeStringify(part.content),
        });
      } else if (isThinkingPart(part)) {
        // Live thinking parts are not replayable (no signature); the marker
        // carries the authoritative blocks. Skip them here.
      }
    }

    if (!isAssistant) {
      // System messages go to the top level; everything else is a user turn.
      if (message.role === vscode.LanguageModelChatMessageRole.User) {
        const userBlocks: AnthropicContentBlock[] = [];
        if (text) userBlocks.push({ type: 'text', text });
        if (userBlocks.length > 0) result.push({ role: 'user', content: userBlocks });
      } else if (text) {
        systemParts.push(text);
      }
    } else {
      const assistantBlocks: AnthropicContentBlock[] = [];
      if (isThinkingModel) {
        assistantBlocks.push(...replayThinkingBlocks(message));
      }
      if (text) assistantBlocks.push({ type: 'text', text });
      assistantBlocks.push(...blocks);
      if (assistantBlocks.length > 0) {
        result.push({ role: 'assistant', content: assistantBlocks });
      }
    }

    // Tool results follow as their own user message.
    if (toolResults.length > 0) {
      result.push({ role: 'user', content: toolResults });
    }
  }

  return { system: systemParts.join('\n\n'), messages: result };
}

export function convertTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): AnthropicTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
  }));
}

/** Read the thinking budget from the connection's thinking config (if any). */
function resolveThinkingBudget(connection: ModelConnection): number | undefined {
  if (connection.capabilities?.thinking !== true) return undefined;
  const thinking = connection.thinking;
  if (!thinking) return undefined;
  const budget =
    (thinking.defaultBudgetTokens as number | undefined) ??
    (thinking.budget_tokens as number | undefined);
  // A budget of 0 means thinking is disabled for this request.
  if (typeof budget !== 'number' || budget <= 0) return undefined;
  return budget;
}

/**
 * Compute `max_tokens`, which is required by the Anthropic API. Our internal
 * `request.maxTokens: 0` (unlimited) has no meaning here, so we fall back to
 * `context.output` then a conservative default, and ensure it always exceeds
 * the thinking budget plus a safety margin.
 */
export function resolveMaxTokens(connection: ModelConnection, thinkingBudget?: number): number {
  let max = connection.request?.maxTokens || connection.context?.output || DEFAULT_MAX_TOKENS;
  if (thinkingBudget && max <= thinkingBudget) {
    max = thinkingBudget + THINKING_SAFETY_MARGIN;
  }
  return max;
}

export function buildRequestBody(
  connection: ModelConnection,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
): AnthropicRequestBody {
  const isThinking = connection.capabilities?.thinking === true;
  const { system, messages: anthropicMessages } = convertMessages(messages, isThinking);
  const tools = connection.capabilities?.tools === false ? undefined : convertTools(options.tools);
  const budget = resolveThinkingBudget(connection);

  const body: AnthropicRequestBody = {
    model: connection.model,
    max_tokens: resolveMaxTokens(connection, budget),
    messages: anthropicMessages,
    stream: true,
  };
  if (system) body.system = system;
  if (tools) body.tools = tools;

  const defaults = connection.request;
  if (budget) {
    body.thinking = { type: 'enabled', budget_tokens: budget };
    // Anthropic requires temperature unset (or 1) when thinking is enabled.
  } else {
    if (defaults?.temperature !== undefined) body.temperature = defaults.temperature;
    if (defaults?.topP !== undefined) body.top_p = defaults.topP;
  }

  return body;
}
