const ILLEGAL_CHARS = /[\\:*?"<>|]/;
// Linux NAME_MAX=255：超出即 mkdir/rename ENAMETOOLONG 裸 500（且 ensureFolder 已先落 DB 行留孤儿）。
// 单段上限在此单源拦截，upload API 与文件管理器命名共用
const MAX_SEGMENT_BYTES = 255;
const utf8 = new TextEncoder();

/**
 * 将用户/Agent 传入的 POSIX 风格路径解析为干净的段数组。
 *
 * 安全边界：所有上传路径都经此过滤，必须保证无法逃出用户根目录。
 * 拒绝：绝对路径、.. 穿越、null byte、Windows 非法字符、超长单段。
 */
export function parsePath(raw: string): string[] {
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new Error('path must be a non-empty string');
    }
    if (raw.startsWith('/')) {
        throw new Error('absolute path denied');
    }
    if (raw.includes('\0')) {
        throw new Error('path contains null byte');
    }
    if (ILLEGAL_CHARS.test(raw)) {
        throw new Error('path contains illegal characters: \\ : * ? " < > |');
    }

    const result: string[] = [];
    for (const seg of raw.split('/').map((s) => s.trim())) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') throw new Error('path traversal (..) denied');
        if (utf8.encode(seg).length > MAX_SEGMENT_BYTES) {
            throw new Error(`path segment too long (max ${MAX_SEGMENT_BYTES} bytes)`);
        }
        result.push(seg);
    }

    if (result.length === 0) {
        throw new Error('path resolves to nothing');
    }
    return result;
}
