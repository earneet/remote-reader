import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, chmod, rm, truncate, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError, type ApiClient } from '../api-client';
import { collectImageProblems, orchestrateImages, rewriteImageRefs, formatImageProblems } from './image-pipeline';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00]);

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rr-imgpipe-'));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const abs = (name: string): string => join(dir, name);
const writePng = async (name: string): Promise<string> => {
    const p = abs(name);
    await writeFile(p, PNG_MAGIC);
    return p;
};

/** 相对路径按 cwd 解析的用例（finally 恢复，防污染同文件后续用例） */
async function withCwd<T>(d: string, fn: () => Promise<T>): Promise<T> {
    const old = process.cwd();
    process.chdir(d);
    try { return await fn(); } finally { process.chdir(old); }
}

function mockApi() {
    return {
        uploadDocument: vi.fn(),
        initImage: vi.fn(),
        relayImage: vi.fn(),
        confirmImage: vi.fn(),
        putImageBytes: vi.fn()
    };
}
const asApi = (m: ReturnType<typeof mockApi>): ApiClient => m as unknown as ApiClient;

/** fake timers 下推进真实事件循环（setImmediate 未被假化），等 readFile 等真实 I/O 走到预期状态 */
async function flushRealIoUntil(pred: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !pred(); i++) {
        await new Promise<void>((r) => setImmediate(r));
    }
    if (!pred()) throw new Error('flushRealIoUntil: 真实 I/O 未在预期轮次内就绪');
}

