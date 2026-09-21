import { describe, it, expect } from 'vitest';
import { detectImageMime, extsForMime, sanitizeImageName } from './image-mime';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const GIF = Buffer.from('GIF89a', 'ascii');
const WEBP = Buffer.from('RIFF....WEBPVP8 ', 'latin1');

describe('image-mime', () => {
    it('四格式魔数识别', () => {
        expect(detectImageMime(PNG)).toBe('image/png');
        expect(detectImageMime(JPEG)).toBe('image/jpeg');
        expect(detectImageMime(GIF)).toBe('image/gif');
        expect(detectImageMime(WEBP)).toBe('image/webp');
    });
    it('未知/过短 → null', () => {
        expect(detectImageMime(Buffer.from('<svg>'))).toBeNull();
        expect(detectImageMime(Buffer.alloc(2))).toBeNull();
    });
    it('extsForMime：mime → 合法扩展名（jpeg 双写法）', () => {
        expect(extsForMime('image/png')).toEqual(['png']);
        expect(extsForMime('image/jpeg')).toEqual(['jpg', 'jpeg']);
        expect(extsForMime('image/gif')).toEqual(['gif']);
        expect(extsForMime('image/webp')).toEqual(['webp']);
    });
    it('sanitize：空格→连字符，其余保留', () => {
        expect(sanitizeImageName('my shot 1.png')).toBe('my-shot-1.png');
        expect(sanitizeImageName('截图1.png')).toBe('截图1.png');
    });
});
