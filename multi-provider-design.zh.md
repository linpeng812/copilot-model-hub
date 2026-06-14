# 多服务商多模型接入 Copilot Chat 设计文档

## 采用方案

本项目采用以下最终方案：

```text
一个统一 VS Code vendor
一个集中 connections 配置
API Key 使用 SecretStorage
内部多协议 adapter
代理服务作为 chat 协议的一种后端
```

该方案的核心判断是：VS Code/Copilot Chat 侧只需要看到一个语言模型提供者，插件内部再根据用户配置把不同模型请求路由到不同服务商和协议。

这样用户理解成本最低：

```text
name + protocol + baseUrl + model + apiKey
```

同时插件内部仍然能精确支持：

- OpenAI Chat Completions compatible
- OpenAI Responses API
- Anthropic Messages compatible
- DeepSeek reasoning
- Copilot Chat tool calling
- vision proxy
- 模型选择器中的 per-model 配置

## 目标

本设计文档用于指导当前 DeepSeek 单服务商扩展改造成多服务商、多模型 Copilot Chat 插件。

目标：

- 用户可以在一个集中配置里添加多个模型连接。
- 每个连接只需要配置 `baseUrl`、`model`、`protocol`、`name` 和 API Key。
- API Key 不写入 `settings.json`，统一使用 VS Code `SecretStorage`。
- 模型统一出现在 Copilot Chat 的模型选择器中。
- 内部通过 adapter 支持不同协议，而不是强行把所有协议压成一种格式。
- OpenRouter、LiteLLM、OneAPI、new-api、自建网关等代理服务通过 `chat` 协议接入。

## 核心概念

### vendor

`vendor` 是 VS Code 用来识别语言模型提供者的供应商 ID。

本方案只注册一个统一 vendor：

```text
vendor = copilot-model-hub
displayName = Copilot Model Hub
```

运行时注册：

```ts
vscode.lm.registerLanguageModelChatProvider('copilot-model-hub', provider);
```

`vendor` 不代表真实上游服务商。真实服务商由用户的 `connections` 配置决定。

示例：

```text
VS Code vendor: copilot-model-hub
connection: deepseek-pro -> https://api.deepseek.com
connection: claude-main -> https://api.anthropic.com/v1
connection: openrouter-qwen -> https://openrouter.ai/api/v1
```

采用统一 vendor 的原因：

- `package.json` 里的 `languageModelChatProviders` 更适合静态声明。
- 用户后续可以动态添加未知服务商，不需要扩展提前声明每个 vendor。
- 插件只需要维护一个 `LanguageModelChatProvider`。
- 模型来源可以通过模型名称、detail、配置 UI 展示。

### connection

`connection` 是用户配置的一个模型连接。

一个 connection 包含：

```text
显示名称
协议类型
Base URL
模型名
密钥引用
能力声明
上下文限制
额外请求头
```

每个 connection 最终会映射成 Copilot Chat 模型选择器中的一个模型。

### protocol

`protocol` 表示上游接口协议，而不是服务商品牌。

支持三类协议：

| protocol | 含义 | 默认请求路径 |
| --- | --- | --- |
| `chat` | OpenAI Chat Completions compatible | `/chat/completions` |
| `responses` | OpenAI Responses API | `/responses` |
| `anthropic` | Anthropic Messages compatible | `/messages` |

代理服务作为 `chat` 协议的一种后端接入。

例如：

```json
{
  "protocol": "chat",
  "baseUrl": "https://openrouter.ai/api/v1",
  "model": "qwen/qwen3-coder"
}
```

最终请求：

```text
POST https://openrouter.ai/api/v1/chat/completions
```

## 用户配置格式

集中设置项使用项目命名空间：

```text
copilotModelHub.connections
```

不再沿用旧的 `deepseek-copilot` 命名空间——从多服务商产品语义看，统一用 `copilotModelHub` 更清晰。从旧扩展迁移时，可在激活时检测旧键并提示用户迁移。

### settings.json 示例

下例显式写出了 `secretKey` 以便说明其形态；实际使用中可省略，由 id 自动推导。`thinking`/`request`/`pricing` 等可选字段按需出现。

```json
{
  "copilotModelHub.connections": [
    {
      "id": "deepseek-pro",
      "name": "DeepSeek V4 Pro",
      "protocol": "chat",
      "baseUrl": "https://api.deepseek.com",
      "model": "deepseek-v4-pro",
      "secretKey": "copilotModelHub.connection.deepseek-pro.apiKey",
      "capabilities": {
        "tools": true,
        "vision": false,
        "thinking": true
      },
      "context": {
        "input": 655360,
        "output": 393216
      },
      "thinking": {
        "type": "deepseek",
        "defaultEffort": "high",
        "efforts": ["none", "high", "max"]
      }
    },
    {
      "id": "openai-main",
      "name": "OpenAI Main",
      "protocol": "responses",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-example",
      "secretKey": "copilotModelHub.connection.openai-main.apiKey",
      "capabilities": {
        "tools": true,
        "vision": true,
        "thinking": true
      },
      "context": {
        "input": 400000,
        "output": 128000
      },
      "thinking": {
        "type": "openai-reasoning",
        "defaultEffort": "medium",
        "efforts": ["low", "medium", "high"]
      }
    },
    {
      "id": "claude-main",
      "name": "Claude Main",
      "protocol": "anthropic",
      "baseUrl": "https://api.anthropic.com/v1",
      "model": "claude-example",
      "secretKey": "copilotModelHub.connection.claude-main.apiKey",
      "headers": {
        "anthropic-version": "2023-06-01"
      },
      "capabilities": {
        "tools": true,
        "vision": true,
        "thinking": true
      },
      "context": {
        "input": 200000,
        "output": 64000
      },
      "thinking": {
        "type": "anthropic-thinking",
        "defaultBudgetTokens": 12000,
        "budgetTokenOptions": [0, 4000, 12000, 32000]
      }
    },
    {
      "id": "openrouter-qwen",
      "name": "Qwen via OpenRouter",
      "protocol": "chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "model": "qwen/qwen3-coder",
      "secretKey": "copilotModelHub.connection.openrouter-qwen.apiKey",
      "headers": {
        "HTTP-Referer": "vscode://copilot-model-hub",
        "X-Title": "Copilot Model Hub"
      },
      "capabilities": {
        "tools": true,
        "vision": false,
        "thinking": false
      },
      "context": {
        "input": 262144,
        "output": 65536
      }
    }
  ]
}
```

## 配置字段

### 必填字段

| 字段 | 说明 |
| --- | --- |
| `id` | 连接 ID，必须稳定且唯一。**只允许小写字母、数字、短横线**（见下方 id 规则）。 |
| `name` | 显示在 Copilot Chat 模型选择器中的名称。 |
| `protocol` | 上游协议，支持 `chat`、`responses`、`anthropic`。 |
| `baseUrl` | 服务商基础 URL，不包含协议路径。规范化规则见下方“baseUrl 规范化”。 |
| `model` | 发送给上游服务商的真实模型名。 |

### 可选字段

