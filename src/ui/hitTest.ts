import type { MapMarkerModel, MapPanelAction, MapPanelModel } from '../domain/types';
import {
  DENSE_GRID_CELL_SIZE_PX,
  MAP_CONTROLS,
  MARKER_HIT_RADIUS_PX,
  containsPoint,
  type MapControlId,
} from './mapLayout';

const DENSE_INDEX_THRESHOLD = 500;
const OVERLAP_CYCLE_WINDOW_MS = 1_500;
// 8px was 0.34deg at 1.25m — below hand tremor and the trigger-pull deflection, so cycling
// silently reset to index 0. The identical-candidate-set check (sameIds) is the real guard;
// this box only rejects gross jumps. ~26px is ~1.1deg.
const OVERLAP_CYCLE_POINT_TOLERANCE_PX = 26;

interface MarkerCandidate {
  marker: MapMarkerModel;
  distanceSquared: number;
}

interface CycleState {
  candidateIds: readonly string[];
  index: number;
  selectedAtMs: number;
  x: number;
  y: number;
}

export interface MarkerSelectionHit {
  kind: 'marker';
  action: Extract<MapPanelAction, { type: 'SELECT_RECORDING' }>;
  marker: MapMarkerModel;
  overlapIndex: number;
  overlapCount: number;
}

export interface ControlHit {
  kind: 'control';
  action: Exclude<MapPanelAction, { type: 'SELECT_RECORDING' }>;
  controlId: MapControlId;
}

export type MapHit = MarkerSelectionHit | ControlHit;

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function markerGeometrySignature(markers: readonly MapMarkerModel[]): string {
  return markers
    .map((marker) => `${marker.recordingId}\u0000${marker.xPx}\u0000${marker.yPx}\u0000${marker.enabled ? 1 : 0}`)
    .join('\u0001');
}

function gridKey(column: number, row: number): string {
  return `${column}:${row}`;
}

function toGridCoordinate(value: number): number {
  return Math.floor(value / DENSE_GRID_CELL_SIZE_PX);
}

