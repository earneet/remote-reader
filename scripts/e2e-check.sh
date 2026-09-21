#!/usr/bin/env bash
set -euo pipefail

BASE=${BASE_URL:-http://localhost:5173}
TOKEN=${API_TOKEN:?need API_TOKEN env (用 `node scripts/seed-token.mjs <email>` 生成)}

echo "→ 上传文档"
RESP=$(curl -s -X POST "$BASE/api/v1/documents" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"e2e.md","content":"# E2E\n\n```ts\nconst a=1;\n```","path":"checks"}')
echo "$RESP"
URL=$(printf '%s' "$RESP" | grep -o '"url":"[^"]*"' | sed 's/"url":"//;s/"//')
[ -n "$URL" ] || { echo "FAIL: 上传未返回 url"; exit 1; }

echo "→ 验证查看页可达（免登录 200）"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$URL")
echo "status=$STATUS"
[ "$STATUS" = "200" ] || { echo "FAIL: 查看页不可达"; exit 1; }

echo "→ 验证错误场景"
S=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/documents" \
  -H "Content-Type: application/json" -d '{"name":"x.md","content":"x"}')
[ "$S" = "401" ] || { echo "FAIL: 无 token 应 401，实际 $S"; exit 1; }

BIG_FILE=$(mktemp)
node -e "process.stdout.write(JSON.stringify({name:'big.md',content:'a'.repeat(6000000)}))" > "$BIG_FILE"
S=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/documents" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data @"$BIG_FILE")
rm -f "$BIG_FILE"
[ "$S" = "413" ] || { echo "FAIL: 超大应 413，实际 $S"; exit 1; }

S=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/s/nonexistent-token-xxx")
[ "$S" = "404" ] || { echo "FAIL: 失效链接应 404，实际 $S"; exit 1; }

echo "→ 验证路径穿越防护（name 与 path 都过 parsePath）"
S=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/documents" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"../../../evil.md","content":"x"}')
[ "$S" = "400" ] || { echo "FAIL: 穿越 name 应 400，实际 $S"; exit 1; }

S=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/documents" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"ok.md","content":"x","path":"../escape"}')
[ "$S" = "400" ] || { echo "FAIL: 穿越 path 应 400，实际 $S"; exit 1; }

echo "→ 验证单段长度防护（parsePath NAME_MAX 拦截）"
S=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/documents" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"$(printf 'a%.0s' $(seq 1 300)).md\",\"content\":\"x\"}")
[ "$S" = "400" ] || { echo "FAIL: 300B 单段名应 400，实际 $S"; exit 1; }

echo "→ 验证跨类型同名冲突 409 + message 透传"
S=$(curl -s -w "\n%{http_code}" -X POST "$BASE/api/v1/documents" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"conflict-probe.md","content":"x"}')
S_CODE=$(echo "$S" | tail -1)
S_BODY=$(echo "$S" | head -1)
[ "$S_CODE" = "200" ] || { echo "FAIL: 预置文档应 200，实际 $S_CODE"; exit 1; }
S=$(curl -s -w "\n%{http_code}" -X POST "$BASE/api/v1/documents" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"inner.md","content":"y","path":"conflict-probe.md"}')
S_CODE=$(echo "$S" | tail -1)
S_BODY=$(echo "$S" | head -1)
[ "$S_CODE" = "409" ] || { echo "FAIL: 路径段撞同名文件应 409，实际 $S_CODE"; exit 1; }
echo "$S_BODY" | grep -q "已被同名文件占用" || { echo "FAIL: 409 响应应携带冲突原因 message，实际 $S_BODY"; exit 1; }