| 字段 | 说明 |
| --- | --- |
| `secretKey` | `SecretStorage` 中保存 API Key 的 key。**省略时自动取** `copilotModelHub.connection.{id}.apiKey`。仅当需要多个连接共享同一把 key 时才需要显式指定。 |
| `headers` | 附加 HTTP 请求头。不能覆盖 `Authorization` 和 `Content-Type`。 |
| `capabilities` | 模型能力声明，影响 Copilot Chat 工具、图片、thinking 配置。 |
| `context` | 模型上下文长度和最大输出 token。 |
| `request` | 请求默认参数，如 `temperature`、`maxTokens`、`timeoutMs`。 |
| `thinking` | thinking/reasoning 配置。**仅在 `capabilities.thinking=true` 时生效**。 |
| `pricing` | 可选价格信息，用于模型选择器展示。 |

此外有一个**全局**（非 per-connection）设置 `copilotModelHub.visionDescriber`，用于指定纯文本连接收到图片时用哪个连接做降级描述，详见“Vision 降级”一节。

### id 规则

- 字符集：`^[a-z0-9][a-z0-9-]*$`，即只允许小写字母、数字、短横线，且以字母或数字开头。
- **不允许 `.` 和 `_`**：因为自动生成的 secretKey（`copilotModelHub.connection.{id}.apiKey`）以 `.` 分段，id 内含 `.` 会破坏解析；model id 也可能加 `.` 前缀。
- id 一旦被用户选用就应稳定，重命名等同于新建连接（旧 key 需手动迁移）。

### secretKey 与 id 的关系

- 默认：`secretKey` 不写，运行时由 id 推导，UI 添加连接时只让用户输入 API Key 并存到推导出的 key。
- 高级：显式写 `secretKey` 让多个连接复用同一把 key。
- 因此 schema 中 `secretKey` **不是必填**，只有 id/name/protocol/baseUrl/model 必填。

### baseUrl 规范化

Registry 加载时统一规范化，规则明确为：

- 去除末尾所有 `/`（`https://x/v1/` → `https://x/v1`）。
- adapter 拼接路径时固定加单个前导 `/`（`{baseUrl}/chat/completions`），避免重复斜杠。
- **是否包含 `/v1` 由用户决定**，插件不自动增删。OpenAI 系一般要 `/v1`，DeepSeek 用根域名，Anthropic 兼容网关各异。
- 必须是 `http`/`https` 合法 URL，否则该连接判定为无效。

### capabilities.thinking 与 thinking 对象

- `capabilities.thinking=false`（默认）：忽略 `thinking` 对象，模型选择器不显示 thinking 控件，请求不带 reasoning 参数。
- `capabilities.thinking=true` 且有 `thinking` 对象：按对象配置暴露控件并发送 reasoning 参数。
- `capabilities.thinking=true` 但缺 `thinking` 对象：按协议默认值处理（如 anthropic 用 `defaultBudgetTokens` 缺省、chat 用 `none`），不报错。

### capabilities

```json
{
  "tools": true,
  "vision": false,
  "thinking": true
}
```

默认值：

```json
{
  "tools": true,
  "vision": false,
  "thinking": false
}
```

字段含义：

| 字段 | 含义 |
| --- | --- |
| `tools` | 是否允许向上游发送工具定义。 |
| `vision` | 是否支持直接图片输入。 |
| `thinking` | 是否在模型选择器中暴露 thinking/reasoning 配置。 |

### context

```json
{
  "input": 128000,
  "output": 64000
}
```

映射到：

```text
LanguageModelChatInformation.maxInputTokens
LanguageModelChatInformation.maxOutputTokens
```

如果用户没有配置，插件应提供保守默认值。

### request

```json
{
  "temperature": 0.2,
  "topP": 1,
  "maxTokens": 0,
  "timeoutMs": 120000,
  "maxRetries": 1
}
```

说明：

- `maxTokens: 0` 表示不显式限制输出。
- adapter 负责把内部字段映射到目标协议字段。
- 例如 `topP` 在 OpenAI Chat Completions 中映射为 `top_p`。

### thinking

不同协议的 thinking/reasoning 参数差异较大，因此使用可选配置对象。

DeepSeek:

```json
{
  "type": "deepseek",
  "defaultEffort": "high",
  "efforts": ["none", "high", "max"]
}
```

OpenAI Responses:

```json
{
  "type": "openai-reasoning",
  "defaultEffort": "medium",
  "efforts": ["low", "medium", "high"]
}
```

Anthropic:

```json
{
  "type": "anthropic-thinking",
  "defaultBudgetTokens": 12000,
  "budgetTokenOptions": [0, 4000, 12000, 32000]
}
```

## package.json 设计

### 统一 vendor 声明

```json
{
  "contributes": {
    "languageModelChatProviders": [
      {
        "vendor": "copilot-model-hub",
        "displayName": "Copilot Model Hub"
      }
    ]
  }
}
```

### connections 设置声明

```json
{
  "contributes": {
    "configuration": {
      "title": "Copilot Model Hub",
      "properties": {
        "copilotModelHub.connections": {
          "type": "array",
          "default": [],
          "markdownDescription": "Configure custom model connections for Copilot Chat. API keys are stored separately in VS Code SecretStorage.",
          "items": {
            "type": "object",
            "required": ["id", "name", "protocol", "baseUrl", "model"],
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z0-9][a-z0-9-]*$",
                "description": "Unique connection ID. Lowercase letters, digits and hyphens only."
              },
              "name": {
                "type": "string",
                "description": "Display name in the Copilot Chat model picker."
              },
              "protocol": {
                "type": "string",
                "enum": ["chat", "responses", "anthropic"],
                "enumDescriptions": [
                  "OpenAI-compatible Chat Completions API.",
                  "OpenAI Responses API.",
                  "Anthropic-compatible Messages API."
                ]
              },
              "baseUrl": {
                "type": "string",
                "description": "Provider base URL, for example https://api.openai.com/v1."
              },
              "model": {
                "type": "string",
                "description": "Provider model name."
              },
              "secretKey": {
                "type": "string",
                "description": "Optional. SecretStorage key for the API key. Defaults to copilotModelHub.connection.{id}.apiKey."
              },
              "headers": {
                "type": "object",
                "additionalProperties": {
                  "type": "string"
                }
              },
              "capabilities": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "tools": {
                    "type": "boolean",
                    "default": true
                  },
                  "vision": {
                    "type": "boolean",
                    "default": false
                  },
                  "thinking": {
                    "type": "boolean",
                    "default": false
                  }
                }
              },
              "context": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "input": {
                    "type": "number",
                    "minimum": 1
                  },
                  "output": {
                    "type": "number",
                    "minimum": 1
                  }
                }
              },
              "request": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "temperature": { "type": "number" },
                  "topP": { "type": "number" },
                  "maxTokens": { "type": "number", "minimum": 0 },
                  "timeoutMs": { "type": "number", "minimum": 1 },
                  "maxRetries": { "type": "number", "minimum": 0 }
                }
              },
              "thinking": {
                "type": "object",
                "description": "Thinking/reasoning config. Only used when capabilities.thinking is true."
              },
              "pricing": {
                "type": "object",
                "description": "Optional pricing info shown in the model picker."
              }
            }
          }
        }
      }
    }
  }
}
```

