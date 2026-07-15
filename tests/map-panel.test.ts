import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { MapPanel, MapPanelModel } from '../src/domain/types';
import { createMapPanel } from '../src/ui/MapPanel';
import { MAP_CANVAS_HEIGHT, MAP_CANVAS_SCALE, MAP_CANVAS_WIDTH } from '../src/ui/mapLayout';

function createCanvasContext(): CanvasRenderingContext2D {
  return {
    arc: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    lineTo: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 8 }) as TextMetrics),
    moveTo: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    strokeText: vi.fn(),
    fillStyle: '',
    font: '',
    lineWidth: 1,
    lineJoin: 'miter',
    strokeStyle: '',
    textAlign: 'left',
  } as unknown as CanvasRenderingContext2D;
}

function createModel(): MapPanelModel {
  return {
    collectionTitle: 'Cardinal recordings',
    xrControlsVisible: true,
    panelVisible: true,
    markers: [
      { recordingId: 'north', xPx: 340, yPx: 128, state: 'selected', enabled: true },
      {
        recordingId: 'unsupported',
        xPx: 400,
        yPx: 200,
        state: 'disabled',
        enabled: false,
        disabledReason: 'unsupported-audio',
      },
    ],
    distanceRings: [
      { normalizedRadius: 0.25, distanceText: '25 m' },
      { normalizedRadius: 0.5, distanceText: '50 m' },
      { normalizedRadius: 0.75, distanceText: '75 m' },
      { normalizedRadius: 1, distanceText: '100 m' },
    ],
    selected: {
      recordingId: 'north',
      title: 'North',
      latitudeText: '37.5674',
      longitudeText: '126.9780',
      distanceText: '100 m',
      bearingText: '0° N',
      description: 'North fixture',
    },
    playback: {
      state: 'paused',
      recordingId: 'north',
      loadedRecordingId: 'north',
      currentTimeSec: 12,
      durationSec: 60,
    },
    masterGain: 0.7,
    calibrationReady: true,
    controllerAvailable: true,
  };
}

let context: CanvasRenderingContext2D;
let getContextSpy: ReturnType<typeof vi.spyOn>;
let panel: MapPanel | undefined;

beforeEach(() => {
  context = createCanvasContext();
  getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
});

afterEach(() => {
  panel?.dispose();
  panel = undefined;
  getContextSpy.mockRestore();
});

