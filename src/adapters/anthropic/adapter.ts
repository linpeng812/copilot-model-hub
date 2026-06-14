import * as vscode from 'vscode';
import { AdapterRequest, ProtocolAdapter } from '../types';
import { postStream, isAbortError } from '../../shared/http';
import { UpstreamError } from '../../shared/errors';
import { getLogger } from '../../runtime/logger';
import { buildRequestBody } from './request';
import { AnthropicStreamParser, AnthropicUsage } from './stream';
import { createReplayMarkerPart, hasReplayMarkerMetadata } from '../../provider/replay';
import { versionedPath } from '../../shared/url';

const USAGE_DATA_PART_MIME = 'usage';
const ANTHROPIC_VERSION = '2023-06-01';

/** Anthropic Messages adapter. */
export class AnthropicMessagesAdapter implements ProtocolAdapter {
  readonly protocol = 'anthropic' as const;

  async send(request: AdapterRequest): Promise<void> {
    const { connection, messages, options, progress, token } = request;
    const log = getLogger();
    const isThinking = connection.capabilities?.thinking === true;

    const body = buildRequestBody(connection, messages, options);

    const headers: Record<string, string> = {
      'anthropic-version': connection.headers?.['anthropic-version'] ?? ANTHROPIC_VERSION,
    };

    const parser = new AnthropicStreamParser((line, err) =>
      log.error(`Failed to parse anthropic SSE event: ${String(err)} :: ${line.slice(0, 200)}`),
    );

    try {
      const reader = await postStream({
        connection,
        apiKey: request.apiKey,
        // Anthropic gateways expect /v1/messages; tolerate base URLs that
        // already include /v1 (don't double it) and those that omit it.
        path: versionedPath(connection.baseUrl, '/messages'),
        auth: 'x-api-key',
        headers,
        body,
        token,
      });

      const decoder = new TextDecoder();
      for (;;) {
        if (token.isCancellationRequested) return;
        const { done, value } = await reader.read();
        if (done) break;
        this.report(parser.push(decoder.decode(value, { stream: true })), progress);
      }
      this.report(parser.end(), progress);

      // Persist the thinking blocks (with signatures) for cross-turn replay.
      if (isThinking) {
        const blocks = parser.thinkingBlocks();
        const metadata = { raw: blocks.length > 0 ? blocks : undefined };
        if (hasReplayMarkerMetadata(metadata)) {
          try {
            progress.report(createReplayMarkerPart(metadata));
          } catch (err) {
            log.warn(`Failed to report replay marker: ${String(err)}`);
          }
        }
      }
    } catch (err) {
      if (isAbortError(err) && token.isCancellationRequested) return;
      throw err;
    }
  }

  private report(
    events: ReturnType<AnthropicStreamParser['push']>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    for (const event of events) {
      switch (event.kind) {
        case 'content':
          progress.report(new vscode.LanguageModelTextPart(event.text));
          break;
        case 'thinking':
          this.reportThinking(event.text, progress);
          break;
        case 'toolCall':
          this.reportToolCall(event.id, event.name, event.arguments, progress);
          break;
        case 'usage':
          this.reportUsage(event.usage, progress);
          break;
        case 'error':
          throw new UpstreamError(event.message);
      }
    }
  }

  private reportThinking(
    text: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    const ctor = (vscode as Record<string, unknown>).LanguageModelThinkingPart as
      | (new (value: string) => vscode.LanguageModelResponsePart)
      | undefined;
    if (typeof ctor === 'function') progress.report(new ctor(text));
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
    usage: AnthropicUsage,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    const data = {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      prompt_tokens_details: { cached_tokens: usage.cache_read_input_tokens ?? 0 },
    };
    try {
      progress.report(
        new vscode.LanguageModelDataPart(
          new TextEncoder().encode(JSON.stringify(data)),
          USAGE_DATA_PART_MIME,
        ),
      );
    } catch {
      // best-effort
    }
  }
}
