import type * as THREE from 'three';

export interface AppConfig {
  manifestUrl: string;
  audioLoadTimeoutMs: number;
  progressUpdateHz: number;
  sourceRadiusMOverride?: number;
  buildCommit: string;
  debugMode: boolean;
  defaultLocation?: LatLon;
}

export interface RuntimeConfig extends Omit<AppConfig, 'sourceRadiusMOverride'> {
  sourceRadiusM: number;
}

export interface LatLon {
  lat: number;
  lon: number;
}

export interface InitializedLocation extends LatLon {
  source: 'browser' | 'manual';
  accuracyM?: number;
  timestampMs: number;
}

export interface GeoFrame {
  originWorld: THREE.Vector3;
  northWorld: THREE.Vector3;
  eastWorld: THREE.Vector3;
  upWorld: THREE.Vector3;
  calibratedAtMs: number;
}

export interface RecordingManifest {
  schemaVersion: '1.0';
  collection: {
    id: string;
    title: string;
    description?: string;
    defaultSpatialRadiusM?: number;
  };
  map?: {
    distanceScale?: 'log' | 'linear';
    maxDistanceM?: number;
  };
  recordings: RecordingRecord[];
}

export interface RecordingRecord {
  id: string;
  title: string;
  audioUrl: string;
  mimeType?: string;
  location: {
    lat: number;
    lon: number;
  };
  spatialFormat: 'point-source';
  durationSec?: number;
  recordedAt?: string;
  description?: string;
  tags?: string[];
  gainDb?: number;
  credit?: string;
}

export type AdaptSourceMetadata = (input: unknown) => RecordingManifest;

export interface GeoResult {
  distanceM: number;
  bearingRad: number | null;
  bearingDeg: number | null;
  cardinal: string | null;
  coLocated: boolean;
}

export interface GeoPlacement {
  geo: GeoResult;
  worldPosition: THREE.Vector3;
}

export interface SelectionAction {
  recordingId: string;
}

export type PlaybackState =
  | 'empty'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'stopped'
  | 'ended'
  | 'error';

export interface PlaybackSnapshot {
  state: PlaybackState;
  recordingId?: string;
  loadedRecordingId?: string;
  currentTimeSec: number;
  durationSec?: number;
  errorCode?: AppErrorCode;
}

export type AppErrorCode =
  | 'INSECURE_CONTEXT'
  | 'XR_API_UNAVAILABLE'
  | 'IMMERSIVE_AR_UNSUPPORTED'
  | 'XR_SESSION_REJECTED'
  | 'XR_SESSION_ALREADY_ACTIVE'
  | 'XR_RENDERER_INIT_FAILED'
  | 'REFERENCE_SPACE_UNAVAILABLE'
  | 'LOCATION_UNAVAILABLE'
  | 'LOCATION_DENIED'
  | 'LOCATION_TIMEOUT'
  | 'LOCATION_INVALID'
  | 'MANIFEST_LOAD_FAILED'
  | 'MANIFEST_INVALID'
  | 'NO_VALID_RECORDINGS'
  | 'CALIBRATION_INVALID'
  | 'CALIBRATION_RESET'
  | 'CONTROLLER_UNAVAILABLE'
  | 'AUDIO_CONTEXT_SUSPENDED'
  | 'AUDIO_INITIALIZATION_FAILED'
  | 'AUDIO_UNSUPPORTED'
  | 'AUDIO_CORS'
  | 'AUDIO_NETWORK'
  | 'AUDIO_DECODE'
  | 'AUDIO_ABORTED'
  | 'AUDIO_PLAY_REJECTED'
  | 'CONFIGURATION_CONFLICT'
  | 'APP_DISPOSED'
  | 'INTERNAL_LISTENER_ERROR';

export type AppPhase =
  | 'booting'
  | 'preflight'
  | 'locationPending'
  | 'locationReady'
  | 'enteringXR'
  | 'calibrating'
  | 'ready'
  | 'endingXR'
  | 'fatalError';

export type PlaybackEligibility = 'eligible' | 'probe-at-play' | 'unsupported';

export type CalibrationInvalidationReason =
  | 'reference-reset'
  | 'document-hidden'
  | 'xr-visible-blurred'
  | 'xr-hidden';

export interface AppErrorState {
  code: AppErrorCode;
  recoverable: boolean;
  calibrationReason?: CalibrationInvalidationReason;
}

