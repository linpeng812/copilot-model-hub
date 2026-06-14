# 实现计划：Copilot Model Hub（阶段 1–5）

## 目标与范围

从零搭建一个 VS Code 扩展，把多个自定义模型连接（chat / responses / anthropic 三种协议）统一接入 Copilot Chat。

本次交付 **阶段 1–5**：配置与密钥 → 统一 provider → Chat adapter → Anthropic adapter → Responses adapter。
不含：阶段 6（vision 降级 / 请求分类优化）、阶段 7（配置 Webview UI）。这两阶段留待后续。

**技术栈决定（已确认）**：TypeScript + esbuild 打包 + Vitest 单测。

## 两个参考项目的定位

- `reference_project/deepseek-v4-for-copilot-main`：**provider 骨架来源**。VS Code LM provider 注册、SSE 解析、tool calling、thinking part、replay marker、token 估算、SecretStorage 的范式全部从它迁移。它的方向与本项目一致（VS Code → 上游），可直接借鉴结构。
- `reference_project/cc-switch-main`：**转换规则字典 + 测试蓝本**。它是 Rust 反向代理，转换方向与本项目相反（它接收 Responses/Anthropic，转成 Chat）。**不能照搬代码方向**，但其字段映射、reasoning 归并、工具结构、SSE 事件语义、边界处理规则完全通用。它的 43 个转换测试用例可一对一改写成本项目的 Vitest 单测。

> 重要：cc-switch 做的是 `Responses→Chat`，我们要的是 `VSCode-msg→Responses`。规则同源，方向需自己定。实现 Responses/Anthropic adapter 时以「构造上游请求 + 解析上游流」为准，cc-switch 用来对照字段和边界，不是复制粘贴。

## 目录结构（新建）

```
copilot-model-hub/
  package.json              # 扩展清单 + 依赖 + 构建脚本
  tsconfig.json
  esbuild.js                # 构建脚本
  vitest.config.ts
  .vscodeignore
  src/
    extension.ts            # activate/deactivate 转发
    runtime/
      lifecycle.ts          # 激活入口，注册 provider + 命令
      provider.ts           # vscode.lm.registerLanguageModelChatProvider('copilot-model-hub', ...)
      commands.ts           # Set API Key / Test Connection / Open Settings 等命令
    config/
      types.ts              # ModelConnection 等内部类型
      registry.ts           # ConnectionRegistry：读取/校验/合并/规范化/查找
      validate.ts           # 连接校验规则
      scope.ts              # 多作用域 inspect() 合并 + 同 id 去重
    secrets/
      manager.ts            # SecretManager：API Key 存取，按 id 推导 secretKey
    provider/
      index.ts              # MultiProvider：三个 LM API 方法
      info.ts               # connection → LanguageModelChatInformation 映射
      tokens.ts             # per-connection 自适应 charsPerToken 估算
      router.ts             # protocol → adapter 路由
      replay/               # thinking 跨轮回放（replay marker 编解码）
        markers.ts
        consts.ts
    adapters/
      types.ts              # ProtocolAdapter / AdapterStreamOptions 接口
      chat/
        adapter.ts          # ChatCompletionsAdapter
        request.ts          # VSCode msg/tools → chat 请求体
        stream.ts           # chat SSE 解析 → VSCode response parts
      anthropic/
        adapter.ts
        request.ts          # → /messages 请求体（system 提顶层、tool_use/tool_result、max_tokens 必填）
        stream.ts           # Anthropic SSE 事件解析
      responses/
        adapter.ts
        request.ts          # → /responses 请求体（input 项、max_output_tokens、reasoning 对象）
        stream.ts           # Responses SSE 状态机（per-item、inline <think> 三态）
    shared/
      sse.ts                # 通用 SSE 行缓冲解析（跨 chunk 半行处理）
      canonical.ts          # JSON 规范化（移植自 cc-switch json_canonical.rs）
      reasoning.ts          # reasoning 字段提取 / <think> 块分割（移植自 codex_chat_common.rs）
      http.ts               # fetch 封装 + AbortController + 错误归一化
      errors.ts             # error normalize（401/403/429/400/网络/取消）
  test/
    canonical.spec.ts
    reasoning.spec.ts
    chat-stream.spec.ts
    anthropic-transform.spec.ts
    responses-transform.spec.ts   # 移植 cc-switch 的 43 个用例
    registry.spec.ts
    tokens.spec.ts
```

## 分阶段实现步骤

### 阶段 0：脚手架（半天）
1. `package.json`：engines.vscode `^1.116.0`、main `./dist/extension.js`、activationEvents `onStartupFinished`、contributes 声明 vendor `copilot-model-hub` + `copilotModelHub.connections` 配置 schema（用设计文档已修正的 schema）+ 命令声明。
2. devDependencies：`@types/vscode`、`@types/node`、`typescript`、`esbuild`、`vitest`、`@vscode/vsce`。无运行时依赖。
3. `esbuild.js`（bundle、external vscode、platform node）、`tsconfig.json`、`vitest.config.ts`、`.vscodeignore`。
4. `extension.ts` + 空 `runtime/lifecycle.ts`，能 F5 激活、显示「Hello」级日志。
**验收**：扩展能在 Extension Host 激活，无报错。

