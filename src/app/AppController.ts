import type * as THREE from 'three';

import { createSpatialAudioPlayer } from '../audio';
import { createManifestService } from '../data/manifest';
import type {
  AppAction,
  AppConfig,
  AppController,
  AppErrorCode,
  AppState,
  CreateLocationInitializer,
  CreateManifestService,
  CreateMapPanel,
  CreateSpatialAudioPlayer,
  CreateXRSessionController,
  GetGlobalResourceCounts,
  InitializedLocation,
  LocationInitializer,
  ManifestService,
  MapMarkerState,
  MapPanel,
  MapPanelModel,
  NormalizedRecording,
  PlaybackEligibility,
  RuntimeConfig,
  RuntimeResourceCounts,
  SpatialAudioPlayer,
  Unsubscribe,
  XRRuntimeEvent,
  XRSessionController,
} from '../domain/types';
import { calibrateGeoFrame, placeAtBearing } from '../geo/GeoFrame';
import { geoBetween } from '../geo/geodesy';
import { createProjectionModel, formatDistanceM } from '../geo/projection';
import { createLocationInitializer } from '../location/LocationInitializer';
import { createMapPanel } from '../ui/MapPanel';
import { PreflightView } from '../ui/PreflightView';
import { createXRSessionController } from '../xr';
import { AppError } from './errors';
import { createInitialState, reduceAppState, type AppReducerContext } from './appState';

const ZERO_COUNTS: RuntimeResourceCounts = Object.freeze({
  appRoots: 0,
  renderers: 0,
  rendererCanvases: 0,
  scenes: 0,
  appCameras: 0,
  mapCanvases: 0,
  mapTextures: 0,
  mapMaterials: 0,
  mapGeometries: 0,
  mapPlanes: 0,
  controllerGroups: 0,
  controllerRayVisuals: 0,
  activeXRSessions: 0,
  registeredXRSessionHandlers: 0,
  registeredReferenceSpaceHandlers: 0,
  registeredControllerGroupHandlers: 0,
  controllerBindings: 0,
  mediaElements: 0,
  mediaElementSourceNodes: 0,
  audioSourceObjects: 0,
  listeners: 0,
  positionalAudioObjects: 0,
  panners: 0,
  registeredMediaHandlers: 0,
  activeLoadWatchdogs: 0,
  activeFadeCompletionTimers: 0,
  registeredAppRootHandlers: 0,
  registeredWindowResizeHandlers: 0,
  registeredDocumentVisibilityHandlers: 0,
});

export interface AppControllerDependencies {
  readonly windowRef?: Window;
  readonly documentRef?: Document;
  readonly fetchImpl?: typeof fetch;
  readonly wallClockMs?: () => number;
  readonly monotonicNowMs?: () => number;
  readonly queueMicrotaskImpl?: (callback: () => void) => void;
  readonly manifestService?: ManifestService;
  readonly locationInitializer?: LocationInitializer;
  readonly createManifestService?: CreateManifestService;
  readonly createLocationInitializer?: CreateLocationInitializer;
  readonly createXRSessionController?: CreateXRSessionController;
  readonly createMapPanel?: CreateMapPanel;
  readonly createSpatialAudioPlayer?: CreateSpatialAudioPlayer;
}

function sameConfig(left: Readonly<AppConfig>, right: Readonly<AppConfig>): boolean {
  return left.manifestUrl === right.manifestUrl
    && left.audioLoadTimeoutMs === right.audioLoadTimeoutMs
    && left.progressUpdateHz === right.progressUpdateHz
    && left.sourceRadiusMOverride === right.sourceRadiusMOverride
    && left.buildCommit === right.buildCommit
    && left.debugMode === right.debugMode;
}

function errorCode(error: unknown, fallback: AppErrorCode): AppErrorCode {
  return error instanceof AppError ? error.code : fallback;
}

function cloneLocation(location: InitializedLocation): InitializedLocation {
  return { ...location };
}

function formatBearing(bearingDeg: number | null, cardinal: string | null): string {
  if (bearingDeg === null || cardinal === null) return '—';
  const rounded = ((Math.round(bearingDeg) % 360) + 360) % 360;
  return `${rounded}° ${cardinal}`;
}

function mapMarkerState(state: AppState, recordingId: string, enabled: boolean): MapMarkerState {
  if (!enabled) return 'disabled';
  if (state.selectedRecordingId !== recordingId) return 'default';
  switch (state.playback.state) {
    case 'loading': return 'loading';
    case 'playing': return 'playing';
    case 'error': return 'failed';
    default: return 'selected';
  }
}

function resolveRuntimeConfig(config: Readonly<AppConfig>, state: AppState): Readonly<RuntimeConfig> {
  const sourceRadiusM = config.sourceRadiusMOverride
    ?? state.manifest?.collection.defaultSpatialRadiusM
    ?? 3;
  if (!Number.isFinite(sourceRadiusM) || sourceRadiusM < 1.5 || sourceRadiusM > 8) {
    throw new AppError('CONFIGURATION_CONFLICT');
  }
  return Object.freeze({
    manifestUrl: config.manifestUrl,
    audioLoadTimeoutMs: config.audioLoadTimeoutMs,
    progressUpdateHz: config.progressUpdateHz,
    sourceRadiusM,
    buildCommit: config.buildCommit,
    debugMode: config.debugMode,
  });
}