## SecretStorage 设计

API Key 不进入 `settings.json`。

保存：

```ts
await context.secrets.store(secretKey, apiKey);
```

读取：

```ts
const apiKey = await context.secrets.get(secretKey);
```

删除：

```ts
await context.secrets.delete(secretKey);
```

推荐自动生成 secret key：

```text
copilotModelHub.connection.{connectionId}.apiKey
```

用户添加连接时，UI 只需要让用户输入 API Key。保存时：

```text
连接元数据 -> VS Code Settings
API Key -> SecretStorage
```

## VS Code 设置作用域

VS Code Settings 可以存在多个作用域：

| 作用域 | 说明 |
| --- | --- |
| User Settings | 全局用户设置，适合个人常用模型。 |
| Workspace Settings | 当前工作区设置，适合项目专用代理或团队共享模型配置。 |
| Folder Settings | 多根工作区中的单个文件夹设置。 |
| Remote Settings | 远程环境设置。 |

建议：

- `connections` 可以根据用户选择写入 User 或 Workspace。
- API Key 始终写入 SecretStorage。
- 如果连接写入 Workspace，需要提醒用户不要把敏感 header 写入 Git。

## 内部类型设计

```ts
export type ConnectionProtocol = 'chat' | 'responses' | 'anthropic';

export interface ModelConnection {
  id: string;
  name: string;
  protocol: ConnectionProtocol;
  baseUrl: string;
  model: string;
  secretKey: string;
  headers?: Record<string, string>;
  capabilities?: ModelCapabilities;
  context?: ModelContext;
  request?: RequestDefaults;
  thinking?: ThinkingConfig;
  pricing?: PricingConfig;
}

export interface ModelCapabilities {
  tools?: boolean;
  vision?: boolean;
  thinking?: boolean;
}

export interface ModelContext {
  input?: number;
  output?: number;
}

export interface RequestDefaults {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
}
```

模型 ID 映射：

```text
VS Code model id = connection.id
Upstream model = connection.model
```

**决定：直接使用 `connection.id` 作为 VS Code model id，不加前缀。**

- id 已通过 `^[a-z0-9][a-z0-9-]*$` 保证唯一且合法，无需前缀防冲突。
- 因为 vendor 是独立的 `copilot-model-hub`，model id 只需在本 vendor 内唯一，不会与其他扩展的模型冲突。
- `getByModelId(modelId)` 直接用 `modelId === connection.id` 查找，无需剥前缀，降低出错面。
- 若未来确实需要前缀，应在 Registry 一处集中加/剥，provider 其余部分只认 `connection.id`。

## 总体架构

```text
Copilot Chat
  |
  v
VS Code LanguageModelChatProvider
  |
  v
Connection Registry
  |
  v
Secret Manager
  |
  v
Request Classifier / Vision 降级 / Replay 还原   （adapter 之上的编排层）
  |
  v
Protocol Adapter Router
  |-- ChatCompletionsAdapter
  |-- ResponsesAdapter
  |-- AnthropicMessagesAdapter
  |
  v
HTTP Client（含 error normalize）
  |
  v
Third-party Model API
```

## 模块职责

### Connection Registry

职责：

- 读取 `copilotModelHub.connections`。
- 校验连接配置。
- 规范化 `baseUrl`。
- 检查重复 `id`。
- 根据 VS Code model id 查找 connection。
- 监听配置变化，触发模型选择器刷新。

建议 API：

```ts
interface ConnectionRegistry {
  list(): ModelConnection[];
  getByModelId(modelId: string): ModelConnection | undefined;
  reload(): void;
}
```

### Secret Manager

职责：

- 保存 API Key。
- 读取 API Key。
- 删除 API Key。
- 监听 SecretStorage 变化后刷新模型状态。

如果某个 connection 没有 API Key，应仍然显示在模型选择器中，但带 warning 状态，提示用户配置 key。

### LanguageModelChatProvider

职责：

- 注册统一 vendor：`copilot-model-hub`。
- 在 `provideLanguageModelChatInformation` 中返回所有连接对应的模型信息。
- 在 `provideLanguageModelChatResponse` 中根据 `modelInfo.id` 找到 connection。
- 读取 API Key。
- 根据 `connection.protocol` 选择 adapter。
- 将 adapter 的流式输出转回 VS Code response parts。

### Protocol Adapter Router

职责：

- 根据 `protocol` 找到 adapter。
- 统一处理 adapter 不存在、配置错误、鉴权缺失等错误。

```ts
function getAdapter(protocol: ConnectionProtocol): ProtocolAdapter {
  switch (protocol) {
    case 'chat':
      return chatCompletionsAdapter;
    case 'responses':
      return responsesAdapter;
    case 'anthropic':
      return anthropicMessagesAdapter;
  }
}
```

## Adapter 接口

```ts
export interface ProtocolAdapter {
  readonly protocol: ConnectionProtocol;

  streamChat(options: AdapterStreamOptions): Promise<void>;
}

export interface AdapterStreamOptions {
  connection: ModelConnection;
  apiKey: string;
  messages: readonly vscode.LanguageModelChatRequestMessage[];
  tools: readonly vscode.LanguageModelChatTool[] | undefined;
  modelOptions: vscode.ProvideLanguageModelChatResponseOptions;
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  token: vscode.CancellationToken;
  // 注：thinking 回放还需要 replayState 字段，完整定义见“thinking 跨轮回放”一节。
}
```

Adapter 必须负责：

- 构造目标协议请求体。
- 转换 VS Code message。
- 转换 VS Code tool definitions。
- 解析上游流式响应。
- 报告文本内容。
- 报告工具调用。
- 报告 thinking/reasoning 内容。
- 还原历史 thinking/reasoning（见“thinking 跨轮回放”一节）。
- 报告 usage 信息（用于 token 校准）。
- 处理取消请求（`AbortController` + `CancellationToken`）。
- 将上游 HTTP/网络错误归一化为不泄露密钥的友好错误（见“错误归一化”一节）。

## 协议适配

### ChatCompletionsAdapter

协议：

```text
OpenAI Chat Completions compatible
```

请求：

```text
POST {baseUrl}/chat/completions
```

请求体示例：

```json
{
  "model": "model-name",
  "messages": [],
  "stream": true,
  "tools": [],
  "tool_choice": "auto"
}
```

流式解析：

- `choices[].delta.content`
- `choices[].delta.tool_calls`
- `choices[].delta.reasoning_content`
- `usage`
- `[DONE]`

实现注意事项：

