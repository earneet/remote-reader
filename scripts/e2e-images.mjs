#!/usr/bin/env node
// ImageLightbox 一次性 Playwright 验收（图片支持 Phase 5 Task 4b，不进 CI，手动运行）。
// 前置：dev server 已起（BASE_URL，默认 http://localhost:5173）+ API_TOKEN env（seed-token 生成）。
// 运行（playwright 不在项目依赖内，经 NODE_PATH 指向任意含 playwright 的 node_modules）：
//   NODE_PATH=<...>/node_modules API_TOKEN=rr_xxx node scripts/e2e-images.mjs
// 断言集：正文图渲染 → 点击开 lightbox（序号/工具栏）→ 滚轮缩放 → >1x 拖动平移 →
// pinch 合成（factor 基准式，断言无指数爆炸）→ Esc 关闭 → 双击 250% → 方向键切图（每图独立重置）→ 全屏/关闭按钮。

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try {
    ({ chromium } = require('playwright'));
} catch {
    console.error('未解析到 playwright：NODE_PATH 指向含 playwright 的 node_modules 再跑（见文件头注释）');
    process.exit(1);
}

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const TOKEN = process.env.API_TOKEN;
if (!TOKEN) {
    console.error('need API_TOKEN env（用 `node scripts/seed-token.mjs <email>` 生成）');
    process.exit(1);
}