describe('WP-4 canvas map panel', () => {
  test('owns one stable canvas/texture/plane and renders preprojected model data', () => {
    const scene = new THREE.Scene();
    panel = createMapPanel(scene);
    const canvas = panel.getCanvas();
    const object = panel.getObject3D() as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    const texture = object.material.map as THREE.CanvasTexture;

    expect(panel.getCanvas()).toBe(canvas);
    // The backing bitmap is supersampled; the logical drawing space (1024x768) is
    // unchanged. MAP_CANVAS_SCALE = 1 would reproduce the original 1024x768 backing.
    expect(canvas.width).toBe(MAP_CANVAS_WIDTH * MAP_CANVAS_SCALE);
    expect(canvas.height).toBe(MAP_CANVAS_HEIGHT * MAP_CANVAS_SCALE);
    expect(scene.children).toEqual([object]);
    expect(object.geometry.parameters).toMatchObject({ width: 0.96, height: 0.72 });
    expect(texture.image).toBe(canvas);
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(texture.minFilter).toBe(THREE.LinearFilter);
    expect(texture.magFilter).toBe(THREE.LinearFilter);
    expect(texture.generateMipmaps).toBe(false);

    panel.setModel(createModel());
    const drawnText = vi.mocked(context.fillText).mock.calls.map(([text]) => text);
    expect(drawnText).toContain('Cardinal recordings');
    expect(drawnText).toContain('37.5674, 126.9780');
    expect(drawnText).toContain('100 m');
    expect(object.material.transparent).toBe(true);
  });

  test('redraws only for event-driven visible changes', () => {
    panel = createMapPanel(new THREE.Scene());
    const object = panel.getObject3D() as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    const texture = object.material.map as THREE.CanvasTexture;
    const mapModel = createModel();

    panel.setModel(mapModel);
    const modelVersion = texture.version;
    panel.setModel(mapModel);
    expect(texture.version).toBe(modelVersion);

    panel.updateHover(400, 200, 1);
    const hoverVersion = texture.version;
    expect(hoverVersion).toBeGreaterThan(modelVersion);
    panel.updateHover(400, 200, 2);
    expect(texture.version).toBe(hoverVersion);
    panel.clearHover();
    expect(texture.version).toBeGreaterThan(hoverVersion);
  });

  test('uses the shared hit path for semantic marker and control actions', () => {
    panel = createMapPanel(new THREE.Scene());
    const mapModel = createModel();
    panel.setModel(mapModel);

    expect(panel.hitTest(340, 128, 10)).toEqual({ type: 'SELECT_RECORDING', recordingId: 'north' });
    expect(panel.hitTest(720, 550, 11)).toEqual({ type: 'PLAY' });
    expect(panel.hitTest(820, 550, 12)).toEqual({ type: 'STOP' });
    expect(panel.hitTest(950, 550, 13)).toEqual({ type: 'EXIT_XR' });
  });

  test('classifies pointer targets for the reticle without redrawing the canvas', () => {
    panel = createMapPanel(new THREE.Scene());
    const object = panel.getObject3D() as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    const texture = object.material.map as THREE.CanvasTexture;
    panel.setModel(createModel());
    const version = texture.version;

    expect(panel.classifyTarget(720, 550)).toBe('control'); // play-pause control rect
    expect(panel.classifyTarget(340, 128)).toBe('marker'); // enabled 'north' marker
    expect(panel.classifyTarget(400, 200)).toBe('disabled'); // unsupported marker
    expect(panel.classifyTarget(500, 400)).toBe('panel'); // empty map area
    expect(texture.version).toBe(version); // classification never repaints the canvas
  });

  test('omits XR-only controls and their hit targets in desktop debug mode', () => {
    panel = createMapPanel(new THREE.Scene());
    vi.mocked(context.fillText).mockClear();
    panel.setModel({
      ...createModel(),
      xrControlsVisible: false,
      calibrationReady: false,
      controllerAvailable: false,
    });

    const drawnText = vi.mocked(context.fillText).mock.calls.map(([text]) => text);
    expect(drawnText).not.toContain('Exit MR');
    expect(drawnText).not.toContain('Recenter');
    expect(drawnText).not.toContain('Recalibrate');
    expect(drawnText).not.toContain('Face north, then pull the trigger.');
    expect(drawnText).not.toContain('No tracked controller. Use the Quest system control to exit Mixed Reality.');
    expect(panel.hitTest(950, 550, 1)).toBeNull();
    expect(panel.hitTest(900, 620, 2)).toBeNull();
    expect(panel.hitTest(800, 700, 3)).toBeNull();
  });

  test('makes the calibration instruction dominant and hides dead controls while calibrating', () => {
    panel = createMapPanel(new THREE.Scene());
    vi.mocked(context.fillText).mockClear();
    panel.setModel({ ...createModel(), calibrationReady: false });

    const drawnText = vi.mocked(context.fillText).mock.calls.map(([text]) => text);
    expect(drawnText).toContain('Face north, then pull the trigger.');
    expect(drawnText).toContain('Exit MR');
    expect(drawnText).not.toContain('Stop');
    expect(drawnText).not.toContain('Recenter');
  });

  test('haloes ring strokes with a second dark pass for passthrough legibility', () => {
    panel = createMapPanel(new THREE.Scene());
    const base = { ...createModel(), markers: [] };
    const rings = createModel().distanceRings;
    const strokeMock = vi.mocked(context.stroke);

    strokeMock.mockClear();
    panel.setModel({ ...base, distanceRings: rings.slice(0, 4) });
    const four = strokeMock.mock.calls.length;
    strokeMock.mockClear();
    panel.setModel({ ...base, distanceRings: rings.slice(0, 2) });
    const two = strokeMock.mock.calls.length;

    // Each ring adds exactly two stroke passes (halo + ink); the constant crosshair
    // strokes cancel out of the difference.
    expect(four - two).toBe(4);
  });

  test('surfaces controller fallback guidance without adding another input resource', () => {
    panel = createMapPanel(new THREE.Scene());
    panel.setModel({ ...createModel(), controllerAvailable: false });

    const drawnText = vi.mocked(context.fillText).mock.calls.map(([text]) => text);
    expect(drawnText).toContain('No tracked controller. Use the Quest system control to exit Mixed Reality.');
  });

  test('recenters from the camera while retaining the last valid horizontal forward', () => {
    panel = createMapPanel(new THREE.Scene());
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(2, 1.6, 3);
    camera.updateMatrixWorld(true);

    panel.setPoseFromCamera(camera);
    const object = panel.getObject3D();
    expect(object.position.toArray()).toEqual([2, 1.52, 1.75]);
    const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(object.quaternion);
    expect(facing.x).toBeCloseTo(0, 8);
    expect(facing.y).toBeCloseTo(0, 8);
    expect(facing.z).toBeCloseTo(1, 8);

    camera.rotation.x = -Math.PI / 2;
    camera.position.set(4, 2, 5);
    camera.updateMatrixWorld(true);
    panel.setPoseFromCamera(camera);
    expect(object.position.x).toBeCloseTo(4, 8);
    expect(object.position.y).toBeCloseTo(1.92, 8);
    expect(object.position.z).toBeCloseTo(3.75, 8);
  });

  test('disposes idempotently and rejects later public work', () => {
    const scene = new THREE.Scene();
    panel = createMapPanel(scene);
    const object = panel.getObject3D() as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    const texture = object.material.map as THREE.CanvasTexture;
    const geometryDispose = vi.spyOn(object.geometry, 'dispose');
    const materialDispose = vi.spyOn(object.material, 'dispose');
    const textureDispose = vi.spyOn(texture, 'dispose');

    panel.dispose();
    panel.dispose();
    expect(scene.children).toHaveLength(0);
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(textureDispose).toHaveBeenCalledTimes(1);
    expect(() => panel?.getCanvas()).toThrowError(expect.objectContaining({ code: 'APP_DISPOSED' }));
  });
});
