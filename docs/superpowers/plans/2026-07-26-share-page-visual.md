# /s/<token> 查看页渲染视觉改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把免登录查看页 `/s/<token>` 从朴素 GitHub 浅色升级为「精修 GitHub」视觉（浅灰底 + 白色文档卡 + 柔和阴影 + 圆角），新增深色模式、修复手机偏左布局 bug、Mermaid 浮卡（缩放/拖动/全屏）、桌面加宽到 960px、代码块等宽并关连字（ASCII flow 图友好）。

**Architecture:** CSS 变量（`--rr-*`）驱动深浅双态，`<html data-theme>` 属性切换；可测交互逻辑抽成纯函数（`theme.ts` / `mermaid-zoom.ts`）走 vitest TDD；markdown SSR 端给 `table` 包 overflow 壳防手机撑破；mermaid 从 `MarkdownViewer` 拆为独立 `MermaidViewer` 组件（浮卡 + 缩放 + 拖动 + 全屏 + 主题跟随）；`app.html` 内联防 FOUC 脚本。

**Tech Stack:** SvelteKit（Svelte 5 runes）/ TypeScript / markdown-it / Shiki / mermaid 11 / vitest（node 运行时，**无 svelte 组件测试框架**）。

**Spec:** `docs/superpowers/specs/2026-07-26-share-page-visual-design.md`

**测试约束说明：** 项目无 `@testing-library/svelte`，无法对 `.svelte` 组件做单测。故 Task 1/2/3 走严格 TDD（纯函数 + SSR 输出可测）；Task 4-8（CSS 变量、组件、页面）按「实现 → `svelte-check` 通过 → commit」，UI 视觉/交互在 Task 9 手动验证。

---

## File Structure

- **Create** `apps/web/src/lib/shared/theme.ts` — 主题解析纯函数（`resolveTheme` / `toggleTheme` / `THEME_STORAGE_KEY` / `Theme`）
- **Create** `apps/web/src/lib/shared/mermaid-zoom.ts` — 缩放计算纯函数（`clampZoom` / `nextZoom` / `formatZoom` / 常量）
- **Create** `apps/web/src/lib/components/ThemeToggle.svelte` — 深浅切换按钮
- **Create** `apps/web/src/lib/components/MermaidViewer.svelte` — mermaid 浮卡（缩放/拖动/全屏/主题跟随）
- **Modify** `apps/web/src/lib/server/markdown.ts` — `table_open`/`table_close` 包 `<div class="rr-table-wrap">`
- **Modify** `apps/web/src/lib/components/MarkdownViewer.svelte` — 颜色换 `var()`、宽度 960、防溢出、等宽关连字、移除 mermaid（接 `MermaidViewer`）
- **Modify** `apps/web/src/routes/+layout.svelte` — `:global()` CSS 变量 token（浅/深）+ body 背景
- **Modify** `apps/web/src/app.html` — `<head>` 内联防 FOUC 脚本
- **Modify** `apps/web/src/routes/s/[token]/+page.svelte` — 顶栏（返回 + ThemeToggle）
- **Test** `apps/web/tests/theme.test.ts`（新）
- **Test** `apps/web/tests/mermaid-zoom.test.ts`（新）
- **Test** `apps/web/tests/markdown.test.ts`（加用例）

> Alias 约定：`$lib` → `src/lib`（SvelteKit 默认）、`$components` → `src/lib/components`、`$server` → `src/lib/server`。**注意 `$shared` 已被 `packages/shared/src` 占用，本计划的纯函数用 `$lib/shared/`。**

---

## Task 1: 主题解析纯函数（TDD）

**Files:**
- Create: `apps/web/src/lib/shared/theme.ts`
- Test: `apps/web/tests/theme.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/web/tests/theme.test.ts`：

```ts
import { test, expect } from 'vitest';
import { resolveTheme, toggleTheme, THEME_STORAGE_KEY } from '../src/lib/shared/theme';

test('resolveTheme: stored 合法值优先', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
});

test('resolveTheme: 无 stored 时跟随系统', () => {
    expect(resolveTheme(null, true)).toBe('dark');
    expect(resolveTheme(null, false)).toBe('light');
});

test('resolveTheme: stored 非法值回退到系统', () => {
    expect(resolveTheme('garbage', true)).toBe('dark');
    expect(resolveTheme('', false)).toBe('light');
});

test('toggleTheme: 双向切换', () => {
    expect(toggleTheme('dark')).toBe('light');
    expect(toggleTheme('light')).toBe('dark');
});

test('THEME_STORAGE_KEY 为约定键名', () => {
    expect(THEME_STORAGE_KEY).toBe('rr-theme');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/theme.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/shared/theme'`

- [ ] **Step 3: 写最小实现**

创建 `apps/web/src/lib/shared/theme.ts`：

