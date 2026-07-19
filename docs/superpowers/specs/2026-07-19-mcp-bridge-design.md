# Remote Reader · 子计划 2：本地 MCP 桥 设计文档

- **创建日期**: 2026-07-19
- **状态**: 设计已确认，待编写实现计划
- **范围**: 子计划 2（本地 MCP 桥）。权威总设计见 [`2026-07-18-remote-reader-design.md`](./2026-07-18-remote-reader-design.md)（§3 架构、§6.4 私有/分享、§8 MCP 工具）。

---

## 1. 概述

本地 MCP 桥（`apps/mcp-bridge`）是 Remote Reader 三大组件里「核心流程缺失的另一半」。它是一个跑在**用户本地机器**上的 stdio MCP server，把 Agent（如 Claude Code）的 MCP 工具调用翻译成对 Web 应用 HTTP API 的请求。

**它解决什么**：Agent 不应直接持有上传 API token、也不应手写 HTTP。桥在本地持有 token，对 Agent 只暴露一个 MCP 工具 `upload_document`——Agent 像调任何 MCP 工具一样上传文档，拿到免登录查看链接。

**一句话定位**：Agent 侧的瘦转发层——MCP 入，HTTP 出，token 不出本地。

## 2. 目标与非目标

### 2.1 目标
- 暴露 1 个 MCP 工具 `upload_document({name, content, path?})`，返回 `{id, url}`。
- 桥在本地持有 API token，不向 Agent 暴露。
- 配置：配置文件默认 + 环境变量覆盖（文件：`$XDG_CONFIG_HOME/remote-reader/config.json` 或 `~/.config/remote-reader/config.json`；env：`REMOTE_READER_URL` / `REMOTE_READER_TOKEN`）。
- 工具逻辑与 transport 解耦（spec 总设计 §3.2）：工具定义/handler 在 `packages/shared`，桥只接 stdio transport。Phase 3 远程 MCP server 可复用同一 handler。
- 错误逐请求以 MCP 结果返回，桥不 crash。

### 2.2 非目标（YAGNI）
- 不做 list/get/delete 工具（Web API 当前只实现 `POST /api/v1/documents`）。
- 不做远程（Streamable HTTP）MCP server（Phase 3）。
- 不做 token 旋转 / token 管理 UI（子计划 3）。
- 不内嵌 Web 应用的 md 渲染（那是 Web 侧）。
- 不做多账号/多 server 切换（一个桥连一个 Web 应用）。

## 3. 架构

```
Agent (Claude Code / 任意 MCP client)
   │ stdio（JSON-RPC over MCP）
   ▼
apps/mcp-bridge  ── stdio MCP server（@modelcontextprotocol）
   │  读 config → 建 apiClient → 注册 upload_document → StdioServerTransport
   ▼
packages/shared  ── 工具逻辑（与 transport 解耦）
   ├─ src/tools/upload-document.ts   工具 schema + handler
   └─ src/api-client.ts              HTTP client
   │  HTTPS + Authorization: Bearer <token>
   ▼
apps/web  POST /api/v1/documents（子计划 1 已实现）
```

**解耦原则**：`packages/shared` 提供「工具定义 + handler + HTTP client」，无任何 MCP transport 依赖；`apps/mcp-bridge` 只把 stdio transport 接到 handler 上。换 transport（Phase 3 的 Streamable HTTP）无需改 shared。

## 4. 组件设计

### 4.1 `packages/shared/src/api-client.ts`

HTTP client，纯 `fetch`，无原生依赖。

```ts
export interface ApiClient {
    uploadDocument(input: { name: string; content: string; path?: string }): Promise<{ id: string; url: string }>;
}

export function createApiClient(opts: { baseUrl: string; token: string }): ApiClient;
```

行为：
- `POST <baseUrl>/api/v1/documents`，header `Authorization: Bearer <token>` + `Content-Type: application/json`，body `{ name, content, path }`（`path` 缺省不带）。
- 2xx：解析 JSON `{id, url}` 返回。
- 非 2xx：抛 `ApiError`，带 `status` 与服务端 message；映射：
  - 400 →「请求非法（name/path 含非法字符或字段缺失）」
  - 401 →「API token 无效或已撤销」
  - 413 →「内容超过大小上限」
  - 429 →「上传过于频繁，请稍后重试」
  - 其它 →「上传失败：HTTP <status>」
- 网络错误（fetch reject）：抛 `ApiError`（status=0，message 含原因）。
- `baseUrl` 末尾去 `/`，避免双斜杠。

### 4.2 `packages/shared/src/tools/upload-document.ts`

工具定义（schema + handler），无 transport 依赖。schema 用 `zod`（与 MCP SDK 一致）。

