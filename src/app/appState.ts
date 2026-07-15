import * as THREE from 'three';

import type {
  AppAction,
  AppConfig,
  AppErrorState,
  AppState,
  GeoFrame,
  PlaybackEligibility,
  PlaybackSnapshot,
} from '../domain/types';

export interface AppReducerContext {
  readonly config: Readonly<AppConfig>;
  readonly locationGeneration: number;
  readonly selectionGeneration: number;
  readonly sessionGeneration: number;
  readonly wallClockMs: number;
}

const EMPTY_ELIGIBILITY: Readonly<Record<string, PlaybackEligibility>> = Object.freeze(
  Object.create(null) as Record<string, PlaybackEligibility>,
);

export function createInitialState(config: Readonly<AppConfig>): AppState {
  return {
    phase: 'booting',
    recordings: [],
    recordingEligibility: EMPTY_ELIGIBILITY,
    rejectedRecordCount: 0,
    unsupportedRecordCount: 0,
    secureContext: false,
    debugMode: config.debugMode,
    xrApiAvailable: false,
    immersiveARSupported: false,
    browserGeolocationAvailable: false,
    sessionActive: false,
    controllerAvailable: false,
    panelVisible: true,
    playback: { state: 'empty', currentTimeSec: 0 },
    masterGain: 0.7,
    audioGestureRequired: false,
    buildCommit: config.buildCommit,
  };
}

export function canonicalDebugFrame(calibratedAtMs: number): GeoFrame {
  return {
    originWorld: new THREE.Vector3(0, 1.6, 0),
    northWorld: new THREE.Vector3(0, 0, -1),
    eastWorld: new THREE.Vector3(1, 0, 0),
    upWorld: new THREE.Vector3(0, 1, 0),
    calibratedAtMs,
  };
}

export function cloneGeoFrame(frame: GeoFrame): GeoFrame {
  return {
    originWorld: frame.originWorld.clone(),
    northWorld: frame.northWorld.clone(),
    eastWorld: frame.eastWorld.clone(),
    upWorld: frame.upWorld.clone(),
    calibratedAtMs: frame.calibratedAtMs,
  };
}

function withoutError(state: AppState): AppState {
  if (state.error === undefined) return state;
  const { error: _error, ...next } = state;
  return next;
}

function withoutCalibration(state: AppState): AppState {
  if (state.calibration === undefined) return state;
  const { calibration: _calibration, ...next } = state;
  return next;
}

function withError(state: AppState, error: AppErrorState): AppState {
  return { ...state, error };
}

function lifecyclePaused(playback: PlaybackSnapshot, selectedRecordingId?: string): PlaybackSnapshot {
  if (selectedRecordingId === undefined) return playback;
  return {
    ...playback,
    state: 'paused',
    recordingId: selectedRecordingId,
  };
}

function isLivePhase(state: AppState): boolean {
  return state.phase !== 'fatalError';
}