```ts
export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'rr-theme';

export function resolveTheme(stored: string | null, prefersDark: boolean): Theme {
    if (stored === 'light' || stored === 'dark') return stored;
    return prefersDark ? 'dark' : 'light';
}

export function toggleTheme(current: Theme): Theme {
    return current === 'dark' ? 'light' : 'dark';
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/theme.test.ts`
Expected: PASS（5 个用例全过）

- [ ] **Step 5: 类型检查 + commit**

Run: `bun --filter remote-reader-web check`
Expected: 0 error / 0 warning

```bash
git add apps/web/src/lib/shared/theme.ts apps/web/tests/theme.test.ts
git commit -m "feat(web): 主题解析纯函数 resolveTheme/toggleTheme + 测试"
```

---

## Task 2: mermaid 缩放纯函数（TDD）

**Files:**
- Create: `apps/web/src/lib/shared/mermaid-zoom.ts`
- Test: `apps/web/tests/mermaid-zoom.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/web/tests/mermaid-zoom.test.ts`：

```ts
import { test, expect } from 'vitest';
import {
    MIN_ZOOM,
    MAX_ZOOM,
    ZOOM_STEP,
    clampZoom,
    nextZoom,
    formatZoom
} from '../src/lib/shared/mermaid-zoom';

test('常量约定', () => {
    expect(MIN_ZOOM).toBe(0.5);
    expect(MAX_ZOOM).toBe(3);
    expect(ZOOM_STEP).toBe(0.2);
});

test('clampZoom: 范围内原值返回', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(2.5)).toBe(2.5);
});

test('clampZoom: 低于下限夹到下限', () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(-1)).toBe(MIN_ZOOM);
});

test('clampZoom: 高于上限夹到上限', () => {
    expect(clampZoom(5)).toBe(MAX_ZOOM);
});

test('nextZoom: 步进并夹取', () => {
    expect(nextZoom(1, ZOOM_STEP)).toBe(1.2);
    expect(nextZoom(MAX_ZOOM, ZOOM_STEP)).toBe(MAX_ZOOM);
    expect(nextZoom(MIN_ZOOM, -ZOOM_STEP)).toBe(MIN_ZOOM);
});

test('formatZoom: 百分比展示', () => {
    expect(formatZoom(1)).toBe('100%');
    expect(formatZoom(1.2)).toBe('120%');
    expect(formatZoom(0.5)).toBe('50%');
    expect(formatZoom(3)).toBe('300%');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/mermaid-zoom.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/shared/mermaid-zoom'`

- [ ] **Step 3: 写最小实现**

创建 `apps/web/src/lib/shared/mermaid-zoom.ts`：

```ts
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;
export const ZOOM_STEP = 0.2;

export function clampZoom(z: number): number {
    if (z < MIN_ZOOM) return MIN_ZOOM;
    if (z > MAX_ZOOM) return MAX_ZOOM;
    return z;
}

export function nextZoom(current: number, delta: number): number {
    return clampZoom(current + delta);
}

export function formatZoom(z: number): string {
    return Math.round(z * 100) + '%';
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/mermaid-zoom.test.ts`
Expected: PASS（6 个用例全过）

- [ ] **Step 5: commit**

```bash
git add apps/web/src/lib/shared/mermaid-zoom.ts apps/web/tests/mermaid-zoom.test.ts
git commit -m "feat(web): mermaid 缩放纯函数 clamp/next/format + 测试"
```

---

## Task 3: markdown 表格 SSR 包 overflow 壳（TDD）

修手机偏左根因的核心一环：宽表撑破容器。在 SSR 端给 `table` 包一层 `<div class="rr-table-wrap">`（CSS 控 `overflow-x:auto`）。

**Files:**
- Modify: `apps/web/src/lib/server/markdown.ts`（在 `getMarkdown()` 内、`mdInstance = md` 之前注册 renderer 规则）
- Test: `apps/web/tests/markdown.test.ts`（加用例）

- [ ] **Step 1: 写失败测试**

在 `apps/web/tests/markdown.test.ts` 末尾追加：

```ts
test('表格被 overflow 壳包裹（防手机撑破布局）', async () => {
    const html = await renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<div class="rr-table-wrap">');
    expect(html).toContain('</table></div>');
    expect(html).toContain('<table>');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/markdown.test.ts -t "表格被 overflow"`
Expected: FAIL — 输出含 `<table>` 但不含 `<div class="rr-table-wrap">`

- [ ] **Step 3: 写实现**

打开 `apps/web/src/lib/server/markdown.ts`，定位到 `getMarkdown()` 函数内 `md.renderer.rules.math_block = ...` 之后、`mdInstance = md` 之前，加入两条 renderer 规则：

```ts
    md.renderer.rules.table_open = () => '<div class="rr-table-wrap"><table>';
    md.renderer.rules.table_close = () => '</table></div>';
```

