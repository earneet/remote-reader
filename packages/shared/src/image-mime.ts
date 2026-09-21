// 图片魔数检测单源（spec #6）：桥预检（Phase 4）与 Web 服务端（relay/confirm 验证链）共用。
// SVG 不支持（XSS 面，spec §14）——拒绝文案由调用方给出。
export function detectImageMime(b: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
        && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a'
        || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
    if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF'
        && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return null;
}

/** mime → 合法扩展名（jpeg 双写法 .jpg/.jpeg）；relay/confirm 扩展名一致性校验单源（spec §5.3 双重承诺） */
export function extsForMime(mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'): string[] {
    switch (mime) {
        case 'image/png': return ['png'];
        case 'image/jpeg': return ['jpg', 'jpeg'];
        case 'image/gif': return ['gif'];
        case 'image/webp': return ['webp'];
    }
}

/** 稳定名 sanitize（spec #2）：仅空格→`-`（引用/URL 编码链路边角），其余字符由单段校验拦截 */
export function sanitizeImageName(name: string): string {
    return name.replace(/ /g, '-');
}