- 必须在请求体中带 `stream_options: { include_usage: true }`，否则部分上游不会在流里返回 usage，导致无法做 token 校准。
- 部分 OpenAI 兼容网关会在每个 chunk 都带 `usage`，应只保留最后一次的值，在流结束（`[DONE]` 或 reader 关闭）时上报一次。
- `tool_calls` 是增量分片，必须按 `tool_calls[].index` 累积 `id`、`function.name`、`function.arguments`，在 `finish_reason` 为 `tool_calls` 或 `stop` 时再 flush。
- 行缓冲要跨 chunk 处理：按 `\n` 切分后，最后一段可能是半行，需保留到下一次 `read` 拼接，避免 JSON 解析失败。
- 单个 chunk 解析失败应记录日志并跳过，不应中断整个流。
- `reasoning_content` 字段名各家不一致（`reasoning_content` / `reasoning`），adapter 应做兼容映射，统一转成 VS Code 的 thinking part。

适用：

- DeepSeek
- OpenRouter
- LiteLLM
- OneAPI
- new-api
- OpenAI-compatible 自建代理

### ResponsesAdapter

协议：

```text
OpenAI Responses API
```

请求：

```text
POST {baseUrl}/responses
```

Responses API 与 Chat Completions 是**两套独立的数据模型**，不能复用 Chat 的请求体。本节的转换规则参考 `cc-switch` 项目经过实战验证的 Responses ↔ Chat Completions 双向转换实现（`transform_codex_chat.rs` / `streaming_codex_chat.rs`），把其中与协议相关、与 Codex 无关的通用经验提炼出来。

#### 两种实现路径

VS Code 侧给 adapter 的是统一的 `LanguageModelChatRequestMessage`。ResponsesAdapter 有两条路：

- **路径 A（推荐，原生）**：直接把 VS Code messages 构造成 Responses 的 `input` 项数组，发 `/responses`，解析 Responses SSE 事件。
- **路径 B（复用 chat 层）**：若上游实际只认 Chat Completions，可把请求降级转换成 chat 请求体走 `/chat/completions`，再把 chat 响应/流**反向**组装回 Responses 形态。`cc-switch` 走的是 B，因此积累了双向转换的完整规则——这些规则对路径 A 的“消息/工具如何映射”同样适用。

#### 请求转换（messages → Responses input）

Responses 的 `input` 是有类型的项序列，不是 chat 的 `messages`。关键映射：

| 来源 | Responses input 项 |
| --- | --- |
| system / 指令 | 顶层 `instructions` 字段（不是 input 项） |
| user / assistant 文本 | `{type:"message", role, content:[{type:"input_text"/"output_text"}]}` |
| 图片 | content part `{type:"input_image", image_url}` |
| 文件 | `{type:"input_file", file_id/file_data/filename}` |
| 工具调用 | `{type:"function_call", call_id, name, arguments}` |
| 工具结果 | `{type:"function_call_output", call_id, output}` |
| reasoning | `{type:"reasoning", summary:[{type:"summary_text", text}]}` |

字段差异要点：

- 输出上限字段是 `max_output_tokens`，**不是** `max_tokens`；降级到 chat 时 o-series 模型要映射成 `max_completion_tokens`，其余映射成 `max_tokens`。
- reasoning 用 `reasoning: {effort}` 对象，effort 取值 `minimal|low|medium|high`（部分平台扩展 `xhigh`，OpenAI 顶层枚举不含 `none`）。
- 工具定义是扁平的 `{type:"function", name, parameters}`，没有 chat 的 `function` 嵌套层。
- `tool_choice` 形态也不同（`{type:"function", name}`），需要按协议转换。

#### reasoning 历史回放（关键）

这是与 thinking 跨轮回放一节呼应的具体实现细节，`cc-switch` 在这块踩了最多坑：

- 多轮工具对话里，`reasoning` 项往往**单独成项**，紧挨在它所属的 `function_call` 之前或之后。转换时要把它**就近归并**到对应的 assistant / tool_call 消息上（前置归并到下一个、尾随归并到上一个 assistant）。
- 若历史里某条带工具调用的 assistant 消息**丢失了 reasoning**（代理重启、call_id 歧义、上游某轮没产出思考），部分 thinking 模型（kimi/Moonshot、DeepSeek 等）会直接拒绝整个请求，报 `reasoning_content is missing in assistant tool call message`。**兜底策略：给这类消息补一个占位 reasoning（如 `"tool call"`）**，作为管线末端最终执行，避免污染真实思考。
- 显式关闭推理（effort=`none`/`off`/`disabled`）要忠实转发还是吞掉，取决于上游：原生 reasoning 对象平台（如 OpenRouter）要透传 `{"reasoning":{"effort":"none"}}`，顶层 `reasoning_effort` 枚举不含 `none` 的平台则只发关闭信号、不带该字段。

#### 流式解析（Responses SSE 事件）

Responses 的 SSE 是**有状态的事件流**，不是 chat 那种 delta 累积，需要一个状态机：

```text
response.created
response.output_item.added        （每个 output item 开始，带 index）
response.content_part.added
response.output_text.delta        （文本增量）
response.reasoning_summary_text.delta  （reasoning 增量）
response.function_call_arguments.delta （工具参数增量）
response.output_item.done
response.completed / response.failed
```

状态机要点（来自 `ChatToResponsesState` 的实战结构）：

- 为每个 output item（text / reasoning / 各 tool_call）维护独立状态：`output_index`、`item_id`、累积缓冲、`added`/`done` 标志。
- 工具调用参数按 item 累积，`output_item.done` 时才算完整。
- `usage` 可能在中途或末尾出现，只保留最后一次，在 `completed` 时统一上报。
- **inline think 兼容**：部分模型不走 reasoning 事件，而是把思考用 `<think>...</think>` 包在普通 content 里。需要一个 detecting/reasoning/text 三态的小状态机，在流的开头探测是否是 think 块，是则切到 reasoning 通道，否则当普通文本——且要处理 `<think>` 标签跨 chunk 到达、半个标签的情况。
- `finish_reason: length` 要映射成 Responses 的 `status: incomplete` + `incomplete_details.reason: max_output_tokens`。

#### 错误归一化

上游错误体五花八门，要统一成 Responses 风格 `{"error":{"message","type","code","param"}}`：

- 标准 OpenAI 形式 `{"error":{...}}` 直接取。
- 非标形式（如 MiniMax 的 `{"base_resp":{"status_code, status_msg}}`、顶层 `detail`、裸字符串）要逐一回落提取。
- 实在提取不出文本就把整个 JSON 序列化回去，方便用户排查（但仍不能含 key）。

#### 严格上游的防御

某些严格 OpenAI 兼容上游（vLLM、企业网关）会因为以下情况返回 400/503：

- 带了 `tool_choice` 或 `parallel_tool_calls` 但 `tools` 为空或缺失 → 转换后若 tools 为空，必须把这两个字段一并删掉。
- 流式请求未声明 `stream_options.include_usage` → 拿不到 usage，要主动注入。
- 中间出现 `role:system`（如把指令放在对话中部）→ 部分上游（MiniMax）只接受首条 system，要把所有 system 合并到头部。

### AnthropicMessagesAdapter

协议：

```text
Anthropic Messages compatible
```

请求：

```text
POST {baseUrl}/messages
```

请求体示例：

```json
{
  "model": "model-name",
  "max_tokens": 4096,
  "system": "system prompt",
  "messages": [],
  "tools": [],
  "stream": true
}
```

