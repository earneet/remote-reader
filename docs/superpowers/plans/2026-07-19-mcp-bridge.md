# 本地 MCP 桥 实现计划（子计划 2/3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `apps/mcp-bridge`——一个 stdio MCP server，暴露 `upload_document` 工具，本地持有 API token 转发到 Web 应用 `POST /api/v1/documents`，让 Agent 像调任何 MCP 工具一样上传文档拿到查看链接。

**Architecture:** 工具逻辑与 transport 解耦（spec 总设计 §3.2）。`packages/shared` 提供 `api-client`（HTTP）+ `tools/upload-document`（schema+handler），无 MCP transport 依赖；`apps/mcp-bridge` 只接 stdio transport（`@modelcontextprotocol/sdk` 高级 `McpServer`）。配置 = 文件默认（XDG）+ env 覆盖。桥无原生依赖 → bun 直跑。

**Tech Stack:** TypeScript · Bun（运行+测试宿主） · `@modelcontextprotocol/sdk` v1.x（`McpServer` + `StdioServerTransport`） · `zod`（工具 schema） · vitest（node 跑测试） · 全局 `fetch`（HTTP）。

**设计 spec：** [`docs/superpowers/specs/2026-07-19-mcp-bridge-design.md`](../specs/2026-07-19-mcp-bridge-design.md)。**改动前必读 spec。**

**运行时约定（项目既有）：** 桥无原生依赖，bun 可直接跑（`bun apps/mcp-bridge/src/index.ts`，无需 build）。测试用 vitest（`bun run test`，node 运行时）。stdout 仅走 MCP 协议；所有日志 `console.error`。

---

## 文件结构

```
packages/shared/
├── package.json                      # Modify: exports 加 ./api-client、./tools/upload-document；dep 加 zod；devDep 加 @types/node
└── src/
    ├── api-client.ts                 # Create: createApiClient + ApiError
    ├── api-client.test.ts            # Create
    ├── tools/
    │   ├── upload-document.ts        # Create: schema + description + handler
    │   └── upload-document.test.ts   # Create
apps/mcp-bridge/
├── package.json                      # Create
├── tsconfig.json                     # Create
├── src/
│   ├── config.ts                     # Create: loadConfig
│   └── index.ts                      # Create: stdio MCP server 入口
├── tests/
│   └── config.test.ts                # Create
└── scripts/
    └── smoke-client.ts               # Create: 集成冒烟用 MCP 客户端
vitest.config.ts                      # Modify: include 加 apps/mcp-bridge/tests
docs/USER_GUIDE.md                    # Modify: §2.4 从"规划中"改为实际接入说明
docs/PRODUCT.md                       # Modify: 桥标为 ✅
README.md                             # Modify: 加桥接入一节
```

---

## Task 1: packages/shared — api-client（HTTP 客户端）

**Files:**
- Create: `packages/shared/src/api-client.ts`
- Test: `packages/shared/src/api-client.test.ts`
- Modify: `packages/shared/package.json`（加 `@types/node` devDep、exports 加 `./api-client`）

- [ ] **Step 1: 给 shared 加 @types/node（fetch/Response 类型）**

Run（从仓库根）: `bun --filter @remote-reader/shared add -d @types/node`
Expected: 安装成功（若 `--filter` 报 404，改 `cd packages/shared && bun add -d @types/node`）。

- [ ] **Step 2: 写失败测试 `packages/shared/src/api-client.test.ts`**

