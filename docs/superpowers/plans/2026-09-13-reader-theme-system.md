# 全站主题系统精修 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全站接入浅色/深色双主题精修 + 三档（自动/浅色/深色）切换；Shiki 代码高亮双主题化（浅色下代码块变浅色），主题变量全站单源。

**Architecture:** 主题变量单源 `apps/web/src/styles/theme.css`（`:root` 浅色 + `[data-theme="dark"]` 深色，`body` 底色承接）；Shiki dual themes（`defaultColor: false` 输出 CSS 变量，一次 SSR 渲染、切主题纯 CSS 取色、RENDER_CACHE 不受影响）；偏好 `ThemePref = 'auto' | 'light' | 'dark'` 存 localStorage（`rr-theme`），纯客户端、按浏览器隔离。

**Tech Stack:** Svelte 5 runes / SvelteKit、Shiki dual themes、CSS Custom Properties、vitest（node 运行时）、Playwright（视觉验收）

**Spec:** `docs/superpowers/specs/2026-09-13-reader-theme-system-design.md`

**运行时注（项目惯例）：** 测试用 `bun run test`（vitest 在 node 下跑，`better-sqlite3` 不能被 bun 直接运行）；类型检查 `bun --filter remote-reader-web check`（svelte-check）。

---

## 全局色值→变量映射表（Task 6/7 的替换依据）

| 旧字面量 | 新取值 | 适用语境 |
|---|---|---|
| `color: #1f2328` | `color: var(--rr-text)` | 正文 |
| `color: #57606a` | `color: var(--rr-text-muted)` | 弱化文字 |
| `color: #0969da` | `color: var(--rr-link)` | 链接/chip 文字 |
| `color: #cf222e` | `color: var(--rr-danger)` | 错误文字 |
| `color: #2da44e` | `color: var(--rr-success)` | 成功提示 |
| `background: #f6f8fa`（页面/条带底） | `background: var(--rr-bg)` | auth 页底、tag-filter 底 |
| `background: #f6f8fa`（hover） | `background: var(--rr-hover-bg)` | 列表 hover、菜单 hover |
| `background: #fff`（卡片/菜单/表格容器） | `background: var(--rr-card-bg)` | auth 卡片、topnav 菜单 |
| `background: #fff`（按钮） | `background: var(--rr-btn-bg)` | `.btn`、`.icon-btn` |
| `background: #fff`（输入框） | `background: var(--rr-input-bg)` | 各 input |
| `#d0d7de`（通用边框） | `var(--rr-border)` | 表格、分隔 |
| `border: 1px solid #d0d7de`（按钮） | `border: 1px solid var(--rr-btn-border)` | `.btn` |
| `border: 1px solid #d0d7de`（输入框） | `border: 1px solid var(--rr-input-border)` | input |
| `#eaecef`（细分隔） | `var(--rr-border-soft)` | 列表分隔线 |
| `background: #ddf4ff` | `background: var(--rr-accent-soft)` | chip、active 段、editing 高亮 |
| `background: #1f883d; color: #fff; border-color: #1f883d` | `background: var(--rr-btn-primary-bg); color: var(--rr-btn-primary-text); border-color: var(--rr-btn-primary-bg)` | 绿色主按钮 `.btn.primary` |
| `background: #1a7f37`（primary hover） | `background: var(--rr-btn-primary-hover)` | `.btn.primary:hover` |
| `background: #0969da; color: #fff; border-color: #0969da` | `background: var(--rr-accent); color: #ffffff; border-color: var(--rr-accent)` | 蓝色 submit（login/register） |
| `background: #0860ca` | `background: var(--rr-accent-hover)` | submit hover |
| `border-color: #0969da`（focus） | `border-color: var(--rr-accent)` | input:focus |
| `box-shadow: 0 0 0 2px rgba(9, 105, 218, 0.2)` | `box-shadow: 0 0 0 2px var(--rr-focus-ring)` | input:focus 焦点环 |
| `background: #ffebe9; border: 1px solid #ff8182` | `background: var(--rr-danger-soft); border: 1px solid var(--rr-danger-border)` | 错误横幅 |
| `background: #fff8c5; border: 1px solid #d4a72c` | `background: var(--rr-warning-soft); border: 1px solid var(--rr-warning-border)` | token reveal、截断提示、`<mark>` 高亮 |

---

### Task 1: `theme.ts` 三档偏好纯函数（TDD）

**Files:**
- Modify: `apps/web/src/lib/shared/theme.ts`
- Test: `apps/web/tests/theme.test.ts`

- [ ] **Step 1: 改写测试（先写失败测试）**

`apps/web/tests/theme.test.ts` 全文替换为：

