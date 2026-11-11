# Exa web search for DeepSeek Harness

为内置的 `web_search` / `web_fetch` 提供 **Exa** 后端。它是一个 Provider 层替换：工具名、参数、提示词、HTML→Markdown、截断和结果卡片都继续由 `@deepseek-ai/dsh-tool-web` 提供，本包只替换 `ctx.web` 背后的搜索与抓取实现。

## 它替换了什么

| 能力 | 原实现 | 本包 |
|---|---|---|
| `web_search` | `deepseek-official`（一次搜索 = 一次 Messages 模型调用） | `exa-search` → `POST https://api.exa.ai/search` |
| `web_fetch` | `http`（匿名 HTTP + 工具层 HTML→Markdown） | `exa-fetch` → `POST https://api.exa.ai/contents` |

`ctx.web` 的 provider 选择由宿主 `web` 行固定：

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: exa-search
    fetchProvider: exa-fetch
```

## 安装

```bash
dsh plugin --profile <profile> add /Users/wang/Workspace/projects/my-dsh-plugins/web-search-exa
```

或在 Harness 里用 `plugin_manager` 的 `install_bundle`，target 指向本目录。安装会立即影响该 profile 的所有会话。

## 密钥

默认从 `EXA_API_KEY` 解析，优先级：

1. 插件配置里的字面 `apiKey`；
2. `ctx.credentials`（Models 页面写入的 `.credentials.yaml`，其下再叠加进程环境、项目 `.env`、`~/.dsh/.env`）；
3. 启动环境快照（`launchEnvironmentOf`）。

本机当前 `~/.dsh/.env` 已提供 `EXA_API_KEY`，无需额外配置。没有 key 时工具仍然可见，调用会返回可操作的 `Error: Exa has no API key...`。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `apiKey` | `''` | 字面 key；优先于 `apiKeyEnv` |
| `apiKeyEnv` | `EXA_API_KEY` | 凭据引用名 |
| `baseURL` | `https://api.exa.ai` | REST 根地址 |
| `timeoutMs` | `25000` | provider 自身资源超时；工具层另有 30s/60s 预算 |
| `searchType` | `auto` | `auto` / `neural` / `keyword` / `fast` / `instant` / `deep` |
| `searchNumResults` | `8` | 每次搜索请求的结果数，服务层还会按 `searchMaxResults` 截断 |
| `searchHighlights` | `true` | 请求 Exa highlights，作为来源 snippet |
| `searchSummaries` | `false` | 请求 Exa 逐页 summary；会计费，开启后优先于 snippet 展示 |
| `searchMaxSnippetChars` | `600` | snippet 截断长度 |
| `searchIncludeDomains` / `searchExcludeDomains` | `[]` | 站点过滤；seam 不提供模型参数，只能按配置固定 |
| `fetchMaxCharacters` | `100000` | 抓取正文上限 |
| `fetchMaxAgeHours` | `0` | `0` = 实时抓取；`-1` = 只用缓存；省略语义见 Exa 文档 |
| `fetchLivecrawlTimeoutMs` | `15000` | 实时抓取超时 |

## 行为与限制

- **搜索结果**：`sources[]` 来自 Exa `results[]`；`snippet` 取 highlights（否则取正文前缀），`publishedAt` 取日历日期。`content`（模型可见的“answer”）不填，工具只列来源。
- **抓取结果**：Exa `/contents` 返回的是正文，不暴露目标页 HTTP 状态和重定向链，因此成功统一报告 `HTTP 200`，`body.kind = 'text'`（避免工具层二次做 HTML→Markdown）。
- **取消**：调用方 `AbortSignal` 与 provider 超时合并；取消映射为 `WEB_ABORTED`。
- **无 key**：`available()` 只检查配置，不查 secret，所以 `web_search` 不会从请求里消失；调用时返回 `WEB_PROVIDER_CREDENTIAL_MISSING`。
- **回滚**：禁用到本插件后，`web` 行仍指向 `exa-search` / `exa-fetch`，会报 `WEB_PROVIDER_CONFIGURED_MISSING`。回滚需同时移除本包 patch 中对 `web` 的覆盖（或把两个 provider 改回 `deepseek-official` / `http`）。

## 验证

```bash
# 语法检查
node --check index.js

# 安装后：确认 provider row 与 web pin
# 在 Harness 中查询 Config.listConfigs（name: dsh-plugin-web-search-exa / entry: web）
# 然后实际调用一次 web_search 和 web_fetch
```
