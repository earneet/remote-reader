import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApiClient } from '@remote-reader/shared/api-client';
import {
    uploadDocumentSchema,
    uploadDocumentDescription,
    uploadDocumentHandler
} from '@remote-reader/shared/tools/upload-document';
import { loadConfig } from './config';
import { getBridgeVersion } from './version';

async function main() {
    const cfg = loadConfig();
    const bridgeVersion = getBridgeVersion();
    // UA 声明桥版本（Layer ①）：服务端 access log 与兼容判断据此识别调用方
    const api = createApiClient({ ...cfg, userAgent: `remote-reader-bridge/${bridgeVersion}` });

    const server = new McpServer({ name: 'remote-reader', version: bridgeVersion });

    server.registerTool(
        'upload_document',
        { description: uploadDocumentDescription, inputSchema: uploadDocumentSchema },
        async (args) => {
            try {
                // clientVersion 供 Layer ③ 自检：服务端建议的最低版本更高时在结果文本提示升级
                return await uploadDocumentHandler(args, api, { clientVersion: bridgeVersion });
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
