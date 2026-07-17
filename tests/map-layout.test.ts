import { describe, expect, test } from 'vitest';

import {
  DETAIL_COLUMN_RECT,
  SOUNDSCAPE_CONTROLS,
  FOOTER_RECT,
  HEADER_RECT,
  MAP_CANVAS_HEIGHT,
  MAP_CANVAS_WIDTH,
  MAP_CENTER,
  MAP_CONTROLS,
  MAP_DRAWABLE_RADIUS_PX,
  MAP_RECT,
  PROGRESS_RECT,
  SELECTED_DETAIL_RECT,
  canvasPointFromUv,
  containsPoint,
} from '../src/ui/mapLayout';

describe('WP-4 fixed map layout', () => {
  test('uses the normative canvas and panel coordinates', () => {
    expect([MAP_CANVAS_WIDTH, MAP_CANVAS_HEIGHT]).toEqual([1024, 768]);
    expect(HEADER_RECT).toEqual({ x: 0, y: 0, width: 1024, height: 84 });
    expect(MAP_RECT).toEqual({ x: 0, y: 84, width: 680, height: 660 });
    expect(DETAIL_COLUMN_RECT).toEqual({ x: 680, y: 84, width: 344, height: 660 });
    expect(FOOTER_RECT).toEqual({ x: 0, y: 744, width: 1024, height: 24 });
    expect(SELECTED_DETAIL_RECT).toEqual({ x: 700, y: 104, width: 304, height: 370 });
    expect(PROGRESS_RECT).toEqual({ x: 700, y: 488, width: 304, height: 32 });
    expect(MAP_CENTER).toEqual({ x: 340, y: 414 });
    expect(MAP_DRAWABLE_RADIUS_PX).toBe(286);
  });

  test('preserves the exact control priority and inclusive-exclusive rectangles', () => {
    expect(MAP_CONTROLS.map(({ id, rect }) => ({ id, rect }))).toEqual([
      { id: 'play-pause', rect: { x: 700, y: 536, width: 96, height: 56 } },
      { id: 'stop', rect: { x: 812, y: 536, width: 96, height: 56 } },
      { id: 'exit-xr', rect: { x: 924, y: 536, width: 80, height: 56 } },
      { id: 'volume-down', rect: { x: 700, y: 608, width: 72, height: 56 } },
      { id: 'volume-up', rect: { x: 788, y: 608, width: 72, height: 56 } },
      { id: 'recenter', rect: { x: 876, y: 608, width: 128, height: 56 } },
      { id: 'recalibrate', rect: { x: 700, y: 680, width: 304, height: 56 } },
    ]);
    expect(containsPoint(MAP_CONTROLS[0]!.rect, 700, 536)).toBe(true);
    expect(containsPoint(MAP_CONTROLS[0]!.rect, 795.999, 591.999)).toBe(true);
    expect(containsPoint(MAP_CONTROLS[0]!.rect, 796, 592)).toBe(false);
  });

  test('places the soundscape control row clear of detail ink and the progress strip', () => {
    expect(SOUNDSCAPE_CONTROLS.map(({ id, rect }) => ({ id, rect }))).toEqual([
      { id: 'stop-all', rect: { x: 700, y: 412, width: 144, height: 56 } },
      { id: 'resume-all', rect: { x: 860, y: 412, width: 144, height: 56 } },
    ]);
    for (const control of SOUNDSCAPE_CONTROLS) {
      expect(control.rect.y + control.rect.height).toBeLessThanOrEqual(PROGRESS_RECT.y);
      expect(control.rect.x).toBeGreaterThanOrEqual(SELECTED_DETAIL_RECT.x);
      expect(control.rect.x + control.rect.width).toBeLessThanOrEqual(
        SELECTED_DETAIL_RECT.x + SELECTED_DETAIL_RECT.width,
      );
    }
  });

  test('converts controller UV and mouse coordinates into one canvas space', () => {
    expect(canvasPointFromUv(0, 0)).toEqual({ x: 0, y: 768 });
    expect(canvasPointFromUv(1, 1)).toEqual({ x: 1024, y: 0 });
    expect(canvasPointFromUv(700 / 1024, 1 - 536 / 768)).toEqual({ x: 700, y: 536 });
  });
});
