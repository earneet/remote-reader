import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { rmSync, readdirSync, statSync } from 'node:fs';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// per-run 测试库隔离（2026-09-26 测试审查 P1）：默认共享 ./data/app.db 时，两个并发的
// vitest 实例（多终端 / 多 agent / CI 并行 job）会经 resetDb 互删对方进程刚插入的行——
// 实测 100% 复现，且失败形态伪装成产品 bug（403/401/FK constraint）。这里在主进程 config
// 加载时按 pid 分配独立库文件，worker fork 继承启动时 env 快照 → 同一 run 内全部文件
// 共享该库（顺序执行 + 逐测试 resetDb 语义不变），跨 run 天然互不可见。
// 清理用纯 Node exit hook（主进程退出时删库 + WAL/SHM）——⚠️ vitest 4.1 没有 globalTeardown
// 配置项（与历史上的 singleFork 同为静默 no-op，全库 0 命中），勿改用；globalSetup 虽存在但
// 其 env 变更传播到 worker 是 pool 时序副作用而非文档化契约（官方推荐 provide/inject 桥接，
// 而产品代码直读 process.env），且清理仍需 exit hook——config 加载副作用 + fork 继承 env
// 是 Node 文档化行为，故弃用 globalSetup。kill -9 不触发 exit，残留由启动清扫兜底
// （删 1h 前的陈旧 test-run-*；并发实例刚建的库 mtime 为当前时刻，不会误删）。
// 显式预设 DATABASE_PATH 调试时不接管、不清理。
if (!process.env.DATABASE_PATH) {
    const runDb = `./data/test-run-${process.pid}.db`;
    process.env.DATABASE_PATH = runDb;
    process.on('exit', () => {
        for (const f of [runDb, `${runDb}-wal`, `${runDb}-shm`]) {
            try { rmSync(f, { force: true }); } catch { /* 尽力而为，残留无害（gitignored） */ }
        }
    });
    try {
        for (const name of readdirSync('./data')) {
            if (!name.startsWith('test-run-')) continue;
            try {
                if (Date.now() - statSync(`./data/${name}`).mtimeMs > 3_600_000) {
                    rmSync(`./data/${name}`, { force: true });
                }
            } catch { /* 单文件失败不阻塞 */ }
        }
    } catch { /* data/ 不存在（首跑）则跳过 */ }
}

export default defineConfig({
    resolve: {
        alias: {
            $server: r('./apps/web/src/lib/server'),
            $shared: r('./packages/shared/src'),
            $components: r('./apps/web/src/lib/components'),
            $lib: r('./apps/web/src/lib')
        }
    },
    // 执行模型（2026-09-26 探针实证，vitest 4.1.10）：fileParallelism:false → maxWorkers=1，
    // 文件顺序执行但**每文件独立 fork**——process.env 与模块状态逐文件隔离，跨文件不泄漏。
    // ⚠️ 历史配置 pool/poolOptions.forks.singleFork 在 vitest 4.1 并不存在（全库 0 命中，
    // 静默 no-op），“singleFork 强制全部文件跑在同一 fork”的心智模型是错的，已移除勿再引入；
    // 顺序性的真正保证是 fileParallelism:false。文件内串扰由 helpers.ts resetDb 逐测试清表兜底，
    // 跨实例串扰由顶部 per-run DATABASE_PATH 封死。
    test: {
        environment: 'node',
        fileParallelism: false,
        include: [
            'packages/shared/src/**/*.test.ts',
            'apps/web/tests/**/*.test.ts',
            'apps/mcp-bridge/tests/**/*.test.ts'
        ],
        exclude: ['node_modules', '**/.svelte-kit', '**/build', '**/dist']
    }
});