```ts
import { test, expect } from 'vitest';
import {
    resolveTheme,
    toggleTheme,
    parseThemePref,
    cycleTheme,
    THEME_STORAGE_KEY
} from '../src/lib/shared/theme';
import type { ThemePref } from '../src/lib/shared/theme';

test('parseThemePref: 合法值直通', () => {
    expect(parseThemePref('light')).toBe('light');
    expect(parseThemePref('dark')).toBe('dark');
    expect(parseThemePref('auto')).toBe('auto');
});

test('parseThemePref: 非法/缺失回退 auto（兼容旧两值存储）', () => {
    expect(parseThemePref(null)).toBe('auto');
    expect(parseThemePref('garbage')).toBe('auto');
    expect(parseThemePref('')).toBe('auto');
});

test('resolveTheme: 显式偏好直通', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
});

test('resolveTheme: auto 跟随系统', () => {
    expect(resolveTheme('auto', true)).toBe('dark');
    expect(resolveTheme('auto', false)).toBe('light');
});

test('cycleTheme: auto → light → dark → auto 循环', () => {
    let pref: ThemePref = 'auto';
    const seq: ThemePref[] = [];
    for (let i = 0; i < 3; i++) {
        pref = cycleTheme(pref);
        seq.push(pref);
    }
    expect(seq).toEqual(['light', 'dark', 'auto']);
});

test('toggleTheme: 双向切换（过渡期保留，Task 3 移除）', () => {
    expect(toggleTheme('dark')).toBe('light');
    expect(toggleTheme('light')).toBe('dark');
});

test('THEME_STORAGE_KEY 为约定键名', () => {
    expect(THEME_STORAGE_KEY).toBe('rr-theme');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/theme.test.ts`
Expected: FAIL（`parseThemePref` 未导出；`resolveTheme(null, …)` 类型不匹配）

- [ ] **Step 3: 实现 `theme.ts`**

`apps/web/src/lib/shared/theme.ts` 全文替换为：

```ts
export type Theme = 'light' | 'dark';
export type ThemePref = 'auto' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'rr-theme';

// 旧版存储只有 light/dark 两值；缺失或非法一律视为 auto（跟随系统）
export function parseThemePref(stored: string | null): ThemePref {
    if (stored === 'light' || stored === 'dark' || stored === 'auto') return stored;
    return 'auto';
}

export function resolveTheme(pref: ThemePref, prefersDark: boolean): Theme {
    if (pref === 'light') return 'light';
    if (pref === 'dark') return 'dark';
    return prefersDark ? 'dark' : 'light';
}

export function cycleTheme(pref: ThemePref): ThemePref {
    return pref === 'auto' ? 'light' : pref === 'light' ? 'dark' : 'auto';
}

// 过渡期保留：Task 3 的 ThemeToggle 切换到 cycleTheme 后随同删除
export function toggleTheme(current: Theme): Theme {
    return current === 'dark' ? 'light' : 'dark';
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/theme.test.ts`
Expected: PASS（7 个测试全绿）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/shared/theme.ts apps/web/tests/theme.test.ts
git commit -m "feat(web): 主题偏好纯函数三档化——parseThemePref/resolveTheme/cycleTheme，兼容旧两值存储"
```

---

### Task 2: `app.html` 防闪脚本支持 auto 档

**Files:**
- Modify: `apps/web/src/app.html:9-21`

- [ ] **Step 1: 替换 inline 脚本**

`app.html` 中 `<script nonce="%sveltekit.nonce%">…</script>` 整块替换为：

```html
<script nonce="%sveltekit.nonce%">
    (function () {
        try {
            var t = localStorage.getItem('rr-theme');
            if (t !== 'light' && t !== 'dark') t = 'auto';
            if (t === 'auto') {
                t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
                    ? 'dark'
                    : 'light';
            }
            document.documentElement.dataset.theme = t;
        } catch (e) {
            document.documentElement.dataset.theme = 'light';
        }
    })();
</script>
```

要点：`'light'`/`'dark'`（旧值）直通；`'auto'`/缺失/非法 → `matchMedia` 解析；`matchMedia` 不存在（老浏览器）短路为 `false` → light；localStorage 异常 → try/catch 兜底 light（现状语义）。

- [ ] **Step 2: 验证脚本随 SSR 产物输出**

Run:
```bash
bun --filter remote-reader-web dev > /tmp/opencode/dev.log 2>&1 &
sleep 4
curl -s http://localhost:5173/login | grep -c "prefers-color-scheme"
kill %1
```
Expected: `grep -c` 输出 `>= 1`（脚本在首屏 HTML 中）

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app.html
git commit -m "feat(web): 防闪脚本支持 auto 档——旧两值兼容、无 matchMedia 兜底 light"
```

