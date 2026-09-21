import { test, expect } from 'vitest';
import {
    MIN_ZOOM,
    MAX_ZOOM,
    ZOOM_STEP,
    clampZoom,
    nextZoom,
    formatZoom
} from '../src/lib/shared/zoom';

test('常量约定（默认 mermaid 范围）', () => {
    expect(MIN_ZOOM).toBe(0.5);
    expect(MAX_ZOOM).toBe(3);
    expect(ZOOM_STEP).toBe(0.2);
});

test('clampZoom: 范围内原值返回', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(2.5)).toBe(2.5);
});

test('clampZoom: 低于下限夹到下限', () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(-1)).toBe(MIN_ZOOM);
});

test('clampZoom: 高于上限夹到上限', () => {
    expect(clampZoom(5)).toBe(MAX_ZOOM);
});

test('nextZoom: 步进并夹取', () => {
    expect(nextZoom(1, ZOOM_STEP)).toBe(1.2);
    expect(nextZoom(MAX_ZOOM, ZOOM_STEP)).toBe(MAX_ZOOM);
    expect(nextZoom(MIN_ZOOM, -ZOOM_STEP)).toBe(MIN_ZOOM);
});

test('formatZoom: 百分比展示', () => {
    expect(formatZoom(1)).toBe('100%');
    expect(formatZoom(1.2)).toBe('120%');
    expect(formatZoom(0.5)).toBe('50%');
    expect(formatZoom(3)).toBe('300%');
});

// —— 参数化范围（ImageLightbox 宽域 {min:0.2, max:10}）——

test('clampZoom: 自定义范围夹取', () => {
    expect(clampZoom(0.1, { min: 0.2, max: 10 })).toBe(0.2);
    expect(clampZoom(12, { min: 0.2, max: 10 })).toBe(10);
    expect(clampZoom(1, { min: 0.2, max: 10 })).toBe(1);
});

test('clampZoom: 半指定范围，另一侧回落默认', () => {
    expect(clampZoom(4, { min: 0.2 })).toBe(MAX_ZOOM);
    expect(clampZoom(0.3, { max: 10 })).toBe(MIN_ZOOM);
});

test('nextZoom: 自定义范围步进并夹取', () => {
    expect(nextZoom(1, ZOOM_STEP, { min: 0.2, max: 10 })).toBe(1.2);
    expect(nextZoom(9.9, ZOOM_STEP, { min: 0.2, max: 10 })).toBe(10);
    expect(nextZoom(0.25, -ZOOM_STEP, { min: 0.2, max: 10 })).toBe(0.2);
});