```ts
import { test, expect, vi, beforeEach } from 'vitest';
import { createApiClient, ApiError } from './api-client';

beforeEach(() => { vi.unstubAllGlobals(); });

function mockFetch(status: number, body: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' }
    })));
}

test('uploadDocument 构造正确请求并解析响应', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response(JSON.stringify({ id: 'd1', url: 'http://x/s/t' }), { status: 200 });
    }));
    const api = createApiClient({ baseUrl: 'https://app.example.com/', token: 'rr_abc' });
    const r = await api.uploadDocument({ name: 'a.md', content: 'x', path: 'p' });
    expect(r).toEqual({ id: 'd1', url: 'http://x/s/t' });
    expect(captured.url).toBe('https://app.example.com/api/v1/documents');
    expect(captured.init!.method).toBe('POST');
    expect((captured.init!.headers as Record<string, string>)['Authorization']).toBe('Bearer rr_abc');
    expect(JSON.parse(captured.init!.body as string)).toEqual({ name: 'a.md', content: 'x', path: 'p' });
});

test('无 path 时 body 不含 path', async () => {
    let body: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
        body = init.body as string;
        return new Response(JSON.stringify({ id: 'd', url: 'u' }), { status: 200 });
    }));
    await createApiClient({ baseUrl: 'http://x', token: 't' }).uploadDocument({ name: 'n', content: 'c' });
    expect(JSON.parse(body!)).toEqual({ name: 'n', content: 'c' });
});

test('baseUrl 去尾斜杠', async () => {
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { url = u; return new Response('{"id":"1","url":"u"}', { status: 200 }); }));
    await createApiClient({ baseUrl: 'http://x///', token: 't' }).uploadDocument({ name: 'n', content: 'c' });
    expect(url).toBe('http://x/api/v1/documents');
});

test('400 映射为 ApiError(400)', async () => {
    mockFetch(400, { type: 'error', error: { message: 'invalid path' } });
    await expect(createApiClient({ baseUrl: 'http://x', token: 't' }).uploadDocument({ name: '../x', content: 'c' }))
        .rejects.toMatchObject({ status: 400 });
});

test('401 / 413 / 429 映射', async () => {
    for (const s of [401, 413, 429]) {
        mockFetch(s, {});
        await expect(createApiClient({ baseUrl: 'http://x', token: 't' }).uploadDocument({ name: 'n', content: 'c' }))
            .rejects.toMatchObject({ status: s });
    }
});

test('网络错误映射为 ApiError(status=0)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND'); }));
    await expect(createApiClient({ baseUrl: 'http://x', token: 't' }).uploadDocument({ name: 'n', content: 'c' }))
        .rejects.toMatchObject({ status: 0 });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `bun run test packages/shared/src/api-client.test.ts`
Expected: FAIL（`./api-client` 未导出）。

- [ ] **Step 4: 实现 `packages/shared/src/api-client.ts`**

```ts
export class ApiError extends Error {
    constructor(public status: number, message: string) {
        super(message);
        this.name = 'ApiError';
    }
}

export interface ApiClient {
    uploadDocument(input: { name: string; content: string; path?: string }): Promise<{ id: string; url: string }>;
}

function mapMessage(status: number, msg: string | undefined): string {
    switch (status) {
        case 400: return msg ? `请求非法：${msg}` : '请求非法（name/path 含非法字符或字段缺失）';
        case 401: return 'API token 无效或已撤销';
        case 413: return '内容超过大小上限';
        case 429: return '上传过于频繁，请稍后重试';
        default: return `上传失败：HTTP ${status}`;
    }
}

export function createApiClient(opts: { baseUrl: string; token: string }): ApiClient {
    const baseUrl = opts.baseUrl.replace(/\/+$/, '');
    return {
        async uploadDocument({ name, content, path }) {
            let res: Response;
            try {
                res = await fetch(`${baseUrl}/api/v1/documents`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${opts.token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(path ? { name, content, path } : { name, content })
                });
            } catch (e) {
                throw new ApiError(0, `无法连接服务器：${(e as Error).message}`);
            }
            const text = await res.text();
            let body: any = {};
            try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
            if (!res.ok) {
                const msg = typeof body?.error?.message === 'string' ? body.error.message : undefined;
                throw new ApiError(res.status, mapMessage(res.status, msg));
            }
            if (typeof body?.id !== 'string' || typeof body?.url !== 'string') {
                throw new ApiError(res.status, '上传成功但响应格式异常');
            }
            return { id: body.id, url: body.url };
        }
    };
}
```

- [ ] **Step 5: 更新 `packages/shared/package.json` 的 exports**

把 `exports` 改为：
```json
{
  ".": "./src/index.ts",
  "./paths": "./src/paths.ts",
  "./types": "./src/types.ts",
  "./api-client": "./src/api-client.ts"
}
```

- [ ] **Step 6: 运行确认通过**

Run: `bun run test packages/shared/src/api-client.test.ts`
Expected: PASS（全部 6 用例）。

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/api-client.ts packages/shared/src/api-client.test.ts packages/shared/package.json bun.lock
git commit -m "feat(shared): api-client for web API (sub-plan 2)"
```