（缩进对齐该函数体内既有的 4 空格层级。）

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/markdown.test.ts`
Expected: PASS（含新用例 + 原有用例；原有「渲染表格（GFM）」断言 `toContain('<table>')` 仍成立，因为包壳后仍含 `<table>`）

- [ ] **Step 5: 回归 share-view + commit**

Run: `bun run test apps/web/tests/share-view.test.ts`
Expected: PASS（`+page.server.ts` 的 `load` 返回 html 含 `<h1>`，table 包壳不影响）

```bash
git add apps/web/src/lib/server/markdown.ts apps/web/tests/markdown.test.ts
git commit -m "feat(web): markdown 表格 SSR 包 overflow 壳（修手机撑破）+ 测试"
```

---

## Task 4: CSS 变量 token（浅/深）+ body 背景 + 防 FOUC 脚本

定义全局 CSS 变量与深色态覆盖，并在 `app.html` 注入防 FOUC 同步脚本（首屏前据 localStorage + `prefers-color-scheme` 设 `data-theme`）。

本 Task 只定义变量与设 `data-theme`，**不应用 body 背景**（避免 Task 7 前出现"深色态正文不可读"的破坏性中间态）；body 背景在 Task 7 与 `MarkdownViewer` 换 `var()` 一起加，保证浅深同时协调。

**Files:**
- Modify: `apps/web/src/routes/+layout.svelte`
- Modify: `apps/web/src/app.html`

- [ ] **Step 1: 改 `+layout.svelte` 注入全局变量**

打开 `apps/web/src/routes/+layout.svelte`，在 `<style>` 块的最前面（`.topnav` 之前）插入全局 token 定义与 body 背景：

```css
    :global(:root) {
        --rr-bg: #f6f8fa;
        --rr-card-bg: #ffffff;
        --rr-card-border: transparent;
        --rr-text: #1f2328;
        --rr-text-muted: #57606a;
        --rr-link: #0969da;
        --rr-border: #d0d7de;
        --rr-border-soft: #eaecef;
        --rr-inline-code-bg: #eff2f5;
        --rr-inline-code-text: #bc4b00;
        --rr-code-bg: #1e2228;
        --rr-shadow: 0 1px 3px rgba(0,0,0,.05), 0 10px 28px rgba(0,0,0,.06);
        --rr-toggle-bg: #eaeef1;
        color-scheme: light;
    }
    :global([data-theme="dark"]) {
        --rr-bg: #0d1117;
        --rr-card-bg: #161b22;
        --rr-card-border: #21262d;
        --rr-text: #c9d1d9;
        --rr-text-muted: #8b949e;
        --rr-link: #58a6ff;
        --rr-border: #21262d;
        --rr-border-soft: #21262d;
        --rr-inline-code-bg: rgba(110,118,129,.28);
        --rr-inline-code-text: #e3b341;
        --rr-code-bg: #0d1117;
        --rr-shadow: 0 10px 28px rgba(0,0,0,.45);
        --rr-toggle-bg: #21262d;
        color-scheme: dark;
    }
```

- [ ] **Step 2: 改 `app.html` 注入防 FOUC 脚本**

打开 `apps/web/src/app.html`，在 `<head>` 内、`%sveltekit.head%` 之前插入：

```html
        <script>
            (function () {
                try {
                    var t = localStorage.getItem('rr-theme');
                    if (t !== 'light' && t !== 'dark') {
                        t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                    }
                    document.documentElement.dataset.theme = t;
                } catch (e) {
                    document.documentElement.dataset.theme = 'light';
                }
            })();
        </script>
```

（逻辑与 `theme.ts` 的 `resolveTheme` 一致；此处必须内联自包含——模块在客户端 hydrate 后才跑，太晚会闪白。）

- [ ] **Step 3: 类型检查**

Run: `bun --filter remote-reader-web check`
Expected: 0 error / 0 warning

- [ ] **Step 4: commit**

```bash
git add apps/web/src/routes/+layout.svelte apps/web/src/app.html
git commit -m "feat(web): CSS 变量深浅 token + body 背景 + 防 FOUC 脚本"
```

---

## Task 5: ThemeToggle 深浅切换按钮组件

按钮显示当前态图标（浅色显月亮 / 深色显太阳），点击切换 `data-theme` 并写 `localStorage`。

**Files:**
- Create: `apps/web/src/lib/components/ThemeToggle.svelte`

- [ ] **Step 1: 写组件**

创建 `apps/web/src/lib/components/ThemeToggle.svelte`：

```svelte
<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { toggleTheme, type Theme, THEME_STORAGE_KEY } from '$lib/shared/theme';

    let current = $state<Theme>('light');
    let observer: MutationObserver | null = null;

    function readCurrent(): Theme {
        return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    }

    function onClick(): void {
        const next = toggleTheme(current);
        document.documentElement.dataset.theme = next;
        try {
            localStorage.setItem(THEME_STORAGE_KEY, next);
        } catch (e) {
            // 隐私模式等写入失败，忽略：DOM 已更新，本次会话仍生效
        }
        current = next;
    }

    onMount(() => {
        current = readCurrent();
        observer = new MutationObserver(() => {
            current = readCurrent();
        });
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
        });
    });
    onDestroy(() => observer?.disconnect());