### 阶段 1：配置与密钥（1 天）
1. `config/types.ts`：ModelConnection / Capabilities / Context / RequestDefaults 等接口。
2. `config/validate.ts` + `config/scope.ts` + `config/registry.ts`：读取 connections、多作用域 inspect 合并、同 id 去重、baseUrl 规范化、校验降级、getByModelId。
3. `secrets/manager.ts`：按 `copilotModelHub.connection.{id}.apiKey` 推导 key，store/get/delete。
4. `runtime/commands.ts`：`Set API Key`、`Test Connection`（发最小请求，区分鉴权/网络/协议错误，不回显 key）。
5. 监听 `onDidChangeConfiguration` + `secrets.onDidChange`。
**测试**：`registry.spec.ts`（重复 id、非法 id、非法 baseUrl、多作用域覆盖）。
**验收**：合法连接加载、非法降级、key 仅入 SecretStorage、Test Connection 可用。

### 阶段 2：统一 provider（1 天）
1. `provider/info.ts`：connection → LanguageModelChatInformation（含缺 key 的 warning 状态）。
2. `provider/tokens.ts`：per-connection 自适应 charsPerToken（移植 DeepSeek tokens.ts，改为按 connection.id 维护 Map）。
3. `provider/index.ts`：`provideLanguageModelChatInformation` / `provideLanguageModelChatResponse`（先接 chat adapter 占位）/ `provideTokenCount`。
4. `provider/router.ts`：protocol → adapter。
5. `runtime/provider.ts`：注册 vendor + 配置/secret 变化刷新 + 停用返回 `[]` 并强制刷新。
**测试**：`tokens.spec.ts`（各类 part 估算、marker 计 0、图片封顶值）。
**验收**：合法连接出现在模型选择器、缺 key 显示 warning、配置变化即时刷新、停用无残留。

### 阶段 3：Chat Completions adapter（1.5 天）
1. `shared/sse.ts`：通用 SSE 行缓冲（跨 chunk 半行、坏 chunk 跳过、`[DONE]`）。
2. `shared/http.ts` + `shared/errors.ts`：fetch + AbortController + 错误归一化。
3. `shared/canonical.ts` + `shared/reasoning.ts`：移植 cc-switch 工具函数。
4. `adapters/chat/request.ts`：VSCode msg/tools → chat 请求体（含 `stream_options.include_usage`）。
5. `adapters/chat/stream.ts`：解析 delta.content / tool_calls 增量（按 index 累积）/ reasoning_content / usage，report VSCode parts。
6. `provider/replay/`：thinking replay marker 编解码（移植 DeepSeek replay）。
**测试**：`canonical.spec.ts`、`reasoning.spec.ts`、`chat-stream.spec.ts`（tool_calls 增量、乱序 index、usage 取末次、半行、坏 chunk、reasoning 字段兼容、提前关闭）。
**验收**：DeepSeek 等 chat 连接多轮对话 + 工具调用 + reasoning 渲染 + 取消即时中止 + 错误不泄露 key。

### 阶段 4：Anthropic Messages adapter（1.5 天）
1. `adapters/anthropic/request.ts`：system 提顶层、content block、tool_use/tool_result、`anthropic-version` header、`max_tokens` 必填（取 context.output 或 4096，且 > thinking budget）。
2. `adapters/anthropic/stream.ts`：message_start / content_block_* / message_delta / message_stop / error 事件解析。
3. thinking 回放：带 thinking 的多轮工具对话原样回传 thinking block（含 signature），复用 replay marker。
**测试**：`anthropic-transform.spec.ts`（system 提取、tool 双向、max_tokens 约束、thinking 回放、占位兜底——对照 cc-switch 的 anthropic 相关用例）。
**验收**：Anthropic 连接带工具多轮对话、无 signature 缺失报错、max_tokens 约束满足。

### 阶段 5：OpenAI Responses adapter（2 天）
1. `adapters/responses/request.ts`：VSCode msg → input 项、instructions、max_output_tokens、reasoning 对象、扁平 tool 定义、tool_choice 转换、严格上游防御（空 tools 删 tool_choice/parallel_tool_calls）。
2. `adapters/responses/stream.ts`：Responses SSE 状态机（per-item 状态、参数累积到 output_item.done、usage 末尾上报、inline `<think>` 三态探测、finish length → incomplete）。
3. reasoning 历史回放 + 就近归并 + 缺失占位兜底。
**测试**：`responses-transform.spec.ts`（移植 cc-switch transform_codex_chat.rs 的 43 个用例，按方向调整断言）。
**验收**：Responses 连接带工具 + reasoning 多轮对话、reasoning 跨轮回放生效、inline think 兼容。

## 关键风险与对策

1. **cc-switch 方向相反**：转换规则通用但方向需自定。对策——把 cc-switch 当规则字典，实现以「构造上游请求/解析上游流」为准；测试用例移植时调整输入输出方向。
2. **VS Code 非公开字段**（configurationSchema/statusIcon/isUserSelectable）：封装在 `provider/info.ts` 单一模块，失效只降级高级展示，基础聊天不依赖。
3. **VS Code API 版本**：以 `^1.116.0` 为准（DeepSeek 参考项目验证过的 LM provider API 版本）。实现中若发现 API 形状不符，以本机安装的 `@types/vscode` 为准并记录。
4. **无法真机验证上游**：单测覆盖纯转换逻辑（不需网络）；真实上游连通性靠 Test Connection 命令手动验证。

## 验证方式

- 每阶段结束跑 `npm run compile`（tsc 类型检查）+ `npm test`（vitest）。
- adapter 逻辑全部纯函数化，用录制的 SSE fixture 做流式回放测试，不依赖网络。
- 阶段 3/4/5 各自的 adapter 完成后，可在 Extension Host 里用真实 key 做一次端到端手验（可选）。

## 不在本次范围

- 阶段 6：vision 降级、请求分类优化。
- 阶段 7：配置管理 Webview / QuickPick UI、诊断 dump UI。
- 英文版设计文档同步。