```ts
import * as z from 'zod';
import type { ApiClient } from '../api-client';

export const uploadDocumentSchema = z.object({
    name: z.string().describe('文档文件名，如 "weekly.md"。禁含 .. / 绝对路径 / \\ : * ? " < > | / null'),
    content: z.string().describe('Markdown 正文（UTF-8）'),
    path: z.string().optional().describe('可选目录前缀，POSIX 风格，如 "reports/2026-07"')
});

export const uploadDocumentDescription = [
    '幂等上传一份 Markdown 文档到 Remote Reader，返回一个免登录、点开即见渲染结果的查看链接。',
    '同 path+name+内容重复上传不产生重复，链接长期稳定；内容变化则原地覆盖、链接不变。',
    '上传成功后，请把返回的 url 通过当前对话/IM 发给用户，并简述文档内容。'
].join(' ');

export async function uploadDocumentHandler(
    args: z.infer<typeof uploadDocumentSchema>,
    api: ApiClient
): Promise<{ content: { type: 'text'; text: string }[] }> {
    const { id, url } = await api.uploadDocument(args);
    return { content: [{ type: 'text', text: `已上传（id=${id}）。查看链接：${url}` }] };
}
```

> handler 返回 MCP 标准工具结果形状（`{content:[{type:'text',text}]}`），让桥几乎零胶水地转发；但 handler 本身不 import SDK（`type` 字面量不引入运行时依赖），保持 shared 与 transport 解耦。

### 4.3 `apps/mcp-bridge/src/config.ts`

```ts
export interface BridgeConfig { baseUrl: string; token: string; }
export function loadConfig(): BridgeConfig;
```

行为：
- 默认从配置文件读：路径 = `$XDG_CONFIG_HOME/remote-reader/config.json`，未设则 `~/.config/remote-reader/config.json`。文件内容 `{ "baseUrl": "...", "token": "rr_..." }`。文件不存在视为无默认（不报错）。
- env 覆盖：`REMOTE_READER_URL` → `baseUrl`，`REMOTE_READER_TOKEN` → `token`。env 非空优先于文件。
- 合并后若 `baseUrl` 或 `token` 缺失：`console.error` 给出清晰指引（去哪配文件 / 传哪些 env）后 `process.exit(1)`。

### 4.4 `apps/mcp-bridge/src/index.ts`

stdio MCP server 入口。

```ts
import { McpServer } from '...';          // stable MCP TS SDK
import { StdioServerTransport } from '...';
import { createApiClient } from '@remote-reader/shared/api-client';
import { uploadDocumentSchema, uploadDocumentDescription, uploadDocumentHandler } from '@remote-reader/shared/tools/upload-document';
import { loadConfig } from './config';

const cfg = loadConfig();                  // 缺失会 process.exit(1)
const api = createApiClient(cfg);

const server = new McpServer({ name: 'remote-reader', version: '0.1.0' });
server.registerTool(
    'upload_document',
    { description: uploadDocumentDescription, inputSchema: uploadDocumentSchema },
    async (args) => {
        try {
            return await uploadDocumentHandler(args, api);
        } catch (e) {
            // 显式映射为 MCP 错误结果（不依赖 SDK 对抛错的默认处理）
            return { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
        }
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[remote-reader] MCP bridge on stdio →', cfg.baseUrl);
```

> exact SDK 包名/导入路径（v1.x `@modelcontextprotocol/sdk` vs v2 split `@modelcontextprotocol/server`）在实现时按当时 stable 版本定。**stdout 仅走 MCP 协议**，所有日志走 `console.error`。桥包装层捕获 handler 抛出的 `ApiError`，显式返回 `{isError:true, content:[...]}`，错误映射不依赖 SDK 默认行为。

## 5. 数据流

一次 `upload_document`：
1. Agent 经 MCP client 发 `tools/call` `upload_document({name,content,path})`。
2. 桥的 handler 调 `api.uploadDocument(args)`。
3. api-client `POST <baseUrl>/api/v1/documents`（`+Bearer`）。
4. Web 应用（子计划 1）：parsePath 过滤 name+path → uploadDocument 幂等落盘 + 建 share link → 返回 `{id, url}`。
5. handler 包装成 `{content:[{type:'text', text:'已上传... 查看链接：<url>'}]}` 返回。
6. Agent 收到文本结果，把 url 发给用户；用户点链接免登录查看。

## 6. 错误处理