</script>

<button
    type="button"
    class="rr-theme-toggle"
    onclick={onClick}
    aria-label="切换深浅色主题"
    title={current === 'dark' ? '切换到浅色' : '切换到深色'}
>
    {#if current === 'dark'}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="4.2" />
            <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
        </svg>
    {:else}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
    {/if}
</button>

<style>
    .rr-theme-toggle {
        width: 32px;
        height: 32px;
        border-radius: 8px;
        border: 1px solid var(--rr-border);
        background: var(--rr-toggle-bg);
        color: var(--rr-text-muted);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 0;
    }
    .rr-theme-toggle:hover {
        color: var(--rr-text);
    }
</style>
```

- [ ] **Step 2: 类型检查**

Run: `bun --filter remote-reader-web check`
Expected: 0 error / 0 warning

- [ ] **Step 3: commit**

```bash
git add apps/web/src/lib/components/ThemeToggle.svelte
git commit -m "feat(web): ThemeToggle 深浅切换按钮组件"
```

---

## Task 6: MermaidViewer 浮卡组件（缩放 / 拖动 / 全屏 / 主题跟随）

把原 `MarkdownViewer` 里的 `enhanceMermaid` 迁出并升级：mermaid 块渲染为独立浮卡，带 `−` / 百分比 / `+` / `⤢ 全屏`，缩放用 CSS `zoom`（影响布局 → 溢出可拖动滚动），主题变化时按新主题重渲。

**Files:**
- Create: `apps/web/src/lib/components/MermaidViewer.svelte`

- [ ] **Step 1: 写组件**

创建 `apps/web/src/lib/components/MermaidViewer.svelte`：

```svelte
<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { nextZoom, formatZoom, ZOOM_STEP } from '$lib/shared/mermaid-zoom';

    let { container }: { container: HTMLDivElement | undefined } = $props();

    let fullscreen = $state<{ svg: string; zoom: number } | null>(null);
    let themeObserver: MutationObserver | null = null;

    function currentTheme(): 'light' | 'dark' {
        return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    }

    async function loadMermaid() {
        const m = (await import('mermaid')).default;
        m.initialize({
            startOnLoad: false,
            theme: currentTheme() === 'dark' ? 'dark' : 'default'
        });
        return m;
    }

    $effect(() => {
        const root = container;
        if (root) void renderAll(root);
    });

    async function renderAll(root: HTMLElement): Promise<void> {
        const blocks = Array.from(root.querySelectorAll<HTMLElement>('code.language-mermaid'));
        if (blocks.length === 0) return;
        const mermaid = await loadMermaid();
        for (const code of blocks) {
            const pre = code.parentElement;
            if (!pre || pre.dataset.rrDone === '1') continue;
            pre.dataset.rrDone = '1';
            const raw = code.textContent ?? '';
            try {
                const id = 'mmd-' + Math.random().toString(36).slice(2, 9);
                const { svg } = await mermaid.render(id, raw);
                pre.replaceWith(buildCard(svg, raw));
            } catch (e) {
                console.warn('[mermaid] render failed', e);
                const fb = document.createElement('pre');
                fb.className = 'rr-mermaid-fallback';
                fb.textContent = raw;
                pre.replaceWith(fb);
            }
        }
    }

    function buildCard(svgMarkup: string, raw: string): HTMLElement {
        const card = document.createElement('div');
        card.className = 'rr-mermaid-card';
        card.dataset.rrRaw = encodeURIComponent(raw);

        const bar = document.createElement('div');
        bar.className = 'rr-mermaid-bar';
        const label = document.createElement('span');
        label.className = 'rr-mermaid-label';
        label.textContent = '图表';
        const ctrls = document.createElement('div');
        ctrls.className = 'rr-mermaid-ctrls';

        const canvas = document.createElement('div');
        canvas.className = 'rr-mermaid-canvas';
        canvas.innerHTML = svgMarkup;

        let zoom = 1;
        const pct = document.createElement('span');
        pct.className = 'rr-mermaid-pct';
        pct.title = '双击重置为 100%';
        const apply = (z: number): void => {
            zoom = z;
            pct.textContent = formatZoom(zoom);
            canvas.style.setProperty('zoom', String(zoom));
            canvas.style.cursor = zoom > 1 ? 'grab' : 'default';
        };
        apply(1);
        pct.addEventListener('dblclick', () => apply(1));

        const minus = mkBtn('−', '缩小', () => apply(nextZoom(zoom, -ZOOM_STEP)));
        const plus = mkBtn('+', '放大', () => apply(nextZoom(zoom, ZOOM_STEP)));
        const full = mkBtn('⤢', '全屏查看', () => {
            fullscreen = { svg: svgMarkup, zoom: 1 };
        });

        ctrls.append(minus, pct, plus, full);
        bar.append(label, ctrls);
        card.append(bar, canvas);
        enableDrag(canvas);
        return card;
    }

    function mkBtn(text: string, title: string, onClick: () => void): HTMLButtonElement {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'rr-mermaid-btn';
        b.textContent = text;
        b.title = title;
        b.addEventListener('click', onClick);
        return b;
    }

    function enableDrag(canvas: HTMLElement): void {
        let down = false;
        let sx = 0;
        let sy = 0;
        let sl = 0;
        let st = 0;
        canvas.addEventListener('mousedown', (e: MouseEvent) => {
            const overflowX = canvas.scrollWidth > canvas.clientWidth;
            const overflowY = canvas.scrollHeight > canvas.clientHeight;
            if (!overflowX && !overflowY) return;
            down = true;
            sx = e.pageX;
            sy = e.pageY;
            sl = canvas.scrollLeft;
            st = canvas.scrollTop;
            canvas.classList.add('dragging');
            e.preventDefault();
        });
        const onMove = (e: MouseEvent): void => {
            if (!down) return;
            canvas.scrollLeft = sl - (e.pageX - sx);
            canvas.scrollTop = st - (e.pageY - sy);
        };
        const onUp = (): void => {
            if (!down) return;
            down = false;
            canvas.classList.remove('dragging');
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }

    async function rerenderOnTheme(): Promise<void> {
        const root = container;
        if (!root) return;
        const cards = Array.from(root.querySelectorAll<HTMLElement>('.rr-mermaid-card'));
        if (cards.length === 0) return;
        const mermaid = await loadMermaid();
        for (const card of cards) {
            const raw = decodeURIComponent(card.dataset.rrRaw ?? '');
            if (!raw) continue;
            try {
                const id = 'mmd-' + Math.random().toString(36).slice(2, 9);
                const { svg } = await mermaid.render(id, raw);
                const cv = card.querySelector<HTMLElement>('.rr-mermaid-canvas');
                if (cv) cv.innerHTML = svg;
            } catch (e) {
                console.warn('[mermaid] rerender failed', e);
            }
        }
    }

    function onKey(e: KeyboardEvent): void {
        if (e.key === 'Escape') fullscreen = null;
    }

    function fsZoom(delta: number): void {
        if (!fullscreen) return;
        fullscreen.zoom = nextZoom(fullscreen.zoom, delta);
    }

    onMount(() => {
        themeObserver = new MutationObserver(() => {
            void rerenderOnTheme();
        });
        themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
        });
        window.addEventListener('keydown', onKey);
    });
    onDestroy(() => {
        themeObserver?.disconnect();
        window.removeEventListener('keydown', onKey);
    });
