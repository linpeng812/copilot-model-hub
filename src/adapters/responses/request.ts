import * as vscode from 'vscode';
import { ModelConnection } from '../../config/types';
import { parseFirstReplayMarker } from '../../provider/replay';
import { canonicalizeToolArgumentsStr } from '../../shared/canonical';

/** Responses API input item types (the subset we produce). */
export interface ResponsesMessageItem {
  type: 'message';
  role: 'user' | 'assistant';
  content: Array<{ type: 'input_text' | 'output_text'; text: string }>;
}
export interface ResponsesFunctionCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}
export interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}
export interface ResponsesReasoningItem {
  type: 'reasoning';
  summary: Array<{ type: 'summary_text'; text: string }>;
}
export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesReasoningItem;

export interface ResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface ResponsesRequestBody {
  model: string;
  input: ResponsesInputItem[];
  stream: true;
  instructions?: string;
  tools?: ResponsesTool[];
  tool_choice?: unknown;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning?: { effort: string };
}

const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const REASONING_OFF = new Set(['none', 'off', 'disabled']);

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function isSystemRole(role: vscode.LanguageModelChatMessageRole): boolean {
  // The stable API exposes only User/Assistant; a System role (proposed API,
  // value 3) may appear at runtime. Detect it dynamically without a static
  // type reference, treating an unknown non-assistant role as user otherwise.
  const enumObj = (vscode as { LanguageModelChatMessageRole?: Record<string, unknown> })
    .LanguageModelChatMessageRole;
  const systemValue = enumObj?.System;
  return typeof systemValue === 'number' && role === systemValue;
}

function isThinkingPart(part: unknown): part is { value: string | string[] } {
  const ctor = (vscode as Record<string, unknown>).LanguageModelThinkingPart;
  return (
    typeof ctor === 'function' &&
    part instanceof (ctor as new (...a: unknown[]) => object) &&
    'value' in (part as object)
  );
}

/**
 * Map a configured/normalized reasoning effort to a Responses value. Returns
 * undefined to mean "do not send a reasoning object" (effort off or unknown).
 */
export function mapReasoningEffort(effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  const normalized = effort.trim().toLowerCase();
  if (REASONING_OFF.has(normalized)) return undefined;
  return REASONING_EFFORTS.has(normalized) ? normalized : undefined;
}

function reasoningEffortFromOptions(
  options: vscode.ProvideLanguageModelChatResponseOptions,
): string | undefined {
  const opts = options as {
    modelConfiguration?: Record<string, unknown>;
    configuration?: Record<string, unknown>;
  };
  const effort = opts.modelConfiguration?.reasoningEffort ?? opts.configuration?.reasoningEffort;
  return typeof effort === 'string' ? effort : undefined;
}

export interface ConvertResult {
  instructions: string;
  input: ResponsesInputItem[];
}

/**
 * Convert VS Code messages to Responses input items. System text goes to the
 * top-level `instructions`. Assistant reasoning is recovered from a replay
 * marker and emitted as a `reasoning` item placed immediately before the
 * assistant/tool-call it belongs to, since some thinking models reject tool
 * conversations whose reasoning items are missing.
 */
export function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  isThinkingModel: boolean,
): ConvertResult {
  const instructions: string[] = [];
  const input: ResponsesInputItem[] = [];

  for (const message of messages) {
    const role = message.role;
    let text = '';
    const toolCalls: ResponsesFunctionCallItem[] = [];
    const toolOutputs: ResponsesFunctionCallOutputItem[] = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          type: 'function_call',
          call_id: part.callId,
          name: part.name,
          arguments: canonicalizeToolArgumentsStr(
            typeof part.input === 'string' ? part.input : safeStringify(part.input),
          ),
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        let output = '';
        if (Array.isArray(part.content)) {
          for (const item of part.content) {
            if (item instanceof vscode.LanguageModelTextPart) output += item.value;
          }
        }
        toolOutputs.push({
          type: 'function_call_output',
          call_id: part.callId,
          output: output || safeStringify(part.content),
        });
      } else if (isThinkingPart(part)) {
        // Live thinking is not replayable; the marker carries reasoning.
      }
    }

    if (isSystemRole(role)) {
      if (text) instructions.push(text);
    } else if (role === vscode.LanguageModelChatMessageRole.Assistant) {
      // Replay reasoning is merged immediately before this assistant turn.
      if (isThinkingModel) {
        const reasoning = recoverReasoningItem(message);
        if (reasoning) input.push(reasoning);
      }
      if (text) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      }
      for (const call of toolCalls) input.push(call);
    } else {
      if (text) {
        input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
      }
      for (const out of toolOutputs) input.push(out);
    }
  }

  return { instructions: instructions.join('\n\n'), input };
}

function recoverReasoningItem(
  message: vscode.LanguageModelChatRequestMessage,
): ResponsesReasoningItem | undefined {
  const marker = parseFirstReplayMarker(message);
  if (!marker?.valid) return undefined;
  // A verbatim reasoning item (with ids) is preferred when present.
  if (marker.raw && typeof marker.raw === 'object' && (marker.raw as { type?: unknown }).type === 'reasoning') {
    return marker.raw as ResponsesReasoningItem;
  }
  if (marker.reasoningText) {
    return { type: 'reasoning', summary: [{ type: 'summary_text', text: marker.reasoningText }] };
  }
  return undefined;
}

export function convertTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): ResponsesTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

export function buildRequestBody(
  connection: ModelConnection,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
): ResponsesRequestBody {
  const isThinking = connection.capabilities?.thinking === true;
  const { instructions, input } = convertMessages(messages, isThinking);
  const tools = connection.capabilities?.tools === false ? undefined : convertTools(options.tools);

  const body: ResponsesRequestBody = {
    model: connection.model,
    input,
    stream: true,
  };
  if (instructions) body.instructions = instructions;

  // Strict-upstream defense: only send tool_choice when tools are present.
  if (tools) {
    body.tools = tools;
    if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
      body.tool_choice = 'required';
    }
  }

  const defaults = connection.request;
  if (defaults?.maxTokens) body.max_output_tokens = defaults.maxTokens;
  if (defaults?.temperature !== undefined) body.temperature = defaults.temperature;
  if (defaults?.topP !== undefined) body.top_p = defaults.topP;

  if (isThinking) {
    const configured =
      reasoningEffortFromOptions(options) ??
      (connection.thinking?.defaultEffort as string | undefined);
    const effort = mapReasoningEffort(configured);
    if (effort) body.reasoning = { effort };
  }

  return body;
}
