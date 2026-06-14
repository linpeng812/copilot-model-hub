// Minimal `vscode` stand-in for unit tests. Only the classes/enums our pure
// logic touches are implemented; everything else is intentionally absent so a
// test that needs more fails loudly rather than silently passing.

class LanguageModelTextPart {
  constructor(public value: string) {}
}

class LanguageModelToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: unknown,
  ) {}
}

class LanguageModelToolResultPart {
  constructor(
    public callId: string,
    public content: unknown[],
  ) {}
}

class LanguageModelDataPart {
  constructor(
    public data: Uint8Array,
    public mimeType: string,
  ) {}
}

class LanguageModelThinkingPart {
  constructor(public value: string | string[]) {}
}

class ThemeIcon {
  constructor(public id: string) {}
}

enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
  System = 3,
}

enum LanguageModelChatToolMode {
  Auto = 1,
  Required = 2,
}

class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(data: T) {
    for (const l of this.listeners) l(data);
  }
  dispose() {
    this.listeners = [];
  }
}

export {
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelDataPart,
  LanguageModelThinkingPart,
  ThemeIcon,
  EventEmitter,
  LanguageModelChatMessageRole,
  LanguageModelChatToolMode,
};

export default {
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelDataPart,
  LanguageModelThinkingPart,
  ThemeIcon,
  EventEmitter,
  LanguageModelChatMessageRole,
  LanguageModelChatToolMode,
};