---

### Task 3: `ThemeToggle` 三档 UI + 移除 `toggleTheme`

**Files:**
- Modify: `apps/web/src/lib/components/ThemeToggle.svelte`（全文替换）
- Modify: `apps/web/src/lib/shared/theme.ts`（删 `toggleTheme`）
- Test: `apps/web/tests/theme.test.ts`（删对应用例）

- [ ] **Step 1: `ThemeToggle.svelte` 全文替换为**

```svelte
<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { parseThemePref, resolveTheme, cycleTheme, type ThemePref, THEME_STORAGE_KEY } from '$lib/shared/theme';

    let pref = $state<ThemePref>('auto');
    let effective = $state<'light' | 'dark'>('light');
    let observer: MutationObserver | null = null;
    let mq: MediaQueryList | null = null;
    let onSystemChange: (() => void) | null = null;

    function prefersDark(): boolean {
        return typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    function apply(): void {
        effective = resolveTheme(pref, prefersDark());
        document.documentElement.dataset.theme = effective;
    }

    function onClick(): void {
        pref = cycleTheme(pref);
        try {
            localStorage.setItem(THEME_STORAGE_KEY, pref);
        } catch (e) {
            // 隐私模式等写入失败，忽略：DOM 已更新，本次会话仍生效
        }
        apply();
    }

    onMount(() => {
        try {
            pref = parseThemePref(localStorage.getItem(THEME_STORAGE_KEY));
        } catch (e) {
            pref = 'auto';
        }
        apply();
        // 多实例/外部改动同步（如 dev 时 HMR）
        observer = new MutationObserver(() => {
            effective = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
        });
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
        });
        // auto 档：系统切换实时跟随
        if (typeof window.matchMedia === 'function') {
            mq = window.matchMedia('(prefers-color-scheme: dark)');
            onSystemChange = () => {
                if (pref === 'auto') apply();
            };
            mq.addEventListener('change', onSystemChange);
        }
    });
    onDestroy(() => {
        observer?.disconnect();
        if (mq && onSystemChange) mq.removeEventListener('change', onSystemChange);
    });

    const LABELS: Record<ThemePref, string> = {
        auto: '主题：自动（跟随系统）',
        light: '主题：浅色',
        dark: '主题：深色'
    };
</script>

<button
    type="button"
    class="rr-theme-toggle"
    onclick={onClick}
    aria-label="{LABELS[pref]}，点击切换"
    title="{LABELS[pref]}，点击切换"
>
    {#if pref === 'auto'}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none" />
        </svg>
    {:else if pref === 'dark'}
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
        border: 1px solid var(--rr-border, #d0d7de);
        background: var(--rr-toggle-bg, #eaeef1);
        color: var(--rr-text-muted, #57606a);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 0;
    }
    .rr-theme-toggle:hover {
        color: var(--rr-text, #1f2328);
    }
</style>
```

图标语义：auto = 半填充圆（半日半月）、dark = 太阳（表示「当前深色，点击回浅色」沿用现有惯例：图标展示当前态）、light = 月亮。

- [ ] **Step 2: 删除 `toggleTheme`**

`theme.ts` 删除整段：

```ts
// 过渡期保留：Task 3 的 ThemeToggle 切换到 cycleTheme 后随同删除
export function toggleTheme(current: Theme): Theme {
    return current === 'dark' ? 'light' : 'dark';
}
```

`theme.test.ts` 删除用例及其 import：

```ts
test('toggleTheme: 双向切换（过渡期保留，Task 3 移除）', () => {
    expect(toggleTheme('dark')).toBe('light');
    expect(toggleTheme('light')).toBe('dark');
});
```

并从 import 列表移除 `toggleTheme`。

- [ ] **Step 3: 类型检查 + 测试**