</script>

{#if fullscreen}
    <div
        class="rr-mermaid-overlay"
        role="dialog"
        aria-modal="true"
        onclick={() => {
            fullscreen = null;
        }}
    >
        <div
            class="rr-mermaid-overlay-inner"
            onclick={(e) => e.stopPropagation()}
        >
            <div class="rr-mermaid-bar">
                <span class="rr-mermaid-label">图表 · 全屏</span>
                <div class="rr-mermaid-ctrls">
                    <button type="button" class="rr-mermaid-btn" onclick={() => fsZoom(-ZOOM_STEP)}>−</button>
                    <span class="rr-mermaid-pct">{formatZoom(fullscreen.zoom)}</span>
                    <button type="button" class="rr-mermaid-btn" onclick={() => fsZoom(ZOOM_STEP)}>+</button>
                    <button
                        type="button"
                        class="rr-mermaid-btn"
                        title="关闭"
                        onclick={() => {
                            fullscreen = null;
                        }}
                    >✕</button>
                </div>
            </div>
            <div class="rr-mermaid-canvas is-fullscreen" style={`zoom:${fullscreen.zoom}`}>
                {@html fullscreen.svg}
            </div>
        </div>
    </div>
{/if}

<style>
    .rr-mermaid-card {
        border: 1px solid var(--rr-border);
        border-radius: 10px;
        background: var(--rr-card-bg);
        box-shadow: var(--rr-shadow);
        margin: 1rem 0;
        overflow: hidden;
    }
    .rr-mermaid-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 10px;
        border-bottom: 1px solid var(--rr-border-soft);
        background: var(--rr-bg);
    }
    .rr-mermaid-label {
        font-size: 12px;
        color: var(--rr-text-muted);
        font-weight: 600;
    }
    .rr-mermaid-ctrls {
        display: flex;
        gap: 4px;
        align-items: center;
    }
    .rr-mermaid-btn {
        min-width: 26px;
        height: 26px;
        padding: 0 6px;
        border: 1px solid var(--rr-border);
        border-radius: 5px;
        background: var(--rr-card-bg);
        color: var(--rr-text-muted);
        cursor: pointer;
        font-size: 13px;
        line-height: 1;
    }
    .rr-mermaid-btn:hover {
        color: var(--rr-text);
    }
    .rr-mermaid-pct {
        font-size: 11px;
        color: var(--rr-text-muted);
        min-width: 40px;
        text-align: center;
        user-select: none;
        cursor: pointer;
    }
    .rr-mermaid-canvas {
        padding: 16px;
        text-align: center;
        overflow: auto;
        max-height: 420px;
        min-width: 0;
    }
    .rr-mermaid-canvas.dragging {
        cursor: grabbing !important;
    }
    .rr-mermaid-canvas :global(svg) {
        max-width: 100%;
        height: auto;
    }
    .rr-mermaid-fallback {
        padding: 1rem;
        overflow-x: auto;
        background: var(--rr-code-bg);
        color: #e1e4e8;
        border-radius: 8px;
        margin: 1rem 0;
        font-family: ui-monospace, Menlo, monospace;
    }

    .rr-mermaid-overlay {
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
    }
    .rr-mermaid-overlay-inner {
        background: var(--rr-card-bg);
        border: 1px solid var(--rr-border);
        border-radius: 12px;
        max-width: 95vw;
        max-height: 92vh;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        width: 100%;
    }
    .rr-mermaid-canvas.is-fullscreen {
        overflow: auto;
        max-height: none;
        flex: 1;
        padding: 20px;
    }