echo "→ 验证图片支持全链路（init 三态/relay 真实 PNG/带图 md/代理 URL/引用回收/错误场景）"
# node -e 一站式生成真实 PNG（魔数 + payload，字节落盘供比对）与 SVG/第二张 PNG 的 hash/base64 元数据
IMG_PNG=$(mktemp); IMG_META=$(mktemp); IMG_GET=$(mktemp); IMG_HDR=$(mktemp)
img_fail() { echo "FAIL: $1"; rm -f "$IMG_PNG" "$IMG_META" "$IMG_GET" "$IMG_HDR"; exit 1; }
node -e '
const { createHash } = require("crypto");
const fs = require("fs");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const md5 = (b) => createHash("md5").update(b).digest("hex");
const MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = Buffer.concat([MAGIC, Buffer.alloc(120, 7)]);
fs.writeFileSync(process.argv[1], png);
const png2 = Buffer.concat([MAGIC, Buffer.alloc(100, 9)]);
const svg = Buffer.from("<svg xmlns=\u0027http://www.w3.org/2000/svg\u0027><script>alert(1)</script></svg>");
process.stdout.write(JSON.stringify({
  hash: sha256(png), md5: md5(png), size: png.length, b64: png.toString("base64"),
  png2Hash: sha256(png2), png2Md5: md5(png2), png2Size: png2.length, png2B64: png2.toString("base64"),
  svgHash: sha256(svg), svgMd5: md5(svg), svgSize: svg.length, svgB64: svg.toString("base64")
}));' "$IMG_PNG" > "$IMG_META" || img_fail "PNG 元数据生成失败"
jstr() { grep -o "\"$1\":\"[^\"]*\"" "$IMG_META" | sed "s/\"$1\":\"//;s/\"//" ; }
IMG_HASH=$(jstr hash); IMG_MD5=$(jstr md5); IMG_B64=$(jstr b64)
PNG2_HASH=$(jstr png2Hash); PNG2_MD5=$(jstr png2Md5); PNG2_B64=$(jstr png2B64)
SVG_HASH=$(jstr svgHash); SVG_MD5=$(jstr svgMd5); SVG_B64=$(jstr svgB64)
IMG_SIZE=$(grep -o '"size":[0-9]*' "$IMG_META" | sed 's/"size"://')
PNG2_SIZE=$(grep -o '"png2Size":[0-9]*' "$IMG_META" | sed 's/"png2Size"://')
SVG_SIZE=$(grep -o '"svgSize":[0-9]*' "$IMG_META" | sed 's/"svgSize"://')

# 1) init 新图 → relay 态（local 后端；direct 态需 s3 配置才出现）。init 只验 hash 格式/大小/文件名，不验内容
S=$(curl -s -w "\n%{http_code}" -X POST "$BASE/api/v1/images/init" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"e2e-shot.png\",\"content_hash\":\"$IMG_HASH\",\"content_md5\":\"$IMG_MD5\",\"size_bytes\":$IMG_SIZE}")
S_CODE=$(echo "$S" | tail -1); S_BODY=$(echo "$S" | head -1)
[ "$S_CODE" = "200" ] || img_fail "init 应 200，实际 $S_CODE：$S_BODY"
echo "$S_BODY" | grep -q '"status":"relay"' || img_fail "init 应 relay 态，实际 $S_BODY"
echo "$S_BODY" | grep -q '"name":"e2e-shot.png"' || img_fail "init 应返回注册名，实际 $S_BODY"
IMAGE_ID=$(printf '%s' "$S_BODY" | grep -o '"imageId":"[^"]*"' | sed 's/"imageId":"//;s/"//')
[ -n "$IMAGE_ID" ] || img_fail "init 未返回 imageId：$S_BODY"

# 2) relay 真实 PNG 字节（sha256 字节绑定 + 魔数/扩展名校验链）
S=$(curl -s -w "\n%{http_code}" -X POST "$BASE/api/v1/images" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"image_id\":\"$IMAGE_ID\",\"content_base64\":\"$IMG_B64\"}")
S_CODE=$(echo "$S" | tail -1); S_BODY=$(echo "$S" | head -1)
[ "$S_CODE" = "200" ] || img_fail "relay 应 200，实际 $S_CODE：$S_BODY"
echo "$S_BODY" | grep -q '"name":"e2e-shot.png"' || img_fail "relay 应返回注册名，实际 $S_BODY"