Run: `bun --filter remote-reader-web check && bun run test apps/web/tests/theme.test.ts`
Expected: check 0 错误；测试全绿（无 toggleTheme 用例）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/components/ThemeToggle.svelte apps/web/src/lib/shared/theme.ts apps/web/tests/theme.test.ts
git commit -m "feat(web): 主题切换按钮三档化——auto/light/dark 循环 + 系统变化实时跟随，删 toggleTheme"
```

---

### Task 4: Shiki 双主题（TDD）

**Files:**
- Modify: `apps/web/src/lib/server/markdown.ts`
- Test: `apps/web/tests/markdown.test.ts`

- [ ] **Step 1: 改写高亮相关断言（先失败）**

`markdown.test.ts` 中替换两个测试：

原「常用语言有 shiki 语法着色」测试（29-36 行）替换为：

```ts
test('常用语言有 shiki 双主题着色（--shiki-light/--shiki-dark 变量输出）', async () => {
    const tsx = await renderMarkdown('```tsx\nconst App = () => <div/>;\n```');
    expect(tsx).toContain('shiki');
    expect(tsx).toContain('--shiki-light');
    expect(tsx).toContain('--shiki-dark');
    const cpp = await renderMarkdown('```cpp\nint main(){return 0;}\n```');
    expect(cpp).toContain('shiki');
    expect(cpp).toContain('--shiki-light');
    expect(cpp).toContain('--shiki-dark');
});
```

原「未预载语言安全降级」测试（38-43 行）替换为：

```ts
test('未预载语言安全降级为双主题代码块（不抛错、内容不丢失、带 shiki 外观）', async () => {
    const html = await renderMarkdown('```brainfuck\n++++++++[>++++++++<-]>\n```');
    expect(html).toContain('shiki');
    expect(html).toContain('--shiki-dark');
    expect(html).toContain('++++++++');
});
```

（原 `/color:#/i` 与 `/background-color:/i` 断言在 dual 模式下不再出现字面 color/background 输出，故随 dual 化更新。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/markdown.test.ts`
Expected: FAIL（输出无 `--shiki-light`/`--shiki-dark`）

- [ ] **Step 3: 实现 `markdown.ts` 双主题**

`markdown.ts` 顶部：

```ts
// 双主题：一份 HTML 携带两套取色变量，data-theme 切换纯 CSS，RENDER_CACHE 不受影响
const THEMES = { light: 'github-light', dark: 'github-dark' } as const;
```

`getHighlighter()` 内：

```ts
highlighterPromise = createHighlighter({ langs: LANGS, themes: [THEMES.light, THEMES.dark] }).catch(
```

`highlight` 回调整体替换为：

```ts
highlight: (code, lang) => {
    if (lang === 'mermaid') return '';
    const isAscii = !lang || lang === 'text';
    const kind = isAscii ? 'ascii' : 'prose';
    const stamp = (html: string) => html.replace(/<pre\b/, `<pre data-rr-code="${kind}"`);
    // dual themes + defaultColor:false：token 输出 --shiki-light/--shiki-dark 变量（无内联默认色/背景），
    // 取色与背景由 styles/theme.css 按 data-theme 控制
    const dual = {
        themes: { light: THEMES.light, dark: THEMES.dark },
        defaultColor: false
    } as const;
    try {
        return stamp(hl.codeToHtml(code, { lang: lang || 'text', ...dual }));
    } catch (e) {
        console.error('[markdown] shiki highlight failed for lang', lang, e);
        // 未预载语言：用 text 重渲染，保证与正常代码块一致的双主题外观
        try {
            return stamp(hl.codeToHtml(code, { lang: 'text', ...dual }));
        } catch {
            const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<pre data-rr-code="${kind}" class="shiki" style="color:var(--shiki-light);--shiki-dark:#e1e4e8"><code>${esc}</code></pre>`;
        }
    }
}
```

删除原 `const THEME = 'github-dark';` 行。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/markdown.test.ts`
Expected: PASS 全绿

（注：此步完成到 Task 5 完成之间，浅色页面代码块暂无 CSS 取色规则，属预期中间态，Task 5 立即接上。）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/markdown.ts apps/web/tests/markdown.test.ts
git commit -m "feat(web): Shiki 双主题化——github-light/dark dual themes 输出 CSS 变量，浅色下代码块随主题"
```

---

### Task 5: `theme.css` 变量单源 + 全局接线

**Files:**
- Create: `apps/web/src/styles/theme.css`
- Modify: `apps/web/src/routes/+layout.svelte:1-3`（import）
- Modify: `apps/web/src/routes/s/[token]/+page.svelte`（删变量定义）
- Modify: `apps/web/src/lib/components/MarkdownViewer.svelte`（pre 背景承接）

- [ ] **Step 1: 新建 `apps/web/src/styles/theme.css`**

```css
/* 全站主题变量单源（spec: docs/superpowers/specs/2026-09-13-reader-theme-system-design.md）
   :root = 浅色默认；[data-theme="dark"] = 深色覆盖。
   消费方一律 var(--rr-*)，页面组件禁止再写死主题色值。 */

