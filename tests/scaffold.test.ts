import { afterEach, describe, expect, test } from 'vitest';

import { AppError } from '../src/app/errors';
import { initializeBootstrapShell } from '../src/main';
import type {
  AdaptSourceMetadata,
  AppAction,
  AppConfig,
  AppController,
  AppErrorCode,
  AppErrorState,
  AppPhase,
  AppState,
  AsyncDisposable,
  AudioPlaybackEvent,
  AudioResourceCounts,
  CalibrationInvalidationReason,
  ContentRejectionCode,
  ContentWarning,
  ContentWarningCode,
  CreateLocationInitializer,
  CreateManifestService,
  CreateMapPanel,
  CreateSpatialAudioPlayer,
  CreateXRSessionController,
  Disposable,
  GeoFrame,
  GeoPlacement,
  GeoResult,
  GetGlobalResourceCounts,
  ImmersiveARSessionInit,
  ImmersiveARSessionMode,
  InitializedLocation,
  InitializeApp,
  LatLon,
  LocationInitializer,
  ManifestLoadResult,
  ManifestService,
  MapDistanceRingModel,
  MapMarkerModel,
  MapMarkerState,
  MapPanel,
  MapPanelAction,
  MapPanelModel,
  MarkerDisabledReason,
  NormalizedManifest,
  NormalizedManifestRecord,
  NormalizedRecording,
  PlaybackEligibility,
  PlaybackSnapshot,
  PlaybackState,
  RecordingManifest,
  RecordingRecord,
  RejectedRecord,
  RuntimeConfig,
  RuntimeResourceCounts,
  SelectionAction,
  SpatialAudioPlayer,
  SpatialAudioPlayerOptions,
  Unsubscribe,
  XRInteractionSurface,
  XRRuntimeEvent,
  XRSessionController,
  XRSessionControllerOptions,
  XRSessionHandle,
  XRStartOperation,
} from '../src/domain/types';

// This tuple intentionally references every frozen type-space export. A missing,
// ambient, or mutually incoherent declaration fails the strict compiler gate.
type ContractSurface = [
  AdaptSourceMetadata,
  AppAction,
  AppConfig,
  AppController,
  AppErrorCode,
  AppErrorState,
  AppPhase,
  AppState,
  AsyncDisposable,
  AudioPlaybackEvent,
  AudioResourceCounts,
  CalibrationInvalidationReason,
  ContentRejectionCode,
  ContentWarning,
  ContentWarningCode,
  CreateLocationInitializer,
  CreateManifestService,
  CreateMapPanel,
  CreateSpatialAudioPlayer,
  CreateXRSessionController,
  Disposable,
  GeoFrame,
  GeoPlacement,
  GeoResult,
  GetGlobalResourceCounts,
  ImmersiveARSessionInit,
  ImmersiveARSessionMode,
  InitializedLocation,
  InitializeApp,
  LatLon,
  LocationInitializer,
  ManifestLoadResult,
  ManifestService,
  MapDistanceRingModel,
  MapMarkerModel,
  MapMarkerState,
  MapPanel,
  MapPanelAction,
  MapPanelModel,
  MarkerDisabledReason,
  NormalizedManifest,
  NormalizedManifestRecord,
  NormalizedRecording,
  PlaybackEligibility,
  PlaybackSnapshot,
  PlaybackState,
  RecordingManifest,
  RecordingRecord,
  RejectedRecord,
  RuntimeConfig,
  RuntimeResourceCounts,
  SelectionAction,
  SpatialAudioPlayer,
  SpatialAudioPlayerOptions,
  Unsubscribe,
  XRInteractionSurface,
  XRRuntimeEvent,
  XRSessionController,
  XRSessionControllerOptions,
  XRSessionHandle,
  XRStartOperation,
];

function compileContract<T>(): true {
  return true;
}

let shell = initializeBootstrapShell();

afterEach(() => {
  shell.dispose();
  document.body.innerHTML = '<div id="app"></div>';
  shell = initializeBootstrapShell();
});

describe('WP-0 scaffold and frozen contracts', () => {
  test('imports the complete strict contract surface', () => {
    expect(compileContract<ContractSurface>()).toBe(true);
    const sessionMode: ImmersiveARSessionMode = 'immersive-ar';
    const sessionInit: ImmersiveARSessionInit = { optionalFeatures: ['local-floor'] };
    expect(sessionMode).toBe('immersive-ar');
    expect(sessionInit.optionalFeatures).toEqual(['local-floor']);
  });

  test('provides the stable AppError shape', () => {
    const error = new AppError('APP_DISPOSED');
    expect(error).toMatchObject({ name: 'AppError', message: 'APP_DISPOSED', code: 'APP_DISPOSED' });
  });

  test('initializes and disposes the bootstrap shell idempotently', () => {
    expect(initializeBootstrapShell()).toBe(shell);
    expect(shell.root.querySelector('h1')?.textContent).toBe('attune');
    expect(() => initializeBootstrapShell({ ...shell.config, buildCommit: 'different' }))
      .toThrowError(expect.objectContaining({ code: 'CONFIGURATION_CONFLICT' }));
    shell.dispose();
    shell.dispose();
    expect(shell.root.childElementCount).toBe(0);
  });
});
