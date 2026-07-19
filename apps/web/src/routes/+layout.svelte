<script lang="ts">
    import { page } from '$app/state';
    let { data, children } = $props();
    const showNav = $derived(
        !!data.user &&
        !(page.url.pathname === '/login' ||
          page.url.pathname === '/register' ||
          page.url.pathname.startsWith('/s/'))
    );
</script>

{#if showNav}
<header class="topnav">
    <a href="/">我的文档</a>
    <details>
        <summary>设置</summary>
        <div class="menu">
            <a href="/settings/tokens">API Token</a>
            <a href="/settings/shares">分享链接</a>
        </div>
    </details>
    <span class="email">{data.user?.email}</span>
    <form method="POST" action="/logout">
        <button type="submit">登出</button>
    </form>
</header>
{/if}

<main>
    {@render children()}
</main>

<style>
    .topnav {
        display: flex; gap: 1.25rem; align-items: center;
        padding: 0.75rem 1.5rem; border-bottom: 1px solid #d0d7de;
        font-family: system-ui, sans-serif;
    }
    .topnav details { position: relative; }
    .topnav details summary { cursor: pointer; }
    .topnav .menu {
        position: absolute; top: 100%; left: 0; background: #fff;
        border: 1px solid #d0d7de; display: flex; flex-direction: column;
        padding: 0.25rem 0; min-width: 9rem; z-index: 10;
    }
    .topnav .menu a { padding: 0.4rem 0.75rem; text-decoration: none; color: #1f2328; }
    .topnav .menu a:hover { background: #f6f8fa; }
    .topnav .email { color: #57606a; margin-left: auto; }
</style>
