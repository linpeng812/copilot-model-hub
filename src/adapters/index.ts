import { AdapterRouter } from '../provider/router';
import { ChatCompletionsAdapter } from './chat/adapter';
import { AnthropicMessagesAdapter } from './anthropic/adapter';
import { ResponsesAdapter } from './responses/adapter';

/**
 * Registers all implemented protocol adapters on the router: chat, anthropic,
 * responses.
 */
export function registerAdapters(router: AdapterRouter): void {
  router.register(new ChatCompletionsAdapter());
  router.register(new AnthropicMessagesAdapter());
  router.register(new ResponsesAdapter());
}