需要处理：

- system message 提取到顶层 `system`。
- assistant 文本转为 content block。
- tool call 转为 `tool_use` block。
- tool result 转为 `tool_result` block。
- 请求头 `anthropic-version`。
- `max_tokens` 是 Anthropic Messages API 的**必填字段**。内部 `request.maxTokens: 0`（不限制）的语义在这里不成立，adapter 必须填一个非零值。建议取 `context.output`，缺失时用保守默认值（如 4096）。
- 开启 thinking 时，`max_tokens` **必须大于** `thinking.budget_tokens`，否则上游报错。adapter 应保证 `max_tokens >= budget + 安全余量`，必要时上调 `max_tokens`。
- `budgetTokenOptions` 中的 `0` 表示**关闭** thinking：此时不应发送 `thinking` 参数，按普通请求处理。
- thinking 历史回放：带 thinking 的多轮工具对话，必须把上一轮 assistant 的 `thinking` block（含 `signature`）原样回传，否则上游会拒绝请求。详见“thinking 跨轮回放”一节。

流式解析：

- `message_start`
- `content_block_start`
- `content_block_delta`
- `content_block_stop`
- `message_delta`
- `message_stop`
- `error`

## 模型选择器映射

每个 connection 转换为一个 `LanguageModelChatInformation`。

建议映射：

```ts
{
  id: connection.id,
  name: connection.name,
  family: inferFamily(connection),
  version: inferVersion(connection),
  detail: `${protocolLabel(connection.protocol)} - ${hostOf(connection.baseUrl)}`,
  tooltip: `${connection.model} via ${connection.baseUrl}`,
  maxInputTokens: connection.context?.input ?? DEFAULT_INPUT_TOKENS,
  maxOutputTokens: connection.context?.output ?? DEFAULT_OUTPUT_TOKENS,
  capabilities: {
    toolCalling: connection.capabilities?.tools ?? true,
    imageInput: connection.capabilities?.vision ?? false
  },
  isUserSelectable: true
}
```

如果缺少 API Key：

```ts
{
  statusIcon: new vscode.ThemeIcon('warning'),
  detail: 'API key required'
}
```

如果 `capabilities.thinking=true`，可以附加 `configurationSchema`，在模型选择器里显示 thinking/reasoning 控件。

注意：以下字段属于当前 Copilot Chat 会消费的非公开字段，存在兼容性风险：

- `configurationSchema`
- `modelConfiguration`
- `isUserSelectable`
- `statusIcon`

建议把这些字段封装在单独模块中，减少未来 VS Code/Copilot Chat 变化时的修改面。

## 请求流程

```text
1. 用户在 Copilot Chat 选择模型
2. Copilot Chat 调用 provideLanguageModelChatResponse
3. provider 根据 modelInfo.id 找到 connection
4. provider 从 SecretStorage 读取 API Key
5. provider 根据 connection.protocol 选择 adapter
6. adapter 转换 messages/tools/request options
7. adapter 向上游 baseUrl 发起流式请求
8. adapter 解析流式响应
9. provider/progress 将文本、thinking、tool call、usage 回传给 VS Code
```

## thinking 跨轮回放

这是多协议接入里最容易被忽略、但不处理就会直接报错的一块。

### 问题

VS Code 每次调用 `provideLanguageModelChatResponse` 时，会把**整段历史对话**作为 `messages` 回传给 provider。但 VS Code 的消息模型里，assistant 的 thinking/reasoning 内容不一定能无损往返：

- Anthropic 的 interleaved thinking 要求：带工具的多轮对话中，上一轮 assistant 的 `thinking` block（含 `signature`）必须原样回传，否则 `/messages` 会拒绝请求。
- OpenAI Responses 的 reasoning item 同理，需要把上一轮的 `reasoning` 项带回。
- 普通 `chat` 协议（DeepSeek 等）不要求回传 `reasoning_content`，可以丢弃。

也就是说，adapter 不能只把 VS Code 给的 `messages` 直接转译，它还需要一个机制，能在历史 assistant 消息里**还原出自己上一轮产生的 reasoning 元数据**。

### 方案：replay marker

参考项目用一个隐藏标记（replay marker）解决：

```text
adapter 产生 thinking 时，除了通过 progress 报告给 VS Code 展示，
还把 reasoning 的原始元数据（signature、segmentId、原始 block 等）
编码进一个 LanguageModelDataPart（自定义 MIME），混在 assistant 输出里。

下一轮 provider 收到历史 messages 时，
从 assistant 消息里解析出这个 marker，
还原成上游协议需要的 thinking/reasoning 结构，重新注入请求体。
```

要点：

- marker 使用自定义 MIME（例如 `application/vnd.copilot-model-hub.replay+json`），与真实内容区分。
- marker 内容只包含回放所需的元数据，不展示给用户。
- token 估算时（`provideTokenCount`）应把 marker part 计为 0，避免污染预算。
- 用 `segmentId` 标识一段连续对话，区分“同一轮工具循环”与“新的用户请求”，避免跨请求误回放。
- 只有 `capabilities.thinking=true` 且协议需要回放（`anthropic` / `responses`）的连接才需要这套机制，`chat` 协议可跳过。

### AdapterStreamOptions 扩展

为支持回放，adapter 接口需要能访问历史 thinking。建议在转换阶段由共享层先扫描 `messages`、抽出 replay marker，再交给具体 adapter：

```ts
export interface AdapterStreamOptions {
  connection: ModelConnection;
  apiKey: string;
  messages: readonly vscode.LanguageModelChatRequestMessage[];
  tools: readonly vscode.LanguageModelChatTool[] | undefined;
  modelOptions: vscode.ProvideLanguageModelChatResponseOptions;
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  token: vscode.CancellationToken;

  // 从历史 assistant 消息中解析出的本插件上一轮 reasoning 元数据，
  // 供 anthropic / responses adapter 还原 thinking block。
  replayState?: ReplayState;
}
```

## Token 计数

`LanguageModelChatProvider` 强制要求实现 `provideTokenCount`。VS Code 用它来做上下文预算和裁剪，不能不实现，也不能简单返回固定值。

### 策略：自适应 chars-per-token

精确 tokenizer 因模型而异，插件不可能内置每个上游的 tokenizer。参考项目用一个自适应比值估算：

```text
estimatedTokens = ceil(totalChars / charsPerToken)
```

`charsPerToken` 初始取经验值（如 4.0），每次上游返回真实 usage 后用 EMA 校准：

```text
charsPerToken = alpha * (actualChars / actualTokens) + (1 - alpha) * charsPerToken
```

### 多 provider 要点

- `charsPerToken` 必须 **per-connection** 维护。不同模型/语言的 tokenizer 差异很大，全局共享一个比值会让估算严重偏移。
- 估算需要递归处理各种 content part：text、tool call（callId + name + JSON 化的 input）、tool result（递归子内容）、thinking。
- 图片等二进制 part 不应按字节数估算（vision 流水线会先把图片转成文字描述），应使用一个稳定的封顶估计值。
- replay marker part 计为 0。

### 字段映射回顾

