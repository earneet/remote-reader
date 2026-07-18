import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(resolve('apps/web/package.json'));
const Database = require('better-sqlite3');

const dbPath = process.env.DATABASE_PATH ?? resolve('apps/web/data/app.db');
const email = process.argv[2];

if (!email) {
    console.error('usage: node scripts/seed-token.mjs <email>');
    process.exit(1);
}

const db = new Database(dbPath);
const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (!user) {
    console.error('user not found:', email);
    process.exit(1);
}

const plaintext = 'rr_' + randomBytes(32).toString('base64url');
const tokenHash = createHash('sha256').update(plaintext, 'utf8').digest('hex');
const id = randomUUID() + Date.now().toString(36);

db.prepare(
    `INSERT INTO api_tokens (id, user_id, name, token_hash, last_used_at, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`
).run(id, user.id, 'seed', tokenHash, Date.now());

console.warn('⚠️  此 Token 仅显示一次，请立即保存，勿提交到代码仓库或粘贴到聊天工具。');
console.log('TOKEN=' + plaintext);