export interface AppState {
  phase: AppPhase;
  manifest?: NormalizedManifest;
  recordings: readonly NormalizedRecording[];
  recordingEligibility: Readonly<Record<string, PlaybackEligibility>>;
  rejectedRecordCount: number;
  unsupportedRecordCount: number;
  secureContext: boolean;
  debugMode: boolean;
  xrApiAvailable: boolean;
  immersiveARSupported: boolean;
  browserGeolocationAvailable: boolean;
  location?: InitializedLocation;
  sessionActive: boolean;
  controllerAvailable: boolean;
  panelVisible: boolean;
  calibration?: GeoFrame;
  selectedRecordingId?: string;
  playback: PlaybackSnapshot;
  masterGain: number;
  audioGestureRequired: boolean;
  error?: AppErrorState;
  buildCommit: string;
}

export type AppAction =
  | {
      type: 'BOOT_SUCCEEDED';
      manifest: NormalizedManifest;
      recordings: readonly NormalizedRecording[];
      recordingEligibility: Readonly<Record<string, PlaybackEligibility>>;
      rejectedRecordCount: number;
      unsupportedRecordCount: number;
      secureContext: boolean;
      debugMode: boolean;
      xrApiAvailable: boolean;
      immersiveARSupported: boolean;
      browserGeolocationAvailable: boolean;
    }
  | { type: 'BOOT_FAILED'; code: AppErrorCode }
  | { type: 'LOCATION_REQUESTED' }
  | { type: 'SUBMIT_MANUAL_LOCATION'; latText: string; lonText: string }
  | { type: 'LOCATION_RESOLVED'; locationGeneration: number; location: InitializedLocation }
  | { type: 'LOCATION_FAILED'; locationGeneration: number; code: AppErrorCode }
  | { type: 'XR_START_REQUESTED' }
  | { type: 'XR_STARTED'; sessionGeneration: number }
  | { type: 'XR_START_FAILED'; sessionGeneration: number; code: AppErrorCode }
  | { type: 'CONFIRM_CALIBRATION' }
  | { type: 'CALIBRATION_CONFIRMED'; sessionGeneration: number; frame: GeoFrame }
  | { type: 'CALIBRATION_FAILED'; sessionGeneration: number; code: 'CALIBRATION_INVALID' }
  | {
      type: 'CALIBRATION_INVALIDATED';
      sessionGeneration: number;
      code: 'CALIBRATION_RESET';
      reason: CalibrationInvalidationReason;
    }
  | { type: 'INPUT_AVAILABILITY_CHANGED'; sessionGeneration: number; available: boolean }
  | { type: 'SELECT_RECORDING'; recordingId: string }
  | { type: 'PLAY' }
  | { type: 'PAUSE' }
  | { type: 'STOP' }
  | { type: 'SET_MASTER_GAIN'; value: number }
  | {
      type: 'AUDIO_GESTURE_REQUIRED';
      sessionGeneration: number;
      required: boolean;
    }
  | { type: 'RECENTER_PANEL' }
  | { type: 'RECALIBRATE' }
  | { type: 'TOGGLE_PANEL' }
  | { type: 'EXIT_XR' }
  | { type: 'XR_ENDED'; sessionGeneration: number }
  | { type: 'PLAYBACK_SNAPSHOT'; generation: number; snapshot: PlaybackSnapshot }
  | { type: 'CLEAR_RECOVERABLE_ERROR' };

export type ContentRejectionCode =
  | 'RECORD_NOT_OBJECT'
  | 'ID_INVALID'
  | 'ID_DUPLICATE'
  | 'TITLE_INVALID'
  | 'AUDIO_URL_INVALID'
  | 'COORDINATE_INVALID'
  | 'SPATIAL_FORMAT_UNSUPPORTED'
  | 'DURATION_INVALID'
  | 'RECORDED_AT_INVALID'
  | 'MIME_TYPE_INVALID'
  | 'GAIN_INVALID'
  | 'TAG_INVALID'
  | 'FIELD_TYPE_INVALID'
  | 'FIELD_LIMIT_EXCEEDED';

export type ContentWarningCode =
  | 'UNKNOWN_FIELD_STRIPPED'
  | 'GAIN_CLAMPED'
  | 'EMPTY_TAG_REMOVED'
  | 'DUPLICATE_TAG_REMOVED'
  | 'EXTERNAL_AUDIO_NOT_FILE_CHECKED';

export interface RejectedRecord {
  index: number;
  id?: string;
  code: ContentRejectionCode;
  fieldPath?: string;
}

export interface ContentWarning {
  index?: number;
  id?: string;
  code: ContentWarningCode;
  fieldPath: string;
}

export interface NormalizedRecording extends Omit<RecordingRecord, 'audioUrl' | 'tags' | 'gainDb'> {
  audioUrl: string;
  resolvedAudioUrl: string;
  tags: readonly string[];
  gainDb: number;
}

export type NormalizedManifestRecord = Omit<NormalizedRecording, 'resolvedAudioUrl'>;

