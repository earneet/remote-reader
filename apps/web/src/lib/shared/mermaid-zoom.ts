export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;
export const ZOOM_STEP = 0.2;

export function clampZoom(z: number): number {
    if (z < MIN_ZOOM) return MIN_ZOOM;
    if (z > MAX_ZOOM) return MAX_ZOOM;
    return z;
}

export function nextZoom(current: number, delta: number): number {
    return clampZoom(current + delta);
}

export function formatZoom(z: number): string {
    return Math.round(z * 100) + '%';
}