# 3) 图 ready 后同 hash 再 init → exists（内容寻址去重幂等）
S=$(curl -s -X POST "$BASE/api/v1/images/init" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"another-name.png\",\"content_hash\":\"$IMG_HASH\",\"content_md5\":\"$IMG_MD5\",\"size_bytes\":$IMG_SIZE}")
echo "$S" | grep -q '"status":"exists"' || img_fail "同 hash 再 init 应 exists，实际 $S"
echo "$S" | grep -q '"name":"e2e-shot.png"' || img_fail "exists 应返回既有注册名，实际 $S"

# 4) 上传带图 md（content 用 init 返回的注册名裸引用）
RESP=$(curl -s -X POST "$BASE/api/v1/documents" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"img-e2e.md","content":"# 带图 e2e\n\n![截图](e2e-shot.png)","path":"checks"}')
IMG_DOC_URL=$(printf '%s' "$RESP" | grep -o '"url":"[^"]*"' | sed 's/"url":"//;s/"//')
[ -n "$IMG_DOC_URL" ] || img_fail "带图文档上传未返回 url：$RESP"

# 5) 查看页 200 且 SSR HTML 含图片代理 URL（local 后端走 /s/<token>/i/<name>）
curl -sf "$IMG_DOC_URL" | grep -q "/i/e2e-shot.png" || img_fail "查看页 HTML 应含代理 URL /i/e2e-shot.png"

# 6) 代理 GET → 200 + Content-Type image/png + 字节与原图逐字节一致
S=$(curl -s -D "$IMG_HDR" -o "$IMG_GET" -w "%{http_code}" "$IMG_DOC_URL/i/e2e-shot.png")
[ "$S" = "200" ] || img_fail "代理 URL 应 200，实际 $S"
grep -qi '^content-type: image/png' "$IMG_HDR" || { echo "--- headers ---"; cat "$IMG_HDR"; img_fail "代理响应 Content-Type 应为 image/png"; }
cmp -s "$IMG_PNG" "$IMG_GET" || img_fail "代理返回字节与原图不一致"

# 7) refs 白名单：未注册名 → 404（share token 不能枚举 owner 其他图）
S=$(curl -s -o /dev/null -w "%{http_code}" "$IMG_DOC_URL/i/not-registered.png")
[ "$S" = "404" ] || img_fail "未注册图名应 404，实际 $S"

# 8) 引用回收：覆盖上传无图版 → 代理 URL 立即 404（gcImagesIfUnreferenced 软删墓碑同步完成）。
#    文档删除走 FM form action（session 认证）无 API token 通道——覆盖 refs 重算触发同一同步 GC 不变量
S=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/documents" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"img-e2e.md","content":"# 无图覆盖版","path":"checks"}')
[ "$S" = "200" ] || img_fail "无图覆盖上传应 200，实际 $S"
S=$(curl -s -o /dev/null -w "%{http_code}" "$IMG_DOC_URL/i/e2e-shot.png")
[ "$S" = "404" ] || img_fail "引用回收后代理 URL 应立即 404，实际 $S"

# 9) SVG 拒收：init 合法（只验格式）→ relay 真实 SVG 字节 → 400 invalid（可携脚本，安全考虑不支持）
S=$(curl -s -X POST "$BASE/api/v1/images/init" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"e2e-evil.png\",\"content_hash\":\"$SVG_HASH\",\"content_md5\":\"$SVG_MD5\",\"size_bytes\":$SVG_SIZE}")
SVG_ID=$(printf '%s' "$S" | grep -o '"imageId":"[^"]*"' | sed 's/"imageId":"//;s/"//')
[ -n "$SVG_ID" ] || img_fail "SVG init 未返回 imageId：$S"
S=$(curl -s -w "\n%{http_code}" -X POST "$BASE/api/v1/images" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"image_id\":\"$SVG_ID\",\"content_base64\":\"$SVG_B64\"}")
S_CODE=$(echo "$S" | tail -1); S_BODY=$(echo "$S" | head -1)
[ "$S_CODE" = "400" ] || img_fail "SVG relay 应 400，实际 $S_CODE：$S_BODY"
echo "$S_BODY" | grep -q '"status":"invalid"' || img_fail "SVG relay 应 status=invalid，实际 $S_BODY"