// —— 最小合法 PNG 构造（8×8 纯色；魔数+垃圾字节浏览器无法解码，DOM 断言需要真实可渲染图）——
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function crc32(buf) {
    let c;
    const table = [];
    for (let n = 0; n < 256; n++) {
        c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}
function solidPng(rgb) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(8, 0);
    ihdr.writeUInt32BE(8, 4);
    ihdr[8] = 8; // 位深
    ihdr[9] = 2; // 颜色类型 truecolor
    const rows = Array.from({ length: 8 }, () => Buffer.from([0, ...rgb])); // 每行 filter 0 + 8 像素
    return Buffer.concat([PNG_MAGIC, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const md5 = (b) => createHash('md5').update(b).digest('hex');

async function api(path, body) {
    const r = await fetch(BASE + path, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(j)}`);
    return j;
}

async function uploadImage(name, bytes) {
    const init = await api('/api/v1/images/init', {
        name, content_hash: sha256(bytes), content_md5: md5(bytes), size_bytes: bytes.length
    });
    if (init.status === 'exists') return init.name; // 重跑幂等：同 hash 去重
    const relay = await api('/api/v1/images', { image_id: init.imageId, content_base64: bytes.toString('base64') });
    if (!relay.name) throw new Error(`relay 无 name：${JSON.stringify(relay)}`);
    return relay.name;
}

let passed = 0;
function ok(cond, name) {
    if (!cond) {
        console.error(`✗ ${name}`);
        throw new Error(name);
    }
    passed++;
    console.log(`✓ ${name}`);
}

const PINCH = `(() => {
    const stage = document.querySelector('.rr-imglb-stage');
    const fire = (type, id, x, y) => stage.dispatchEvent(new PointerEvent(type, {
        pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y,
        bubbles: true, cancelable: true
    }));
    fire('pointerdown', 1, 500, 400);
    fire('pointerdown', 2, 600, 400);   // 起始指距 100
    fire('pointermove', 1, 450, 400);
    fire('pointermove', 2, 650, 400);   // 指距 200 → factor 2 → zoom 200%
    fire('pointermove', 1, 400, 400);
    fire('pointermove', 2, 700, 400);   // 指距 300 → factor 3 → zoom 300%（若错误累积式则 600%）
    fire('pointerup', 1, 500, 400);
    fire('pointerup', 2, 600, 400);
})()`;

const browser = await chromium.launch();
try {
    // —— 准备：两张不同色图 + 带图 md（图集语义需要 ≥2 张）——
    const name1 = await uploadImage('e2e-lb-red.png', solidPng([200, 60, 60]));
    const name2 = await uploadImage('e2e-lb-blue.png', solidPng([60, 60, 200]));
    const doc = await api('/api/v1/documents', {
        name: 'img-lb-e2e.md',
        content: `# 图集 e2e\n\n![红图](${name1})\n\n![蓝图](${name2})\n`,
        path: 'checks'
    });
    if (!doc.url) throw new Error(`上传未返回 url：${JSON.stringify(doc)}`);

    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(doc.url);
    await page.waitForSelector('.markdown-body img');
    // SSR HTML 即满足 waitForSelector——真实点击必须等 hydration（事件委托挂载）完成；
    // networkidle 后仍以"点击→验证→重试"兜底（hydration 时序不作为断言前提）
    await page.waitForLoadState('networkidle');
    const imgs = await page.$$('.markdown-body img');
    ok(imgs.length >= 2, `正文图片渲染（${imgs.length} 张）`);

    async function openVia(img) {
        for (let i = 0; i < 10 && !(await page.$('.rr-imglb-overlay')); i++) {
            await img.click();
            await page.waitForTimeout(400);
        }
        await overlay.waitFor();
    }

    // —— 打开 lightbox ——
    const overlay = page.locator('.rr-imglb-overlay');
    await openVia(imgs[0]);
    const label = overlay.locator('.rr-imglb-label');
    await overlay.locator('.rr-imglb-ctrls button[title="放大"]').waitFor();
    ok((await label.textContent()) === '图片 1 / 2 · 100%', 'lightbox 开启：序号 + 初始 100% + 工具栏可见');

    // —— 滚轮缩放 ——
    const box = await overlay.locator('.rr-imglb-stage').boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -200); // zoom = 1 + 0.3
    ok((await label.textContent()) === '图片 1 / 2 · 130%', '滚轮缩放：100% → 130%');

    // —— >1x 态拖动平移 ——
    const wrapTransform = () => page.$eval('.rr-imglb-wrap', (el) => el.style.transform);
    const t0 = await wrapTransform();
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy + 40, { steps: 4 });
    await page.mouse.up();
    const t1 = await wrapTransform();
    // 滚轮锚定补偿可能带入 ±0.5px 半像素残差——按数值 ±1px 容差断言
    const pan = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(t1);
    ok(t0 !== t1 && pan !== null && Math.abs(parseFloat(pan[1]) - 60) <= 1 && Math.abs(parseFloat(pan[2]) - 40) <= 1, `拖动平移生效（${t1}）`);

    // —— pinch 合成：factor 基准式（P1-2 验收——无指数爆炸）——
    await overlay.locator('button[title="重置 100%"]').click();
    await page.evaluate(PINCH);
    ok((await label.textContent()) === '图片 1 / 2 · 300%', 'pinch 基准式：factor 3 → 300%（累积式错误实现会到 600%）');

    // —— Esc 关闭 ——
    await page.keyboard.press('Escape');
    await overlay.waitFor({ state: 'detached' });
    ok(true, 'Esc 关闭 lightbox');

    // —— 重开（点第二张）→ 双击放大 → 切图重置 ——
    await openVia(imgs[1]);
    ok((await label.textContent()) === '图片 2 / 2 · 100%', '点击第二张重开：start 索引正确');
    const box2 = await overlay.locator('.rr-imglb-stage').boundingBox();
    await page.mouse.dblclick(box2.x + box2.width / 2, box2.y + box2.height / 2);
    ok((await label.textContent()) === '图片 2 / 2 · 250%', '双击放大：→ 250%');
    await page.keyboard.press('ArrowLeft');
    ok((await label.textContent()) === '图片 1 / 2 · 100%', '← 切图：索引回退 + 每图独立重置 100%');

    // —— 全屏按钮（class 驱动视觉全屏；headless 下 requestFullscreen 可能被拒，class 已先行翻转）——
    await overlay.locator('button[title="全屏"]').click();
    ok((await overlay.getAttribute('class')).includes('rr-fs'), '全屏按钮：rr-fs 视觉全屏 class 生效');
    await overlay.locator('button[title="关闭"]').click();
    await overlay.waitFor({ state: 'detached' });
    ok(true, '工具栏关闭按钮');

    console.log(`\n✓ lightbox Playwright 验收全部通过（${passed} 项断言）`);
} finally {
    await browser.close();
}
