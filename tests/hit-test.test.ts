import { describe, expect, test } from 'vitest';

import type { MapMarkerModel, MapPanelModel } from '../src/domain/types';
import { MapHitTester, controlActionAt } from '../src/ui/hitTest';
import { canvasPointFromUv } from '../src/ui/mapLayout';

function marker(
  recordingId: string,
  xPx: number,
  yPx: number,
  enabled = true,
): MapMarkerModel {
  return {
    recordingId,
    xPx,
    yPx,
    state: enabled ? 'default' : 'disabled',
    enabled,
    ...(enabled ? {} : { disabledReason: 'unsupported-audio' as const }),
  };
}

function model(markers: readonly MapMarkerModel[], overrides: Partial<MapPanelModel> = {}): MapPanelModel {
  return {
    collectionTitle: 'fixture',
    xrControlsVisible: true,
    panelVisible: true,
    soundscapeControlsVisible: false,
    markers,
    distanceRings: [],
    playback: { state: 'stopped', currentTimeSec: 0 },
    masterGain: 0.7,
    calibrationReady: true,
    controllerAvailable: true,
    ...overrides,
  };
}

describe('WP-4 hit testing', () => {
  test('evaluates controls before overlapping markers and uses exact actions', () => {
    const panelModel = model([marker('under-control', 720, 550)]);
    const tester = new MapHitTester();
    tester.setMarkers(panelModel.markers);

    expect(tester.select(panelModel, 720, 550, 1_000)).toMatchObject({
      kind: 'control',
      controlId: 'play-pause',
      action: { type: 'PLAY' },
    });
    expect(controlActionAt(
      model([], { playback: { state: 'loading', recordingId: 'x', currentTimeSec: 0 } }),
      720,
      550,
    )).toMatchObject({ action: { type: 'PAUSE' } });
    expect(controlActionAt(model([], { masterGain: 0 }), 710, 620)).toMatchObject({
      action: { type: 'SET_MASTER_GAIN', value: 0 },
    });
    expect(controlActionAt(model([], { masterGain: 1 }), 800, 620)).toMatchObject({
      action: { type: 'SET_MASTER_GAIN', value: 1 },
    });
  });

  test('allows only Exit MR through the panel while calibration is pending', () => {
    const calibrating = model([marker('marker', 340, 414)], { calibrationReady: false });
    const tester = new MapHitTester();
    tester.setMarkers(calibrating.markers);

    expect(tester.select(calibrating, 340, 414, 1)).toBeNull();
    expect(tester.select(calibrating, 720, 550, 2)).toBeNull();
    expect(tester.select(calibrating, 950, 550, 3)).toMatchObject({
      kind: 'control',
      action: { type: 'EXIT_XR' },
    });
  });

  test('sorts equal-distance candidates by UTF-16 ID and cycles deterministic overlaps', () => {
    const panelModel = model([
      marker('ä', 340, 414),
      marker('Z', 340, 414),
      marker('a', 340, 414),
    ]);
    const tester = new MapHitTester();
    tester.setMarkers(panelModel.markers);

    expect(tester.select(panelModel, 340, 414, 1_000)).toMatchObject({
      action: { recordingId: 'Z' },
      overlapIndex: 0,
      overlapCount: 3,
    });
    expect(tester.select(panelModel, 340, 414, 1_100)).toMatchObject({
      action: { recordingId: 'a' },
      overlapIndex: 1,
    });
    expect(tester.select(panelModel, 340, 414, 1_200)).toMatchObject({
      action: { recordingId: 'ä' },
      overlapIndex: 2,
    });
    expect(tester.select(panelModel, 349, 414, 1_300)).toMatchObject({
      action: { recordingId: 'Z' },
      overlapIndex: 0,
    });
  });

  test('advances the overlap cycle under natural jitter above the old 8px box', () => {
    const panelModel = model([
      marker('ä', 340, 414),
      marker('Z', 340, 414),
      marker('a', 340, 414),
    ]);
    const tester = new MapHitTester();
    tester.setMarkers(panelModel.markers);

    expect(tester.select(panelModel, 340, 414, 1_000)).toMatchObject({
      action: { recordingId: 'Z' },
      overlapIndex: 0,
    });
    // A ~9px re-click (below hand tremor, above the retired 8px box) must still advance
    // through the identical candidate set instead of silently resetting to index 0.
    expect(tester.select(panelModel, 349, 414, 1_100)).toMatchObject({
      action: { recordingId: 'a' },
      overlapIndex: 1,
    });
  });

  test('includes disabled markers in hover order but never selects them', () => {
    const panelModel = model([
      marker('a-disabled', 200, 200, false),
      marker('b-enabled', 200, 200),
    ]);
    const tester = new MapHitTester();
    tester.setMarkers(panelModel.markers);

    expect(tester.hover(200, 200)?.recordingId).toBe('a-disabled');
    expect(tester.select(panelModel, 200, 200, 1)).toMatchObject({
      kind: 'marker',
      action: { type: 'SELECT_RECORDING', recordingId: 'b-enabled' },
      overlapCount: 1,
    });
  });

  test('keeps dense-fixture records reachable through the deterministic grid', () => {
    const markers = Array.from({ length: 501 }, (_, index) => marker(`overlap-${String(index).padStart(3, '0')}`, 340, 414));
    const panelModel = model(markers);
    const tester = new MapHitTester();
    tester.setMarkers(panelModel.markers);

    const visited = new Set<string>();
    for (let index = 0; index < markers.length; index += 1) {
      const hit = tester.select(panelModel, 340, 414, 50 + index);
      expect(hit?.kind).toBe('marker');
      if (hit?.kind === 'marker') visited.add(hit.marker.recordingId);
    }
    expect(visited.size).toBe(markers.length);
  });

  test('resolves controller UV and mouse coordinates to the same target', () => {
    const panelModel = model([marker('parity', 256, 192)]);
    const mouseTester = new MapHitTester();
    const controllerTester = new MapHitTester();
    mouseTester.setMarkers(panelModel.markers);
    controllerTester.setMarkers(panelModel.markers);
    const controllerPoint = canvasPointFromUv(0.25, 0.75);

    expect(mouseTester.select(panelModel, 256, 192, 1)?.action).toEqual({
      type: 'SELECT_RECORDING',
      recordingId: 'parity',
    });
    expect(controllerTester.select(panelModel, controllerPoint.x, controllerPoint.y, 1)?.action).toEqual({
      type: 'SELECT_RECORDING',
      recordingId: 'parity',
    });
  });
});