/** Pure observable-state reducer. Generation allocation and effects stay in AppController. */
export function reduceAppState(
  state: AppState,
  action: AppAction,
  context: AppReducerContext,
): AppState {
  switch (action.type) {
    case 'BOOT_SUCCEEDED': {
      if (state.phase !== 'booting' || action.debugMode !== context.config.debugMode) return state;
      if (!action.debugMode && (!action.secureContext || !action.xrApiAvailable || !action.immersiveARSupported)) {
        return state;
      }
      const countedUnsupported = action.recordings.reduce(
        (count, record) => count + (action.recordingEligibility[record.id] === 'unsupported' ? 1 : 0),
        0,
      );
      if (countedUnsupported !== action.unsupportedRecordCount) return state;
      return {
        ...state,
        phase: 'preflight',
        manifest: action.manifest,
        recordings: action.recordings,
        recordingEligibility: action.recordingEligibility,
        rejectedRecordCount: action.rejectedRecordCount,
        unsupportedRecordCount: action.unsupportedRecordCount,
        secureContext: action.secureContext,
        debugMode: action.debugMode,
        xrApiAvailable: action.xrApiAvailable,
        immersiveARSupported: action.immersiveARSupported,
        browserGeolocationAvailable: action.browserGeolocationAvailable,
      };
    }
    case 'BOOT_FAILED':
      return state.phase === 'booting'
        ? { ...state, phase: 'fatalError', error: { code: action.code, recoverable: false } }
        : state;
    case 'LOCATION_REQUESTED': {
      if (
        !state.browserGeolocationAvailable
        || !['preflight', 'locationPending', 'locationReady', 'ready'].includes(state.phase)
        || (state.phase === 'ready' && !state.debugMode)
        || state.phase === 'locationPending'
      ) return state;
      const cleared = withoutError(state);
      return {
        ...cleared,
        phase: 'locationPending',
        ...(state.debugMode
          ? { playback: lifecyclePaused(state.playback, state.selectedRecordingId) }
          : {}),
      };
    }
    case 'LOCATION_RESOLVED': {
      if (
        action.locationGeneration !== context.locationGeneration
        || state.sessionActive
        || state.phase === 'enteringXR'
        || !['preflight', 'locationPending', 'locationReady', 'ready'].includes(state.phase)
      ) return state;
      const cleared = withoutError(state);
      if (state.debugMode) {
        return {
          ...cleared,
          phase: 'ready',
          location: action.location,
          calibration: canonicalDebugFrame(context.wallClockMs),
          playback: lifecyclePaused(state.playback, state.selectedRecordingId),
        };
      }
      return { ...cleared, phase: 'locationReady', location: action.location };
    }
    case 'LOCATION_FAILED': {
      if (state.phase !== 'locationPending' || action.locationGeneration !== context.locationGeneration) return state;
      const phase = state.debugMode && state.location !== undefined && state.calibration !== undefined
        ? 'ready'
        : state.location === undefined ? 'preflight' : 'locationReady';
      return { ...state, phase, error: { code: action.code, recoverable: true } };
    }
    case 'SUBMIT_MANUAL_LOCATION':
      return state;
    case 'XR_START_REQUESTED': {
      if (
        state.debugMode || state.phase !== 'locationReady' || state.location === undefined
        || !state.xrApiAvailable || !state.immersiveARSupported
        || state.recordings.every((record) => state.recordingEligibility[record.id] === 'unsupported')
      ) return state;
      return { ...withoutError(state), phase: 'enteringXR', audioGestureRequired: false };
    }
    case 'XR_STARTED':
      return state.phase === 'enteringXR' && action.sessionGeneration === context.sessionGeneration
        ? {
            ...withoutCalibration(withoutError(state)),
            phase: 'calibrating',
            sessionActive: true,
            controllerAvailable: false,
          }
        : state;
    case 'XR_START_FAILED':
      return state.phase === 'enteringXR' && action.sessionGeneration === context.sessionGeneration
        ? {
            ...withoutCalibration(state),
            phase: 'locationReady',
            sessionActive: false,
            controllerAvailable: false,
            error: { code: action.code, recoverable: true },
          }
        : state;
    case 'CONFIRM_CALIBRATION':
      return state;
    case 'CALIBRATION_CONFIRMED':
      return state.phase === 'calibrating' && action.sessionGeneration === context.sessionGeneration
        ? {
            ...withoutError(state),
            phase: 'ready',
            calibration: cloneGeoFrame(action.frame),
          }
        : state;
    case 'CALIBRATION_FAILED':
      return state.phase === 'calibrating' && action.sessionGeneration === context.sessionGeneration
        ? withError(state, { code: action.code, recoverable: true })
        : state;
    case 'CALIBRATION_INVALIDATED': {
      if (
        !state.sessionActive || action.sessionGeneration !== context.sessionGeneration
        || !['ready', 'calibrating'].includes(state.phase)
      ) return state;
      return {
        ...withoutCalibration(state),
        phase: 'calibrating',
        playback: lifecyclePaused(state.playback, state.selectedRecordingId),
        error: { code: action.code, recoverable: true, calibrationReason: action.reason },
      };
    }
    case 'INPUT_AVAILABILITY_CHANGED':
      return action.sessionGeneration === context.sessionGeneration
        && ['calibrating', 'ready', 'endingXR'].includes(state.phase)
        && state.controllerAvailable !== action.available
        ? { ...state, controllerAvailable: action.available }
        : state;
    case 'SELECT_RECORDING': {
      if (
        state.phase !== 'ready'
        || !Object.hasOwn(state.recordingEligibility, action.recordingId)
        || state.recordingEligibility[action.recordingId] === 'unsupported'
      ) return state;
      if (
        state.selectedRecordingId === action.recordingId
        && (state.playback.state === 'loading' || state.playback.state === 'playing')
      ) return state;
      if (state.selectedRecordingId === action.recordingId && state.playback.state !== 'error') return state;
      const playback: PlaybackSnapshot = {
        state: 'loading',
        recordingId: action.recordingId,
        currentTimeSec: 0,
      };
      return {
        ...withoutError(state),
        selectedRecordingId: action.recordingId,
        playback,
      };
    }
    case 'PLAY':
      return state.phase === 'ready' && state.selectedRecordingId !== undefined
        && state.playback.state === 'error'
        ? {
            ...withoutError(state),
            playback: { state: 'loading', recordingId: state.selectedRecordingId, currentTimeSec: 0 },
          }
        : state;
    case 'PAUSE':
    case 'STOP':
      return state;
    case 'SET_MASTER_GAIN': {
      if (state.phase !== 'ready' || !Number.isFinite(action.value)) return state;
      const value = Math.round(Math.min(1, Math.max(0, action.value)) * 10) / 10;
      return value === state.masterGain ? state : { ...state, masterGain: value };
    }
    case 'AUDIO_GESTURE_REQUIRED':
      return action.sessionGeneration === context.sessionGeneration
        && ['enteringXR', 'calibrating', 'ready', 'endingXR'].includes(state.phase)
        && action.required !== state.audioGestureRequired
        ? { ...state, audioGestureRequired: action.required }
        : state;
    case 'RECENTER_PANEL':
      return state;
    case 'TOGGLE_PANEL':
      // Grip toggles panel visibility only once calibrated and in a live session; hiding
      // during calibration would strand the user with no instruction and no way to proceed.
      return !state.debugMode && state.phase === 'ready' && state.sessionActive
        ? { ...state, panelVisible: !state.panelVisible }
        : state;
    case 'RECALIBRATE':
      return !state.debugMode && state.phase === 'ready' && state.sessionActive
        ? {
            ...withoutCalibration(state),
            phase: 'calibrating',
            playback: lifecyclePaused(state.playback, state.selectedRecordingId),
          }
        : state;
    case 'EXIT_XR':
      return !state.debugMode && state.sessionActive && ['calibrating', 'ready'].includes(state.phase)
        ? { ...state, phase: 'endingXR' }
        : state;
    case 'XR_ENDED':
      return action.sessionGeneration === context.sessionGeneration
        && ['enteringXR', 'calibrating', 'ready', 'endingXR'].includes(state.phase)
        ? {
            ...withoutCalibration(state),
            phase: 'locationReady',
            sessionActive: false,
            controllerAvailable: false,
            playback: lifecyclePaused(state.playback, state.selectedRecordingId),
          }
        : state;
    case 'PLAYBACK_SNAPSHOT': {
      if (!isLivePhase(state) || action.generation !== context.selectionGeneration) return state;
      if (
        action.snapshot.recordingId !== undefined
        && action.snapshot.recordingId !== state.selectedRecordingId
      ) return state;
      let next = { ...state, playback: { ...action.snapshot } };
      if (action.snapshot.state === 'playing') next = { ...next, audioGestureRequired: false };
      if (action.snapshot.state === 'error' && action.snapshot.errorCode !== undefined) {
        next = { ...next, error: { code: action.snapshot.errorCode, recoverable: true } };
      }
      if (
        action.snapshot.errorCode === 'AUDIO_PLAY_REJECTED'
        || action.snapshot.errorCode === 'AUDIO_CONTEXT_SUSPENDED'
      ) next = { ...next, audioGestureRequired: true };
      return next;
    }
    case 'CLEAR_RECOVERABLE_ERROR':
      return state.error?.recoverable === true ? withoutError(state) : state;
  }
}