---

## Task 2: packages/shared — upload_document 工具定义

**Files:**
- Create: `packages/shared/src/tools/upload-document.ts`
- Test: `packages/shared/src/tools/upload-document.test.ts`
- Modify: `packages/shared/package.json`（加 zod dep、exports 加 `./tools/upload-document`）

- [ ] **Step 1: 给 shared 加 zod**

Run: `cd packages/shared && bun add zod`（或 `bun --filter @remote-reader/shared add zod`，看哪个不报 404）。
Expected: 安装成功（zod v3.x）。

- [ ] **Step 2: 写失败测试 `packages/shared/src/tools/upload-document.test.ts`**

```ts
import { test, expect, vi } from 'vitest';
import {
    uploadDocumentHandler,
    uploadDocumentSchema,
    uploadDocumentDescription
} from './upload-document';

test('description 非空且引导把 url 发给用户', () => {
    expect(uploadDocumentDescription).toBeTruthy();
    expect(uploadDocumentDescription).toContain('url');
});

test('schema 接受 name+content（无 path）', () => {
    expect(uploadDocumentSchema.safeParse({ name: 'a.md', content: 'x' }).success).toBe(true);
});
test('schema 接受带 path', () => {
    expect(uploadDocumentSchema.safeParse({ name: 'a.md', content: 'x', path: 'r' }).success).toBe(true);
});
test('schema 拒绝缺 name', () => {
    expect(uploadDocumentSchema.safeParse({ content: 'x' }).success).toBe(false);
});

test('handler 透传参数并返回 MCP 结果形状', async () => {
    const api = { uploadDocument: vi.fn(async () => ({ id: 'd1', url: 'http://s/t' })) };
    const r = await uploadDocumentHandler({ name: 'a.md', content: 'c', path: 'p' }, api);
    expect(api.uploadDocument).toHaveBeenCalledWith({ name: 'a.md', content: 'c', path: 'p' });
    expect(r.content[0]).toMatchObject({ type: 'text' });
    expect(r.content[0].text).toContain('http://s/t');
});

test('handler 透传 api 错误（不吞）', async () => {
    const api = { uploadDocument: vi.fn(async () => { throw new Error('boom'); }) };
    await expect(uploadDocumentHandler({ name: 'a', content: 'b' }, api)).rejects.toThrow('boom');
});
```

- [ ] **Step 3: 运行确认失败**

Run: `bun run test packages/shared/src/tools/upload-document.test.ts`
Expected: FAIL（模块未导出）。

- [ ] **Step 4: 实现 `packages/shared/src/tools/upload-document.ts`**

```ts
import { z } from 'zod';

export const uploadDocumentSchema = z.object({
    name: z.string().describe('文档文件名，如 "weekly.md"。禁含 .. / 绝对路径 / \\ : * ? " < > | / null byte'),
    content: z.string().describe('Markdown 正文（UTF-8）'),
    path: z.string().optional().describe('可选目录前缀，POSIX 风格，如 "reports/2026-07"')
});

export const uploadDocumentDescription = [
    '幂等上传一份 Markdown 文档到 Remote Reader，返回一个免登录、点开即见渲染结果的查看链接。',
    '同 path+name+内容重复上传不产生重复，链接长期稳定；内容变化则原地覆盖、链接不变。',
    '上传成功后，请把返回的 url 通过当前对话/IM 发给用户，并简述文档内容。'
].join(' ');

export interface UploadDocumentArgs {
    name: string;
    content: string;
    path?: string;
}

export async function uploadDocumentHandler(
    args: UploadDocumentArgs,
    api: { uploadDocument(input: UploadDocumentArgs): Promise<{ id: string; url: string }> }
): Promise<{ content: { type: 'text'; text: string }[] }> {
    const { id, url } = await api.uploadDocument(args);
    return { content: [{ type: 'text', text: `已上传（id=${id}）。查看链接：${url}` }] };
}
```