:root {
    color-scheme: light;
    /* 基础（原 /s/[token] 定义，值保真；--rr-code-bg 精修为浅色） */
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
    --rr-code-bg: #f6f8fa;
    --rr-code-text: #1f2328;
    --rr-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 10px 28px rgba(0, 0, 0, 0.06);
    --rr-toggle-bg: #eaeef1;
    /* 管理页面语义色 */
    --rr-hover-bg: #f3f4f6;
    --rr-btn-bg: #ffffff;
    --rr-btn-border: #d0d7de;
    --rr-btn-text: #1f2328;
    --rr-btn-primary-bg: #1f883d;
    --rr-btn-primary-hover: #1a7f37;
    --rr-btn-primary-text: #ffffff;
    --rr-accent: #0969da;
    --rr-accent-hover: #0860ca;
    --rr-accent-soft: #ddf4ff;
    --rr-input-bg: #ffffff;
    --rr-input-border: #d0d7de;
    --rr-focus-ring: rgba(9, 105, 218, 0.2);
    --rr-danger: #cf222e;
    --rr-danger-soft: #ffebe9;
    --rr-danger-border: #ff8182;
    --rr-success: #2da44e;
    --rr-warning-soft: #fff8c5;
    --rr-warning-border: #d4a72c;
}

[data-theme="dark"] {
    color-scheme: dark;
    --rr-bg: #0d1117;
    --rr-card-bg: #161b22;
    --rr-card-border: #21262d;
    --rr-text: #c9d1d9;
    --rr-text-muted: #8b949e;
    --rr-link: #58a6ff;
    --rr-border: #21262d;
    --rr-border-soft: #21262d;
    --rr-inline-code-bg: rgba(110, 118, 129, 0.28);
    --rr-inline-code-text: #e3b341;
    --rr-code-bg: #0d1117;
    --rr-code-text: #e1e4e8;
    --rr-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
    --rr-toggle-bg: #21262d;

    --rr-hover-bg: #21262d;
    --rr-btn-bg: #21262d;
    --rr-btn-border: #30363d;
    --rr-btn-text: #c9d1d9;
    --rr-btn-primary-bg: #238636;
    --rr-btn-primary-hover: #2ea043;
    --rr-btn-primary-text: #ffffff;
    --rr-accent: #1f6feb;
    --rr-accent-hover: #388bfd;
    --rr-accent-soft: rgba(56, 139, 253, 0.16);
    --rr-input-bg: #0d1117;
    --rr-input-border: #30363d;
    --rr-focus-ring: rgba(88, 166, 255, 0.35);
    --rr-danger: #f85149;
    --rr-danger-soft: rgba(248, 81, 73, 0.12);
    --rr-danger-border: rgba(248, 81, 73, 0.4);
    --rr-success: #3fb950;
    --rr-warning-soft: rgba(187, 128, 9, 0.15);
    --rr-warning-border: #bb8009;
}

/* body 全局承接：/d/、login 等无页面级底色的路由在暗色下不再白底刺眼（G2） */
body {
    background: var(--rr-bg);
    color: var(--rr-text);
}

/* Shiki 双主题取色：dual themes(defaultColor:false) 输出仅含变量，
   这里按 data-theme 取值；pre 背景走 --rr-code-bg（shiki 不再输出内联背景）。 */
pre.shiki,
pre.shiki span {
    color: var(--shiki-light);
}
pre.shiki {
    background: var(--rr-code-bg);
}
[data-theme="dark"] pre.shiki,
[data-theme="dark"] pre.shiki span {
    color: var(--shiki-dark);
}
```

- [ ] **Step 2: `+layout.svelte` 引入**

`apps/web/src/routes/+layout.svelte` 的 `<script lang="ts">` 首行加：

```ts
import '../styles/theme.css';
```

- [ ] **Step 3: `/s/[token]/+page.svelte` 删除变量定义**

删除 `<style>` 中 `.share-root { … }` 内的 13 行 `--rr-*` 声明、`color-scheme: light;`，以及整个 `:global([data-theme="dark"]) .share-root { … }` 块。替换后的 `<style>`：

```svelte
<style>
    .share-root {
        min-height: 100vh;
        background: var(--rr-bg);
        color: var(--rr-text);
    }
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

- [ ] **Step 4: `MarkdownViewer.svelte` pre 背景承接**

`.markdown-body :global(pre)` 规则内加一行 `background: var(--rr-code-bg);`（shiki 不再输出内联背景后由变量接管）。

- [ ] **Step 5: 验证**

Run: `bun --filter remote-reader-web check && bun run test`
Expected: check 0 错误；全量测试绿