# 10) 谎报 hash：init 报称 PNG2 的 hash、relay 送 PNG1 字节 → 400 invalid（sha256 字节绑定）
S=$(curl -s -X POST "$BASE/api/v1/images/init" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"e2e-lie.png\",\"content_hash\":\"$PNG2_HASH\",\"content_md5\":\"$PNG2_MD5\",\"size_bytes\":$PNG2_SIZE}")
LIE_ID=$(printf '%s' "$S" | grep -o '"imageId":"[^"]*"' | sed 's/"imageId":"//;s/"//')
[ -n "$LIE_ID" ] || img_fail "谎报 hash init 未返回 imageId：$S"
S=$(curl -s -w "\n%{http_code}" -X POST "$BASE/api/v1/images" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"image_id\":\"$LIE_ID\",\"content_base64\":\"$IMG_B64\"}")
S_CODE=$(echo "$S" | tail -1); S_BODY=$(echo "$S" | head -1)
[ "$S_CODE" = "400" ] || img_fail "谎报 hash relay 应 400，实际 $S_CODE：$S_BODY"
echo "$S_BODY" | grep -q '"status":"invalid"' || img_fail "谎报 hash 应 status=invalid，实际 $S_BODY"
rm -f "$IMG_PNG" "$IMG_META" "$IMG_GET" "$IMG_HDR"


echo "→ 验证登录页 Agent 指引块在 SSR HTML 中"
curl -sf "$BASE/login" | grep -q 'id="agent-guide"' || { echo "FAIL: 登录页缺少 agent-guide 指引块"; exit 1; }

# 可选全链路：提供 E2E_INVITE_CODE 时验证 Agent 自助注册→建 token→上传
if [ -n "${E2E_INVITE_CODE:-}" ]; then
  echo "→ 验证 Agent 自助注册→建 token→上传全链路"
  JAR=$(mktemp)
  EMAIL="e2e-$(date +%s)@example.com"
  S=$(curl -s -o /dev/null -w "%{http_code}" -c "$JAR" -X POST "$BASE/api/v1/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"e2e-password-123\",\"invite_code\":\"$E2E_INVITE_CODE\"}")
  [ "$S" = "200" ] || { echo "FAIL: 注册应 200，实际 $S"; rm -f "$JAR"; exit 1; }
  TOKEN_JSON=$(curl -s -b "$JAR" -X POST "$BASE/api/v1/auth/api-token" \
    -H "Content-Type: application/json" -d '{"name":"e2e-agent"}')
  rm -f "$JAR"
  NEW_TOKEN=$(printf '%s' "$TOKEN_JSON" | grep -o '"token":"[^"]*"' | sed 's/"token":"//;s/"//')
  [ -n "$NEW_TOKEN" ] || { echo "FAIL: 未返回 token，实际 $TOKEN_JSON"; exit 1; }
  S=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/documents" \
    -H "Authorization: Bearer $NEW_TOKEN" -H "Content-Type: application/json" \
    -d '{"name":"e2e-agent.md","content":"# agent e2e","path":"checks"}')
  [ "$S" = "200" ] || { echo "FAIL: 新 token 上传应 200，实际 $S"; exit 1; }
fi

echo "✓ 端到端通过（上传→免登录查看→错误场景→图片全链路→agent-guide 指引块${E2E_INVITE_CODE:+→自助注册全链路}）"
