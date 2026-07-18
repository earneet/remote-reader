import { test, expect } from 'vitest';
import { parsePath } from './paths';

test('单文件名合法', () => {
    expect(parsePath('weekly.md')).toEqual(['weekly.md']);
});

test('多级路径合法', () => {
    expect(parsePath('reports/2026-07/weekly.md')).toEqual(['reports', '2026-07', 'weekly.md']);
});

test('拒绝 .. 穿越', () => {
    expect(() => parsePath('../etc/passwd')).toThrow();
    expect(() => parsePath('a/../../b')).toThrow();
});

test('拒绝绝对路径', () => {
    expect(() => parsePath('/etc/passwd')).toThrow();
});

test('拒绝空路径', () => {
    expect(() => parsePath('')).toThrow();
    expect(() => parsePath('   ')).toThrow();
});

test('拒绝 null byte', () => {
    expect(() => parsePath('a\0b')).toThrow();
});

test('折叠多余斜杠', () => {
    expect(parsePath('a//b')).toEqual(['a', 'b']);
});

test('拒绝 trailing slash 形式的空段', () => {
    expect(parsePath('a/b/')).toEqual(['a', 'b']);
    expect(() => parsePath('/')).toThrow();
});

test('拒绝 Windows 非法字符', () => {
    expect(() => parsePath('a\\b')).toThrow();
    expect(() => parsePath('a:b')).toThrow();
    expect(() => parsePath('a*b')).toThrow();
});

test('点文件合法（不误伤隐藏文件）', () => {
    expect(parsePath('.env')).toEqual(['.env']);
    expect(parsePath('config/.gitignore')).toEqual(['config', '.gitignore']);
});

test('单点段不逃出根', () => {
    const result = parsePath('./a');
    expect(result.includes('..')).toBe(false);
});
