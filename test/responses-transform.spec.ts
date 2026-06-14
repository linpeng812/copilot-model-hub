import { describe, it, expect } from 'vitest';
import {
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelDataPart,
  LanguageModelChatMessageRole as Role,
  LanguageModelChatToolMode as ToolMode,
} from './mocks/vscode';
import {
  buildRequestBody,
  convertMessages,
  convertTools,
  mapReasoningEffort,
} from '../src/adapters/responses/request';
import { createReplayMarkerPart } from '../src/provider/replay';
import { ModelConnection } from '../src/config/types';

const conn = (overrides: Partial<ModelConnection> = {}): ModelConnection => ({
  id: 'gpt',
  name: 'GPT',
  protocol: 'responses',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-x',
  secretKey: 'k',
  ...overrides,
});

const msg = (role: number, content: unknown[]) => ({ role, content }) as never;
const options = (tools?: unknown[], toolMode = ToolMode.Auto) => ({ tools, toolMode }) as never;

describe('mapReasoningEffort', () => {
  it('passes through known efforts', () => {
    for (const e of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(mapReasoningEffort(e)).toBe(e);
    }
  });

  it('treats none/off/disabled as no reasoning object', () => {
    expect(mapReasoningEffort('none')).toBeUndefined();
    expect(mapReasoningEffort('off')).toBeUndefined();
    expect(mapReasoningEffort('disabled')).toBeUndefined();
  });

  it('drops unknown efforts', () => {
    expect(mapReasoningEffort('turbo')).toBeUndefined();
    expect(mapReasoningEffort(undefined)).toBeUndefined();
  });

  it('is case and whitespace insensitive', () => {
    expect(mapReasoningEffort('  HIGH ')).toBe('high');
  });
});

describe('responses convertMessages', () => {
  it('routes system text to instructions', () => {
    const { instructions, input } = convertMessages(
      [
        msg(Role.System, [new LanguageModelTextPart('be terse')]),
        msg(Role.User, [new LanguageModelTextPart('hi')]),
      ],
      false,
    );
    expect(instructions).toBe('be terse');
    expect(input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
  });

  it('maps assistant text to an output_text message item', () => {
    const { input } = convertMessages(
      [msg(Role.Assistant, [new LanguageModelTextPart('done')])],
      false,
    );
    expect(input).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    ]);
  });

  it('maps tool calls to function_call items with canonical arguments', () => {
    const { input } = convertMessages(
      [msg(Role.Assistant, [new LanguageModelToolCallPart('c1', 'lookup', { b: 2, a: 1 })])],
      false,
    );
    expect(input).toEqual([
      { type: 'function_call', call_id: 'c1', name: 'lookup', arguments: '{"a":1,"b":2}' },
    ]);
  });

  it('maps tool results to function_call_output items', () => {
    const { input } = convertMessages(
      [msg(Role.User, [new LanguageModelToolResultPart('c1', [new LanguageModelTextPart('ok')])])],
      false,
    );
    expect(input).toEqual([{ type: 'function_call_output', call_id: 'c1', output: 'ok' }]);
  });

  it('inserts a reasoning item before the assistant turn (text marker)', () => {
    const marker = createReplayMarkerPart({ reasoningText: 'I reasoned' });
    const { input } = convertMessages(
      [
        msg(Role.Assistant, [
          new LanguageModelDataPart(marker.data, marker.mimeType),
          new LanguageModelTextPart('answer'),
        ]),
      ],
      true,
    );
    expect(input[0]).toEqual({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'I reasoned' }],
    });
    expect(input[1]).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'answer' }],
    });
  });

  it('replays a verbatim reasoning item when present in the marker', () => {
    const raw = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'r' }] };
    const marker = createReplayMarkerPart({ raw });
    const { input } = convertMessages(
      [msg(Role.Assistant, [new LanguageModelDataPart(marker.data, marker.mimeType), new LanguageModelTextPart('a')])],
      true,
    );
    expect(input[0]).toEqual(raw);
  });

  it('does not replay reasoning for non-thinking models', () => {
    const marker = createReplayMarkerPart({ reasoningText: 'r' });
    const { input } = convertMessages(
      [msg(Role.Assistant, [new LanguageModelDataPart(marker.data, marker.mimeType), new LanguageModelTextPart('a')])],
      false,
    );
    expect(input).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
    ]);
  });
});

describe('responses convertTools', () => {
  it('produces flat function tool definitions', () => {
    expect(
      convertTools([{ name: 'f', description: 'd', inputSchema: { type: 'object' } }] as never),
    ).toEqual([{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object' } }]);
  });

  it('returns undefined for empty tools', () => {
    expect(convertTools(undefined)).toBeUndefined();
    expect(convertTools([] as never)).toBeUndefined();
  });
});

describe('responses buildRequestBody', () => {
  it('builds a minimal streaming request', () => {
    const body = buildRequestBody(conn(), [msg(Role.User, [new LanguageModelTextPart('hi')])], options());
    expect(body.model).toBe('gpt-x');
    expect(body.stream).toBe(true);
    expect(body.input).toHaveLength(1);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it('uses max_output_tokens, not max_tokens', () => {
    const body = buildRequestBody(
      conn({ request: { maxTokens: 2048 } }),
      [msg(Role.User, [new LanguageModelTextPart('hi')])],
      options(),
    );
    expect(body.max_output_tokens).toBe(2048);
    expect((body as unknown as Record<string, unknown>).max_tokens).toBeUndefined();
  });

  it('omits tool_choice when no tools are present (strict-upstream defense)', () => {
    const body = buildRequestBody(
      conn(),
      [msg(Role.User, [new LanguageModelTextPart('hi')])],
      options(undefined, ToolMode.Required),
    );
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it('sends tool_choice required when tools are present and required', () => {
    const body = buildRequestBody(
      conn(),
      [msg(Role.User, [new LanguageModelTextPart('hi')])],
      options([{ name: 'f', inputSchema: {} }], ToolMode.Required),
    );
    expect(body.tool_choice).toBe('required');
  });

  it('sends a reasoning object for thinking models', () => {
    const body = buildRequestBody(
      conn({ capabilities: { thinking: true }, thinking: { type: 'openai-reasoning', defaultEffort: 'medium' } }),
      [msg(Role.User, [new LanguageModelTextPart('hi')])],
      options(),
    );
    expect(body.reasoning).toEqual({ effort: 'medium' });
  });

  it('omits reasoning when effort resolves to off', () => {
    const body = buildRequestBody(
      conn({ capabilities: { thinking: true }, thinking: { defaultEffort: 'none' } }),
      [msg(Role.User, [new LanguageModelTextPart('hi')])],
      options(),
    );
    expect(body.reasoning).toBeUndefined();
  });
});
