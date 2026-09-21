// 缩放数学（mermaid-zoom 泛化：范围参数化，默认保持 mermaid 现值 0.5–3；
// ImageLightbox 传宽域 { min: 0.2, max: 10 }）
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;
export const ZOOM_STEP = 0.2;
/** 滚轮缩放的像素增量→zoom 换算系数（三浮层组件同款手感） */
export const ZOOM_WHEEL_FACTOR = 0.0015;

export function clampZoom(z: number, range: { min?: number; max?: number } = {}): number {
    const min = range.min ?? MIN_ZOOM;
    const max = range.max ?? MAX_ZOOM;
    if (z < min) return min;
    if (z > max) return max;
    return z;
}

export function nextZoom(current: number, delta: number, range?: { min?: number; max?: number }): number {
    return clampZoom(current + delta, range);
}

export function formatZoom(z: number): string {
    return Math.round(z * 100) + '%';
}
