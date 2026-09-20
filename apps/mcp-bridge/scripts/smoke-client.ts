import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const url = process.argv[2];
const token = process.argv[3];
if (!url || !token) {
    console.error('usage: bun apps/mcp-bridge/scripts/smoke-client.ts <baseUrl> <token>');
    console.error('  env: SMOKE_COMMAND（默认 bun）/ SMOKE_ARGS（逗号分隔，默认 apps/mcp-bridge/src/index.ts）');
    console.error('  例：SMOKE_COMMAND=node SMOKE_ARGS=apps/mcp-bridge/dist/index.ts（冒烟 npm 构建产物）');
    process.exit(2);
}

const transport = new StdioClientTransport({
    command: process.env.SMOKE_COMMAND ?? 'bun',
    args: (process.env.SMOKE_ARGS ?? 'apps/mcp-bridge/src/index.ts').split(','),
    env: { ...process.env, REMOTE_READER_URL: url, REMOTE_READER_TOKEN: token } as Record<string, string>
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