- [ ] **Step 5: 更新 `packages/shared/package.json` 的 exports**

在 `exports` 加一行：
```json
"./tools/upload-document": "./src/tools/upload-document.ts"
```

- [ ] **Step 6: 运行确认通过**

Run: `bun run test packages/shared/src/tools/upload-document.test.ts`
Expected: PASS（全部）。

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/tools packages/shared/package.json bun.lock
git commit -m "feat(shared): upload_document tool definition (sub-plan 2)"
```

---

## Task 3: apps/mcp-bridge — 脚手架 + config 加载

**Files:**
- Create: `apps/mcp-bridge/package.json`
- Create: `apps/mcp-bridge/tsconfig.json`
- Create: `apps/mcp-bridge/src/config.ts`
- Test: `apps/mcp-bridge/tests/config.test.ts`
- Modify: `vitest.config.ts`（include 加 `apps/mcp-bridge/tests`）

- [ ] **Step 1: 写 `apps/mcp-bridge/package.json`**

```json
{
  "name": "remote-reader-mcp-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "bun src/index.ts",
    "check": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "@remote-reader/shared": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0"
  }
}
```

> zod 由 `@remote-reader/shared` 间接提供（shared 已加 zod）；桥直接用 shared 导出的 schema 对象，不直接 import zod。

- [ ] **Step 2: 写 `apps/mcp-bridge/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tests", "scripts"]
}
```

- [ ] **Step 3: 安装依赖**

Run: `bun install`
Expected: workspace 解析 `@remote-reader/shared` + 装 `@modelcontextprotocol/sdk`，无错误。

- [ ] **Step 4: 写失败测试 `apps/mcp-bridge/tests/config.test.ts`**

```ts
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config';

const TMP = './data/test-bridge-config';
const CFG_DIR = join(TMP, 'remote-reader');
const CFG_FILE = join(CFG_DIR, 'config.json');

beforeEach(() => {
    mkdirSync(CFG_DIR, { recursive: true });
    process.env.XDG_CONFIG_HOME = TMP;
});
afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.REMOTE_READER_URL;
    delete process.env.REMOTE_READER_TOKEN;
    rmSync(TMP, { recursive: true, force: true });
});

test('从配置文件读', () => {
    writeFileSync(CFG_FILE, JSON.stringify({ baseUrl: 'https://app', token: 'rr_f' }));
    expect(loadConfig()).toEqual({ baseUrl: 'https://app', token: 'rr_f' });
});

test('env 覆盖文件', () => {
    writeFileSync(CFG_FILE, JSON.stringify({ baseUrl: 'https://file', token: 'rr_file' }));
    process.env.REMOTE_READER_URL = 'https://env';
    process.env.REMOTE_READER_TOKEN = 'rr_env';
    expect(loadConfig()).toEqual({ baseUrl: 'https://env', token: 'rr_env' });
});

test('仅 env（无文件）也能工作', () => {
    rmSync(CFG_DIR, { recursive: true, force: true });
    process.env.REMOTE_READER_URL = 'https://env';
    process.env.REMOTE_READER_TOKEN = 'rr_env';
    expect(loadConfig()).toEqual({ baseUrl: 'https://env', token: 'rr_env' });
});

test('都缺失则 process.exit(1)', () => {
    rmSync(CFG_DIR, { recursive: true, force: true });
    const spy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('exit-1');
    }) as never);
    expect(() => loadConfig()).toThrow('exit-1');
    expect(spy).toHaveBeenCalledWith(1);
    spy.mockRestore();
});
```

- [ ] **Step 5: 更新根 `vitest.config.ts` 的 include**

把 include 数组改为：
```ts
include: [
    'packages/shared/src/**/*.test.ts',
    'apps/web/tests/**/*.test.ts',
    'apps/mcp-bridge/tests/**/*.test.ts'
],
```

- [ ] **Step 6: 运行确认失败**

Run: `bun run test apps/mcp-bridge/tests/config.test.ts`
Expected: FAIL（`../src/config` 未找到）。

- [ ] **Step 7: 实现 `apps/mcp-bridge/src/config.ts`**

```ts
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface BridgeConfig {
    baseUrl: string;
    token: string;
}

