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
