import MarkdownIt from 'markdown-it';
import { registerMathRules } from './markdown-math';

// 单文档图片引用数量硬上限（上传 413 / 渲染整体降级 / 桥预检拦截三方共用）：
// 5MB md 可含数十万互异图名——无上限时 resolveImages 每请求 O(N×|html|) 替换 + O(N) 同步
// SQLite 查询，免登录查看页单请求即可阻塞事件循环分钟级（交叉审查 P0 DoS）
export const MAX_IMAGE_REFS = 500;

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

// 手写 HTML 锚点形态（服务端 warnings 检测用）：html:false 渲染下 <a id/name=...></a> 按原文转义显示、
// 文档内 #fragment 链接落空。引号覆盖直双/直单/弯双/弯单——AI 中文文档常把 " 写成 “（本次事故形态）；
// 标签间允许纯文本（<a id="x">第一章</a> 带可见文本的变体）。只锚 id/name 且要求其为唯一属性：
// <a href> 失效是可见的原文显示不告警防噪音；id 前后带其他属性（class 等）的变体不匹配——检测是
// 反馈回路非正确性闸门，罕见形态漏检仅少一条提醒。i 标志顺带覆盖 <A ID=...> 老式大写。
const ANCHOR_TAG_RE = /<a\s+(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|“([^”]*)”|‘([^’]*)’)\s*>([^<]*)<\/a\s*>/gi;

/** token → 手写锚点 id（去重保序）。code（fence/行内）/math 内不提取——教学文档的锚点示例是合法
 *  内容，不构成问题信号。html:false 下锚点完整落在 text token content；⚠️ smartquotes（core 链，
 *  parse 时原地改写 text token）会把 `id=` 后的直引号弯化（探针实证：各上下文中 `id="ch1"` 到达
 *  walk 时已是 `id=“ch1”`）——弯引号分支才是直引号输入的主要命中路径，四分支缺一不可，按直觉
 *  「直引号输入走直引号分支」删弯引号分支会全量漏检。直引号分支仅兜 smartquotes 配对失败的角落
 *  （如纯空白 id 实测保持直引号）。 */
function anchorIdsOf(toks: MdToken[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (id: string): void => {
        if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    };
    const walk = (list: MdToken[]): void => {
        for (const t of list) {
            if (t.type === 'text') {
                for (const m of t.content.matchAll(ANCHOR_TAG_RE)) {
                    push(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '');
                }
            }
            if (t.children) walk(t.children);
        }
    };
    walk(toks);
    return out;
}

export function extractRawHtmlAnchorIds(src: string): string[] {
    return anchorIdsOf(parser().parse(src, {}));
}

export interface ImageTokenLine { src: string; line: number }

/** token 级图片引用（含所在行号）：桥预检收集与改写定位共用（spec §6.1/§6.3）。
 *  ⚠️ markdown-it 中 image（inline 层）token 的 .map 恒 null（Oracle 探针实证）——行信息在
 *  父 inline token 的块级 map [start, end)。父 map 亦为 null（表格）时扫描含 src 的行兜底。 */
export function imageTokenLines(src: string): ImageTokenLine[] {
    const out: ImageTokenLine[] = [];
    const lines = src.split('\n');
    // 双形态匹配（Task 1 遗留边界）：md 原文写中文/空格、token src 是 normalizeLink 编码形态——
    // 只试编码形态会 miss → line=-1 → 改写丢失；decode 形态也须参与命中。
    // R-25：map-less（表格）token 的兜底找行须跳过同 src 前序 token 已消费的行——
    // 恒取首现行会使「同图先段落再表格」的表格真实行永不进改写集合（残留本地路径）。
    const consumed = new Map<string, Set<number>>();
    const lineOf = (raw: string, range: [number, number] | null): number => {
        const hit = (l: string): boolean => l.includes(raw) || l.includes(decodeLocalSrc(raw));
        if (range) {
            for (let i = range[0]; i < range[1] && i < lines.length; i++) {
                if (hit(lines[i])) return i;
            }
        }
        const taken = consumed.get(raw);
        if (taken) {
            for (let i = 0; i < lines.length; i++) {
                if (hit(lines[i]) && !taken.has(i)) return i;
            }
        }
        return lines.findIndex(hit); // null 或范围未命中且无未消费命中：全文找（首现行）
    };
    const walk = (toks: MdToken[], parentMap: [number, number] | null): void => {
        for (const t of toks) {
            // map-less inline（表格 cell）必须重置为 null：沿用上一段落的陈旧范围会把
            // 表格 token 定位回段落行（旧实现两路径结果恰等价，R-25 修复后不再等价）
            if (t.type === 'inline') parentMap = t.map ? [t.map[0], t.map[1]] : null;
            if (t.type === 'image') {
                const raw = t.attrGet('src') ?? '';
                if (raw) {
                    const line = lineOf(raw, parentMap);
                    out.push({ src: raw, line });
                    if (line >= 0) {
                        const s = consumed.get(raw) ?? new Set<number>();
                        s.add(line);
                        consumed.set(raw, s);
                    }
                }
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

/** token → 本地图片引用（去重保序，原始 src 编码形态）。
 *  免行号 walk：不经 imageTokenLines——其行定位在表格上下文（父 inline map 为 null）退化为
 *  全文 findIndex，O(引用数×全文)，认证用户可用大表格+海量引用单请求阻塞事件循环（审查 P1 DoS）。
 *  遍历序与 imageTokenLines 的 DFS 同构，输出序列逐字节等价（对照快照用例锁定）。 */
function localImageSrcsOf(toks: MdToken[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const walk = (list: MdToken[]): void => {
        for (const t of list) {
            if (t.type === 'image') {
                const raw = t.attrGet('src') ?? '';
                if (!raw) continue;
                const decoded = decodeLocalSrc(raw);
                if (WINDOWS_DRIVE.test(decoded)) { if (!seen.has(decoded)) { seen.add(decoded); out.push(decoded); } continue; }
                if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) continue;
                if (!seen.has(raw)) { seen.add(raw); out.push(raw); }
            }
            if (t.children) walk(t.children);
        }
    };
    walk(toks);
    return out;
}

export function extractLocalImageSrcs(src: string): string[] {
    return localImageSrcsOf(parser().parse(src, {}));
}

/** 上传路径双检测单入口：一次 parse，双 walk（本地图片 src + 手写锚点 id）。
 *  之前图片/锚点两个检测各自 parse 同一 content，5MB 上限文档把事件循环同步阻塞翻倍
 *  （~2.4s→~5.2s，node 实测）——本仓库对上传路径阻塞面的历轮加固（MAX_IMAGE_REFS、
 *  免行号化）均以此为标准，故上传侧统一走本入口；桥侧单检测继续用各自的独立导出。 */
export function extractUploadSignals(src: string): { imageSrcs: string[]; anchorIds: string[] } {
    const toks = parser().parse(src, {});
    return { imageSrcs: localImageSrcsOf(toks), anchorIds: anchorIdsOf(toks) };
}

/** 桥侧读盘用：编码形态 src → 本地路径（decode + cwd join，P1-1） */
export function decodeLocalSrc(raw: string): string {
    let s = raw;
    try { s = decodeURIComponent(raw); } catch { /* 非法编码按原样 */ }
    return s;
}