function configFilePath(): string {
    const xdg = process.env.XDG_CONFIG_HOME;
    const base = xdg ? join(xdg, 'remote-reader') : join(homedir(), '.config', 'remote-reader');
    return join(base, 'config.json');
}

export function loadConfig(): BridgeConfig {
    let fileUrl: string | undefined;
    let fileToken: string | undefined;
    const file = configFilePath();
    if (existsSync(file)) {
        try {
            const parsed = JSON.parse(readFileSync(file, 'utf-8'));
            if (typeof parsed?.baseUrl === 'string') fileUrl = parsed.baseUrl;
            if (typeof parsed?.token === 'string') fileToken = parsed.token;
        } catch {
            // 配置文件损坏：忽略，靠 env 兜底
        }
    }
    const baseUrl = (process.env.REMOTE_READER_URL || fileUrl || '').trim();
    const token = (process.env.REMOTE_READER_TOKEN || fileToken || '').trim();
    if (!baseUrl || !token) {
        console.error(
            '[remote-reader] 缺少配置：需要 baseUrl 与 token。\n' +
            '  方式一：设环境变量 REMOTE_READER_URL 与 REMOTE_READER_TOKEN。\n' +
            `  方式二：写配置文件 ${file}，内容 {"baseUrl":"https://...","token":"rr_..."}。`
        );
        process.exit(1);
    }
    return { baseUrl, token };
}
```

- [ ] **Step 8: 运行确认通过**

Run: `bun run test apps/mcp-bridge/tests/config.test.ts`
Expected: PASS（全部 4 用例）。

- [ ] **Step 9: Commit**

```bash
git add apps/mcp-bridge vitest.config.ts bun.lock
git commit -m "feat(mcp-bridge): scaffold + config loader (sub-plan 2)"
```

---

## Task 4: apps/mcp-bridge — stdio MCP server 入口

**Files:**
- Create: `apps/mcp-bridge/src/index.ts`

- [ ] **Step 1: 实现 `apps/mcp-bridge/src/index.ts`**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApiClient } from '@remote-reader/shared/api-client';
import {
    uploadDocumentSchema,
    uploadDocumentDescription,
    uploadDocumentHandler
} from '@remote-reader/shared/tools/upload-document';
import { loadConfig } from './config';

async function main() {
    const cfg = loadConfig();
    const api = createApiClient(cfg);

    const server = new McpServer({ name: 'remote-reader', version: '0.1.0' });

    server.registerTool(
        'upload_document',
        { description: uploadDocumentDescription, inputSchema: uploadDocumentSchema },
        async (args) => {
            try {
                return await uploadDocumentHandler(args, api);
            } catch (e) {
                return {
                    isError: true as const,
                    content: [{ type: 'text' as const, text: (e as Error).message }]
                };
            }
        }
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[remote-reader] MCP bridge on stdio → ${cfg.baseUrl}`);
}

main().catch((e) => {
    console.error('[remote-reader] fatal:', e);
    process.exit(1);
});
```

- [ ] **Step 2: 类型检查**

Run: `cd apps/web 2>/dev/null; cd ../mcp-bridge && bun run check`（或在仓库根 `bun --filter remote-reader-mcp-bridge check`）
Expected: 0 error。若 `@modelcontextprotocol/sdk/server/mcp.js` 类型解析问题，确认 `bun install` 已装 SDK；若 `registerTool` 的 `args` 类型与 handler 不匹配，把 handler 内联或断言 `args as UploadDocumentArgs`。

- [ ] **Step 3: 启动冒烟（应起来并等 stdin，日志走 stderr）**

Run:
```bash
REMOTE_READER_URL=http://localhost:5173 REMOTE_READER_TOKEN=rr_dummy \
  timeout 2 bun apps/mcp-bridge/src/index.ts
```
Expected: stderr 打印 `[remote-reader] MCP bridge on stdio → http://localhost:5173`，2 秒后 timeout 退出（无 fatal）。

- [ ] **Step 4: 缺配置时退出码 1**