function manualFailureState(state: AppState): AppState {
  const phase = state.debugMode && state.location !== undefined && state.calibration !== undefined
    ? 'ready'
    : state.location === undefined ? 'preflight' : 'locationReady';
  return { ...state, phase, error: { code: 'LOCATION_INVALID', recoverable: true } };
}

class AttuneAppController implements AppController {
  private state: AppState;
  private lifecycle: 'new' | 'initializing' | 'initialized' | 'disposing' | 'disposed' = 'new';
  private initializePromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private root: HTMLElement | null = null;
  private view: PreflightView | null = null;
  private manifestService: ManifestService | null = null;
  private locationInitializer: LocationInitializer | null = null;
  private runtimeConfig: Readonly<RuntimeConfig> | null = null;
  private xrController: XRSessionController | null = null;
  private mapPanel: MapPanel | null = null;
  private audioPlayer: SpatialAudioPlayer | null = null;
  private abortController: AbortController | null = null;
  private xrUnsubscribe: Unsubscribe | null = null;
  private audioUnsubscribe: Unsubscribe | null = null;
  private readonly subscribers = new Set<(state: AppState) => void>();
  private readonly actionQueue: AppAction[] = [];
  private processingActions = false;
  private rootHandlersInstalled = false;
  private visibilityHandlerInstalled = false;
  private locationGeneration = 0;
  private selectionGeneration = 0;
  private sessionGeneration = 0;
  private pendingLocation: Promise<void> | null = null;
  private pendingCalibration = false;

  private readonly windowRef: Window;
  private readonly documentRef: Document;
  private readonly fetchImpl: typeof fetch;
  private readonly wallClockMs: () => number;
  private readonly monotonicNowMs: () => number;
  private readonly queueMicrotaskImpl: (callback: () => void) => void;

  public constructor(
    private readonly config: Readonly<AppConfig>,
    private readonly dependencies: AppControllerDependencies,
  ) {
    this.windowRef = dependencies.windowRef ?? window;
    this.documentRef = dependencies.documentRef ?? document;
    this.fetchImpl = dependencies.fetchImpl ?? fetch.bind(globalThis);
    this.wallClockMs = dependencies.wallClockMs ?? Date.now;
    this.monotonicNowMs = dependencies.monotonicNowMs ?? (() => performance.now());
    this.queueMicrotaskImpl = dependencies.queueMicrotaskImpl ?? queueMicrotask;
    this.state = createInitialState(config);
  }

  public initialize(): Promise<void> {
    if (this.lifecycle === 'disposing' || this.lifecycle === 'disposed') {
      return Promise.reject(new AppError('APP_DISPOSED'));
    }
    if (this.initializePromise !== null) return this.initializePromise;
    if (this.lifecycle === 'initialized') return Promise.resolve();
    this.lifecycle = 'initializing';
    this.initializePromise = this.runInitialization();
    return this.initializePromise;
  }

  public matchesConfig(config: Readonly<AppConfig>): boolean {
    return sameConfig(this.config, config);
  }

  public isClosing(): boolean {
    return this.lifecycle === 'disposing' || this.lifecycle === 'disposed';
  }

  public dispatch(action: AppAction): void {
    this.assertLive();
    this.actionQueue.push(action);
    if (this.processingActions) return;
    this.processingActions = true;
    try {
      while (this.actionQueue.length > 0 && this.lifecycle !== 'disposed') {
        const next = this.actionQueue.shift();
        if (next !== undefined) this.processAction(next);
      }
    } finally {
      this.processingActions = false;
    }
  }

  public getState(): AppState {
    this.assertLive();
    return this.state;
  }

  public subscribe(listener: (state: AppState) => void): Unsubscribe {
    this.assertLive();
    this.subscribers.add(listener);
    let subscribed = true;
    return (): void => {
      if (!subscribed) return;
      subscribed = false;
      this.subscribers.delete(listener);
    };
  }

  public resourceCounts(): RuntimeResourceCounts {
    if (this.lifecycle === 'disposed') return { ...ZERO_COUNTS };
    const xr = this.xrController?.resourceCounts();
    const audio = this.audioPlayer?.resourceCounts();
    const mapLive = this.mapPanel !== null;
    return {
      ...ZERO_COUNTS,
      ...(xr ?? {}),
      ...(audio ?? {}),
      appRoots: this.root === null ? 0 : 1,
      mapCanvases: mapLive ? 1 : 0,
      mapTextures: mapLive ? 1 : 0,
      mapMaterials: mapLive ? 1 : 0,
      mapGeometries: mapLive ? 1 : 0,
      mapPlanes: mapLive ? 1 : 0,
      registeredAppRootHandlers: this.rootHandlersInstalled ? 3 : 0,
      registeredWindowResizeHandlers: this.xrController === null ? 0 : 1,
      registeredDocumentVisibilityHandlers: this.visibilityHandlerInstalled ? 1 : 0,
    };
  }