</style>
```

- [ ] **Step 2: 类型检查**

Run: `bun --filter remote-reader-web check`
Expected: 0 error / 0 warning

- [ ] **Step 3: commit**

```bash
git add apps/web/src/lib/components/MermaidViewer.svelte
git commit -m "feat(web): MermaidViewer 浮卡（缩放/拖动/全屏/主题跟随）"
```

---

## Task 7: MarkdownViewer 重构（var / 960 / 防溢出 / 等宽关连字 / 接 MermaidViewer）

颜色硬编码换 CSS 变量；宽度 760→960；防溢出（pre/img/svg/table-wrap max-width + overflow）；代码块等宽字体栈 + `font-variant-ligatures:none` + `tab-size:4`（ASCII flow 图友好）；移除 `enhanceMermaid`（交给 `MermaidViewer`），保留 katex 增强。

**Files:**
- Modify: `apps/web/src/lib/components/MarkdownViewer.svelte`（整体重写 `<script>` 与 `<style>`，结构不变：仍一个 `.markdown-body` 容器 + `{@html html}`）
- Modify: `apps/web/src/routes/+layout.svelte`（应用 body 背景——此时正文已换 `var()`，浅深同时生效）

- [ ] **Step 1: 重写组件 + 应用 body 背景**

把 `apps/web/src/lib/components/MarkdownViewer.svelte` 整体替换为：

```svelte
<script lang="ts">
    import MermaidViewer from '$components/MermaidViewer.svelte';
    let { html }: { html: string } = $props();
    let container: HTMLDivElement | undefined = $state(undefined);

    $effect(() => {
        if (container) enhanceKatex(container);
    });

    async function enhanceKatex(root: HTMLElement): Promise<void> {
        const nodes = Array.from(root.querySelectorAll<HTMLElement>('.math.inline, .math.block'));
        if (nodes.length === 0) return;
        const katex = (await import('katex')).default;
        for (const el of nodes) {
            try {
                el.innerHTML = katex.renderToString(el.textContent ?? '', {
                    displayMode: el.classList.contains('block'),
                    throwOnError: false
                });
            } catch (e) {
                console.warn('[katex] render failed', e);
            }
        }
    }
</script>

<div class="markdown-body" bind:this={container}>
    {@html html}
</div>
<MermaidViewer {container} />

