# remote-reader-bridge

[Remote Reader](https://github.com/earneet/remote-reader) 的本地 MCP 桥——把 Agent 的 MCP 工具调用（stdio）转发为对 Remote Reader 服务器的 HTTP 请求。桥持有 API token，不暴露给 Agent。

## 是什么

一个 stdio MCP server，暴露 `upload_document` 工具：

```
upload_document({ name, content, path? }) → { id, url }
```

上传 Markdown 文档到你的 Remote Reader 服务器，返回免登录查看链接。链接长期稳定（同路径同内容幂等；内容更新链接不变）。

## 配置（二选一，env 优先）

方式一：环境变量

```
REMOTE_READER_URL=https://your-host
REMOTE_READER_TOKEN=rr_xxx
```

方式二：配置文件 `~/.config/remote-reader/config.json`

```json
{ "baseUrl": "https://your-host", "token": "rr_xxx" }
```

token 在 Remote Reader 网页 `/settings/tokens` 创建（或 Agent 走登录页指引的 `/api/v1/auth/*` 端点自助获取）。

## 注册进 MCP 客户端

Claude Code：

```bash
claude mcp add remote-reader -- npx -y remote-reader-bridge \
  -e REMOTE_READER_URL=https://your-host \
  -e REMOTE_READER_TOKEN=rr_xxx
```

其他客户端（Cursor / Cline / Windsurf / opencode 等）用标准 `mcpServers` JSON：

```json
{
  "mcpServers": {
    "remote-reader": {
      "command": "npx",
      "args": ["-y", "remote-reader-bridge"],
      "env": { "REMOTE_READER_URL": "https://your-host", "REMOTE_READER_TOKEN": "rr_xxx" }
    }
  }
}
```

bun 用户可用 `bunx remote-reader-bridge` 替代 `npx -y remote-reader-bridge`。

## 文档

- 完整用户手册 / 部署指导：https://github.com/earneet/remote-reader#readme

## License

MIT