  public dispose(): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise;
    if (this.lifecycle === 'disposed') return Promise.resolve();
    this.lifecycle = 'disposing';
    this.abortController?.abort();
    ++this.locationGeneration;
    ++this.selectionGeneration;
    this.pendingLocation = null;
    this.pendingCalibration = false;
    this.actionQueue.length = 0;
    this.disposePromise = (async (): Promise<void> => {
      await this.initializePromise?.catch(() => undefined);
      await this.cleanupHeavyResources();
      this.removeShell();
      this.subscribers.clear();
      this.lifecycle = 'disposed';
      if (activeController === this) activeController = null;
    })();
    return this.disposePromise;
  }

  private async runInitialization(): Promise<void> {
    try {
      this.installShell();
      this.abortController = new AbortController();
      this.manifestService = this.dependencies.manifestService
        ?? (this.dependencies.createManifestService ?? createManifestService)(this.fetchImpl);
      const geolocation = this.windowRef.navigator.geolocation;
      this.locationInitializer = this.dependencies.locationInitializer
        ?? (this.dependencies.createLocationInitializer ?? createLocationInitializer)(
          geolocation,
          this.wallClockMs,
        );
      const secureContext = this.windowRef.isSecureContext === true;
      const xrSystem = this.windowRef.navigator.xr;
      const xrApiAvailable = xrSystem !== undefined;
      const browserGeolocationAvailable = geolocation !== undefined;

      if (!this.config.debugMode && !secureContext) {
        this.expectedBootFailure('INSECURE_CONTEXT');
        return;
      }
      if (!this.config.debugMode && !xrApiAvailable) {
        this.expectedBootFailure('XR_API_UNAVAILABLE');
        return;
      }

      let manifestPromise: Promise<Awaited<ReturnType<ManifestService['load']>>>;
      try {
        manifestPromise = this.manifestService.load(
          this.config.manifestUrl,
          this.abortController.signal,
        );
      } catch (cause) {
        manifestPromise = Promise.reject(cause);
      }
      let supportPromise: Promise<boolean>;
      try {
        supportPromise = xrSystem === undefined
          ? Promise.resolve(false)
          : xrSystem.isSessionSupported('immersive-ar');
      } catch (cause) {
        supportPromise = Promise.reject(cause);
      }
      const [support, manifest] = await Promise.allSettled([supportPromise, manifestPromise]);
      this.assertInitializationCurrent();

      const immersiveARSupported = support.status === 'fulfilled' && support.value === true;
      if (!this.config.debugMode && !immersiveARSupported) {
        this.expectedBootFailure('IMMERSIVE_AR_UNSUPPORTED');
        return;
      }
      if (manifest.status === 'rejected') {
        this.expectedBootFailure(errorCode(manifest.reason, 'MANIFEST_LOAD_FAILED'));
        return;
      }
      if (manifest.value.records.length === 0) {
        this.expectedBootFailure('NO_VALID_RECORDINGS');
        return;
      }

      const provisionalEligibility = Object.freeze(Object.create(null) as Record<string, PlaybackEligibility>);
      const provisionalState = reduceAppState(this.state, {
        type: 'BOOT_SUCCEEDED',
        manifest: manifest.value.manifest,
        recordings: manifest.value.records,
        recordingEligibility: provisionalEligibility,
        rejectedRecordCount: manifest.value.rejected.length,
        unsupportedRecordCount: 0,
        secureContext,
        debugMode: this.config.debugMode,
        xrApiAvailable,
        immersiveARSupported,
        browserGeolocationAvailable,
      }, this.reducerContext());
      this.runtimeConfig = resolveRuntimeConfig(this.config, {
        ...provisionalState,
        manifest: manifest.value.manifest,
      });

      try {
        this.xrController = (this.dependencies.createXRSessionController ?? createXRSessionController)({
          root: this.root as HTMLElement,
          xrSystem,
          windowRef: this.windowRef,
          monotonicNowMs: this.monotonicNowMs,
        });
      } catch (cause) {
        await this.cleanupHeavyResources();
        this.expectedBootFailure(errorCode(cause, 'XR_RENDERER_INIT_FAILED'));
        return;
      }
      const scene = this.xrController.getScene();
      const camera = this.xrController.getAppCamera();
      try {
        this.mapPanel = (this.dependencies.createMapPanel ?? createMapPanel)(scene);
      } catch (cause) {
        await this.cleanupHeavyResources();
        this.expectedBootFailure(errorCode(cause, 'XR_RENDERER_INIT_FAILED'));
        return;
      }
      try {
        this.audioPlayer = (this.dependencies.createSpatialAudioPlayer ?? createSpatialAudioPlayer)(
          camera,
          scene,
          {
            audioLoadTimeoutMs: this.runtimeConfig.audioLoadTimeoutMs,
            progressUpdateHz: this.runtimeConfig.progressUpdateHz,
          },
        );
      } catch (cause) {
        await this.cleanupHeavyResources();
        this.expectedBootFailure(errorCode(cause, 'AUDIO_INITIALIZATION_FAILED'));
        return;
      }
      this.xrController.setInteractionSurface({
        object: this.mapPanel.getObject3D(),
        widthPx: 1024,
        heightPx: 768,
      });

      const eligibility = Object.create(null) as Record<string, PlaybackEligibility>;
      let unsupportedRecordCount = 0;
      for (const record of manifest.value.records) {
        const result = this.audioPlayer.classifyMimeType(record.mimeType);
        eligibility[record.id] = result;
        if (result === 'unsupported') unsupportedRecordCount += 1;
      }
      Object.freeze(eligibility);
      if (unsupportedRecordCount === manifest.value.records.length) {
        await this.cleanupHeavyResources();
        this.expectedBootFailure('AUDIO_UNSUPPORTED');
        return;
      }

      this.xrUnsubscribe = this.xrController.subscribe((event) => this.handleXrEvent(event));
      this.audioUnsubscribe = this.audioPlayer.subscribe((event) => {
        this.dispatch({ type: 'PLAYBACK_SNAPSHOT', generation: event.generation, snapshot: event.snapshot });
      });
      this.documentRef.addEventListener('visibilitychange', this.onVisibilityChange);
      this.visibilityHandlerInstalled = true;
      this.dispatch({
        type: 'BOOT_SUCCEEDED',
        manifest: manifest.value.manifest,
        recordings: Object.freeze([...manifest.value.records]),
        recordingEligibility: eligibility,
        rejectedRecordCount: manifest.value.rejected.length,
        unsupportedRecordCount,
        secureContext,
        debugMode: this.config.debugMode,
        xrApiAvailable,
        immersiveARSupported,
        browserGeolocationAvailable,
      });
      this.lifecycle = 'initialized';
    } catch (cause) {
      await this.cleanupHeavyResources();
      this.removeShell();
      this.lifecycle = 'disposed';
      if (activeController === this) activeController = null;
      throw cause;
    }
  }

  private processAction(action: AppAction): void {
    if (action.type === 'SUBMIT_MANUAL_LOCATION') {
      this.processManualLocation(action.latText, action.lonText);
      return;
    }
    if (
      action.type === 'PLAYBACK_SNAPSHOT'
      && action.generation === this.selectionGeneration
      && action.snapshot.recordingId !== undefined
      && action.snapshot.recordingId !== this.state.selectedRecordingId
    ) {
      console.error('INTERNAL_LISTENER_ERROR');
      return;
    }
    const before = this.state;
    this.prepareGenerations(action, before);
    const next = reduceAppState(before, action, this.reducerContext());
    this.state = next;
    this.runEffect(action, before, next);
    if (next !== before) this.publishState();
  }

  private prepareGenerations(action: AppAction, state: AppState): void {
    if (
      action.type === 'LOCATION_REQUESTED'
      && state.phase !== 'locationPending'
      && state.browserGeolocationAvailable
      && (['preflight', 'locationReady'].includes(state.phase) || (state.debugMode && state.phase === 'ready'))
    ) {
      ++this.locationGeneration;
      this.pendingLocation = null;
      if (state.debugMode && state.phase === 'ready') ++this.selectionGeneration;
      return;
    }
    if (
      action.type === 'LOCATION_RESOLVED'
      && action.locationGeneration === this.locationGeneration
      && state.debugMode
      && !state.sessionActive
    ) {
      ++this.selectionGeneration;
      return;
    }
    if (
      action.type === 'CALIBRATION_INVALIDATED'
      && action.sessionGeneration === this.sessionGeneration
      && state.sessionActive
      && ['ready', 'calibrating'].includes(state.phase)
    ) {
      ++this.selectionGeneration;
      return;
    }
    if (action.type === 'RECALIBRATE' && !state.debugMode && state.phase === 'ready' && state.sessionActive) {
      ++this.selectionGeneration;
      return;
    }
    if (
      action.type === 'XR_ENDED'
      && action.sessionGeneration === this.sessionGeneration
      && ['enteringXR', 'calibrating', 'ready', 'endingXR'].includes(state.phase)
    ) {
      ++this.selectionGeneration;
    }
  }

  private runEffect(action: AppAction, before: AppState, after: AppState): void {
    switch (action.type) {
      case 'LOCATION_REQUESTED':
        if (after !== before && after.phase === 'locationPending') {
          if (before.debugMode && before.phase === 'ready') this.runLifecyclePauseEffect(before);
          this.startBrowserLocation();
        }
        break;
      case 'LOCATION_RESOLVED':
        if (after !== before && after.debugMode) {
          this.runLifecyclePauseEffect(before);
          this.repositionSelectedSource();
        }
        break;
      case 'XR_START_REQUESTED':
        if (after !== before && after.phase === 'enteringXR') this.startXr();
        break;
      case 'CONFIRM_CALIBRATION':
        if (before.phase === 'calibrating' && !this.pendingCalibration) this.queueCalibrationCapture();
        break;
      case 'CALIBRATION_CONFIRMED':
        this.pendingCalibration = false;
        if (after !== before) this.repositionSelectedSource();
        break;
      case 'CALIBRATION_FAILED':
        this.pendingCalibration = false;
        break;
      case 'CALIBRATION_INVALIDATED':
        if (after !== before) {
          this.pendingCalibration = false;
          this.runLifecyclePauseEffect(before);
        }
        break;
      case 'SELECT_RECORDING':
        this.runSelection(action.recordingId, before);
        break;
      case 'PLAY':
        this.runPlay(before);
        break;
      case 'PAUSE':
        if (before.phase === 'ready' && before.selectedRecordingId !== undefined
          && !['paused', 'stopped', 'ended', 'empty'].includes(before.playback.state)) {
          this.audioPlayer?.pause(++this.selectionGeneration, 'user');
        }
        break;
      case 'STOP':
        if (before.phase === 'ready' && before.selectedRecordingId !== undefined
          && !['stopped', 'empty'].includes(before.playback.state)) {
          this.audioPlayer?.stop(++this.selectionGeneration);
        }
        break;
      case 'SET_MASTER_GAIN':
        if (after !== before) this.audioPlayer?.setMasterGain(after.masterGain);
        break;
      case 'RECENTER_PANEL': {
        if (!before.debugMode && before.phase === 'ready' && before.sessionActive) {
          const handle = this.xrController?.getActive();
          if (handle !== null && handle !== undefined) this.mapPanel?.setPoseFromCamera(handle.getViewerCamera());
        }
        break;
      }
      case 'EXIT_XR':
        if (after.phase === 'endingXR' && after !== before) {
          void this.xrController?.getActive()?.end().catch(() => console.error('XR_SESSION_REJECTED'));
        }
        break;
      case 'RECALIBRATE':
      case 'XR_ENDED':
        if (after !== before) {
          this.pendingCalibration = false;
          this.runLifecyclePauseEffect(before);
        }
        break;
      case 'BOOT_SUCCEEDED':
      case 'BOOT_FAILED':
      case 'SUBMIT_MANUAL_LOCATION':
      case 'LOCATION_FAILED':
      case 'XR_STARTED':
      case 'XR_START_FAILED':
      case 'INPUT_AVAILABILITY_CHANGED':
      case 'AUDIO_GESTURE_REQUIRED':
      case 'PLAYBACK_SNAPSHOT':
      case 'CLEAR_RECOVERABLE_ERROR':
        break;
    }
  }

  private processManualLocation(latText: string, lonText: string): void {
    const state = this.state;
    if (!['preflight', 'locationPending', 'locationReady'].includes(state.phase)
      && !(state.debugMode && state.phase === 'ready')) return;
    ++this.locationGeneration;
    this.pendingLocation = null;
    try {
      const location = this.locationInitializer?.parseManual(latText, lonText);
      if (location === undefined) throw new AppError('LOCATION_INVALID');
      this.actionQueue.push({
        type: 'LOCATION_RESOLVED',
        locationGeneration: this.locationGeneration,
        location: cloneLocation(location),
      });
    } catch {
      const next = manualFailureState(state);
      this.state = next;
      this.publishState();
    }
  }

  private startBrowserLocation(): void {
    if (this.pendingLocation !== null || this.locationInitializer === null) return;
    const generation = this.locationGeneration;
    const request = this.locationInitializer.requestBrowserLocation().then(
      (location) => {
        if (this.lifecycle !== 'disposing' && this.lifecycle !== 'disposed' && generation === this.locationGeneration) {
          this.dispatch({
            type: 'LOCATION_RESOLVED',
            locationGeneration: generation,
            location: cloneLocation(location),
          });
        }
      },
      (cause: unknown) => {
        if (this.lifecycle !== 'disposing' && this.lifecycle !== 'disposed' && generation === this.locationGeneration) {
          this.dispatch({
            type: 'LOCATION_FAILED',
            locationGeneration: generation,
            code: errorCode(cause, 'LOCATION_UNAVAILABLE'),
          });
        }
      },
    ).finally(() => {
      if (generation === this.locationGeneration && this.pendingLocation === request) {
        this.pendingLocation = null;
      }
    });
    this.pendingLocation = request;
  }

  private startXr(): void {
    const audioPlayer = this.audioPlayer;
    const xrController = this.xrController;
    if (audioPlayer === null || xrController === null) return;
    ++this.locationGeneration;
    this.pendingLocation = null;
    const audioResume = audioPlayer.resumeContext();
    let operation;
    try {
      operation = xrController.start();
    } catch (cause) {
      void audioResume.catch(() => undefined);
      this.dispatch({
        type: 'XR_START_FAILED',
        sessionGeneration: this.sessionGeneration,
        code: errorCode(cause, 'XR_SESSION_REJECTED'),
      });
      return;
    }
    this.sessionGeneration = operation.generation;
    void Promise.allSettled([audioResume, operation.result]).then(([audio, xr]) => {
      if (this.lifecycle === 'disposing' || this.lifecycle === 'disposed') return;
      if (xr.status === 'rejected') {
        this.dispatch({
          type: 'XR_START_FAILED',
          sessionGeneration: operation.generation,
          code: errorCode(xr.reason, 'XR_SESSION_REJECTED'),
        });
        return;
      }
      this.dispatch({ type: 'XR_STARTED', sessionGeneration: operation.generation });
      this.dispatch({
        type: 'AUDIO_GESTURE_REQUIRED',
        sessionGeneration: operation.generation,
        required: audio.status === 'rejected',
      });
    });
  }

  private queueCalibrationCapture(): void {
    const generation = this.sessionGeneration;
    this.pendingCalibration = true;
    this.queueMicrotaskImpl(() => {
      if (!this.pendingCalibration || generation !== this.sessionGeneration || this.state.phase !== 'calibrating') return;
      const handle = this.xrController?.getActive();
      if (handle === null || handle === undefined || handle.generation !== generation) {
        this.dispatch({ type: 'CALIBRATION_FAILED', sessionGeneration: generation, code: 'CALIBRATION_INVALID' });
        return;
      }
      try {
        const viewerCamera = handle.getViewerCamera();
        if (viewerCamera.cameras.length === 0) throw new AppError('CALIBRATION_INVALID');
        const frame = calibrateGeoFrame(viewerCamera, this.wallClockMs());
        this.mapPanel?.setPoseFromCamera(viewerCamera);
        this.dispatch({ type: 'CALIBRATION_CONFIRMED', sessionGeneration: generation, frame });
      } catch {
        this.dispatch({ type: 'CALIBRATION_FAILED', sessionGeneration: generation, code: 'CALIBRATION_INVALID' });
      }
    });
  }

  private runSelection(recordingId: string, before: AppState): void {
    if (before.phase !== 'ready' || before.calibration === undefined) return;
    if (!Object.hasOwn(before.recordingEligibility, recordingId)
      || before.recordingEligibility[recordingId] === 'unsupported') return;
    if (before.selectedRecordingId === recordingId) {
      if (before.playback.state === 'loading' || before.playback.state === 'playing') return;
      const generation = ++this.selectionGeneration;
      if (before.playback.state === 'error') {
        this.selectRecording(generation, recordingId);
      } else {
        void this.audioPlayer?.play(generation);
      }
      return;
    }
    this.selectRecording(++this.selectionGeneration, recordingId);
  }

  private runPlay(before: AppState): void {
    if (before.phase !== 'ready' || before.selectedRecordingId === undefined
      || before.playback.state === 'playing' || before.playback.state === 'loading') return;
    const generation = ++this.selectionGeneration;
    if (before.playback.state === 'error') {
      this.selectRecording(generation, before.selectedRecordingId);
    } else {
      void this.audioPlayer?.play(generation);
    }
  }

  private selectRecording(generation: number, recordingId: string): void {
    const record = this.findRecording(recordingId);
    const position = record === undefined ? null : this.positionFor(record);
    if (record !== undefined && position !== null) {
      void this.audioPlayer?.select(generation, record, position);
    }
  }

  private runLifecyclePauseEffect(state: AppState): void {
    if (state.selectedRecordingId !== undefined) {
      this.audioPlayer?.pause(this.selectionGeneration, 'lifecycle');
    }
  }

  private repositionSelectedSource(): void {
    const selected = this.state.selectedRecordingId;
    if (selected === undefined) return;
    const record = this.findRecording(selected);
    const position = record === undefined ? null : this.positionFor(record);
    if (position !== null) this.audioPlayer?.setPosition(position);
  }

  private positionFor(record: NormalizedRecording): THREE.Vector3 | null {
    if (this.state.location === undefined || this.state.calibration === undefined || this.runtimeConfig === null) return null;
    const geo = geoBetween(this.state.location, record.location);
    return placeAtBearing(this.state.calibration, geo, this.runtimeConfig.sourceRadiusM);
  }

  private findRecording(recordingId: string): NormalizedRecording | undefined {
    return this.state.recordings.find((record) => record.id === recordingId);
  }

  private handleXrEvent(event: XRRuntimeEvent): void {
    if (event.sessionGeneration !== this.sessionGeneration) return;
    switch (event.type) {
      case 'ended':
        this.dispatch({ type: 'XR_ENDED', sessionGeneration: event.sessionGeneration });
        break;
      case 'visibilityChanged':
        if (event.visibilityState === 'visible-blurred' || event.visibilityState === 'hidden') {
          this.dispatch({
            type: 'CALIBRATION_INVALIDATED',
            sessionGeneration: event.sessionGeneration,
            code: 'CALIBRATION_RESET',
            reason: event.visibilityState === 'hidden' ? 'xr-hidden' : 'xr-visible-blurred',
          });
        }
        break;
      case 'referenceReset':
        this.dispatch({
          type: 'CALIBRATION_INVALIDATED',
          sessionGeneration: event.sessionGeneration,
          code: 'CALIBRATION_RESET',
          reason: 'reference-reset',
        });
        break;
      case 'inputAvailabilityChanged':
        this.dispatch({
          type: 'INPUT_AVAILABILITY_CHANGED',
          sessionGeneration: event.sessionGeneration,
          available: event.hasTrackedPointer,
        });
        break;
      case 'pointerMove':
        this.mapPanel?.updateHover(event.canvasX, event.canvasY, event.nowMs);
        break;
      case 'pointerLeave':
        this.mapPanel?.clearHover();
        break;
      case 'primarySelect':
        if (this.state.phase === 'calibrating') {
          const hit = event.canvasX === undefined || event.canvasY === undefined
            ? null
            : this.mapPanel?.hitTest(event.canvasX, event.canvasY, event.nowMs) ?? null;
          this.dispatch(hit?.type === 'EXIT_XR' ? hit : { type: 'CONFIRM_CALIBRATION' });
        } else if (this.state.phase === 'ready' && event.canvasX !== undefined && event.canvasY !== undefined) {
          const hit = this.mapPanel?.hitTest(event.canvasX, event.canvasY, event.nowMs);
          if (hit !== null && hit !== undefined) this.dispatch(hit);
        }
        break;
    }
  }

  private updateMapModel(): void {
    const panel = this.mapPanel;
    const location = this.state.location;
    if (panel === null) return;
    const geos = location === undefined
      ? []
      : this.state.recordings.map((record) => ({ record, geo: geoBetween(location, record.location) }));
    const projection = createProjectionModel(geos.map(({ record, geo }) => {
      const enabled = this.state.recordingEligibility[record.id] !== 'unsupported';
      return {
        recordingId: record.id,
        geo,
        state: mapMarkerState(this.state, record.id, enabled),
        enabled,
        ...(enabled ? {} : { disabledReason: 'unsupported-audio' as const }),
      };
    }), {
      ...(this.state.manifest?.map?.distanceScale === undefined
        ? {}
        : { distanceScale: this.state.manifest.map.distanceScale }),
      ...(this.state.manifest?.map?.maxDistanceM === undefined
        ? {}
        : { configuredMaxDistanceM: this.state.manifest.map.maxDistanceM }),
    });
    const selectedGeo = geos.find(({ record }) => record.id === this.state.selectedRecordingId);
    const selected = selectedGeo === undefined ? undefined : {
      recordingId: selectedGeo.record.id,
      title: selectedGeo.record.title,
      latitudeText: selectedGeo.record.location.lat.toFixed(6),
      longitudeText: selectedGeo.record.location.lon.toFixed(6),
      distanceText: formatDistanceM(selectedGeo.geo.distanceM),
      bearingText: formatBearing(selectedGeo.geo.bearingDeg, selectedGeo.geo.cardinal),
      ...(selectedGeo.record.description === undefined ? {} : { description: selectedGeo.record.description }),
      ...(selectedGeo.record.credit === undefined ? {} : { credit: selectedGeo.record.credit }),
    };
    const warnings: string[] = [];
    if (this.state.location?.accuracyM !== undefined && this.state.location.accuracyM > 100) {
      warnings.push('Location accuracy is low; consider a manual coordinate.');
    } else if (this.state.location?.accuracyM !== undefined && this.state.location.accuracyM > 50) {
      warnings.push('Location accuracy is moderate.');
    }
    if (this.state.recordings.length > 2_000) warnings.push(`Dense collection: ${this.state.recordings.length} records.`);
    if (selectedGeo !== undefined && selectedGeo.geo.bearingRad === null && !selectedGeo.geo.coLocated) {
      warnings.push('Geographic bearing is undefined for this coordinate pair.');
    }
    const model: MapPanelModel = {
      collectionTitle: this.state.manifest?.collection.title ?? 'attune',
      xrControlsVisible: !this.config.debugMode,
      markers: projection.markers,
      distanceRings: projection.distanceRings,
      ...(selected === undefined ? {} : { selected }),
      playback: this.state.playback,
      masterGain: this.state.masterGain,
      calibrationReady: this.state.debugMode || this.state.calibration !== undefined,
      controllerAvailable: this.state.debugMode || this.state.controllerAvailable,
      ...(warnings.length === 0 ? {} : { warningText: warnings.join(' ') }),
      ...(this.state.error === undefined ? {} : { errorCode: this.state.error.code }),
    };
    panel.setModel(model);
  }

  private publishState(): void {
    this.updateMapModel();
    this.view?.render(this.state, this.resourceCounts(), this.mapPanel);
    for (const subscriber of [...this.subscribers]) {
      if (!this.subscribers.has(subscriber) || this.lifecycle === 'disposed') continue;
      try {
        subscriber(this.state);
      } catch {
        console.error('INTERNAL_LISTENER_ERROR');
      }
    }
  }

  private reducerContext(): AppReducerContext {
    return {
      config: this.config,
      locationGeneration: this.locationGeneration,
      selectionGeneration: this.selectionGeneration,
      sessionGeneration: this.sessionGeneration,
      wallClockMs: this.wallClockMs(),
    };
  }

  private installShell(): void {
    const root = this.documentRef.querySelector<HTMLElement>('#app');
    if (root === null) throw new AppError('CONFIGURATION_CONFLICT');
    this.root = root;
    this.view = new PreflightView(root);
    root.addEventListener('click', this.onRootClick);
    root.addEventListener('input', this.onRootInput);
    root.addEventListener('pointermove', this.onRootPointerMove);
    this.rootHandlersInstalled = true;
    this.view.render(this.state, this.resourceCounts(), null);
  }

  private removeShell(): void {
    if (this.visibilityHandlerInstalled) {
      this.documentRef.removeEventListener('visibilitychange', this.onVisibilityChange);
      this.visibilityHandlerInstalled = false;
    }
    if (this.root !== null && this.rootHandlersInstalled) {
      this.root.removeEventListener('click', this.onRootClick);
      this.root.removeEventListener('input', this.onRootInput);
      this.root.removeEventListener('pointermove', this.onRootPointerMove);
      this.rootHandlersInstalled = false;
    }
    this.view?.clear();
    this.view = null;
    this.root = null;
  }

  private expectedBootFailure(code: AppErrorCode): void {
    this.dispatch({ type: 'BOOT_FAILED', code });
    this.lifecycle = 'initialized';
  }

  private async cleanupHeavyResources(): Promise<void> {
    this.audioUnsubscribe?.();
    this.audioUnsubscribe = null;
    this.xrUnsubscribe?.();
    this.xrUnsubscribe = null;
    if (this.visibilityHandlerInstalled) {
      this.documentRef.removeEventListener('visibilitychange', this.onVisibilityChange);
      this.visibilityHandlerInstalled = false;
    }
    this.xrController?.setInteractionSurface(null);
    this.audioPlayer?.dispose();
    this.audioPlayer = null;
    this.mapPanel?.dispose();
    this.mapPanel = null;
    const xr = this.xrController;
    this.xrController = null;
    if (xr !== null) await xr.dispose();
    this.runtimeConfig = null;
  }

  private assertInitializationCurrent(): void {
    if (this.lifecycle === 'disposing' || this.lifecycle === 'disposed' || this.abortController?.signal.aborted) {
      throw new AppError('APP_DISPOSED');
    }
  }

  private assertLive(): void {
    if (this.lifecycle === 'disposing' || this.lifecycle === 'disposed') throw new AppError('APP_DISPOSED');
  }

  private canvasPoint(event: MouseEvent | PointerEvent): { x: number; y: number } | null {
    const canvas = this.mapPanel?.getCanvas();
    if (canvas === undefined || event.target !== canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: ((event.clientX - rect.left) / rect.width) * 1024,
      y: ((event.clientY - rect.top) / rect.height) * 768,
    };
  }

  private readonly onRootClick = (event: MouseEvent): void => {
    if (this.lifecycle === 'disposing' || this.lifecycle === 'disposed') return;
    const point = this.config.debugMode ? this.canvasPoint(event) : null;
    if (point !== null) {
      const action = this.mapPanel?.hitTest(point.x, point.y, this.monotonicNowMs());
      if (action !== null && action !== undefined) this.dispatch(action);
      return;
    }
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-action]') : null;
    switch (target?.dataset.action) {
      case 'use-location': this.dispatch({ type: 'LOCATION_REQUESTED' }); break;
      case 'submit-location': {
        const latText = this.root?.querySelector<HTMLInputElement>('[name="latitude"]')?.value ?? '';
        const lonText = this.root?.querySelector<HTMLInputElement>('[name="longitude"]')?.value ?? '';
        this.dispatch({ type: 'SUBMIT_MANUAL_LOCATION', latText, lonText });
        break;
      }
      case 'enter-xr': this.dispatch({ type: 'XR_START_REQUESTED' }); break;
      case 'clear-error': this.dispatch({ type: 'CLEAR_RECOVERABLE_ERROR' }); break;
    }
  };

  private readonly onRootInput = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.dataset.action === 'master-gain') {
      this.dispatch({ type: 'SET_MASTER_GAIN', value: Number(target.value) });
    }
  };

  private readonly onRootPointerMove = (event: PointerEvent): void => {
    if (!this.config.debugMode) return;
    const point = this.canvasPoint(event);
    if (point === null) this.mapPanel?.clearHover();
    else this.mapPanel?.updateHover(point.x, point.y, this.monotonicNowMs());
  };

  private readonly onVisibilityChange = (): void => {
    if (this.documentRef.visibilityState === 'hidden' && this.state.sessionActive) {
      this.dispatch({
        type: 'CALIBRATION_INVALIDATED',
        sessionGeneration: this.sessionGeneration,
        code: 'CALIBRATION_RESET',
        reason: 'document-hidden',
      });
    }
  };
}

let activeController: AttuneAppController | null = null;

/** Create an unregistered controller for deterministic integration tests. */
export function createAppController(
  config: Readonly<AppConfig>,
  dependencies: AppControllerDependencies = {},
): AppController {
  return new AttuneAppController(config, dependencies);
}

/** Initialize or reuse the page-global application controller. */
export async function initializeApp(config: AppConfig): Promise<AppController> {
  if (activeController !== null) {
    if (activeController.isClosing()) throw new AppError('APP_DISPOSED');
    if (!activeController.matchesConfig(config)) throw new AppError('CONFIGURATION_CONFLICT');
    await activeController.initialize();
    return activeController;
  }
  const controller = new AttuneAppController(Object.freeze({ ...config }), {});
  activeController = controller;
  await controller.initialize();
  return controller;
}

export const getGlobalResourceCounts: GetGlobalResourceCounts = () =>
  activeController?.resourceCounts() ?? { ...ZERO_COUNTS };
