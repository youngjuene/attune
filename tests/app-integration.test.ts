import * as THREE from 'three';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createAppController, getGlobalResourceCounts, initializeApp } from '../src/app/AppController';
import type {
  AppConfig,
  InitializedLocation,
  LocationInitializer,
  ManifestLoadResult,
  MapPanel,
  MapPanelAction,
  MapPanelModel,
  PlaybackEligibility,
  PlaybackSnapshot,
  PointerTargetKind,
  RuntimeResourceCounts,
  SoundscapeEvent,
  SoundscapePlayer,
  SoundscapeResourceCounts,
  Unsubscribe,
  XRInteractionSurface,
  XRRuntimeEvent,
  XRSessionController,
  XRSessionHandle,
} from '../src/domain/types';

const config = (debugMode: boolean): AppConfig => ({
  manifestUrl: 'https://example.test/content.json',
  audioLoadTimeoutMs: 20_000,
  progressUpdateHz: 4,
  maxSimultaneousSources: 1,
  buildCommit: 'integration-test',
  debugMode,
});

const manifestResult: ManifestLoadResult = {
  manifest: {
    schemaVersion: '1.0',
    collection: { id: 'fixture', title: 'Fixture' },
    recordings: [{
      id: 'north', title: 'North', audioUrl: './north.wav', location: { lat: 37.567, lon: 126.978 },
      spatialFormat: 'point-source', mimeType: 'audio/wav', tags: [], gainDb: 0,
    }],
  },
  records: [{
    id: 'north', title: 'North', audioUrl: './north.wav', resolvedAudioUrl: 'https://example.test/north.wav',
    location: { lat: 37.567, lon: 126.978 }, spatialFormat: 'point-source', mimeType: 'audio/wav',
    tags: [], gainDb: 0,
  }],
  rejected: [],
  warnings: [],
};

const originalSecure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
const originalXr = Object.getOwnPropertyDescriptor(navigator, 'xr');
const originalGeo = Object.getOwnPropertyDescriptor(navigator, 'geolocation');

afterEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  if (originalSecure === undefined) delete (window as { isSecureContext?: boolean }).isSecureContext;
  else Object.defineProperty(window, 'isSecureContext', originalSecure);
  if (originalXr === undefined) delete (navigator as Navigator & { xr?: XRSystem }).xr;
  else Object.defineProperty(navigator, 'xr', originalXr);
  if (originalGeo === undefined) delete (navigator as unknown as { geolocation?: Geolocation }).geolocation;
  else Object.defineProperty(navigator, 'geolocation', originalGeo);
  vi.restoreAllMocks();
});

function setCapabilities(options: { secure: boolean; xr?: XRSystem; geolocation?: Geolocation }): void {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: options.secure });
  Object.defineProperty(navigator, 'xr', { configurable: true, value: options.xr });
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: options.geolocation });
}

class FakeMapPanel implements MapPanel {
  public readonly models: MapPanelModel[] = [];
  public readonly canvas = document.createElement('canvas');
  public readonly object = new THREE.Object3D();
  public disposed = false;
  public poses = 0;
  public hitAction: MapPanelAction | null = null;
  public readonly hits: Array<{ x: number; y: number; now: number }> = [];
  public setModel(model: MapPanelModel): void { this.models.push(model); }
  public getCanvas(): HTMLCanvasElement { return this.canvas; }
  public setPoseFromCamera(): void { this.poses += 1; }
  public updateHover(): void {}
  public clearHover(): void {}
  public hitTest(x: number, y: number, now: number): MapPanelAction | null {
    this.hits.push({ x, y, now });
    return this.hitAction;
  }
  public targetKind: PointerTargetKind = 'panel';
  public classifyTarget(): PointerTargetKind { return this.targetKind; }
  public getObject3D(): THREE.Object3D { return this.object; }
  public dispose(): void { this.disposed = true; }
}