| 来源 | 表现 | Agent 看到 |
|---|---|---|
| 配置缺失（url/token 都没有） | 桥启动 `console.error` 指引 + `process.exit(1)` | MCP client 连不上桥（桥没起来） |
| API 400 | handler 抛 `ApiError` → SDK 转为 MCP 工具错误结果 | 「name/path 非法，请改参数」 |
| API 401 | 同上 | 「API token 无效或已撤销」 |
| API 413 | 同上 | 「内容超过大小上限」 |
| API 429 | 同上 | 「上传过频，稍后重试」 |
| 网络/连接错误 | 同上（status=0） | 「无法连接服务器：<原因>」 |
| 桥进程内未捕获异常 | `main().catch(...)` 兜底，日志 + exit(1) | 桥退出 |

桥对每个 `tools/call` 都返回结果（成功或错误），不会因单次工具调用 crash；仅配置缺失或致命错误才退出进程。

## 7. 运行时与集成

- **运行时**：桥无原生依赖（纯 `fetch` + MCP SDK），**bun 可直接跑，无需 build**：`bun apps/mcp-bridge/src/index.ts`。
- **Claude Code 接入**（二选一）：
  - env 全传：`claude mcp add remote-reader bun apps/mcp-bridge/src/index.ts -e REMOTE_READER_URL=https://your-host -e REMOTE_READER_TOKEN=rr_...`
  - 配置文件：把 `{baseUrl,token}` 写进 `~/.config/remote-reader/config.json`，`claude mcp add remote-reader bun apps/mcp-bridge/src/index.ts`
- 也可用 MCP inspector 调试：`npx @modelcontextprotocol/inspector bun apps/mcp-bridge/src/index.ts`。

## 8. 测试策略（vitest，与现有一致）

| 对象 | 测试 |
|---|---|
| `api-client` | mock global `fetch`：验证请求 URL/method/header/body 构造；2xx 解析 `{id,url}`；400/401/413/429/网络 各映射为 `ApiError`（status + message）；baseUrl 去尾斜杠 |
| `config` | tmp 配置文件读取；`XDG_CONFIG_HOME` 解析；env 覆盖文件；文件不存在不报错；url/token 都缺失时 `process.exit(1)`（用 spy 捕获） |
| `upload-document` handler | mock `ApiClient`：验证透传 `{name,content,path}`、返回 MCP 结果形状 `{content:[{type:'text',text 含 url}]}`；api 抛错时 handler 透传抛出 |
| stdio transport | 不单测（薄层，由集成验证） |
| 集成 | 起 web dev（含已建 admin + token）→ 配桥 env → 直接用一条 stdio JSON-RPC `tools/call upload_document` 喂入，确认响应含 `{id,url}` 且 web 侧落盘 |

## 9. 文件结构（新增）

```
apps/mcp-bridge/
├── package.json          # name: remote-reader-mcp-bridge; dep: @remote-reader/shared, MCP SDK; 无原生依赖
├── tsconfig.json
└── src/
    ├── index.ts          # stdio MCP server 入口
    └── config.ts         # loadConfig
packages/shared/src/
├── api-client.ts         # createApiClient
├── tools/
│   └── upload-document.ts  # schema + description + handler
└── (现有 paths.ts / types.ts / index.ts)
packages/shared/src/api-client.test.ts
packages/shared/src/tools/upload-document.test.ts
apps/mcp-bridge/tests/config.test.ts
```

`packages/shared/package.json` 的 `exports` 增加 `"./api-client"` 与 `"./tools/upload-document"`。

## 10. 安全注意

- token 明文存于本地配置文件或 env——按机密处理；建议文件权限 `600`（实现时 `config.ts` 可 `chmod` 提示，不强制）。
- 桥与 Web 间应走 HTTPS（生产）。`baseUrl` 用 `https://`。
- 桥不向 Agent 回显 token（错误信息只说「token 无效」，不暴露 token）。
- 不在日志打印 token（只打印 `baseUrl`）。

## 11. 与总设计 spec 的差异/澄清

- 总 spec §8 描述的 `upload_document` 返回 `{id,url}` 不变；本桥把它包成 MCP 工具结果文本。
- 配置方式（文件+env 覆盖）是本子计划新定，总 spec 未细化。
- 运行时：桥用 bun 直跑（无原生依赖），与 Web 应用（生产用 node）不同——本子计划不涉及 better-sqlite3。

## 12. 验收标准

- `bun run test` 通过（含新增 api-client/config/handler 单测）。
- svelte-check 不涉及（桥非 SvelteKit）；桥若有 tsconfig，做一次 `tsc --noEmit` 无错。
- 集成：桥 + web dev，stdio 喂入 `tools/call upload_document` 拿到 `{id,url}`，且 web `/s/<token>` 可渲染。
- 错误注入（改坏 token → 401；断网 → 网络错）能经 MCP 结果返回。