export interface NormalizedManifest {
  schemaVersion: '1.0';
  collection: Readonly<{
    id: string;
    title: string;
    description?: string;
    defaultSpatialRadiusM?: number;
  }>;
  map?: Readonly<{
    distanceScale?: 'log' | 'linear';
    maxDistanceM?: number;
  }>;
  recordings: readonly NormalizedManifestRecord[];
}

export interface ManifestLoadResult {
  manifest: NormalizedManifest;
  records: readonly NormalizedRecording[];
  rejected: readonly RejectedRecord[];
  warnings: readonly ContentWarning[];
}

export interface AudioResourceCounts {
  mediaElements: 0 | 1;
  mediaElementSourceNodes: 0 | 1;
  audioSourceObjects: 0 | 1;
  listeners: 0 | 1;
  positionalAudioObjects: 0 | 1;
  panners: 0 | 1;
  registeredMediaHandlers: 0 | 10;
  activeLoadWatchdogs: 0 | 1;
  activeFadeCompletionTimers: 0 | 1;
}

export interface RuntimeResourceCounts extends AudioResourceCounts {
  appRoots: 0 | 1;
  renderers: 0 | 1;
  rendererCanvases: 0 | 1;
  scenes: 0 | 1;
  appCameras: 0 | 1;
  mapCanvases: 0 | 1;
  mapTextures: 0 | 1;
  mapMaterials: 0 | 1;
  mapGeometries: 0 | 1;
  mapPlanes: 0 | 1;
  controllerGroups: 0 | 2;
  controllerRayVisuals: 0 | 2;
  pointerReticles: 0 | 1;
  reticleGeometries: 0 | 1;
  reticleMaterials: 0 | 1;
  activeXRSessions: 0 | 1;
  registeredXRSessionHandlers: 0 | 5;
  registeredReferenceSpaceHandlers: 0 | 1;
  registeredControllerGroupHandlers: 0 | 4;
  controllerBindings: 0 | 1;
  registeredAppRootHandlers: 0 | 3;
  registeredWindowResizeHandlers: 0 | 1;
  registeredDocumentVisibilityHandlers: 0 | 1;
}

export type Unsubscribe = () => void;

export interface AudioPlaybackEvent {
  generation: number;
  snapshot: PlaybackSnapshot;
}

export interface XRInteractionSurface {
  object: THREE.Object3D;
  widthPx: 1024;
  heightPx: 768;
}

export type ImmersiveARSessionMode = 'immersive-ar';

export type ImmersiveARSessionInit = {
  optionalFeatures: ['local-floor'];
};

export type XRRuntimeEvent =
  | { sessionGeneration: number; type: 'ended' }
  | { sessionGeneration: number; type: 'visibilityChanged'; visibilityState: XRVisibilityState }
  | { sessionGeneration: number; type: 'referenceReset' }
  | { sessionGeneration: number; type: 'inputAvailabilityChanged'; hasTrackedPointer: boolean }
  | { sessionGeneration: number; type: 'pointerMove'; canvasX: number; canvasY: number; nowMs: number }
  | { sessionGeneration: number; type: 'pointerLeave' }
  | {
      sessionGeneration: number;
      type: 'primarySelect';
      nowMs: number;
      canvasX?: number;
      canvasY?: number;
    }
  | { sessionGeneration: number; type: 'primarySqueeze'; nowMs: number };

export type MapMarkerState =
  | 'default'
  | 'hovered'
  | 'selected'
  | 'loading'
  | 'playing'
  | 'failed'
  | 'disabled';

export type MarkerDisabledReason = 'unsupported-audio';

export type PointerTargetKind = 'none' | 'panel' | 'marker' | 'control' | 'disabled';

export interface MapMarkerModel {
  recordingId: string;
  xPx: number;
  yPx: number;
  state: MapMarkerState;
  enabled: boolean;
  disabledReason?: MarkerDisabledReason;
}

export interface MapDistanceRingModel {
  normalizedRadius: 0.25 | 0.5 | 0.75 | 1;
  distanceText: string;
}

export interface MapPanelModel {
  collectionTitle: string;
  xrControlsVisible: boolean;
  panelVisible: boolean;
  markers: readonly MapMarkerModel[];
  distanceRings: readonly MapDistanceRingModel[];
  selected?: {
    recordingId: string;
    title: string;
    latitudeText: string;
    longitudeText: string;
    distanceText: string;
    bearingText: string;
    description?: string;
    credit?: string;
  };
  playback: PlaybackSnapshot;
  masterGain: number;
  calibrationReady: boolean;
  controllerAvailable: boolean;
  overlapCycle?: { index: number; count: number };
  warningText?: string;
  errorCode?: AppErrorCode;
}