<style>
    .markdown-body {
        width: 100%;
        max-width: 960px;
        margin: 0 auto;
        padding: 2rem;
        box-sizing: border-box;
        min-width: 0;
        font-size: 16px;
        line-height: 1.75;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        color: var(--rr-text);
    }
    .markdown-body :global(a) {
        color: var(--rr-link);
    }
    .markdown-body :global(a:hover) {
        text-decoration: underline;
    }
    .markdown-body :global(h1),
    .markdown-body :global(h2) {
        border-bottom: 1px solid var(--rr-border-soft);
        padding-bottom: 0.3em;
    }
    .markdown-body :global(pre) {
        padding: 1rem;
        border-radius: 8px;
        overflow-x: auto;
        max-width: 100%;
        margin: 1rem 0;
        font-size: 0.9em;
        font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, "Liberation Mono", "DejaVu Sans Mono", Menlo, monospace;
        font-variant-ligatures: none;
        font-feature-settings: "liga" 0, "calt" 0;
        tab-size: 4;
    }
    .markdown-body :global(code) {
        font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, "Liberation Mono", "DejaVu Sans Mono", Menlo, monospace;
        font-variant-ligatures: none;
        font-feature-settings: "liga" 0, "calt" 0;
    }
    .markdown-body :global(:not(pre) > code) {
        padding: 0.15em 0.35em;
        background: var(--rr-inline-code-bg);
        color: var(--rr-inline-code-text);
        border-radius: 4px;
    }
    .markdown-body :global(.rr-table-wrap) {
        overflow-x: auto;
        max-width: 100%;
        margin: 1rem 0;
    }
    .markdown-body :global(table) {
        border-collapse: collapse;
    }
    .markdown-body :global(th),
    .markdown-body :global(td) {
        border: 1px solid var(--rr-border);
        padding: 0.4rem 0.8rem;
    }
    .markdown-body :global(blockquote) {
        border-left: 3px solid var(--rr-border);
        margin: 1rem 0;
        padding: 0 1rem;
        color: var(--rr-text-muted);
    }
    .markdown-body :global(img) {
        max-width: 100%;
    }
    .markdown-body :global(.math.block) {
        margin: 1rem 0;
        overflow-x: auto;
    }
    :global([data-theme="dark"]) .markdown-body :global(pre.shiki) {
        border: 1px solid var(--rr-border);
    }
    @media (max-width: 768px) {
        .markdown-body {
            padding: 1rem;
        }
    }
</style>
```

接着打开 `apps/web/src/routes/+layout.svelte`，在 Task 4 写入的 `:global([data-theme="dark"]) { ... }` 块之后追加 body 背景：

```css
    :global(body) {
        background: var(--rr-bg);
        color: var(--rr-text);
        margin: 0;
    }
```

- [ ] **Step 2: 类型检查**

Run: `bun --filter remote-reader-web check`
Expected: 0 error / 0 warning

- [ ] **Step 3: 回归测试**

Run: `bun run test apps/web/tests/markdown.test.ts apps/web/tests/share-view.test.ts`
Expected: PASS（table 包壳后仍含 `<table>`；share-view 的 `<h1>` 断言不受影响）

- [ ] **Step 4: commit**

```bash
git add apps/web/src/lib/components/MarkdownViewer.svelte
git commit -m "refactor(web): MarkdownViewer 样式重构（var/960/防溢出/等宽关连字）+ 接 MermaidViewer"
```

---

## Task 8: 查看页 `/s/[token]` 顶栏整合

把返回链接与 `ThemeToggle` 组成顶栏，宽度对齐 960，移除旧 `.back` 硬编码色。

**Files:**
- Modify: `apps/web/src/routes/s/[token]/+page.svelte`

- [ ] **Step 1: 重写查看页**

把 `apps/web/src/routes/s/[token]/+page.svelte` 整体替换为：

```svelte
<script lang="ts">
    import MarkdownViewer from '$components/MarkdownViewer.svelte';
    import ThemeToggle from '$components/ThemeToggle.svelte';
    let { data } = $props();
</script>

<svelte:head>
    <title>{data.title}</title>
</svelte:head>

<div class="share-topbar">
    <a class="back" href="/">← 返回我的文档库</a>
    <ThemeToggle />
</div>

<MarkdownViewer html={data.html} />

<style>
    .share-topbar {
        max-width: 960px;
        margin: 0 auto;
        padding: 1rem 2rem 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        box-sizing: border-box;
    }
    .back {
        color: var(--rr-link);
        text-decoration: none;
        font-size: 14px;
    }
    .back:hover {
        text-decoration: underline;
    }
    @media (max-width: 768px) {
        .share-topbar {
            padding: 1rem 1rem 0;
        }
    }
</style>
```

- [ ] **Step 2: 类型检查**

Run: `bun --filter remote-reader-web check`
Expected: 0 error / 0 warning

- [ ] **Step 3: commit**

```bash
git add apps/web/src/routes/s/[token]/+page.svelte
git commit -m "feat(web): /s/<token> 查看页顶栏整合 + ThemeToggle"
```

---

## Task 9: 回归与手动验证（收尾）

**Files:** 无代码改动（发现问题才回头补，并补对应测试）

- [ ] **Step 1: 全量单测**

Run: `bun run test`
Expected: 全绿（原 200 + 新增 theme 5 + mermaid-zoom 6 + markdown 1 = 212）

- [ ] **Step 2: 类型检查**

Run: `bun --filter remote-reader-web check`
Expected: 0 error / 0 warning

Run: `bun --filter remote-reader-mcp-bridge check`
Expected: 0 error（桥未动，确认无连带）

- [ ] **Step 3: 启动 dev 并准备一个含多元素的测试文档**

Run: `bun run dev -- --host 0.0.0.0`，用 `hostname -I` 取局域网 IP（如 `192.168.x.x`），浏览器打开 `http://<局域网IP>:5173`（用户在局域网机器访问，**非 localhost**）

