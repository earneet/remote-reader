// hooks.server.ts 写入 locals.user 的形状；app.d.ts 按此类型化（role 供 admin 分支判断）
export interface User {
    id: string;
    email: string;
    role: 'admin' | 'member';
    createdAt: number;
}
