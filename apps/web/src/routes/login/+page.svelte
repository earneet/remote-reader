<script lang="ts">
    import { enhance } from '$app/forms';
    import AuthCard from '$components/AuthCard.svelte';
    let { data, form } = $props();
    let loading = $state(false);
    let submitBtn = $state<HTMLButtonElement | null>(null);

    // Agent 指引块的 curl/配置文本在 script 层拼装——避免模板里转义 JSON 花括号
    const cloneCmd = $derived(`git clone ${data.repoUrl} && cd remote-reader && bun install`);
    const registerCurl = $derived(`curl -c cookies.txt -X POST ${data.baseUrl}/api/v1/auth/register \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"<邮箱>","password":"<密码，至少8位>","invite_code":"<邀请码>"}'`);
    const loginCurl = $derived(`curl -c cookies.txt -X POST ${data.baseUrl}/api/v1/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"<邮箱>","password":"<密码>"}'`);
    const tokenCurl = $derived(`curl -b cookies.txt -X POST ${data.baseUrl}/api/v1/auth/api-token \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"my-agent"}'`);
    const bridgeConfig = $derived(`{"baseUrl":"${data.baseUrl}","token":"rr_..."}`);
    const npmAddCmd = $derived('claude mcp add remote-reader -- npx -y remote-reader-bridge');
    const npmServersJson = $derived('{"mcpServers":{"remote-reader":{"command":"npx","args":["-y","remote-reader-bridge"]}}}');
</script>

<AuthCard title="登录" error={form?.error}>
    <form
        method="POST"
        use:enhance={() => {
            loading = true;
            return async ({ update }) => {
                await update();
                loading = false;
                // disabled 会把焦点抛回 body——失败后归还，键盘用户 Enter 重提交链不断
                submitBtn?.focus();
            };
        }}
    >
        <div class="field">
            <label for="email">邮箱</label>
            <input id="email" name="email" type="email" required autocomplete="email" />
        </div>
        <div class="field">
            <label for="password">密码</label>
            <input
                id="password"
                name="password"
                type="password"
                required
                autocomplete="current-password"
            />
        </div>
        <button type="submit" class="submit" bind:this={submitBtn} disabled={loading}>登录</button>
    </form>
    {#snippet footer()}
        没有账号？<a href="/register">注册</a>
    {/snippet}
</AuthCard>

<!-- Agent 自动接入指南：默认收起保持页面干净；内容始终在 SSR HTML 中，Agent fetch 本页即可读到全文 -->
<details class="agent-guide" id="agent-guide">
    <summary>Agent 自动接入指南（供 AI Agent 阅读）</summary>
    <div class="guide-body">
        <p>
            本站地址：<code>{data.baseUrl}</code>。如果你是 AI
            Agent，请按以下步骤用 curl 完成接入（全程无需浏览器）；注册用的邮箱与密码请和用户商量决定。
        </p>

        <h3>1. 安装本地 MCP 桥（二选一）</h3>
        <p>方式一（npm 包，推荐）：<code>npx -y remote-reader-bridge</code> 或 <code>bunx remote-reader-bridge</code>（node ≥18 即可，无需克隆仓库）</p>
        <p>方式二（源码克隆）：</p>
        <pre><code>{cloneCmd}</code></pre>
        <p>方式二的桥入口为 <code>remote-reader/apps/mcp-bridge/src/index.ts</code>，注册进 MCP 客户端时必须写绝对路径。</p>

        <h3>2. 注册账号（已有账号请改用登录）</h3>
        <pre><code>{registerCurl}</code></pre>
        <p>成功返回 <code>{'{"ok":true}'}</code> 并种 session cookie（存入 cookies.txt）。已有账号改用登录：</p>
        <pre><code>{loginCurl}</code></pre>

        <h3>3. 创建 API token</h3>
        <pre><code>{tokenCurl}</code></pre>
        <p>返回 <code>{'{"token":"rr_..."}'}</code>，明文仅此一次返回，立即保存。</p>

        <h3>4. 配置桥</h3>
        <p>写入 <code>~/.config/remote-reader/config.json</code>：</p>
        <pre><code>{bridgeConfig}</code></pre>
        <p>（或设环境变量 <code>REMOTE_READER_URL</code> / <code>REMOTE_READER_TOKEN</code>）</p>

        <h3>5. 注册进 MCP 客户端</h3>
        <p>npm 路线（推荐；已写第 4 步的 config.json 时无需再传 env）：Claude Code：</p>
        <pre><code>{npmAddCmd}</code></pre>
        <p>其他客户端用标准 mcpServers JSON：</p>
        <pre><code>{npmServersJson}</code></pre>
        <p>方式二（源码克隆）时改用绝对路径注册（Claude Code）：</p>
        <pre><code>claude mcp add remote-reader bun "/absolute/path/to/remote-reader/apps/mcp-bridge/src/index.ts"</code></pre>
        <p>其他客户端源码路线的 mcpServers JSON（入口同样写绝对路径）：</p>
        <pre><code>{'{"mcpServers":{"remote-reader":{"command":"bun","args":["/absolute/path/to/remote-reader/apps/mcp-bridge/src/index.ts"]}}}'}</code></pre>

        <h3>错误处理</h3>
        <p>
            非 2xx 响应体为 <code>{'{"message":"..."}'}</code>：403=邀请码无效（向用户索要有效邀请码）；
            409=邮箱已注册（改用登录端点）；429=限流（稍等重试）；401=session 失效（重新登录）。
            完成后即可通过 MCP 工具 <code>upload_document</code> 上传文档，返回免登录查看链接。
        </p>
    </div>
</details>

<style>
    .agent-guide {
        width: min(560px, calc(100vw - 2rem));
        margin: 1rem auto 2rem;
        background: var(--rr-card-bg);
        border: 1px solid var(--rr-card-border);
        border-radius: 12px;
        padding: 0.75rem 1.25rem;
        box-sizing: border-box;
        font-family: system-ui, -apple-system, sans-serif;
        color: var(--rr-text);
        font-size: 0.875rem;
    }

    .agent-guide summary {
        cursor: pointer;
        font-weight: 500;
        color: var(--rr-text-muted);
        user-select: none;
    }

    .agent-guide summary:hover {
        color: var(--rr-accent);
    }

    .agent-guide h3 {
        margin: 1rem 0 0.375rem;
        font-size: 0.9rem;
        color: var(--rr-text);
    }

    .agent-guide p {
        margin: 0.375rem 0;
        line-height: 1.6;
    }

    .agent-guide pre {
        margin: 0.375rem 0;
        padding: 0.6rem 0.75rem;
        background: var(--rr-input-bg);
        border: 1px solid var(--rr-border);
        border-radius: 6px;
        overflow-x: auto;
        font-size: 0.8rem;
    }

    .agent-guide code {
        color: var(--rr-text);
    }
</style>