Run: `timeout 2 env -u REMOTE_READER_URL -u REMOTE_READER_TOKEN XDG_CONFIG_HOME=./data/empty-no-cfg bun apps/mcp-bridge/src/index.ts; echo "exit=$?"`
Expected: stderr 打印「缺少配置」指引，`exit=1`（非 124 timeout）。

- [ ] **Step 5: Commit**

```bash
git add apps/mcp-bridge/src/index.ts
git commit -m "feat(mcp-bridge): stdio MCP server with upload_document (sub-plan 2)"
```

---

## Task 5: 集成冒烟（桥 → Web 全链路）

**Files:**
- Create: `apps/mcp-bridge/scripts/smoke-client.ts`

- [ ] **Step 1: 写 `apps/mcp-bridge/scripts/smoke-client.ts`**

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const url = process.argv[2];
const token = process.argv[3];
if (!url || !token) {
    console.error('usage: bun apps/mcp-bridge/scripts/smoke-client.ts <baseUrl> <token>');
    process.exit(2);
}

const transport = new StdioClientTransport({
    command: 'bun',
    args: ['apps/mcp-bridge/src/index.ts'],
    env: { ...process.env, REMOTE_READER_URL: url, REMOTE_READER_TOKEN: token }
});
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

const r = await client.callTool({
    name: 'upload_document',
    arguments: {
        name: 'bridge-smoke.md',
        content: '# from bridge\n\n```ts\nconst x: number = 1;\n```\n',
        path: 'smoke'
    }
}) as { isError?: boolean; content?: { type: string; text: string }[] };

console.log(JSON.stringify(r));
await client.close();
process.exit(r.isError ? 1 : 0);
```

- [ ] **Step 2: 起 Web dev 并 seed token（另开终端或后台）**

Run（仓库根）:
```bash
bun --filter remote-reader-web dev --port 5174 &   # 5173 可能被占
sleep 5
TOKEN=$(node scripts/seed-token.mjs t4@example.com | sed 's/^TOKEN=//')
echo "$TOKEN" > /tmp/rr_bridge_token.txt
```
Expected: dev 就绪；seed 输出 token（存 /tmp）。

- [ ] **Step 3: 跑集成冒烟**

Run:
```bash
TOKEN=$(cat /tmp/rr_bridge_token.txt)
bun apps/mcp-bridge/scripts/smoke-client.ts http://localhost:5174 "$TOKEN"
echo "exit=$?"
```
Expected: stdout 打印的 JSON `content[0].text` 含 `/s/<token>` 查看链接，无 `isError`，`exit=0`。Web 侧 `apps/web/data/documents/<ownerId>/smoke/bridge-smoke.md` 落盘。

- [ ] **Step 4: 错误注入——坏 token 应返回 isError**

Run:
```bash
bun apps/mcp-bridge/scripts/smoke-client.ts http://localhost:5174 rr_bogus_token
echo "exit=$?"
```
Expected: JSON 含 `"isError":true`，`content[0].text` 含「token 无效或已撤销」，`exit=1`。

- [ ] **Step 5: 停 dev**

Run: `pkill -f "remote-reader-web dev"`（或按端口找 PID kill）。

- [ ] **Step 6: Commit**

```bash
git add apps/mcp-bridge/scripts/smoke-client.ts
git commit -m "test(mcp-bridge): stdio integration smoke client (sub-plan 2)"
```

---

## Task 6: 文档同步（桥已可用）

**Files:**
- Modify: `docs/USER_GUIDE.md`（§2.4 改为实际接入）
- Modify: `docs/PRODUCT.md`（桥标 ✅）
- Modify: `README.md`（加桥接入一节）

- [ ] **Step 1: 更新 `docs/USER_GUIDE.md` 的 §2.4**

把「🚧 规划中：本地 MCP 桥」一节替换为实际接入说明（示例）：

```markdown
### 2.4 本地 MCP 桥 ✅

桥已实现（`apps/mcp-bridge`），让 Agent 以 MCP 工具调用上传。两种配置方式：

**方式一：环境变量**（推荐，配合 MCP client）

