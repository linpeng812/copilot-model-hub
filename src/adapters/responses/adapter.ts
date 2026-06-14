import * as vscode from 'vscode';
import { AdapterRequest, ProtocolAdapter } from '../types';
import { postStream, isAbortError } from '../../shared/http';
import { UpstreamError } from '../../shared/errors';
import { getLogger } from '../../runtime/logger';
import { buildRequestBody } from './request';
import { ResponsesStreamParser, ResponsesUsage } from './stream';
import { InlineThinkDetector } from '../../shared/inline-think';
import { createReplayMarkerPart, hasReplayMarkerMetadata } from '../../provider/replay';

const USAGE_DATA_PART_MIME = 'usage';

/** OpenAI Responses API adapter (native path). */
export class ResponsesAdapter implements ProtocolAdapter {
  readonly protocol = 'responses' as const;

  async send(request: AdapterRequest): Promise<void> {
    const { connection, messages, options, progress, token } = request;
    const log = getLogger();
    const isThinking = connection.capabilities?.thinking === true;

    const body = buildRequestBody(connection, messages, options);

    const parser = new ResponsesStreamParser((line, err) =>
      log.error(`Failed to parse responses SSE event: ${String(err)} :: ${line.slice(0, 200)}`),
    );
    // Some models inline reasoning as <think> in normal content rather than
    // using reasoning events; this detector recovers it without leaking tags.
    const inlineThink = new InlineThinkDetector();
    let accumulatedReasoning = '';

    try {
      const reader = await postStream({
        connection,
        apiKey: request.apiKey,
        path: '/responses',
        auth: 'bearer',
        body,
        token,
      });

      const decoder = new TextDecoder();
      for (;;) {
        if (token.isCancellationRequested) return;
        const { done, value } = await reader.read();
        if (done) break;
        accumulatedReasoning += this.report(
          parser.push(decoder.decode(value, { stream: true })),
          inlineThink,
          progress,
        );
      }
      accumulatedReasoning += this.report(parser.end(), inlineThink, progress);
      // Flush any reasoning/text still buffered by the inline-think detector.
      accumulatedReasoning += this.emitInlineThink(inlineThink.end(), progress);

      if (isThinking && accumulatedReasoning) {
        const metadata = { reasoningText: accumulatedReasoning };
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

  /** Returns reasoning text seen (for the replay marker). */
  private report(
    events: ReturnType<ResponsesStreamParser['push']>,
    inlineThink: InlineThinkDetector,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): string {
    let reasoning = '';
    for (const event of events) {
      switch (event.kind) {
        case 'content':
          // Route content through the inline-think detector.
          reasoning += this.emitInlineThink(inlineThink.push(event.text), progress);
          break;
        case 'thinking':
          reasoning += event.text;
          this.reportThinking(event.text, progress);
          break;
        case 'toolCall':
          this.reportToolCall(event.callId, event.name, event.arguments, progress);
          break;
        case 'usage':
          this.reportUsage(event.usage, progress);
          break;
        case 'error':
          throw new UpstreamError(event.message);
      }
    }
    return reasoning;
  }

  private emitInlineThink(
    emits: ReturnType<InlineThinkDetector['push']>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): string {
    let reasoning = '';
    for (const emit of emits) {
      if (emit.kind === 'reasoning') {
        reasoning += emit.text;
        this.reportThinking(emit.text, progress);
      } else {
        progress.report(new vscode.LanguageModelTextPart(emit.text));
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
    if (typeof ctor === 'function') progress.report(new ctor(text));
  }

  private reportToolCall(
    callId: string,
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
    progress.report(new vscode.LanguageModelToolCallPart(callId, name, input));
  }

  private reportUsage(
    usage: ResponsesUsage,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    const data = {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      prompt_tokens_details: { cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0 },
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
