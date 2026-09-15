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

echo "✓ 子计划 1 端到端通过（上传→免登录查看→401/413/404/400 穿越防护→400 段长→409 冲突透传）"
