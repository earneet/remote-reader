// 服务端建议的最低桥版本（Layer ③）：低于此版本的桥不支持图片自动上传（md 本地引用不改写 → 查看页裂图）。
// 上传成功响应经 X-Remote-Reader-Min-Bridge 头下发，桥据此自检并提示升级。
export const MIN_BRIDGE_VERSION = '0.2.0';