手动冒烟（dev server）：`/s/<token>` 页面浅色下代码块浅底、深色下深底；`/d/<id>` 暗色系统下整体暗色。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/styles/theme.css apps/web/src/routes/+layout.svelte apps/web/src/routes/s/[token]/+page.svelte apps/web/src/lib/components/MarkdownViewer.svelte
git commit -m "feat(web): 主题变量全站单源 theme.css——13 个既有变量保名上移 + 管理页语义色 + body/Shiki 接线"
```

---

### Task 6: 全站路由硬编码色迁移

**Files:**（全部 Modify，仅样式色值→变量，不动布局/结构）
- `apps/web/src/routes/+page.svelte`（文件管理器）
- `apps/web/src/routes/d/[id]/+page.svelte`
- `apps/web/src/routes/login/+page.svelte`
- `apps/web/src/routes/register/+page.svelte`
- `apps/web/src/routes/search/+page.svelte`
- `apps/web/src/routes/+layout.svelte`
- `apps/web/src/routes/settings/tokens/+page.svelte`
- `apps/web/src/routes/settings/shares/+page.svelte`
- `apps/web/src/routes/settings/tags/+page.svelte`

按顶部「全局色值→变量映射表」逐条替换。各文件目标（行号为当前 grep 定位，替换以选择器语义为准）：

- [ ] **Step 1: 文件管理器 `routes/+page.svelte`**

| 行 | 旧 | 新 |
|---|---|---|
| 217 | `border-right: 1px solid #d0d7de` | `border-right: 1px solid var(--rr-border)` |
| 232 | `border-bottom: 1px solid #d0d7de` | `border-bottom: 1px solid var(--rr-border)` |
| 240 | `border: 1px solid #d0d7de`（.segmented） | `border: 1px solid var(--rr-border)` |
| 242 | `background: #f6f8fa; color: #1f2328`（.seg-btn） | `background: var(--rr-btn-bg); color: var(--rr-btn-text)` |
| 245 | `border-left: 1px solid #d0d7de` | `border-left: 1px solid var(--rr-border)` |
| 246 | `background: #ddf4ff; color: #0969da`（.seg-btn.active） | `background: var(--rr-accent-soft); color: var(--rr-link)` |
| 250 | `border: 1px solid #d0d7de`（.create-folder input） | `border: 1px solid var(--rr-input-border)`；并补 `background: var(--rr-input-bg); color: var(--rr-text)` |
| 252 | `border-color: #0969da; box-shadow: 0 0 0 2px rgba(9, 105, 218, 0.2)` | `border-color: var(--rr-accent); box-shadow: 0 0 0 2px var(--rr-focus-ring)` |
| 259 | `border-bottom: 1px solid #eaecef`（.item） | `border-bottom: 1px solid var(--rr-border-soft)` |
| 262 | `background: #f6f8fa`（.item:hover） | `background: var(--rr-hover-bg)` |
| 263 | `background: #ddf4ff`（.item.editing） | `background: var(--rr-accent-soft)` |
| 266 | `color: #0969da`（.name a） | `color: var(--rr-link)` |
| 268/269 | `color: #57606a`（.cold-chip/.size） | `color: var(--rr-text-muted)` |
| 276 | `border: 1px solid #0969da; … background: #fff`（.search-box input） | `border: 1px solid var(--rr-accent); background: var(--rr-input-bg); color: var(--rr-text)` |
| 282 | `color: #57606a`（.icon-btn） | `color: var(--rr-text-muted)` |
| 284 | `background: #fff; border-color: #d0d7de; color: #1f2328`（.icon-btn:hover） | `background: var(--rr-btn-bg); border-color: var(--rr-btn-border); color: var(--rr-btn-text)` |
| 285 | `color: #cf222e; border-color: #cf222e`（.icon-btn.danger:hover） | `color: var(--rr-danger); border-color: var(--rr-danger)` |
| 288 | `border: 1px solid #d0d7de; background: #fff; color: #1f2328`（.btn） | `border: 1px solid var(--rr-btn-border); background: var(--rr-btn-bg); color: var(--rr-btn-text)` |
| 292 | `.btn.primary` 三值 | `background: var(--rr-btn-primary-bg); color: var(--rr-btn-primary-text); border-color: var(--rr-btn-primary-bg)` |
| 293 | `background: #1a7f37`（primary:hover） | `background: var(--rr-btn-primary-hover)` |
| 297 | `color: #2da44e`（.hint） | `color: var(--rr-success)` |
| 298 | `color: #cf222e`（.error） | `color: var(--rr-danger)` |
| 299 | `color: #0969da`（.link） | `color: var(--rr-link)` |
| 300 | `color: #57606a`（.muted） | `color: var(--rr-text-muted)` |
| 303 | `background: #ddf4ff; color: #0969da`（.chip-static） | `background: var(--rr-accent-soft); color: var(--rr-link)` |
| 305 | `border: 1px solid #0969da`（.tag-form input） | `border: 1px solid var(--rr-accent)`；并补 `background: var(--rr-input-bg); color: var(--rr-text)` |

完整示例（.btn 区替换后）：

