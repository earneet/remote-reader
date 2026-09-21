import MarkdownIt from 'markdown-it';
import { registerMathRules } from './markdown-math';

// 图片引用名提取的单一事实源（spec P1-3）：桥预检（Phase 4）、Web 上传时声明式 refs 登记、
// Web 渲染 names[] 收集（Phase 3）三方强制共用——任何私有实现都会造成 refs 漂移 → 活图被 24h GC。
// math 规则必须注册：与 web 渲染实例同构，否则 $...$ 内图片被多提取（渲染端不渲染它）。
let cached: MarkdownIt | null = null;
function parser(): MarkdownIt {
    if (!cached) {
        cached = new MarkdownIt({ html: false, linkify: true, typographer: true });
        registerMathRules(cached);
    }
    return cached;
}

/** 提取 md 中本地图片引用的裸名（去重保序）。外链/data:/绝对路径/含分隔符路径/math 内/code 内不提取 */
export function extractImageNames(src: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (raw: string): void => {
        let s = raw;
        const hashAt = s.search(/[?#]/);
        if (hashAt >= 0) s = s.slice(0, hashAt);
        try { s = decodeURIComponent(s); } catch { /* 非法编码按原样 */ }
        if (s.startsWith('./')) s = s.slice(2);
        if (!s || s.includes('/') || s.includes('\\')) return;    // 含分隔符：非裸名
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return;          // scheme（http/data/…）
        if (!seen.has(s)) { seen.add(s); out.push(s); }
    };
    const tokens = parser().parse(src, {});
    const walk = (toks: MarkdownIt.Token[]): void => {
        for (const t of toks) {
            if (t.type === 'image') {
                const raw = t.attrGet('src');
                if (raw) push(raw);
            }
            if (t.children) walk(t.children);
        }
    };
    walk(tokens);
    return out;
}