function sortedCandidates(markers: readonly MapMarkerModel[], x: number, y: number): MarkerCandidate[] {
  const maximumDistanceSquared = MARKER_HIT_RADIUS_PX * MARKER_HIT_RADIUS_PX;
  return markers
    .map((marker) => {
      const deltaX = marker.xPx - x;
      const deltaY = marker.yPx - y;
      return { marker, distanceSquared: deltaX * deltaX + deltaY * deltaY };
    })
    .filter((candidate) => candidate.distanceSquared <= maximumDistanceSquared)
    .sort((left, right) => {
      const distanceOrder = left.distanceSquared - right.distanceSquared;
      return distanceOrder !== 0
        ? distanceOrder
        : compareIds(left.marker.recordingId, right.marker.recordingId);
    });
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function normalizedGain(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function isXrOnlyControl(controlId: MapControlId): boolean {
  return controlId === 'exit-xr' || controlId === 'recenter' || controlId === 'recalibrate';
}

export function controlActionAt(model: MapPanelModel, x: number, y: number): ControlHit | null {
  for (const control of MAP_CONTROLS) {
    if (!model.xrControlsVisible && isXrOnlyControl(control.id)) {
      continue;
    }
    if (!containsPoint(control.rect, x, y)) {
      continue;
    }

    if (!model.calibrationReady && control.id !== 'exit-xr') {
      return null;
    }

    switch (control.id) {
      case 'play-pause':
        return {
          kind: 'control',
          controlId: control.id,
          action: model.playback.state === 'playing' || model.playback.state === 'loading'
            ? { type: 'PAUSE' }
            : { type: 'PLAY' },
        };
      case 'stop':
        return { kind: 'control', controlId: control.id, action: { type: 'STOP' } };
      case 'exit-xr':
        return { kind: 'control', controlId: control.id, action: { type: 'EXIT_XR' } };
      case 'volume-down': {
        const value = Math.round(Math.max(0, normalizedGain(model.masterGain) - 0.1) * 10) / 10;
        return { kind: 'control', controlId: control.id, action: { type: 'SET_MASTER_GAIN', value } };
      }
      case 'volume-up': {
        const value = Math.round(Math.min(1, normalizedGain(model.masterGain) + 0.1) * 10) / 10;
        return { kind: 'control', controlId: control.id, action: { type: 'SET_MASTER_GAIN', value } };
      }
      case 'recenter':
        return { kind: 'control', controlId: control.id, action: { type: 'RECENTER_PANEL' } };
      case 'recalibrate':
        return { kind: 'control', controlId: control.id, action: { type: 'RECALIBRATE' } };
    }
  }
  return null;
}

export class MapHitTester {
  private markers: readonly MapMarkerModel[] = [];
  private geometrySignature = '';
  private denseGrid: ReadonlyMap<string, readonly MapMarkerModel[]> | null = null;
  private cycle: CycleState | null = null;

  public setMarkers(markers: readonly MapMarkerModel[]): boolean {
    const signature = markerGeometrySignature(markers);
    if (signature === this.geometrySignature) {
      this.markers = markers;
      return false;
    }

    this.markers = markers;
    this.geometrySignature = signature;
    this.cycle = null;
    this.denseGrid = markers.length > DENSE_INDEX_THRESHOLD ? this.buildDenseGrid(markers) : null;
    return true;
  }

  public hover(x: number, y: number): MapMarkerModel | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    return this.candidatesAt(x, y, false)[0]?.marker ?? null;
  }

  public select(model: MapPanelModel, x: number, y: number, nowMs: number): MapHit | null {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(nowMs)) {
      this.cycle = null;
      return null;
    }

    const control = controlActionAt(model, x, y);
    if (control !== null) {
      this.cycle = null;
      return control;
    }
    if (!model.calibrationReady) {
      this.cycle = null;
      return null;
    }

    const candidates = this.candidatesAt(x, y, true);
    if (candidates.length === 0) {
      this.cycle = null;
      return null;
    }

    const candidateIds = candidates.map((candidate) => candidate.marker.recordingId);
    const previous = this.cycle;
    const mayAdvance = previous !== null
      && nowMs >= previous.selectedAtMs
      && nowMs - previous.selectedAtMs <= OVERLAP_CYCLE_WINDOW_MS
      && Math.hypot(x - previous.x, y - previous.y) <= OVERLAP_CYCLE_POINT_TOLERANCE_PX
      && sameIds(previous.candidateIds, candidateIds);
    const index = mayAdvance && previous !== null ? (previous.index + 1) % candidates.length : 0;
    const selected = candidates[index];
    if (selected === undefined) {
      this.cycle = null;
      return null;
    }

    this.cycle = { candidateIds, index, selectedAtMs: nowMs, x, y };
    return {
      kind: 'marker',
      action: { type: 'SELECT_RECORDING', recordingId: selected.marker.recordingId },
      marker: selected.marker,
      overlapIndex: index,
      overlapCount: candidates.length,
    };
  }

  public resetCycle(): boolean {
    const changed = this.cycle !== null;
    this.cycle = null;
    return changed;
  }

  private candidatesAt(x: number, y: number, enabledOnly: boolean): MarkerCandidate[] {
    let candidates: readonly MapMarkerModel[];
    if (this.denseGrid === null) {
      candidates = this.markers;
    } else {
      const column = toGridCoordinate(x);
      const row = toGridCoordinate(y);
      const nearby: MapMarkerModel[] = [];
      for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
        for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
          const cell = this.denseGrid.get(gridKey(column + columnOffset, row + rowOffset));
          if (cell !== undefined) {
            nearby.push(...cell);
          }
        }
      }
      candidates = nearby;
    }
    const eligible = enabledOnly ? candidates.filter((marker) => marker.enabled) : candidates;
    return sortedCandidates(eligible, x, y);
  }

  private buildDenseGrid(markers: readonly MapMarkerModel[]): ReadonlyMap<string, readonly MapMarkerModel[]> {
    const mutable = new Map<string, MapMarkerModel[]>();
    for (const marker of markers) {
      const key = gridKey(toGridCoordinate(marker.xPx), toGridCoordinate(marker.yPx));
      const cell = mutable.get(key);
      if (cell === undefined) {
        mutable.set(key, [marker]);
      } else {
        cell.push(marker);
      }
    }
    return mutable;
  }
}
