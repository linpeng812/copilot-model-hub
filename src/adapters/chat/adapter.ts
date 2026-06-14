import * as vscode from 'vscode';
import { AdapterRequest, ProtocolAdapter } from '../types';
import { postStream, isAbortError } from '../../shared/http';
import { getLogger } from '../../runtime/logger';
import {
  ChatRequestBody,
  convertMessages,
  convertTools,
} from './request';
import { ChatStreamParser, ChatUsage } from './stream';
import { createReplayMarkerPart, hasReplayMarkerMetadata } from '../../provider/replay';

const USAGE_DATA_PART_MIME = 'usage';

interface ModelConfigOptions {
  modelConfiguration?: Record<string, unknown>;
  configuration?: Record<string, unknown>;
}

function reasoningEffort(options: vscode.ProvideLanguageModelChatResponseOptions): string | undefined {
  const opts = options as ModelConfigOptions;
  const effort = opts.modelConfiguration?.reasoningEffort ?? opts.configuration?.reasoningEffort;
  return typeof effort === 'string' ? effort : undefined;
}

/** OpenAI-compatible Chat Completions adapter. */
export class ChatCompletionsAdapter implements ProtocolAdapter {
  readonly protocol = 'chat' as const;

  async send(request: AdapterRequest): Promise<void> {
    const { connection, messages, options, progress, token } = request;
    const log = getLogger();

    const isThinking = connection.capabilities?.thinking === true;
    const chatMessages = convertMessages(messages, isThinking);
    const tools = connection.capabilities?.tools === false ? undefined : convertTools(options.tools);

    const body: ChatRequestBody = {
      model: connection.model,
      messages: chatMessages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools) body.tools = tools;
    if (tools && options.toolMode === vscode.LanguageModelChatToolMode.Required) {
      body.tool_choice = 'required';
    }

    const defaults = connection.request;
    if (defaults?.temperature !== undefined) body.temperature = defaults.temperature;
    if (defaults?.topP !== undefined) body.top_p = defaults.topP;
    if (defaults?.maxTokens) body.max_tokens = defaults.maxTokens;

    if (isThinking) {
      const effort = reasoningEffort(options);
      if (effort && effort !== 'none') body.reasoning_effort = effort;
    }

    let accumulatedReasoning = '';
    let markerReported = false;
    const reportMarkerOnce = () => {
      if (markerReported || !isThinking) return;
      markerReported = true;
      const metadata = { reasoningText: accumulatedReasoning || undefined };
      if (hasReplayMarkerMetadata(metadata)) {
        try {
          progress.report(createReplayMarkerPart(metadata));
        } catch (err) {
          log.warn(`Failed to report replay marker: ${String(err)}`);
        }
      }
    };

    const parser = new ChatStreamParser((line, err) =>
      log.error(`Failed to parse chat SSE chunk: ${String(err)} :: ${line.slice(0, 200)}`),
    );

    try {
      const reader = await postStream({
        connection,
        apiKey: request.apiKey,
        path: '/chat/completions',
        auth: 'bearer',
        body,
        token,
      });

      const decoder = new TextDecoder();
      for (;;) {
        if (token.isCancellationRequested) return;
        const { done, value } = await reader.read();
        if (done) break;
        const events = parser.push(decoder.decode(value, { stream: true }));
        accumulatedReasoning += this.report(events, progress, request);
      }
      accumulatedReasoning += this.report(parser.end(), progress, request);
      reportMarkerOnce();
    } catch (err) {
      if (isAbortError(err) && token.isCancellationRequested) return;
      throw err;
    }
  }

  /** Report events to VS Code; returns any reasoning text seen (for the marker). */
  private report(
    events: ReturnType<ChatStreamParser['push']>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    request: AdapterRequest,
  ): string {
    let reasoning = '';
    for (const event of events) {
      switch (event.kind) {
        case 'content':
          progress.report(new vscode.LanguageModelTextPart(event.text));
          break;
        case 'thinking':
          reasoning += event.text;
          this.reportThinking(event.text, progress);
          break;
        case 'toolCall':
          this.reportToolCall(event.id, event.name, event.arguments, progress);
          break;
        case 'usage':
          this.reportUsage(event.usage, progress, request);
          break;
      }
    }
    return reasoning;
  }

  private reportThinking(
    text: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    const ctor = (vscode as Record<string, unknown>).LanguageModelThinkingPart as
      | (new (value: string) => vscode.LanguageModelResponsePart)
      | undefined;
    if (typeof ctor === 'function') {
      progress.report(new ctor(text));
    }
  }

  private reportToolCall(
    id: string,
    name: string,
    args: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    let input: object = {};
    try {
      input = args.trim() ? (JSON.parse(args) as object) : {};
    } catch {
      input = {};
    }
    progress.report(new vscode.LanguageModelToolCallPart(id, name, input));
  }

  private reportUsage(
    usage: ChatUsage,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    request: AdapterRequest,
  ): void {
    const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
    const data = {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      prompt_tokens_details: { cached_tokens: cached },
    };
    try {
      progress.report(
        new vscode.LanguageModelDataPart(
          new TextEncoder().encode(JSON.stringify(data)),
          USAGE_DATA_PART_MIME,
        ),
      );
    } catch {
      // Usage reporting is best-effort.
    }
    void request;
  }
}
