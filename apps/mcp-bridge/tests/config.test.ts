import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config';

const TMP = './data/test-bridge-config';
const CFG_DIR = join(TMP, 'remote-reader');
const CFG_FILE = join(CFG_DIR, 'config.json');

beforeEach(() => {
    mkdirSync(CFG_DIR, { recursive: true });
    process.env.XDG_CONFIG_HOME = TMP;
});

afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.REMOTE_READER_URL;
    delete process.env.REMOTE_READER_TOKEN;
    rmSync(TMP, { recursive: true, force: true });
});

test('从配置文件读', () => {
    writeFileSync(CFG_FILE, JSON.stringify({ baseUrl: 'https://app', token: 'rr_f' }));
    expect(loadConfig()).toEqual({ baseUrl: 'https://app', token: 'rr_f' });
});

test('env 覆盖文件', () => {
    writeFileSync(CFG_FILE, JSON.stringify({ baseUrl: 'https://file', token: 'rr_file' }));
    process.env.REMOTE_READER_URL = 'https://env';
    process.env.REMOTE_READER_TOKEN = 'rr_env';
    expect(loadConfig()).toEqual({ baseUrl: 'https://env', token: 'rr_env' });
});

test('仅 env（无文件）也能工作', () => {
    rmSync(CFG_DIR, { recursive: true, force: true });
    process.env.REMOTE_READER_URL = 'https://env';
    process.env.REMOTE_READER_TOKEN = 'rr_env';
    expect(loadConfig()).toEqual({ baseUrl: 'https://env', token: 'rr_env' });
});

test('都缺失则 process.exit(1)', () => {
    rmSync(CFG_DIR, { recursive: true, force: true });
    const spy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('exit-1');
    }) as never);
    expect(() => loadConfig()).toThrow('exit-1');
    expect(spy).toHaveBeenCalledWith(1);
    spy.mockRestore();
});
