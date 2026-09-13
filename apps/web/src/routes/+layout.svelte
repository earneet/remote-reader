<script lang="ts">
    import '../styles/theme.css';
    import { page } from '$app/state';
    let { data, children } = $props();
    const showNav = $derived(
        !!data.user &&
        !(page.url.pathname === '/login' ||
          page.url.pathname === '/register' ||
          page.url.pathname.startsWith('/s/'))
    );

    // topnav 实际高度（换行/字体差异会变）→ CSS 变量，供文件管理器页做
    // 「顶栏 + 内容恰好铺满视口」的 app-shell 高度计算，避免硬编码魔法数字。
    // 用 offsetHeight（border-box）：clientHeight 不含 border-bottom 会少算 1px 导致整页溢出。
    let navH = $state(0);
    $effect(() => {
        if (navH > 0) document.documentElement.style.setProperty('--nav-h', `${navH}px`);
    });
</script>

{#if showNav}
<header class="topnav" bind:offsetHeight={navH}>
    <a href="/">我的文档</a>
    <form class="nav-search" method="GET" action="/search">
        <input name="q" placeholder="搜索文档…" aria-label="搜索文档">
    </form>
    <details>
        <summary>设置</summary>
        <div class="menu">
            <a href="/settings/tokens">API Token</a>
            <a href="/settings/shares">分享链接</a>
            <a href="/settings/tags">标签管理</a>
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
    .topnav .nav-search { margin-left: 0.5rem; }
    .topnav .nav-search input {
        padding: 0.3rem 0.6rem; border: 1px solid #d0d7de; border-radius: 5px;
        font-size: 0.85rem; width: 14rem;
    }

    /* 窄屏两行布局：搜索框固定 14rem 不收缩会把其余元素挤到竖排换行，
       故令其独占第二行满宽；email 截断防长地址撑爆。 */
    @media (max-width: 640px) {
        .topnav { flex-wrap: wrap; row-gap: 0.6rem; padding: 0.75rem 1rem; }
        .topnav .nav-search { order: 9; flex-basis: 100%; margin-left: 0; }
        .topnav .nav-search input { width: 100%; box-sizing: border-box; }
        .topnav .email {
            max-width: 7rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
    }
</style>
