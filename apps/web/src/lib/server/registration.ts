import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from './db';
import { hashPassword, verifyPassword, generateId, sha256Hex } from './auth';
import { redeemInviteCodeTx, isInviteCodeValid } from './invites';

// 注册/登录核心逻辑（form action 与 /api/v1/auth/* JSON 端点共用）。
// 错误风格裁定：预期业务失败返回 result 对象，路由层转 fail()/error()。
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
// 卫生上限：防超长输入放大——argon2 线性 prehash、DB/限流键膨胀（审查 LOW 项加固）
const MAX_EMAIL = 254;
const MAX_PASSWORD = 1024;

// 事务内邀请码失效的信号（预检通过、核销时被并发撤销/过期）
class InviteRejected extends Error {}

export type RegisterResult = { ok: true; userId: string } | { ok: false; status: number; message: string };

export async function registerUser(input: {
    email: string;
    password: string;
    inviteCode: string;
}): Promise<RegisterResult> {
    const email = input.email.trim().toLowerCase();
    const { password, inviteCode } = input;

    if (!email || !password) return { ok: false, status: 400, message: 'email 与 password 必填' };
    if (!EMAIL_RE.test(email)) return { ok: false, status: 400, message: '邮箱格式不正确' };
    if (email.length > MAX_EMAIL) return { ok: false, status: 400, message: `邮箱过长（≤${MAX_EMAIL} 字符）` };
    if (password.length < MIN_PASSWORD) return { ok: false, status: 400, message: `密码至少 ${MIN_PASSWORD} 位` };
    if (password.length > MAX_PASSWORD) return { ok: false, status: 400, message: `密码过长（≤${MAX_PASSWORD} 字符）` };

    // 邀请码预检（不核销）：INITIAL_INVITE_CODE 引导码或 DB 邀请码；403 先于 409（不泄露邮箱存在性）。
    // bootstrap 恒定时间比较：两侧先 sha256（长度恒 64）再 timingSafeEqual，防明文 === 的前缀时序侧信道
    const bootstrap = process.env.INITIAL_INVITE_CODE;
    const isBootstrap = !!bootstrap && timingSafeEqual(
        Buffer.from(sha256Hex(inviteCode), 'utf8'),
        Buffer.from(sha256Hex(bootstrap), 'utf8')
    );
    if (!isBootstrap && !isInviteCodeValid(inviteCode)) {
        return { ok: false, status: 403, message: '邀请码无效' };
    }

    const existing = db.select().from(schema.users).where(eq(schema.users.email, email)).get();
    if (existing) return { ok: false, status: 409, message: '该邮箱已注册' };

    const passwordHash = await hashPassword(password);
    // 核销与建用户同一事务：失败注册不烧计数；firstUser 判定 + 插入同事务（better-sqlite3 同步原子）
    try {
        const userId = db.transaction((tx) => {
            if (!isBootstrap && !redeemInviteCodeTx(tx, inviteCode)) throw new InviteRejected();
            const firstUser = tx.select().from(schema.users).all().length === 0;
            const id = generateId();
            tx.insert(schema.users).values({
                id,
                email,
                passwordHash,
                role: (firstUser ? 'admin' : 'member') as 'admin' | 'member',
                createdAt: Date.now()
            }).run();
            return id;
        });
        return { ok: true, userId };
    } catch (e) {
        if (e instanceof InviteRejected) return { ok: false, status: 403, message: '邀请码无效' };
        if (e instanceof Error && (e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return { ok: false, status: 409, message: '该邮箱已注册' };
        }
        throw e;
    }
}

// 用户不存在时也对 dummy hash 跑一次 argon2 verify，响应时延与存在时一致（防邮箱枚举）
let dummyHash: string | null = null;

// email 须已由调用方归一化（trim + lowercase）——登录限流键含归一化邮箱，归一化必须在路由层先发生
export async function authenticateUser(email: string, password: string): Promise<{ id: string } | null> {
    // 注册已限密码 ≤ MAX_PASSWORD，超长值不可能为有效密码——跳过 argon2 防长输入 CPU 放大
    if (password.length > MAX_PASSWORD) return null;
    const user = db.select().from(schema.users).where(eq(schema.users.email, email)).get();
    if (!user) {
        if (!dummyHash) dummyHash = await hashPassword('dummy-nonexistent-user');
        await verifyPassword(password, dummyHash);
        return null;
    }
    const ok = await verifyPassword(password, user.passwordHash);
    return ok ? { id: user.id } : null;
}