`context.input` / `context.output` 映射到 `maxInputTokens` / `maxOutputTokens`，这是给 VS Code 看的上限；`provideTokenCount` 则是实际估算，两者配合完成裁剪。缺省时给保守默认值。

## Vision 降级

`capabilities.vision` 在多 provider 场景不能只是一个布尔开关，还要回答一个现实问题：**当用户用一个纯文本模型、但请求里带了图片时怎么办。**

多 provider 下纯文本连接会很多，这个情况会频繁发生。三种处理方式：

```text
A. 直接报错 —— 体验差，用户不知道该切哪个模型。
B. 丢弃图片 —— 静默丢信息，结果不可预期。
C. vision 降级 —— 用一个支持视觉的连接把图片转成文字描述，再喂给主模型。
```

推荐方案 C，并把它做成可配置：

### 设计

- 新增一个全局设置，指定哪个 connection 作为 **vision describer**：

```text
copilotModelHub.visionDescriber = "<connection id>"
```

- 该连接必须 `capabilities.vision=true`。
- 请求流程中，provider 在交给主 adapter 之前先做一次 vision 预处理：
  - 若主连接 `vision=true`，图片原样透传。
  - 若主连接 `vision=false` 且存在图片：调用 describer 连接，把每张图片转成文字描述，替换原图片 part。
  - 若 `vision=false` 且未配置 describer：按策略报错或附一条说明性提示。
- describer 的调用结果可缓存（按图片内容 hash），避免多轮对话里反复描述同一张图。

### 边界情况

- describer 指向的连接不存在、无效、或 `vision=false`：视为未配置 describer，按“无 describer”策略处理。
- describer 缺 API Key：同上降级，并在日志/UI 提示。
- describer 与主连接是同一个连接：直接透传图片（主连接本就支持 vision，不会进入降级分支）。
- describer 调用本身失败（网络/限流）：不应让整个主请求失败，应附一条“图片描述失败”的说明性文本继续，或按配置报错。
- 成本提示：vision 降级会**额外**产生一次对 describer 的调用，用户可能无感知。应在文档和 UI 中说明，并通过缓存降低重复开销。
- describer 调用也要尊重主请求的 `CancellationToken`，主请求取消时一并中止。

### 与 capabilities 的关系

`capabilities.vision` 仍表示“该连接是否能直接吃图片”。降级是 provider 层在 adapter 之上的编排，对 adapter 透明——adapter 只会收到已经处理好的纯文本或带图消息。

## 请求分类与轻量请求优化

Copilot Chat 除了主对话，还会发很多辅助请求：生成对话标题、commit message、分支名、todo 跟踪、prompt 分类等。这些请求不需要推理，但如果连接开了 thinking，会白白增加延迟和成本。

参考项目通过识别这些请求的 system prompt 前缀（或特征工具）对其分类，并对辅助类请求**强制关闭 thinking**。

建议作为可选优化：

- 维护一个请求分类器，识别 `chat-title`、`git-commit-message`、`todo-tracker` 等类别。
- 对这些类别，无论连接配置如何，都强制 `thinking=none` / 最低 effort。
- 主对话（`main-agent`）保留连接配置的 thinking 设置。
- 分类规则依赖 Copilot 的 prompt 文本，属于会随版本漂移的启发式，应单独封装，失效时只影响优化、不影响功能正确性。

## 错误归一化

运行期上游错误必须统一处理，且**绝不能泄露 API Key**。

建议在 HTTP 客户端层加一个共享的 error normalize：

| 上游情况 | 处理 |
| --- | --- |
| 401 / 403 | 提示鉴权失败，引导用户检查 / 重设 API Key（不回显 key）。 |
| 429 | 提示限流，建议稍后重试。 |
| 400 上下文超限 | 提示输入过长，引导减少上下文。 |
| 网络错误 / 超时 | 提示连接失败，附 connection id 和协议，不附 baseUrl 中可能的敏感片段。 |
| SSE 单 chunk 解析失败 | 记录日志并跳过，不中断整个流。 |
| 取消（AbortError + token 已取消） | 静默返回，不当作错误。 |

错误信息应包含 connection id 和 protocol 便于定位，但不得包含 key、完整 prompt 或敏感 header。

## 停用清理

插件停用时，应主动把模型从选择器中移除，避免残留死条目：

```text
1. 标记 provider 为非激活状态。
2. provideLanguageModelChatInformation 在非激活时返回 []。
3. 触发 onDidChangeLanguageModelChatInformation。
4. 主动调用一次 vscode.lm.selectChatModels({ vendor: 'copilot-model-hub' })，
   强制宿主在卸载前同步重新拉取模型列表。
```


## 配置 UI

JSON 配置保留给高级用户，但普通用户应使用命令或 Webview 表单。

建议命令：

```text
Copilot Model Hub: Add Model Connection
Copilot Model Hub: Edit Model Connection
Copilot Model Hub: Remove Model Connection
Copilot Model Hub: Set API Key
Copilot Model Hub: Test Connection
Copilot Model Hub: Set Vision Describer
Copilot Model Hub: Open Connections Settings
```

添加连接流程：

```text
1. 输入显示名称
2. 选择协议：Chat Completions / Responses / Anthropic
3. 输入 Base URL
4. 输入模型名
5. 输入 API Key
6. 选择能力：Tools / Vision / Thinking
7. 测试连接
8. 保存
```

保存行为：

```text
connection metadata -> VS Code Settings
apiKey -> SecretStorage
refresh model picker
```

## 校验规则

连接配置加载时应校验：

- `id` 非空、符合 `^[a-z0-9][a-z0-9-]*$`、且在合并后的列表中唯一。
- `name` 非空。
- `protocol` 是已支持协议。
- `baseUrl` 是合法 `http`/`https` URL。
- `model` 非空。
- `secretKey`（若显式提供）非空；未提供时由 id 推导。
- `headers` 不能覆盖 `Authorization`。
- `headers` 不能覆盖 `Content-Type`。
- `context.input` 和 `context.output` 必须为正数。
- `request.maxTokens` >= 0，`request.timeoutMs` > 0，`request.maxRetries` >= 0。
- 若设置了全局 `visionDescriber`，其指向的连接必须存在且 `capabilities.vision=true`，否则视为未配置 describer。

### 重复 id 的取舍

- 同一作用域内出现重复 id：保留**第一个**，其余记日志丢弃。
- 跨作用域（见下）合并后出现重复 id：以更具体作用域为准（Folder > Workspace > User）。

### 多作用域合并

VS Code 对 array 类型设置**不做合并，而是整体覆盖**——更具体作用域存在 `connections` 时会完全替换上层。这点反直觉，必须明确处理：

- 插件应使用 `inspect()` 分别读取 user / workspace / folder 三层的 `connections`，自行按“具体覆盖宽泛、同 id 去重”规则合并，而不是直接用 `get()` 拿到的单层结果。
- 合并策略：按 user → workspace → folder 顺序叠加，同 id 后者覆盖前者。
- 在文档与 UI 中说明此行为，避免用户以为 workspace 配置会“追加”到 user 配置。