export type MapPanelAction = Extract<
  AppAction,
  {
    type:
      | 'SELECT_RECORDING'
      | 'PLAY'
      | 'PAUSE'
      | 'STOP'
      | 'SET_MASTER_GAIN'
      | 'RECENTER_PANEL'
      | 'RECALIBRATE'
      | 'EXIT_XR';
  }
>;

export interface Disposable {
  dispose(): void;
}

export interface AsyncDisposable {
  dispose(): Promise<void>;
}

export interface ManifestService {
  load(url: string, signal?: AbortSignal): Promise<ManifestLoadResult>;
}

export interface LocationInitializer {
  requestBrowserLocation(): Promise<InitializedLocation>;
  parseManual(latText: string, lonText: string): InitializedLocation;
}

export interface XRSessionHandle {
  readonly generation: number;
  readonly session: XRSession;
  readonly referenceSpace: XRReferenceSpace;
  getAppCamera(): THREE.PerspectiveCamera;
  getViewerCamera(): THREE.ArrayCamera;
  end(): Promise<void>;
}

export interface XRStartOperation {
  readonly generation: number;
  readonly result: Promise<XRSessionHandle>;
}

export interface XRSessionController extends AsyncDisposable {
  start(): XRStartOperation;
  getActive(): XRSessionHandle | null;
  getScene(): THREE.Scene;
  getAppCamera(): THREE.PerspectiveCamera;
  setInteractionSurface(surface: XRInteractionSurface | null): void;
  setPointerTarget(kind: PointerTargetKind): void;
  subscribe(listener: (event: XRRuntimeEvent) => void): Unsubscribe;
  resourceCounts(): Pick<
    RuntimeResourceCounts,
    | 'renderers'
    | 'rendererCanvases'
    | 'scenes'
    | 'appCameras'
    | 'controllerGroups'
    | 'controllerRayVisuals'
    | 'pointerReticles'
    | 'reticleGeometries'
    | 'reticleMaterials'
    | 'activeXRSessions'
    | 'registeredXRSessionHandlers'
    | 'registeredReferenceSpaceHandlers'
    | 'registeredControllerGroupHandlers'
    | 'controllerBindings'
  >;
}

export interface MapPanel extends Disposable {
  setModel(model: MapPanelModel): void;
  getCanvas(): HTMLCanvasElement;
  setPoseFromCamera(camera: THREE.Camera): void;
  updateHover(canvasX: number, canvasY: number, nowMs: number): void;
  clearHover(): void;
  hitTest(canvasX: number, canvasY: number, nowMs: number): MapPanelAction | null;
  classifyTarget(canvasX: number, canvasY: number): PointerTargetKind;
  getObject3D(): THREE.Object3D;
}

export interface SpatialAudioPlayer extends Disposable {
  classifyMimeType(mimeType?: string): PlaybackEligibility;
  resumeContext(): Promise<void>;
  select(generation: number, recording: NormalizedRecording, position: THREE.Vector3): Promise<void>;
  play(generation: number): Promise<void>;
  pause(generation: number, reason: 'user' | 'lifecycle'): void;
  stop(generation: number): void;
  setPosition(position: THREE.Vector3): void;
  setMasterGain(value: number): void;
  snapshot(): PlaybackSnapshot;
  subscribe(listener: (event: AudioPlaybackEvent) => void): Unsubscribe;
  resourceCounts(): AudioResourceCounts;
}

export interface XRSessionControllerOptions {
  root: HTMLElement;
  xrSystem: XRSystem | undefined;
  windowRef: Window;
  monotonicNowMs: () => number;
}

export interface SpatialAudioPlayerOptions {
  audioLoadTimeoutMs: number;
  progressUpdateHz: number;
  mediaElement?: HTMLAudioElement;
}

export type CreateManifestService = (fetchImpl: typeof fetch) => ManifestService;
export type CreateLocationInitializer = (
  geolocation: Geolocation | undefined,
  wallClockMs: () => number,
) => LocationInitializer;
export type CreateXRSessionController = (
  options: XRSessionControllerOptions,
) => XRSessionController;
export type CreateMapPanel = (scene: THREE.Scene) => MapPanel;
export type CreateSpatialAudioPlayer = (
  camera: THREE.PerspectiveCamera,
  scene: THREE.Scene,
  options: SpatialAudioPlayerOptions,
) => SpatialAudioPlayer;

export interface AppController extends AsyncDisposable {
  initialize(): Promise<void>;
  dispatch(action: AppAction): void;
  getState(): AppState;
  subscribe(listener: (state: AppState) => void): Unsubscribe;
  resourceCounts(): RuntimeResourceCounts;
}

export type InitializeApp = (config: AppConfig) => Promise<AppController>;
export type GetGlobalResourceCounts = () => RuntimeResourceCounts;
