import * as vscode from 'vscode';
import { parseFirstReplayMarker } from '../../provider/replay';
import { canonicalizeToolArgumentsStr } from '../../shared/canonical';

/** OpenAI Chat Completions wire types (the subset we produce). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  reasoning_content?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: unknown };
}

export interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: ChatTool[];
  tool_choice?: unknown;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  reasoning_effort?: string;
}

function mapRole(role: vscode.LanguageModelChatMessageRole): 'user' | 'assistant' {
  return role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
}

function isThinkingPart(part: unknown): part is { value: string | string[] } {
  const ctor = (vscode as Record<string, unknown>).LanguageModelThinkingPart;
  return (
    typeof ctor === 'function' &&
    part instanceof (ctor as new (...a: unknown[]) => object) &&
    'value' in (part as object)
  );
}

function thinkingText(value: string | string[]): string {
  return Array.isArray(value) ? value.join('') : value;
}

/**
 * Convert VS Code request messages to chat messages. When `isThinkingModel`,
 * assistant reasoning is recovered from a replay marker (preferred) or from
 * live thinking parts, and re-attached as `reasoning_content` so thinking
 * models that require it across tool turns do not reject the request.
 */
export function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  isThinkingModel: boolean,
): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (const message of messages) {
    const role = mapRole(message.role);
    let content = '';
    let thinking = '';
    const toolCalls: ChatToolCall[] = [];
    const toolResults: Array<{ callId: string; content: string }> = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        content += part.value;
      } else if (isThinkingPart(part)) {
        thinking += thinkingText(part.value);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: { name: part.name, arguments: canonicalizeToolArgumentsStr(stringifyInput(part.input)) },
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        let toolContent = '';
        if (Array.isArray(part.content)) {
          for (const item of part.content) {
            if (item instanceof vscode.LanguageModelTextPart) toolContent += item.value;
          }
        }
        toolResults.push({
          callId: part.callId,
          content: toolContent || safeStringify(part.content),
        });
      }
    }

    if (role === 'assistant') {
      if (content || toolCalls.length > 0) {
        const msg: ChatMessage = { role: 'assistant', content };
        if (toolCalls.length > 0) msg.tool_calls = toolCalls;
        if (isThinkingModel) {
          const marker = parseFirstReplayMarker(message);
          const reasoning =
            marker?.valid && marker.reasoningText ? marker.reasoningText : thinking;
          if (reasoning) msg.reasoning_content = reasoning;
        }
        result.push(msg);
      }
    } else if (content) {
      result.push({ role, content });
    }

    for (const tr of toolResults) {
      result.push({ role: 'tool', content: tr.content, tool_call_id: tr.callId });
    }
  }

  return result;
}

function stringifyInput(input: unknown): string {
  if (typeof input === 'string') return input;
  return safeStringify(input);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

export function convertTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): ChatTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

/** Total chars across produced messages, for charsPerToken calibration. */
export function countMessageChars(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += m.content?.length ?? 0;
    total += m.reasoning_content?.length ?? 0;
    for (const tc of m.tool_calls ?? []) {
      total += tc.function.name.length + tc.function.arguments.length;
    }
  }
  return total;
}