class FakeAudioPlayer implements SoundscapePlayer {
  public readonly commands: string[] = [];
  public readonly selectedPositions: THREE.Vector3[] = [];
  public readonly appliedPositions: THREE.Vector3[] = [];
  private readonly listeners = new Set<(event: SoundscapeEvent) => void>();
  private current: PlaybackSnapshot = { state: 'empty', currentTimeSec: 0 };
  public watchdog: 0 | 1 = 0;
  public fade: 0 | 1 = 0;
  public classifyMimeType(): PlaybackEligibility { return 'eligible'; }
  public resumeContext(): Promise<void> { this.commands.push('resume'); return Promise.resolve(); }
  public activate(
    generation: number,
    recording: ManifestLoadResult['records'][number],
    position: THREE.Vector3,
  ): Promise<void> {
    this.commands.push(`select:${generation}:${recording.id}`);
    this.selectedPositions.push(position.clone());
    this.current = { state: 'loading', recordingId: recording.id, currentTimeSec: 0 };
    for (const listener of this.listeners) {
      listener({ generation, recordingId: recording.id, snapshot: this.current });
    }
    return Promise.resolve();
  }
  public deactivate(generation: number, recordingId: string): void {
    this.commands.push(`deactivate:${generation}:${recordingId}`);
  }
  public playById(generation: number, _recordingId: string): Promise<void> { this.commands.push(`play:${generation}`); return Promise.resolve(); }
  public pauseById(generation: number, _recordingId: string, reason: 'user' | 'lifecycle'): void { this.commands.push(`pause:${generation}:${reason}`); }
  public stopById(generation: number, _recordingId: string): void { this.commands.push(`stop:${generation}`); }
  public pauseAll(generation: number, reason: 'user' | 'lifecycle'): void { this.commands.push(`pause:${generation}:${reason}`); }
  public stopAll(generation: number): void { this.commands.push(`stopAll:${generation}`); }
  public playAll(generation: number): Promise<void> { this.commands.push(`playAll:${generation}`); return Promise.resolve(); }
  public setPosition(_recordingId: string, position: THREE.Vector3): void {
    this.appliedPositions.push(position.clone());
    this.commands.push(`position:${position.toArray().join(',')}`);
  }
  public setMasterGain(value: number): void { this.commands.push(`gain:${value}`); }
  public setDistanceGain(recordingId: string, value: number): void { this.commands.push(`distanceGain:${recordingId}:${value}`); }
  public activeRecordingIds(): readonly string[] {
    return this.current.recordingId === undefined ? [] : [this.current.recordingId];
  }
  public snapshotById(): PlaybackSnapshot { return this.current; }
  public subscribe(listener: (event: SoundscapeEvent) => void): Unsubscribe {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  public resourceCounts(): SoundscapeResourceCounts {
    return {
      mediaElements: 1, mediaElementSourceNodes: 1, audioSourceObjects: 1, listeners: 1,
      positionalAudioObjects: 1, panners: 1, registeredMediaHandlers: 10,
      activeLoadWatchdogs: this.watchdog, activeFadeCompletionTimers: this.fade,
    };
  }
  public dispose(): void { this.commands.push('dispose'); this.listeners.clear(); }
}

class FakeXrController implements XRSessionController {
  public readonly scene = new THREE.Scene();
  public readonly camera = new THREE.PerspectiveCamera();
  public readonly events = new Set<(event: XRRuntimeEvent) => void>();
  public requestedSessions = 0;
  public interactionSurface: XRInteractionSurface | null = null;
  public active = false;
  public generation = 0;
  public readonly viewerCamera = new THREE.ArrayCamera([new THREE.PerspectiveCamera()]);
  public readonly log: string[];
  public readonly functional: boolean;
  public readonly handle: XRSessionHandle;
  public constructor(options: { functional?: boolean; log?: string[] } = {}) {
    this.functional = options.functional ?? false;
    this.log = options.log ?? [];
    this.viewerCamera.position.set(0, 1.6, 0);
    this.viewerCamera.updateMatrixWorld(true);
    this.handle = {
      generation: 1,
      session: {} as XRSession,
      referenceSpace: {} as XRReferenceSpace,
      getAppCamera: () => this.camera,
      getViewerCamera: () => this.viewerCamera,
      end: () => {
        this.log.push('end');
        this.active = false;
        this.emit({ sessionGeneration: this.generation, type: 'ended' });
        return Promise.resolve();
      },
    };
  }
  public start(): ReturnType<XRSessionController['start']> {
    this.requestedSessions += 1;
    this.log.push('start');
    if (!this.functional) throw new Error('not used in debug test');
    this.generation = 1;
    this.active = true;
    return { generation: 1, result: Promise.resolve(this.handle) };
  }
  public getActive() { return this.active ? this.handle : null; }
  public getScene(): THREE.Scene { return this.scene; }
  public getAppCamera(): THREE.PerspectiveCamera { return this.camera; }
  public setInteractionSurface(surface: XRInteractionSurface | null): void { this.interactionSurface = surface; }
  public setPointerTarget(): void {}
  public subscribe(listener: (event: XRRuntimeEvent) => void): Unsubscribe {
    this.events.add(listener); return () => this.events.delete(listener);
  }
  public resourceCounts(): Pick<RuntimeResourceCounts,
    'renderers' | 'rendererCanvases' | 'scenes' | 'appCameras' | 'controllerGroups' |
    'controllerRayVisuals' | 'pointerReticles' | 'reticleGeometries' | 'reticleMaterials' |
    'activeXRSessions' | 'registeredXRSessionHandlers' |
    'registeredReferenceSpaceHandlers' | 'registeredControllerGroupHandlers' | 'controllerBindings'> {
    return {
      renderers: 1, rendererCanvases: 1, scenes: 1, appCameras: 1, controllerGroups: 2,
      controllerRayVisuals: 2, pointerReticles: 1, reticleGeometries: 1, reticleMaterials: 1,
      activeXRSessions: this.active ? 1 : 0,
      registeredXRSessionHandlers: this.active ? 5 : 0,
      registeredReferenceSpaceHandlers: this.active ? 1 : 0,
      registeredControllerGroupHandlers: this.active ? 4 : 0,
      controllerBindings: this.active ? 1 : 0,
    };
  }
  public emit(event: XRRuntimeEvent): void {
    for (const listener of [...this.events]) listener(event);
  }
  public dispose(): Promise<void> { return Promise.resolve(); }
}

function dependencies(options: {
  location: LocationInitializer;
  load?: () => Promise<ManifestLoadResult>;
  audio?: FakeAudioPlayer;
  xr?: FakeXrController;
  map?: FakeMapPanel;
}) {
  const audio = options.audio ?? new FakeAudioPlayer();
  const xr = options.xr ?? new FakeXrController();
  const map = options.map ?? new FakeMapPanel();
  return {
    values: { audio, xr, map },
    deps: {
      wallClockMs: () => 500,
      monotonicNowMs: () => 10,
      manifestService: { load: options.load ?? (() => Promise.resolve(manifestResult)) },
      locationInitializer: options.location,
      createXRSessionController: () => xr,
      createMapPanel: () => map,
      createSoundscapePlayer: () => audio,
    },
  };
}

const manualLocation: LocationInitializer = {
  requestBrowserLocation: () => Promise.reject(new Error('unused')),
  parseManual: (latText, lonText) => ({
    lat: Number(latText), lon: Number(lonText), source: 'manual', timestampMs: 50,
  }),
};

describe('AppController integration', () => {
  test('debug mode tolerates absent WebXR, exposes the production map, and never starts a session', async () => {
    setCapabilities({ secure: false });
    const setup = dependencies({ location: manualLocation });
    const controller = createAppController(config(true), setup.deps);
    expect(Object.values(controller.resourceCounts()).every((value) => value === 0)).toBe(true);
    const first = controller.initialize();
    expect(controller.initialize()).toBe(first);
    await first;
    expect(controller.getState()).toMatchObject({ phase: 'preflight', xrApiAvailable: false, immersiveARSupported: false });
    expect(document.querySelector('[data-testid="debug-view"]')).not.toBeNull();
    expect(setup.values.map.models.at(-1)).toMatchObject({
      xrControlsVisible: false,
      calibrationReady: true,
      controllerAvailable: true,
    });
    expect(controller.resourceCounts()).toMatchObject({
      appRoots: 1, renderers: 1, rendererCanvases: 1, scenes: 1, appCameras: 1,
      mapCanvases: 1, mapTextures: 1, mapMaterials: 1, mapGeometries: 1, mapPlanes: 1,
      controllerGroups: 2, controllerRayVisuals: 2, activeXRSessions: 0,
      mediaElements: 1, mediaElementSourceNodes: 1, audioSourceObjects: 1, listeners: 1,
      positionalAudioObjects: 1, panners: 1, registeredMediaHandlers: 10,
      activeLoadWatchdogs: 0, activeFadeCompletionTimers: 0,
      registeredAppRootHandlers: 3, registeredWindowResizeHandlers: 1,
      registeredDocumentVisibilityHandlers: 1,
    });
    setup.values.audio.watchdog = 1;
    expect(controller.resourceCounts().activeLoadWatchdogs).toBe(1);
    setup.values.audio.watchdog = 0;
    setup.values.audio.fade = 1;
    expect(controller.resourceCounts().activeFadeCompletionTimers).toBe(1);
    setup.values.audio.fade = 0;
    controller.dispatch({ type: 'SUBMIT_MANUAL_LOCATION', latText: '37.5665', lonText: '126.978' });
    expect(controller.getState()).toMatchObject({ phase: 'ready', sessionActive: false });
    expect(controller.getState().calibration?.originWorld.toArray()).toEqual([0, 1.6, 0]);
    expect(setup.values.map.models.at(-1)?.xrControlsVisible).toBe(false);
    setup.values.map.hitAction = { type: 'SELECT_RECORDING', recordingId: 'north' };
    vi.spyOn(setup.values.map.canvas, 'getBoundingClientRect').mockReturnValue({
      left: 10, top: 20, width: 512, height: 384, right: 522, bottom: 404, x: 10, y: 20,
      toJSON: () => ({}),
    });
    setup.values.map.canvas.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      clientX: 266,
      clientY: 212,
    }));
    expect(setup.values.map.hits.at(-1)).toEqual({ x: 512, y: 384, now: 10 });
    expect(setup.values.audio.commands.some((command) => command.includes('select:'))).toBe(true);
    controller.dispatch({ type: 'XR_START_REQUESTED' });
    expect(setup.values.xr.requestedSessions).toBe(0);
    expect(controller.resourceCounts().activeXRSessions).toBe(0);
    await controller.dispose();
    expect(Object.values(controller.resourceCounts()).every((value) => value === 0)).toBe(true);
  });

  test('reuses a pending browser request and suppresses its late result after manual input', async () => {
    setCapabilities({ secure: false, geolocation: {} as Geolocation });
    let resolveBrowser!: (location: InitializedLocation) => void;
    const requestBrowserLocation = vi.fn(() => new Promise<InitializedLocation>((resolve) => { resolveBrowser = resolve; }));
    const setup = dependencies({
      location: { requestBrowserLocation, parseManual: manualLocation.parseManual },
    });
    const controller = createAppController(config(true), setup.deps);
    await controller.initialize();
    controller.dispatch({ type: 'LOCATION_REQUESTED' });
    const pendingState = controller.getState();
    controller.dispatch({ type: 'LOCATION_REQUESTED' });
    expect(controller.getState()).toBe(pendingState);
    expect(requestBrowserLocation).toHaveBeenCalledTimes(1);
    controller.dispatch({ type: 'SUBMIT_MANUAL_LOCATION', latText: '10', lonText: '20' });
    resolveBrowser({ lat: 30, lon: 40, source: 'browser', timestampMs: 70 });
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getState().location).toMatchObject({ lat: 10, lon: 20, source: 'manual' });
    await controller.dispose();
  });

  test('queues reentrant subscriber dispatch in synchronous FIFO order', async () => {
    setCapabilities({ secure: false });
    const setup = dependencies({ location: manualLocation });
    const controller = createAppController(config(true), setup.deps);
    await controller.initialize();
    controller.dispatch({ type: 'SUBMIT_MANUAL_LOCATION', latText: '1', lonText: '2' });
    const observed: number[] = [];
    controller.subscribe((state) => {
      observed.push(state.masterGain);
      if (state.masterGain === 0.8) controller.dispatch({ type: 'SET_MASTER_GAIN', value: 0.9 });
    });
    controller.dispatch({ type: 'SET_MASTER_GAIN', value: 0.8 });
    expect(observed).toEqual([0.8, 0.9]);
    expect(setup.values.audio.commands.slice(-2)).toEqual(['gain:0.8', 'gain:0.9']);
    await controller.dispose();
  });

  test('replaces a selected debug location with lifecycle pause and a recomputed source position', async () => {
    setCapabilities({ secure: false });
    const setup = dependencies({ location: manualLocation });
    const controller = createAppController(config(true), setup.deps);
    await controller.initialize();
    controller.dispatch({ type: 'SUBMIT_MANUAL_LOCATION', latText: '37.5665', lonText: '126.978' });
    controller.dispatch({ type: 'SELECT_RECORDING', recordingId: 'north' });
    const originalPosition = setup.values.audio.selectedPositions[0]?.clone();
    controller.dispatch({ type: 'SUBMIT_MANUAL_LOCATION', latText: '37.5', lonText: '127.2' });
    expect(setup.values.audio.commands).toContain('pause:3:lifecycle');
    expect(setup.values.audio.appliedPositions).toHaveLength(1);
    expect(setup.values.audio.appliedPositions[0]?.equals(originalPosition as THREE.Vector3)).toBe(false);
    expect(controller.getState()).toMatchObject({ phase: 'ready', playback: { state: 'paused' } });
    await controller.dispose();
  });

  test('orchestrates normal XR start, post-render calibration, invalidation, exit, and ended counts', async () => {
    const log: string[] = [];
    const xrSystem = {
      isSessionSupported: vi.fn(() => Promise.resolve(true)),
      requestSession: vi.fn(),
    } as unknown as XRSystem;
    setCapabilities({ secure: true, xr: xrSystem });
    const audio = new FakeAudioPlayer();
    audio.resumeContext = () => { log.push('resume'); return Promise.resolve(); };
    const xr = new FakeXrController({ functional: true, log });
    const map = new FakeMapPanel();
    const setup = dependencies({ location: manualLocation, audio, xr, map });
    const controller = createAppController(config(false), setup.deps);
    await controller.initialize();
    controller.dispatch({ type: 'SUBMIT_MANUAL_LOCATION', latText: '37.5665', lonText: '126.978' });
    controller.dispatch({ type: 'XR_START_REQUESTED' });
    expect(log.slice(0, 2)).toEqual(['resume', 'start']);
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({ phase: 'calibrating', sessionActive: true });
    expect(controller.resourceCounts()).toMatchObject({
      activeXRSessions: 1,
      registeredXRSessionHandlers: 5,
      registeredReferenceSpaceHandlers: 1,
      registeredControllerGroupHandlers: 4,
      controllerBindings: 1,
    });
    xr.emit({ sessionGeneration: 1, type: 'primarySelect', nowMs: 10 });
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({ phase: 'ready' });
    expect(map.poses).toBe(1);
    map.hitAction = { type: 'SELECT_RECORDING', recordingId: 'north' };
    xr.emit({ sessionGeneration: 1, type: 'primarySelect', nowMs: 15, canvasX: 512, canvasY: 384 });
    expect(map.hits.at(-1)).toEqual({ x: 512, y: 384, now: 15 });
    xr.emit({ sessionGeneration: 1, type: 'visibilityChanged', visibilityState: 'hidden' });
    expect(controller.getState()).toMatchObject({
      phase: 'calibrating',
      error: { code: 'CALIBRATION_RESET', calibrationReason: 'xr-hidden' },
      playback: { state: 'paused' },
    });
    expect(audio.commands).toContain('pause:2:lifecycle');
    xr.emit({ sessionGeneration: 1, type: 'primarySelect', nowMs: 20 });
    await Promise.resolve();
    expect(controller.getState().phase).toBe('ready');
    xr.emit({ sessionGeneration: 1, type: 'referenceReset' });
    expect(controller.getState().error).toMatchObject({ calibrationReason: 'reference-reset' });
    xr.emit({ sessionGeneration: 1, type: 'primarySelect', nowMs: 30 });
    await Promise.resolve();
    controller.dispatch({ type: 'EXIT_XR' });
    expect(log).toContain('end');
    expect(controller.getState()).toMatchObject({ phase: 'locationReady', sessionActive: false, playback: { state: 'paused' } });
    expect(controller.resourceCounts()).toMatchObject({
      activeXRSessions: 0,
      registeredXRSessionHandlers: 0,
      registeredReferenceSpaceHandlers: 0,
      registeredControllerGroupHandlers: 0,
      controllerBindings: 0,
    });
    await controller.dispose();
  });

  test('grip toggles the panel without interrupting playback or re-posing', async () => {
    const xrSystem = {
      isSessionSupported: vi.fn(() => Promise.resolve(true)),
      requestSession: vi.fn(),
    } as unknown as XRSystem;
    setCapabilities({ secure: true, xr: xrSystem });
    const audio = new FakeAudioPlayer();
    const xr = new FakeXrController({ functional: true });
    const map = new FakeMapPanel();
    const setup = dependencies({ location: manualLocation, audio, xr, map });
    const controller = createAppController(config(false), setup.deps);
    await controller.initialize();
    controller.dispatch({ type: 'SUBMIT_MANUAL_LOCATION', latText: '37.5665', lonText: '126.978' });
    controller.dispatch({ type: 'XR_START_REQUESTED' });
    await Promise.resolve();
    await Promise.resolve();
    xr.emit({ sessionGeneration: 1, type: 'primarySelect', nowMs: 10 });
    await Promise.resolve();
    expect(controller.getState().phase).toBe('ready');

    map.hitAction = { type: 'SELECT_RECORDING', recordingId: 'north' };
    xr.emit({ sessionGeneration: 1, type: 'primarySelect', nowMs: 15, canvasX: 512, canvasY: 384 });
    const posesBefore = map.poses;
    const commandsBefore = [...audio.commands];

    xr.emit({ sessionGeneration: 1, type: 'primarySqueeze', nowMs: 20 });
    expect(map.models.at(-1)?.panelVisible).toBe(false);
    xr.emit({ sessionGeneration: 1, type: 'primarySqueeze', nowMs: 25 });
    expect(map.models.at(-1)?.panelVisible).toBe(true);

    expect(audio.commands).toEqual(commandsBefore); // playback uninterrupted by the toggle
    expect(map.poses).toBe(posesBefore); // shown panel keeps its world pose (no re-pose)
    await controller.dispose();
  });

  test('normal absent-XR failure starts neither manifest nor heavy factories and retains only the shell', async () => {
    setCapabilities({ secure: true });
    const load = vi.fn(() => Promise.resolve(manifestResult));
    const createXr = vi.fn(() => new FakeXrController());
    const controller = createAppController(config(false), {
      manifestService: { load },
      locationInitializer: manualLocation,
      createXRSessionController: createXr,
    });
    await expect(controller.initialize()).resolves.toBeUndefined();
    expect(controller.getState()).toMatchObject({ phase: 'fatalError', error: { code: 'XR_API_UNAVAILABLE', recoverable: false } });
    expect(load).not.toHaveBeenCalled();
    expect(createXr).not.toHaveBeenCalled();
    expect(controller.resourceCounts()).toEqual({ ...controller.resourceCounts(), appRoots: 1, registeredAppRootHandlers: 3 });
    const nonShellCounts = Object.entries(controller.resourceCounts())
      .filter(([key]) => key !== 'appRoots' && key !== 'registeredAppRootHandlers');
    expect(nonShellCounts.every(([, value]) => value === 0)).toBe(true);
    await controller.dispose();
  });

  test('reuses the global singleton, rejects conflicts, and clears every global count after disposal', async () => {
    setCapabilities({ secure: true });
    const first = await initializeApp(config(false));
    const second = await initializeApp({ ...config(false) });
    expect(second).toBe(first);
    await expect(initializeApp({ ...config(false), buildCommit: 'different' }))
      .rejects.toMatchObject({ code: 'CONFIGURATION_CONFLICT' });
    await first.dispose();
    expect(Object.values(getGlobalResourceCounts()).every((value) => value === 0)).toBe(true);
    const fresh = await initializeApp(config(false));
    expect(fresh).not.toBe(first);
    await fresh.dispose();
  });
});