describe('collectImageProblems（阶段一预检：零字节上传）', () => {
    it('正常两图（PNG+JPEG 魔数）→ 零问题', async () => {
        const a = await writePng('a.png');
        const b = abs('b.jpg');
        await writeFile(b, JPEG_MAGIC);
        expect(await collectImageProblems(`![x](${a}) ![y](${b})`)).toEqual([]);
    });

    it('中文/空格文件名（P1-1 回归）：编码 src decode 后按 cwd 命中磁盘文件', async () => {
        await writeFile(join(dir, '截图 1.png'), PNG_MAGIC);
        await withCwd(dir, async () => {
            expect(await collectImageProblems('![x](<截图 1.png>)')).toEqual([]);
        });
    });

    it('FILE_NOT_FOUND：resolvedPath 是 decode 后形态，hint 含 cwd 基准提示', async () => {
        const problems = await collectImageProblems('![x](nope%20file.png)');
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatchObject({
            code: 'FILE_NOT_FOUND',
            src: 'nope%20file.png',
            resolvedPath: join(process.cwd(), 'nope file.png')
        });
        expect(problems[0].hint).toContain('cwd');
    });

    it('IS_DIRECTORY：src 指向目录', async () => {
        await mkdir(abs('d'));
        const problems = await collectImageProblems(`![x](${abs('d')})`);
        expect(problems).toHaveLength(1);
        expect(problems[0].code).toBe('IS_DIRECTORY');
    });

    it('TOO_LARGE：稀疏 60MB 文件（stat 拦截不读内容）', async () => {
        const p = abs('big.png');
        await writeFile(p, PNG_MAGIC);
        await truncate(p, 60 * 1024 * 1024);
        const problems = await collectImageProblems(`![x](${p})`);
        expect(problems).toHaveLength(1);
        expect(problems[0].code).toBe('TOO_LARGE');
        expect(problems[0].detail).toContain('62914560B');
    });

    it('UNSUPPORTED_FORMAT：SVG 字节 → detail 含 SVG 文案；未知字节 → 通用文案', async () => {
        const svg = abs('x.svg');
        await writeFile(svg, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
        const bin = abs('y.bin');
        await writeFile(bin, Buffer.from('definitely not an image'));
        const problems = await collectImageProblems(`![a](${svg}) ![b](${bin})`);
        expect(problems.map((p) => p.code)).toEqual(['UNSUPPORTED_FORMAT', 'UNSUPPORTED_FORMAT']);
        expect(problems[0].detail).toContain('SVG');
        expect(problems[1].detail).toContain('无法识别');
    });

    it('多问题一次性全报 + formatImageProblems 多行结构含 [i/N] 与建议', async () => {
        await writeFile(abs('x.svg'), Buffer.from('<svg></svg>'));
        const problems = await collectImageProblems(`![a](missing.png) ![b](${abs('x.svg')})`);
        expect(problems).toHaveLength(2);
        const text = formatImageProblems(problems);
        expect(text).toContain('2 个问题');
        expect(text).toContain('[1/2] FILE_NOT_FOUND: "missing.png"');
        expect(text).toContain('[2/2] UNSUPPORTED_FORMAT');
        expect(text).toContain('建议');
        expect(text.split('\n').length).toBeGreaterThan(2);
    });
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
describe.skipIf(isRoot)('权限类用例（root 下 chmod 无效）', () => {
    it('PERMISSION_DENIED：父目录 000 → stat EACCES', async () => {
        await mkdir(abs('locked'));
        await writeFile(abs('locked/secret.png'), PNG_MAGIC);
        await chmod(abs('locked'), 0o000);
        try {
            const problems = await collectImageProblems(`![x](${abs('locked/secret.png')})`);
            expect(problems).toHaveLength(1);
            expect(problems[0].code).toBe('PERMISSION_DENIED');
        } finally {
            await chmod(abs('locked'), 0o755);
        }
    });

    it('READ_ERROR：stat 成功但 open 失败（文件 000）→ detail 含底层错误', async () => {
        const p = await writePng('noread.png');
        await chmod(p, 0o000);
        try {
            const problems = await collectImageProblems(`![x](${p})`);
            expect(problems).toHaveLength(1);
            expect(problems[0].code).toBe('READ_ERROR');
            expect(problems[0].detail).toBeTruthy();
        } finally {
            await chmod(p, 0o644);
        }
    });
});

describe('orchestrateImages（阶段二上传）', () => {
    it('exists → 复用注册名（init 只调一次；reused 计数；注册名非请求名）', async () => {
        const p = await writePng('shot.png');
        const m = mockApi();
        m.initImage.mockResolvedValue({ status: 'exists', name: 'reg-abc.png' });
        const r = await orchestrateImages(`![x](${p})`, asApi(m));
        expect(m.initImage).toHaveBeenCalledTimes(1);
        expect(m.initImage).toHaveBeenCalledWith({
            name: 'shot.png',
            contentHash: expect.any(String),
            contentMd5: expect.any(String),
            sizeBytes: PNG_MAGIC.length
        });
        expect(m.relayImage).not.toHaveBeenCalled();
        expect(m.putImageBytes).not.toHaveBeenCalled();
        expect(r.uploaded).toBe(0);
        expect(r.reused).toBe(1);
        expect(r.rewrites).toBe(1);
        expect(r.content).toBe(`![x](reg-abc.png)`);
    });

    it('direct → putImageBytes(uploadUrl 透传原字节) + confirm ok', async () => {
        const p = await writePng('d.png');
        const m = mockApi();
        m.initImage.mockResolvedValue({ status: 'direct', name: 'n.png', imageId: 'i1', uploadUrl: 'http://put/url' });
        m.confirmImage.mockResolvedValue({ status: 'ok', name: 'reg-d.png' });
        const r = await orchestrateImages(`![x](${p})`, asApi(m));
        expect(m.putImageBytes).toHaveBeenCalledWith('http://put/url', await readFile(p));
        expect(m.confirmImage).toHaveBeenCalledWith({ imageId: 'i1' });
        expect(m.relayImage).not.toHaveBeenCalled();
        expect(r.uploaded).toBe(1);
        expect(r.reused).toBe(0);
        expect(r.content).toBe('![x](reg-d.png)');
    });

    it('direct → confirm 首次 404(missing) → 重 PUT + confirm → ok（P2-1 catch 收窄）', async () => {
        const p = await writePng('d2.png');
        const m = mockApi();
        m.initImage.mockResolvedValue({ status: 'direct', name: 'n.png', imageId: 'i2', uploadUrl: 'u' });
        m.confirmImage
            .mockRejectedValueOnce(new ApiError(404, 'missing'))
            .mockResolvedValueOnce({ status: 'ok', name: 'reg-d2.png' });
        const r = await orchestrateImages(`![x](${p})`, asApi(m));
        expect(m.putImageBytes).toHaveBeenCalledTimes(2);
        expect(m.confirmImage).toHaveBeenCalledTimes(2);
        expect(r.uploaded).toBe(1);
        expect(r.content).toBe('![x](reg-d2.png)');
    });

    it('relay → base64 内容正确（mock 捕获），不走直传', async () => {
        const p = await writePng('r.png');
        const m = mockApi();
        m.initImage.mockResolvedValue({ status: 'relay', name: 'n.png', imageId: 'i3' });
        m.relayImage.mockResolvedValue({ name: 'reg-r.png' });
        const r = await orchestrateImages(`![x](${p})`, asApi(m));
        expect(m.relayImage).toHaveBeenCalledWith({ imageId: 'i3', contentBase64: (await readFile(p)).toString('base64') });
        expect(m.putImageBytes).not.toHaveBeenCalled();
        expect(r.uploaded).toBe(1);
        expect(r.content).toBe('![x](reg-r.png)');
    });

    it('429 → 按 Retry-After 秒退避后重试成功（fake timers）', async () => {
        const p = await writePng('r429.png');
        const m = mockApi();
        m.initImage
            .mockRejectedValueOnce(new ApiError(429, 'too many', 1))
            .mockResolvedValueOnce({ status: 'exists', name: 'reg-429.png' });
        // 只假化 setTimeout：readFile 是真实 I/O，需要真实事件循环推进到 init 首调 + sleep 定时器挂上
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const t = orchestrateImages(`![x](${p})`, asApi(m));
            await flushRealIoUntil(() => m.initImage.mock.calls.length === 1);
            await vi.advanceTimersByTimeAsync(999);
            expect(m.initImage).toHaveBeenCalledTimes(1); // Retry-After=1s 未到不重试
            await vi.advanceTimersByTimeAsync(1);
            const r = await t;
            expect(r.reused).toBe(1);
            expect(r.content).toBe('![x](reg-429.png)');
        } finally {
            vi.useRealTimers();
        }
    });

    it('429 无 Retry-After → 默认 30s 退避；2 次仍 429 → throw 进度摘要', async () => {
        const p = await writePng('r429b.png');
        const m = mockApi();
        m.initImage.mockRejectedValue(new ApiError(429, 'too many'));
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const t = orchestrateImages(`![x](${p})`, asApi(m));
            const assertion = expect(t).rejects.toThrow(/已成功 0 张（重试时相同内容自动跳过），失败于第 1\/1 张 ".*r429b\.png"：/);
            await flushRealIoUntil(() => m.initImage.mock.calls.length === 1);
            await vi.advanceTimersByTimeAsync(29_999);
            expect(m.initImage).toHaveBeenCalledTimes(1); // 默认 30s 未到不重试
            await vi.advanceTimersByTimeAsync(1);
            expect(m.initImage).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(30_000);
            await assertion;
            expect(m.initImage).toHaveBeenCalledTimes(3); // 初次 + 2 次退避后放弃
        } finally {
            vi.useRealTimers();
        }
    });

    it('relay invalid → throw 含 reason 与进度（已成功 1 张…失败于第 2/2 张）', async () => {
        const a = await writePng('a.png');
        const b = await writePng('b.png');
        const m = mockApi();
        m.initImage
            .mockResolvedValueOnce({ status: 'exists', name: 'reg-a.png' })
            .mockResolvedValueOnce({ status: 'relay', name: 'n.png', imageId: 'i9' });
        m.relayImage.mockRejectedValue(new ApiError(400, '图片内容与 init 声明不一致'));
        await expect(orchestrateImages(`![x](${a}) ![y](${b})`, asApi(m))).rejects.toThrow(
            /已成功 1 张（重试时相同内容自动跳过），失败于第 2\/2 张 ".*b\.png"：图片内容与 init 声明不一致/
        );
        expect(m.putImageBytes).not.toHaveBeenCalled();
    });

    it('同一图两次引用（不同行）→ 一次上传两处改写（rewrites=2）', async () => {
        const p = await writePng('dup.png');
        const m = mockApi();
        m.initImage.mockResolvedValue({ status: 'exists', name: 'reg-dup.png' });
        const md = `intro\n\n![a](${p})\n\nmiddle\n\n![b](${p})\n`;
        const r = await orchestrateImages(md, asApi(m));
        expect(m.initImage).toHaveBeenCalledTimes(1);
        expect(r.rewrites).toBe(2);
        expect(r.content.match(/reg-dup\.png/g)).toHaveLength(2);
    });
});

describe('rewriteImageRefs（token 级改写）', () => {
    it('code block / inline code 内相同 src 文本不被替换（token 行定位证据）', () => {
        const md = '![a](x.png)\n```\n![b](x.png)\n```\n`![c](x.png)`';
        const { content, rewrites } = rewriteImageRefs(md, new Map([['x.png', 'reg.png']]));
        const lines = content.split('\n');
        expect(lines[0]).toBe('![a](reg.png)');
        expect(lines[2]).toBe('![b](x.png)');
        expect(lines[4]).toBe('`![c](x.png)`');
        expect(rewrites).toBe(1);
    });

    it('raw（编码形态）→ 服务器注册名（非请求名；依赖行定位双形态命中）', () => {
        const { content } = rewriteImageRefs('![截图](截图.png)', new Map([['%E6%88%AA%E5%9B%BE.png', 'a1b2c3d4.png']]));
        expect(content).toBe('![截图](a1b2c3d4.png)');
    });

    it('P2-2 子串互蚀回归：同行 mylogo.png 与 logo.png 互不污染', () => {
        const md = '![a](mylogo.png) ![b](logo.png)';
        const { content } = rewriteImageRefs(md, new Map([['mylogo.png', 'reg-a.png'], ['logo.png', 'logo-2.png']]));
        expect(content).toBe('![a](reg-a.png) ![b](logo-2.png)');
    });

    it('P0-1 行定位回归：多行段落图片在第二行 → 该行改写；表格内图片 → 该行改写', () => {
        const multi = rewriteImageRefs('l0\n![m](m.png)\nl2', new Map([['m.png', 'r-m.png']]));
        expect(multi.content).toBe('l0\n![m](r-m.png)\nl2');
        const table = rewriteImageRefs('| a | b |\n|---|---|\n| ![x](t.png) | y |', new Map([['t.png', 'r-t.png']]));
        expect(table.content.split('\n')[2]).toBe('| ![x](r-t.png) | y |');
    });

    it('空 rename → 原文返回，rewrites=0', () => {
        const { content, rewrites } = rewriteImageRefs('![a](x.png)', new Map());
        expect(content).toBe('![a](x.png)');
        expect(rewrites).toBe(0);
    });

    it('终审 P3：行定位失败（entity/转义写法使原文行不含 src 任何形态）→ 跳过不 crash', () => {
        // markdown-it 把 a&amp;b.png 解码为 a&b.png（token src），原文行只含 a&amp;b.png
        // → lineOf 全形态 miss → line=-1。改写须跳过（图已上传，残留路径由渲染端裸名匹配自愈）。
        const r = rewriteImageRefs('![a](a&amp;b.png)', new Map([['a&b.png', 'reg.png']]));
        expect(r.content).toBe('![a](a&amp;b.png)'); // 原样保留（不 crash、不误改）
        expect(r.rewrites).toBe(0);
    });
});
