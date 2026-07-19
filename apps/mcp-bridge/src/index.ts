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