### 无效连接降级

- 不让无效连接进入模型列表。
- 在日志中记录具体原因（含 id 与失败字段，不含 key）。
- 在配置 UI 中显示错误状态。

## 安全设计

### API Key

API Key 只进入 `SecretStorage`。

禁止：

```json
{
  "apiKey": "sk-..."
}
```

推荐：

```json
{
  "secretKey": "copilotModelHub.connection.deepseek-pro.apiKey"
}
```

### headers

允许用户配置服务商需要的普通 header。

禁止用户通过 `headers` 覆盖：

```text
Authorization
Content-Type
```

原因：

- `Authorization` 应由 SecretStorage 中的 API Key 统一生成。
- `Content-Type` 应由 adapter 控制。

### 日志和 dump

默认日志不应包含：

- API Key
- 完整 prompt
- 工具参数中的敏感内容
- 图片解析后的敏感文本

verbose dump 应默认关闭，并在 UI 中明确提示风险。

## 开发路线

### 阶段 1：配置和密钥

- 新增 `copilotModelHub.connections` 配置项。
- 新增 `ConnectionRegistry`。
- 新增连接配置校验。
- 新增 `SecretStorage` API Key 管理。
- 新增 `Set API Key` 和 `Test Connection` 命令。

### 阶段 2：统一 provider

- 在 `package.json` 中声明统一 vendor `copilot-model-hub`。
- 运行时注册 `vscode.lm.registerLanguageModelChatProvider('copilot-model-hub', provider)`。
- `provideLanguageModelChatInformation` 从 connections 生成模型列表。
- 实现 `provideTokenCount`（per-connection 自适应 chars-per-token）。
- 配置变化和 secret 变化时刷新模型选择器。
- 停用时返回 `[]` 并强制刷新选择器，清理残留模型。

### 阶段 3：Chat Completions adapter

- 将当前 DeepSeek `/chat/completions` 实现迁移为 `ChatCompletionsAdapter`。
- 支持 DeepSeek 原有能力。
- 支持 OpenRouter、LiteLLM、OneAPI、new-api 等代理。
- 保留 `reasoning_content` 解析。
- 实现 `stream_options.include_usage` 与 usage 回流校准。
- 实现共享的 error normalize 层。

### 阶段 4：Anthropic Messages adapter

- 实现 Anthropic messages 请求转换。
- 实现 tool_use/tool_result 转换。
- 实现 Anthropic SSE 事件解析。
- 支持 `anthropic-version` header。
- 处理 `max_tokens` 必填（取 `context.output` 或保守默认）。
- 实现 thinking 跨轮回放（replay marker）。

### 阶段 5：OpenAI Responses adapter

- 实现 Responses API 请求转换（messages → input 项、`max_output_tokens`、reasoning 对象、扁平 tool 定义）。
- 实现 Responses SSE 事件状态机（per-item 状态、参数累积、usage 末尾上报）。
- 实现 function call 和 reasoning 事件映射。
- 实现 reasoning item 跨轮回放与就近归并，含丢失 reasoning 的占位兜底。
- 实现 inline `<think>` 块的三态探测兼容。
- 复用共享 error normalize，并处理严格上游的 tool_choice/stream_options/system 防御。
- 参考 `cc-switch` 的 `transform_codex_chat.rs` 转换规则与测试用例。

### 阶段 6：Vision 降级与轻量请求优化

- 新增 `copilotModelHub.visionDescriber` 配置。
- 实现纯文本连接收到图片时的 describer 降级与缓存。
- 新增请求分类器，对辅助类请求强制关闭 thinking。

### 阶段 7：配置 UI 和诊断

- 新增连接管理 Webview 或 QuickPick 流程。
- 新增连接测试结果展示。
- 新增配置错误提示。
- 新增隐私安全诊断日志。

## 与当前项目的迁移关系

当前项目已有能力：

- VS Code LanguageModelChatProvider 注册。
- DeepSeek 模型元数据返回。
- OpenAI Chat Completions compatible 请求。
- SSE streaming 解析。
- tool calling 转换。
- DeepSeek `reasoning_content` 支持。
- vision proxy。
- SecretStorage 保存 DeepSeek API Key。

迁移时建议：

```text
DeepSeekChatProvider
  -> MultiProvider

MODELS 常量
  -> 默认 connections 或内置 connection templates

DeepSeekClient
  -> ChatCompletionsAdapter + shared HTTP client

getBaseUrl/getApiModelId
  -> connection.baseUrl / connection.model

AuthManager
  -> SecretManager keyed by connection.secretKey

provider/tokens.ts（charsPerToken 估算）
  -> 保留并改为 per-connection 维护

provider/vision/*（vision 降级服务）
  -> 保留，改为按 connection 选择 describer

provider/replay/* + segment.ts（thinking 回放）
  -> 保留，供 anthropic / responses adapter 复用

provider/routing/classifier.ts（请求分类）
  -> 保留为可选优化

client/error/*（错误归一化）
  -> 提升为所有 adapter 共享的层
```

第一步不要急着删除 DeepSeek 专用代码。可以先把 DeepSeek 作为第一个 `chat` connection 跑通，再逐步抽象公共层。当前项目已经实现的 token 估算、vision 降级、thinking 回放、请求分类、错误归一化这几块运行期逻辑应当**保留并抽象复用**，而不是重写——它们正是多 protocol 接入里最容易踩坑的部分。

### 参考项目

- `deepseek-v4-for-copilot`：VS Code LM provider 接入、chat 协议、thinking 回放、vision 降级、token 估算的来源。本项目的 provider 骨架与 chat adapter 主要从它迁移。
- `cc-switch`：Responses ↔ Chat Completions 双向转换、Responses SSE 状态机、reasoning 历史回放与占位兜底、严格上游防御、错误归一化的来源（Rust 实现，逻辑可直接移植到 TS）。其 `transform_codex_chat.rs` 的测试用例覆盖了大量真实兼容性边界（MiniMax system 约束、OpenRouter effort 枚举、kimi reasoning 缺失等），是 ResponsesAdapter 单元测试的现成蓝本。

## 测试与调试

### 测试分层

| 层级 | 对象 | 重点 |
| --- | --- | --- |
| 单元测试 | adapter 转换函数、SSE 解析、token 估算、校验、baseUrl 规范化 | 纯函数，无网络，最易覆盖，优先做。 |
| 流式回放测试 | adapter 的流解析 | 用录制的 SSE fixture 喂入解析器，断言产出的 response parts。 |
| 集成测试 | provider 在 VS Code Extension Host 中的行为 | 模型列表生成、配置/secret 变化触发刷新、停用清理。 |
| 手动验收 | 真实上游 | 用 `Test Connection` 和真实对话验证端到端。 |

### 必须覆盖的单元用例

SSE / 流解析：
- tool_calls 增量分片按 index 跨多个 chunk 正确拼接 id/name/arguments。
- 一个 chunk 里含多个 tool_call，且 index 乱序到达。
- `usage` 在每个 chunk 重复出现时只取最后一次。
- 半行 JSON 跨 chunk 边界，下一个 chunk 拼接后才完整。
- 单个 chunk 是坏 JSON 时跳过且不中断流。
- `reasoning_content` 与 `reasoning` 两种字段名都能映射到 thinking part。
- `[DONE]` 后不再处理任何数据；流提前关闭（无 `[DONE]`）也能正常 flush。

