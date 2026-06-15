# Copilot Model Hub

[English](README.md) | 简体中文

![自定义模型出现在 Copilot Chat 的模型选择器里](https://raw.githubusercontent.com/linpeng812/copilot-model-hub/main/img/ScreenShot_2026-06-15_032000_354.png)

> **你的 Copilot，你的模型。**

> 支持任意第三方数据源接入Copilot Chat 对话框的模型选择器。
> 不必再装 Claude Code、OpenCode、Codex 一堆 AI IDE 插件了，VS Code 原生一键秒切数据源和模型。
> 无论是大厂 API 还是小厂中转站，只要支持 `chat/completions`、`responses` 或 `anthropic` 格式的数据源，流式输出、工具调用、思考/推理、都能无缝兼容。
> 密钥只留在本地 SecretStorage，请求直连你的端点，零第三方遥测，隐私安全可靠。


## 快速开始

**1. 添加连接** — 打开用户设置 JSON（命令面板 → `首选项: 打开用户设置(JSON)`），加入：

```jsonc
"copilotModelHub.connections": [
  // chat — 任何 OpenAI Chat Completions 兼容端点（DeepSeek、OpenRouter、中转站…）
  {
    "id": "deepseek",
    "name": "DeepSeek",
    "protocol": "chat",
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-chat"
  },
  // responses — OpenAI Responses API（或任意 Responses 兼容端点）
  {
    "id": "gpt5",
    "name": "GPT-5",
    "protocol": "responses",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-5"
  },
  // anthropic — Anthropic Messages API（或任意 Messages 兼容端点）
  {
    "id": "claude",
    "name": "Claude",
    "protocol": "anthropic",
    "baseUrl": "https://api.anthropic.com",
    "model": "claude-opus-4-8"
  },
  // 任意第三方供应商 — 按其文档填入 baseUrl/model，并选对 protocol 即可
  {
    "id": "my-provider",
    "name": "My Provider",
    "protocol": "chat",
    "baseUrl": "https://your-provider.example.com/v1",
    "model": "any-model-name"
  }
]
```

每个连接都会在模型选择器里成为一个独立模型，按需添加即可。只要端点支持这三种协议之一，填好 `protocol`、`baseUrl`、`model` 就能接入。

> **💡 记得配上 `context`，填你模型真实的上下文大小。** 不填的话默认按约 136K 算（选择器里看到的就是这个数）。这个数不会真的截断你的输入，但 Copilot 会拿它来决定往对话里塞多少内容。所以：模型其实更大（比如 200K、1M）却不配，就只按 136K 塞数据，就白白浪费了模型容量；模型其实更小（比如只有 64K）还按 136K 塞数据，上游接口就会报错。按你模型的真实大小填就对了：
>
> ```jsonc
> { "id": "claude", "name": "Claude", "protocol": "anthropic",
>   "baseUrl": "https://api.anthropic.com", "model": "claude-opus-4-8",
>   "context": { "input": 200000, "output": 32000 } }   // input = 上下文窗口，output = 单次最多输出多少
> ```

**2. 设置密钥** — 命令面板 → **Copilot Model Hub: Set API Key** → 选连接 → 粘贴密钥。

**3. 选用** — 打开 Copilot Chat，在模型选择器里选中你的连接即可。未设密钥的会显示 ⚠️ `API key required`。

> 要求：VS Code ≥ 1.116，且已安装并登录 GitHub Copilot Chat。

## 配置字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 唯一标识，匹配 `^[a-z0-9][a-z0-9._-]*$`（字母/数字开头）。 |
| `name` | 是 | 模型选择器里显示的名称。 |
| `protocol` | 是 | `chat`、`responses` 或 `anthropic`。 |
| `baseUrl` | 是 | 服务商基础 URL，需包含完整路径（如 `/v1`）。见下方说明。 |
| `model` | 是 | 上游模型名，原样发送。 |
| `secretKey` | 否 | 密钥的 SecretStorage 键名，默认 `copilotModelHub.connection.{id}.apiKey`。多个连接填同一个即可共享密钥。 |
| `headers` | 否 | 额外请求头。 |
| `capabilities` | 否 | `{ tools, vision, thinking }`，默认 `tools` 开、其余关。 |
| `context` | 否 | `{ input, output }` token 上限。 |
| `request` | 否 | `{ temperature, topP, maxTokens, timeoutMs, maxRetries }` 默认值。 |
| `thinking` | 否 | 推理配置，仅 `capabilities.thinking: true` 时生效。 |

### 关于 baseUrl 和 `/v1`

按服务商文档原样填写，扩展只去掉末尾斜杠、不增删路径。各家不同：OpenAI 用 `/v1`，DeepSeek 用裸域名，部分网关用自定义路径。

`anthropic` 例外：对齐 Claude Code，`baseUrl` 不以 `/v1` 结尾时会自动补，所以填不填 `/v1` 都能解析到 `…/v1/messages`。

### 开启思考/推理

设 `capabilities.thinking: true` 并给出对应的 `thinking` 对象：

```jsonc
"thinking": { "type": "deepseek", "defaultEffort": "high" }              // chat
"thinking": { "type": "openai-reasoning", "defaultEffort": "medium" }    // responses
"thinking": { "type": "anthropic-thinking", "defaultBudgetTokens": 12000 } // anthropic
```

effort 为 `none`/`off`/`0` 时该次请求不启用推理。

## 配置示例

```jsonc
// OpenAI Responses
{ "id": "gpt5", "name": "GPT-5", "protocol": "responses",
  "baseUrl": "https://api.openai.com/v1", "model": "gpt-5",
  "capabilities": { "thinking": true },
  "thinking": { "type": "openai-reasoning", "defaultEffort": "medium" } }

// Anthropic
{ "id": "claude", "name": "Claude", "protocol": "anthropic",
  "baseUrl": "https://api.anthropic.com", "model": "claude-opus-4-8" }

// 两个连接共享一个密钥
{ "id": "openai-prod", "name": "OpenAI (prod)", "protocol": "chat",
  "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o", "secretKey": "openai.shared" }
{ "id": "openai-mini", "name": "OpenAI (mini)", "protocol": "chat",
  "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini", "secretKey": "openai.shared" }
```

## 命令

- **Set API Key** — 给某个连接存入密钥。
- **Test Connection** — 探测可达性与鉴权（不发真实聊天）。若提示返回 HTML 页面，多半是 `baseUrl` 路径填错了。
- **Open Connections Settings** — 跳转到连接配置项。


## 开发

```bash
npm install && npm run compile   # 安装并构建
npm test                         # 运行测试
npm run package                  # 打包 .vsix
```

按 **F5** 启动调试窗口；改完配置后执行 `开发人员: 重新加载窗口`。


## 许可证

MIT