在 Claude Code 注册桥（env 传 url+token）：
\`\`\`bash
claude mcp add remote-reader bun apps/mcp-bridge/src/index.ts \
  -e REMOTE_READER_URL=https://your-host \
  -e REMOTE_READER_TOKEN=rr_xxx
\`\`\`

**方式二：配置文件**

写 \`~/.config/remote-reader/config.json\`（或 \`$XDG_CONFIG_HOME/remote-reader/config.json\`）：
\`\`\`json
{ "baseUrl": "https://your-host", "token": "rr_xxx" }
\`\`\`
然后只注册命令：\`claude mcp add remote-reader bun apps/mcp-bridge/src/index.ts\`。

env 优先于文件。配置缺失桥启动即退并提示。Agent 即可调用 \`upload_document({name, content, path?})\`，拿到查看链接。
```

- [ ] **Step 2: 更新 `docs/PRODUCT.md` 的功能清单与路线图**

把「🚧 子计划 2 · 本地 MCP 桥」改为「✅ 本地 MCP 桥（`apps/mcp-bridge`，stdio，`upload_document` 工具，文件+env 配置）」；路线图表里子计划 2 状态改为 ✅。

- [ ] **Step 3: 更新 `README.md`**

在「快速开始」之后加一节「## 通过 MCP 桥上传（Agent）」，简述 `claude mcp add ... bun apps/mcp-bridge/src/index.ts -e REMOTE_READER_URL=... -e REMOTE_READER_TOKEN=...`，并链到 `docs/USER_GUIDE.md` §2.4。

- [ ] **Step 4: 全量验证**

Run: `bun run test`
Expected: 全部测试通过（含新增 api-client / upload-document / config）。

Run: `bun --filter remote-reader-mcp-bridge check`
Expected: 0 error。

- [ ] **Step 5: Commit**

```bash
git add docs/USER_GUIDE.md docs/PRODUCT.md README.md
git commit -m "docs: MCP bridge now available (sub-plan 2 complete)"
```

---

## Self-Review 记录

**1. Spec 覆盖**（对照 spec §2 目标 / §4 组件 / §6 错误 / §8 测试 / §12 验收）：
- §4.1 api-client（createApiClient + ApiError + 错误映射）→ Task 1 ✓
- §4.2 upload-document（schema + description + handler）→ Task 2 ✓
- §4.3 config（文件 + env 覆盖 + 缺失退出）→ Task 3 ✓
- §4.4 index.ts（McpServer + registerTool + try/catch isError）→ Task 4 ✓
- §6 错误逐请求返回 → Task 1（api-client 映射）+ Task 4（桥 try/catch）+ Task 5 步骤 4（401 验证）✓
- §8 测试（api-client/config/handler 单测 + 集成）→ Task 1/2/3 单测 + Task 5 集成 ✓
- §12 验收（test 通过、tsc 无错、集成拿到 url、错误注入）→ Task 5 + Task 6 步骤 4 ✓

**2. 占位扫描**：无 TBD/TODO；所有代码块完整。SDK 版本用 caret（`^1.29.0`）由 `bun install` 解析实际版本；若解析失败 Task 4 步骤 2 有排查指引。

**3. 类型一致性**：`createApiClient({baseUrl,token})` → `uploadDocument({name,content,path?})` → `{id,url}`，在 Task 1/2/4 一致。`uploadDocumentHandler(args, api)` 签名在 Task 2 定义、Task 4 调用一致。`loadConfig(): BridgeConfig` 在 Task 3 定义、Task 4 调用一致。`uploadDocumentSchema`/`uploadDocumentDescription`/`uploadDocumentHandler` 三处导出名一致。

**4. 已知风险**（执行时留意）：
- `@modelcontextprotocol/sdk` 的 `registerTool` 对 zod schema 的接受方式（直接传 zod 对象 vs 需 `.shape`）若与预期不符，Task 4 步骤 2 会暴露——按报错调整（如传 `uploadDocumentSchema` 或其 `.shape`）。
- 桥的 `tsc --noEmit` 跨 workspace 导入 shared 源码时，需 `@types/node` 提供 `fetch` 类型（Task 1 已加到 shared）。