消息/工具转换：
- system message 在 anthropic 协议被提到顶层 `system`。
- tool_use / tool_result 在 anthropic 与 chat 之间双向转换正确。
- 历史 thinking block 通过 replay marker 还原后注入请求体。
- 空 content、纯 tool-result 消息、图片 part 的处理。

Responses 转换（参考 cc-switch 测试用例）：
- `instructions`/`max_output_tokens`/`reasoning` 对象到 chat 字段的映射，o-series 用 `max_completion_tokens`。
- `function_call` + `function_call_output` 序列正确转成 assistant(tool_calls) + tool 消息，多个并行 tool_call 与其 output 顺序对齐。
- 独立 `reasoning` 项就近归并到前一个/后一个 assistant 或 tool_call 消息。
- 带 tool_calls 但缺 reasoning 的 assistant 消息补占位（防 kimi/DeepSeek 拒绝）。
- effort=`none` 在原生 reasoning 平台透传、在顶层 effort 平台被吞掉。
- 严格上游防御：tools 为空时 `tool_choice`/`parallel_tool_calls` 被删除。
- 中部 `role:system` 合并到首位。
- inline `<think>` 块在流式下的三态探测，含标签跨 chunk 到达。
- Responses SSE：per-item 状态、参数累积到 `output_item.done`、`finish_reason:length` → `incomplete`。
- 错误体归一化：标准 OpenAI / MiniMax base_resp / 顶层 detail / 裸字符串 / 空体。

边界与校验：
- 重复 id、非法 id、非法 baseUrl、缺 model 等各自的降级行为。
- 多作用域合并与同 id 覆盖顺序。
- anthropic `max_tokens` 与 `budget_tokens` 的大小约束被强制满足。
- token 估算对 text / tool call / tool result / 图片 / replay marker 各类 part 的处理（marker 计 0，图片用封顶值）。

### Test Connection 命令

`Test Connection` 应发一个最小请求（如单条 user 消息、`max_tokens` 很小、不带工具），验证：

- baseUrl 可达、鉴权通过。
- 协议匹配（能解析出至少一个流式事件）。
- 返回结构化结果：成功 / 失败原因（鉴权、网络、协议不匹配、模型名错误），**不回显 key**。

### 调试支持

- 提供分级日志（off / error / info / verbose），默认不输出敏感内容。
- 提供可选的 request/response dump（写入 `globalStorageUri` 下文件），**默认关闭**，开启时 UI 明确提示风险，且对 key / Authorization / 完整 prompt 做脱敏。
- 日志和错误信息统一带 connection id 与 protocol，便于多连接环境定位问题。

## 验收标准

每个阶段的“完成”定义如下，作为验收清单。

### 阶段 1（配置和密钥）
- [ ] `copilotModelHub.connections` 出现在设置中，JSON schema 校验通过示例配置（含 thinking/request/pricing）。
- [ ] 合法连接被加载，非法连接被降级并记录原因。
- [ ] 多作用域合并与同 id 去重行为符合规则。
- [ ] API Key 仅存于 SecretStorage，settings.json 中无 key。
- [ ] `Set API Key` / `Test Connection` 命令可用，Test Connection 能区分鉴权/网络/协议错误。

### 阶段 2（统一 provider）
- [ ] 所有合法连接出现在 Copilot Chat 模型选择器中。
- [ ] 缺 key 的连接显示 warning 状态而非消失。
- [ ] 修改配置或 secret 后，选择器在不重启的情况下刷新。
- [ ] `provideTokenCount` 返回合理估算，并随 usage 回流校准（per-connection）。
- [ ] 插件停用后选择器中不残留本扩展的模型。

### 阶段 3（Chat Completions adapter）
- [ ] DeepSeek 等 chat 连接可完成多轮对话与工具调用。
- [ ] reasoning_content 正确渲染为可折叠 thinking。
- [ ] usage 正确上报；取消请求能即时中止流。
- [ ] 上游错误按错误归一化表呈现，不泄露 key。

### 阶段 4（Anthropic adapter）
- [ ] Anthropic 连接可完成带工具的多轮对话。
- [ ] thinking 多轮回放生效，不出现 signature 缺失类报错。
- [ ] `max_tokens` 必填且大于 budget 的约束被满足。

### 阶段 5（Responses adapter）
- [ ] Responses 连接可完成带工具与 reasoning 的多轮对话。
- [ ] reasoning item 跨轮回放生效。

### 阶段 6（Vision 降级与轻量优化）
- [ ] 纯文本连接收到图片时按配置走 describer 降级或给出明确提示。
- [ ] describer 各边界情况（缺失/无效/失败/同连接）行为符合设计。
- [ ] 辅助类请求（标题、commit message 等）被强制关闭 thinking。

### 阶段 7（配置 UI 和诊断）
- [ ] 可通过命令/Webview 完成增删改连接，无需手写 JSON。
- [ ] 配置错误在 UI 中可见。
- [ ] dump/日志默认关闭且脱敏，开启有风险提示。

### 全局非功能验收
- [ ] 任何日志、错误、dump 都不包含明文 API Key。
- [ ] 一个连接的失败不影响其他连接的可用性。
- [ ] 单元测试覆盖上述“必须覆盖的单元用例”，CI 通过。

## 兼容性风险

### Copilot Chat 非公开字段

模型选择器中的高级展示依赖一些非公开字段：

- `configurationSchema`
- `modelConfiguration`
- `isUserSelectable`
- `statusIcon`

风险：

- VS Code 或 Copilot Chat 更新后字段行为可能变化。

缓解：

- 单独封装模型 picker metadata。
- 基础聊天能力不依赖这些字段。
- 字段失效时只降级高级展示。

### 协议差异

风险：

- 不同服务商对 tools、thinking、usage、streaming 的实现差异很大。

缓解：

- 每种协议维护独立 adapter。
- 代理服务统一走 `chat` adapter。
- 不强行用 Chat Completions 表达 Anthropic 或 Responses 的所有语义。

### 用户配置错误

风险：

- baseUrl 填错。
- protocol 选错。
- model 名称不匹配。
- API Key 缺失。

缓解：

- 提供 `Test Connection`。
- 模型选择器显示 warning 状态。
- 错误信息包含 connection id 和协议，但不泄露 key。

## 最终结论

本项目应以统一 vendor 和集中 connections 为核心：

```text
vendor: copilot-model-hub
settings: copilotModelHub.connections
secret: SecretStorage
protocols: chat / responses / anthropic
adapters: internal protocol adapters
proxy: chat protocol backend
```

这个结构能让用户只面对最直观的配置项：

```text
Base URL
Model
API Key
Protocol
```

同时让插件内部保留足够的工程空间，去精确支持 Copilot Chat 的工具调用、流式响应、thinking、vision 和多协议差异。