通过文件管理器或 API 上传一篇覆盖各元素的 markdown（标题/段落/表格/代码块/mermaid/数学公式/含 `->` `=>` 的 ASCII 框线图），生成 `/s/<token>` 链接。

- [ ] **Step 4: 手动验证清单（逐项在浏览器确认）**

- [ ] 浅色态：浅灰底 + 白色文档卡 + 柔和阴影 + 圆角，正文/链接/行内 code 配色正确。
- [ ] 点击右上角 ThemeToggle → 切到深色态（页面底、卡片、文字、链接、行内 code 全部变深色）。
- [ ] 刷新页面 → 深色态被记忆（localStorage `rr-theme`），且**首屏不闪白**（防 FOUC 生效）。
- [ ] 把系统主题切到深色、清掉 localStorage → 刷新后自动深色（跟随系统）。
- [ ] 代码块两态都保持深色（github-dark）；深色态代码块有细边框。
- [ ] **ASCII flow 图对齐正确**：含 `->` `=>` `>=` 的图未被连字成箭头（仍是独立字符），`┌─┐│└─┘` 框线对齐无错位。
- [ ] 表格：宽表在容器内**横向滚动**（不撑破布局）。
- [ ] **手机响应式**：Chrome DevTools 切 375 视口 → 文档居中、不被宽内容挤到左半屏、padding 收窄。
- [ ] **Mermaid 浮卡**：图渲染为带顶栏的浮卡；`−`/`+` 缩放、百分比更新、双击百分比重置 100%；放大后鼠标拖动平移看局部；`⤢` 进全屏、全屏内缩放、Esc/点遮罩/✕ 关闭。
- [ ] 切换深浅主题时，已渲染的 mermaid 图按新主题重渲（浅色态为 default 配色、深色态为 dark 配色）。

- [ ] **Step 5: 终态 commit（如有验证中修复）**

若 Step 4 发现问题并修复，提交修复；否则无新增 commit。最终确认 `git status` 干净、`git log` 含本计划各 Task 的 commit。

---

## Self-Review（计划作者自检）

**Spec coverage：**
- §3.1 视觉 token（浅/深）→ Task 4 ✓
- §3.1 字体/宽度/圆角/代码块始终深色 → Task 4（变量）+ Task 7（字体/宽度/边框）✓
- §3.1 代码块等宽 + 关连字（ASCII 友好）→ Task 7（`font-variant-ligatures:none` / `tab-size:4` / 字体栈）✓
- §3.2 响应式防溢出（容器 100%/min-width:0、手机 padding、table 包壳、pre/img/svg max-width）→ Task 3（table SSR 壳）+ Task 7（容器/pre/img 样式 + @media）✓
- §3.3 深色模式（data-theme / 优先级 / 防 FOUC / ThemeToggle / mermaid 跟随）→ Task 4（变量+防FOUC）+ Task 5（ThemeToggle）+ Task 6（mermaid MutationObserver 重渲）✓
- §3.4 Mermaid 浮卡（浮卡/缩放/拖动/全屏/失败兜底）→ Task 6 ✓
- §4 文件级改动 → Task 1-8 逐一覆盖 ✓
- §5 测试（table 包壳单测、回归 200+、svelte-check、手动验证）→ Task 3/9 ✓

**Type consistency：**
- `Theme` 类型在 `theme.ts`（Task 1）定义，`ThemeToggle`（Task 5）`import type Theme` ✓
- `THEME_STORAGE_KEY`（Task 1）被 `ThemeToggle`（Task 5）与 `app.html`（Task 4，字面量 `'rr-theme'`，注释指向 theme.ts）共用，值一致 ✓
- `nextZoom` / `formatZoom` / `ZOOM_STEP`（Task 2）被 `MermaidViewer`（Task 6）使用，签名匹配 ✓
- `MermaidViewer` props `{ container: HTMLDivElement | undefined }` 与 `MarkdownViewer` 传入的 `bind:this={container}`（`HTMLDivElement | undefined`）匹配 ✓

**Placeholder scan：** 无 TBD/TODO；所有代码步均含完整代码；命令含 expected 输出 ✓

**中间态处理：** body 背景推迟到 Task 7 与 `MarkdownViewer` 换 `var()` 同做，避免了"深色态正文不可读"的破坏性中间态——每个 commit 后浅深两态均可正常查看。