```css
.btn {
    border: 1px solid var(--rr-btn-border); background: var(--rr-btn-bg); color: var(--rr-btn-text); cursor: pointer;
    padding: 0.4rem 0.5rem; border-radius: 5px;
}
.btn.primary { background: var(--rr-btn-primary-bg); color: var(--rr-btn-primary-text); border-color: var(--rr-btn-primary-bg); }
.btn.primary:hover { background: var(--rr-btn-primary-hover); }
```

- [ ] **Step 2: `routes/d/[id]/+page.svelte`**

| 行 | 旧 | 新 |
|---|---|---|
| 46 | `color: #0969da`（.back） | `color: var(--rr-link)` |
| 48 | `background: #ddf4ff; color: #0969da`（.chip-static） | `background: var(--rr-accent-soft); color: var(--rr-link)` |
| 49 | `.btn` 三值 | `border: 1px solid var(--rr-btn-border); background: var(--rr-btn-bg); color: var(--rr-btn-text)` |
| 51 | `.btn.primary` 三值 | 同映射表 |
| 52 | `border: 1px solid #0969da`（.tag-bar input） | `border: 1px solid var(--rr-accent)`；补 `background: var(--rr-input-bg); color: var(--rr-text)` |

- [ ] **Step 3: `routes/login/+page.svelte`**

| 行 | 旧 | 新 |
|---|---|---|
| 72 | `background: #f6f8fa`（页面底） | `background: var(--rr-bg)` |
| 79-80 | `background: #fff; border: 1px solid #d0d7de`（卡片） | `background: var(--rr-card-bg); border: 1px solid var(--rr-card-border)` |
| 98/106/135 | `color: #1f2328` | `color: var(--rr-text)` |
| 111-115 | `background: #ffebe9; border: 1px solid #ff8182; … color: #cf222e`（错误横幅） | `background: var(--rr-danger-soft); border: 1px solid var(--rr-danger-border); color: var(--rr-danger)` |
| 142 | `border: 1px solid #d0d7de`（input） | `border: 1px solid var(--rr-input-border)`；补 `background: var(--rr-input-bg); color: var(--rr-text)` |
| 146-147 | `background: #fff; color: #1f2328`（input focus 前置/按钮） | 按语境：input → `var(--rr-input-bg)/var(--rr-text)` |
| 153 | `border-color: #0969da` | `border-color: var(--rr-accent)` |
| 161-162 | `background: #0969da; color: #fff`（submit） | `background: var(--rr-accent); color: #ffffff` |
| 172 | `background: #0860ca`（submit hover） | `background: var(--rr-accent-hover)` |
| 184 | `color: #57606a` | `color: var(--rr-text-muted)` |
| 188 | `color: #0969da` | `color: var(--rr-link)` |

- [ ] **Step 4: `routes/register/+page.svelte`**

与 login 同构（行号 76-192），按同映射逐条替换：76 → `var(--rr-bg)`；83-84 → 卡片两值；102/110/139 → `var(--rr-text)`；115-119 → danger 三值；146/150-151 → input；157 → `var(--rr-accent)`；165-166 → submit 两值；176 → `var(--rr-accent-hover)`；188 → `var(--rr-text-muted)`；192 → `var(--rr-link)`。

- [ ] **Step 5: `routes/search/+page.svelte`**

| 行 | 旧 | 新 |
|---|---|---|
| 79 | input 边框 | `border: 1px solid var(--rr-input-border)`；补 `background: var(--rr-input-bg); color: var(--rr-text)` |
| 80 | focus 焦点环 | `border-color: var(--rr-accent); box-shadow: 0 0 0 2px var(--rr-focus-ring)` |
| 81 | `.btn` 三值 | `var(--rr-btn-border)/var(--rr-btn-bg)/var(--rr-btn-text)` |
| 82 | `.btn.primary` | 同映射表 |
| 83 | `background: #f6f8fa`（.tag-filter） | `background: var(--rr-bg)` |
| 84 | `color: #57606a`（h2） | `color: var(--rr-text-muted)` |
| 86 | `.chip` 四值 | `border: 1px solid var(--rr-border); color: var(--rr-text); background: var(--rr-card-bg)` |
| 87 | `.chip.active` 三值 | `background: var(--rr-accent); color: #ffffff; border-color: var(--rr-accent)` |
| 90 | `border-bottom: 1px solid #eaecef` | `border-bottom: 1px solid var(--rr-border-soft)` |
| 91 | `color: #0969da`（.title） | `color: var(--rr-link)` |
| 93/96/98 | `color: #57606a` | `color: var(--rr-text-muted)` |
| 95 | `.chip-static` | `background: var(--rr-accent-soft); color: var(--rr-link)` |
| 97 | `background: #fff8c5`（mark 高亮） | `background: var(--rr-warning-soft)` |
| 99 | `background: #fff8c5; border: 1px solid #d4a72c`（.truncated） | `background: var(--rr-warning-soft); border: 1px solid var(--rr-warning-border)` |

