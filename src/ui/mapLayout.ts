export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasRect extends CanvasPoint {
  width: number;
  height: number;
}

export const MAP_CANVAS_WIDTH = 1024 as const;
export const MAP_CANVAS_HEIGHT = 768 as const;
// Supersample factor for the backing canvas only. The logical drawing space stays
// 1024x768 (the frozen XRInteractionSurface coordinates); a larger backing bitmap plus a
// context transform raise texture density above the display's PPD. Setting this to 1
// reproduces the pre-supersampling layout byte-for-byte.
export const MAP_CANVAS_SCALE = 1.5 as const;
export const MAP_WORLD_WIDTH_M = 0.96 as const;
export const MAP_WORLD_HEIGHT_M = 0.72 as const;

export const HEADER_RECT = Object.freeze<CanvasRect>({ x: 0, y: 0, width: 1024, height: 84 });
export const MAP_RECT = Object.freeze<CanvasRect>({ x: 0, y: 84, width: 680, height: 660 });
export const DETAIL_COLUMN_RECT = Object.freeze<CanvasRect>({ x: 680, y: 84, width: 344, height: 660 });
export const FOOTER_RECT = Object.freeze<CanvasRect>({ x: 0, y: 744, width: 1024, height: 24 });
export const SELECTED_DETAIL_RECT = Object.freeze<CanvasRect>({ x: 700, y: 104, width: 304, height: 370 });
export const PROGRESS_RECT = Object.freeze<CanvasRect>({ x: 700, y: 488, width: 304, height: 32 });

export const MAP_CENTER = Object.freeze<CanvasPoint>({ x: 340, y: 414 });
export const MAP_DRAWABLE_RADIUS_PX = 286 as const;
export const MARKER_VISUAL_RADIUS_PX = 8 as const;
export const MARKER_HIT_RADIUS_PX = 22 as const;
export const DENSE_GRID_CELL_SIZE_PX = 64 as const;

export type MapControlId =
  | 'play-pause'
  | 'stop'
  | 'exit-xr'
  | 'volume-down'
  | 'volume-up'
  | 'recenter'
  | 'recalibrate';

export interface MapControlLayout {
  id: MapControlId;
  label: string;
  rect: Readonly<CanvasRect>;
}

export const MAP_CONTROLS: readonly Readonly<MapControlLayout>[] = Object.freeze([
  { id: 'play-pause', label: 'Play', rect: Object.freeze({ x: 700, y: 536, width: 96, height: 56 }) },
  { id: 'stop', label: 'Stop', rect: Object.freeze({ x: 812, y: 536, width: 96, height: 56 }) },
  { id: 'exit-xr', label: 'Exit MR', rect: Object.freeze({ x: 924, y: 536, width: 80, height: 56 }) },
  { id: 'volume-down', label: 'Volume -', rect: Object.freeze({ x: 700, y: 608, width: 72, height: 56 }) },
  { id: 'volume-up', label: 'Volume +', rect: Object.freeze({ x: 788, y: 608, width: 72, height: 56 }) },
  { id: 'recenter', label: 'Recenter', rect: Object.freeze({ x: 876, y: 608, width: 128, height: 56 }) },
  { id: 'recalibrate', label: 'Recalibrate north', rect: Object.freeze({ x: 700, y: 680, width: 304, height: 56 }) },
] satisfies MapControlLayout[]);

export function containsPoint(rect: Readonly<CanvasRect>, x: number, y: number): boolean {
  return x >= rect.x
    && x < rect.x + rect.width
    && y >= rect.y
    && y < rect.y + rect.height;
}

export function canvasPointFromUv(uvX: number, uvY: number): CanvasPoint {
  return {
    x: uvX * MAP_CANVAS_WIDTH,
    y: (1 - uvY) * MAP_CANVAS_HEIGHT,
  };
}

export function clampCanvasPoint(point: Readonly<CanvasPoint>): CanvasPoint {
  return {
    x: Math.min(MAP_CANVAS_WIDTH, Math.max(0, point.x)),
    y: Math.min(MAP_CANVAS_HEIGHT, Math.max(0, point.y)),
  };
}
