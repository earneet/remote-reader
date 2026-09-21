import MarkdownIt from 'markdown-it';
import { registerMathRules } from './markdown-math';

// 图片引用名提取的单一事实源（spec P1-3）：桥预检（Phase 4）、Web 上传时声明式 refs 登记、
// Web 渲染 names[] 收集（Phase 3）三方强制共用——任何私有实现都会造成 refs 漂移 → 活图被 24h GC。
// math 规则必须注册：与 web 渲染实例同构，否则 $...$ 内图片被多提取（渲染端不渲染它）。
// default import 绑定不可访问 namespace 成员（MarkdownIt.Token 会报"only refers to a type"），故推导
type MdToken = ReturnType<MarkdownIt['parse']>[number];
let cached: MarkdownIt | null = null;
function parser(): MarkdownIt {
    if (!cached) {
        cached = new MarkdownIt({ html: false, linkify: true, typographer: true });
        registerMathRules(cached);
    }
    return cached;
}

/** 图片引用归一化（单源）：query/fragment 剥离 → URL decode → ./ 剥离 → 非裸名（分隔符/scheme）判 null。
 *  extractImageNames 与 web 渲染 image renderer 共用——两处漂移会造成占位符索引错位。 */
export function normalizeImageRef(raw: string): string | null {
    let s = raw;
    const hashAt = s.search(/[?#]/);
    if (hashAt >= 0) s = s.slice(0, hashAt);
    try { s = decodeURIComponent(s); } catch { /* 非法编码按原样 */ }
    if (s.startsWith('./')) s = s.slice(2);
    if (!s || s.includes('/') || s.includes('\\')) return null;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return null;
    return s;
}

/** 提取 md 中本地图片引用的裸名（去重保序）。外链/data:/绝对路径/含分隔符路径/math 内/code 内不提取 */
export function extractImageNames(src: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (raw: string): void => {
        const n = normalizeImageRef(raw);
        if (n && !seen.has(n)) { seen.add(n); out.push(n); }
    };
    const tokens = parser().parse(src, {});
    const walk = (toks: MdToken[]): void => {
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

export interface ImageTokenLine { src: string; line: number }

/** token 级图片引用（含所在行号）：桥预检收集与改写定位共用（spec §6.1/§6.3）。
 *  ⚠️ markdown-it 中 image（inline 层）token 的 .map 恒 null（Oracle 探针实证）——行信息在
 *  父 inline token 的块级 map [start, end)。父 map 亦为 null（表格）时扫描含 src 的行兜底。 */
export function imageTokenLines(src: string): ImageTokenLine[] {
    const out: ImageTokenLine[] = [];
    const lines = src.split('\n');
    const lineOf = (raw: string, range: [number, number] | null): number => {
        if (range) {
            for (let i = range[0]; i < range[1] && i < lines.length; i++) {
                if (lines[i].includes(raw)) return i;
            }
        }
        return lines.findIndex((l) => l.includes(raw)); // null 或范围未命中：全文找（首现行）
    };
    const walk = (toks: MdToken[], parentMap: [number, number] | null): void => {
        for (const t of toks) {
            if (t.type === 'inline' && t.map) parentMap = [t.map[0], t.map[1]];
            if (t.type === 'image') {
                const raw = t.attrGet('src') ?? '';
                if (raw) out.push({ src: raw, line: lineOf(raw, parentMap) });
            }
            if (t.children) walk(t.children, parentMap);
        }
    };
    walk(parser().parse(src, {}), null);
    return out;
}

/** 桥侧本地图片引用（原始 src——markdown-it normalizeLink 后的编码形态，去重保序）：
 *  文件系统读取时由调用方 decode（P1-1），改写时用编码原样（spec §6.3 "替换 src 编码形态"）。
 *  scheme 过滤含 Windows 盘符例外（P2-5）——盘符走 decode 形态判定与产出：normalizeLink 把 \ 编码为
 *  %5C，raw 恒不含字面反斜杠（探针实测），且盘符已是绝对路径，decode 后即文件系统可用形态。 */
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;

export function extractLocalImageSrcs(src: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const { src: raw } of imageTokenLines(src)) {
        if (!raw) continue;
        const decoded = decodeLocalSrc(raw);
        if (WINDOWS_DRIVE.test(decoded)) { if (!seen.has(decoded)) { seen.add(decoded); out.push(decoded); } continue; }
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) continue;
        if (!seen.has(raw)) { seen.add(raw); out.push(raw); }
    }
    return out;
}

/** 桥侧读盘用：编码形态 src → 本地路径（decode + cwd join，P1-1） */
export function decodeLocalSrc(raw: string): string {
    let s = raw;
    try { s = decodeURIComponent(raw); } catch { /* 非法编码按原样 */ }
    return s;
}