- [ ] **Step 6: `routes/+layout.svelte`（topnav）**

| 行 | 旧 | 新 |
|---|---|---|
| 48 | `border-bottom: 1px solid #d0d7de` | `border-bottom: 1px solid var(--rr-border)` |
| 54 | `background: #fff`（菜单） | `background: var(--rr-card-bg)` |
| 55 | `border: 1px solid #d0d7de`（菜单） | `border: 1px solid var(--rr-border)` |
| 58 | `color: #1f2328`（菜单项） | `color: var(--rr-text)` |
| 59 | `background: #f6f8fa`（菜单 hover） | `background: var(--rr-hover-bg)` |
| 60 | `color: #57606a`（email） | `color: var(--rr-text-muted)` |
| 63 | `border: 1px solid #d0d7de`（搜索框） | `border: 1px solid var(--rr-input-border)`；补 `background: var(--rr-input-bg); color: var(--rr-text)` |

- [ ] **Step 7: settings 三页**

`settings/tokens/+page.svelte`：67 行 `.reveal` → `background: var(--rr-warning-soft); border: 1px solid var(--rr-warning-border)`；68 行 `.reveal code` → `background: var(--rr-card-bg)`；72 行 `th, td` → `border: 1px solid var(--rr-border)`。

`settings/shares/+page.svelte`：44 行 `.muted` → `color: var(--rr-text-muted)`；46 行 `th, td` → `border: 1px solid var(--rr-border)`。

`settings/tags/+page.svelte`：50 行 `th, td` → `border: 1px solid var(--rr-border)`。

- [ ] **Step 8: 验证 + Commit**

Run: `bun --filter remote-reader-web check && bun run test`
Expected: check 0 错误；全量测试绿

```bash
git add apps/web/src/routes
git commit -m "feat(web): 全站路由硬编码色迁移至主题变量——文件管理器/认证/搜索/topnav/settings 首次接入暗色"
```

---

### Task 7: overlay 组件收尾

**Files:**
- Modify: `apps/web/src/lib/components/MermaidViewer.svelte:277-285`

- [ ] **Step 1: mermaid fallback 字色主题化**

`.rr-mermaid-fallback` 规则替换为：

```css
:global(.rr-mermaid-fallback) {
    padding: 1rem;
    overflow-x: auto;
    background: var(--rr-code-bg);
    color: var(--rr-code-text);
    border-radius: 8px;
    margin: 1rem 0;
    font-family: ui-monospace, Menlo, monospace;
}
```

（两个 overlay 的 `background: rgba(0, 0, 0, 0.8)` 暗遮罩保留——半透明黑遮罩是双主题惯例，GitHub modal 同款。）

- [ ] **Step 2: 验证 + Commit**

Run: `bun --filter remote-reader-web check`
Expected: 0 错误

```bash
git add apps/web/src/lib/components/MermaidViewer.svelte
git commit -m "feat(web): mermaid 降级块字色随主题（--rr-code-text）"
```

---

### Task 8: 全量验证 + 视觉验收 + 文档回填

**Files:**
- Modify: `docs/superpowers/specs/2026-09-13-reader-theme-system-design.md`（§9 回填）
- Modify: `CLAUDE.md`（当前状态追加一行）

- [ ] **Step 1: 全量测试 + 类型检查**

Run: `bun run test && bun --filter remote-reader-web check`
Expected: 全部测试通过；check 0 错误

- [ ] **Step 2: 视觉验收（Playwright，light + dark 两态）**

起 dev server，对以下页面双态截图核对协调感（深色系统模拟用 `colorScheme: 'dark'`，浅色 `'light'`）：
1. `/s/<token>`：正文层级、**浅色代码块浅底/深色代码块深底**、行内代码、表格、mermaid 图、KaTeX 公式、mermaid lightbox
2. `/`（文件管理器）：列表、目录树、分段控件、按钮（绿 primary）
3. `/login`：卡片、输入框焦点态、蓝色 submit、错误横幅
4. 刷新首屏无浅/深闪跳（防闪脚本验证）

- [ ] **Step 3: spec §9 回填 + CLAUDE.md 更新**

spec §9 记录：改动文件清单、测试计数、验收结论。CLAUDE.md「当前状态」追加本特性条目（含 spec 路径）。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-13-reader-theme-system-design.md CLAUDE.md
git commit -m "docs: 主题系统实现状态回填——spec §9 + CLAUDE.md 当前状态"
```
