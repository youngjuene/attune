import * as THREE from 'three';

import { AppError } from '../app/errors';
import type {
  AppErrorCode,
  AudioPlaybackEvent,
  AudioResourceCounts,
  CreateSpatialAudioPlayer,
  NormalizedRecording,
  PlaybackEligibility,
  PlaybackSnapshot,
  SpatialAudioPlayer,
  SpatialAudioPlayerOptions,
  Unsubscribe,
} from '../domain/types';

const SELECTION_FADE_SECONDS = 0.15;
const VOLUME_FADE_SECONDS = 0.05;
const MEDIA_EVENTS = [
  'loadstart',
  'loadedmetadata',
  'canplay',
  'playing',
  'pause',
  'ended',
  'error',
  'abort',
  'stalled',
  'timeupdate',
] as const;

type MediaEventName = (typeof MEDIA_EVENTS)[number];

interface GainRamp {
  from: number;
  to: number;
  startContextTime: number;
  endContextTime: number;
}

interface PendingOperation {
  generation: number;
  resolve: () => void;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteMediaTime(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizedUrl(url: string): string {
  return new URL(url, document.baseURI).href;
}

function classifyPlayRejection(error: unknown): {
  code: AppErrorCode;
  gestureRequired: boolean;
} {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String(error.name)
      : '';

  switch (name) {
    case 'NotAllowedError':
      return { code: 'AUDIO_PLAY_REJECTED', gestureRequired: true };
    case 'NotSupportedError':
      return { code: 'AUDIO_UNSUPPORTED', gestureRequired: false };
    case 'SecurityError':
      return { code: 'AUDIO_CORS', gestureRequired: false };
    case 'AbortError':
      return { code: 'AUDIO_ABORTED', gestureRequired: false };
    default:
      return { code: 'AUDIO_PLAY_REJECTED', gestureRequired: false };
  }
}

function mediaErrorCode(media: HTMLAudioElement): AppErrorCode {
  switch (media.error?.code) {
    case 1:
      return 'AUDIO_ABORTED';
    case 2:
      return 'AUDIO_NETWORK';
    case 3:
      return 'AUDIO_DECODE';
    case 4:
      return 'AUDIO_UNSUPPORTED';
    default:
      return 'AUDIO_DECODE';
  }
}

class SpatialAudioPlayerImplementation implements SpatialAudioPlayer {
  private readonly listener: THREE.AudioListener;
  private readonly positional: THREE.PositionalAudio;
  private readonly sourceObject: THREE.Object3D;
  private readonly media: HTMLAudioElement;
  private readonly context: AudioContext;
  private readonly subscribers = new Set<(event: AudioPlaybackEvent) => void>();
  private readonly mediaHandlers = new Map<MediaEventName, EventListener>();
  private readonly audioLoadTimeoutMs: number;
  private readonly progressIntervalMs: number;
  private readonly ownsListener: boolean;

  private disposed = false;
  private generation = 0;
  private targetRecording: NormalizedRecording | undefined;
  private targetPosition: THREE.Vector3 | undefined;
  private loadedRecordingId: string | undefined;
  private appliedPosition: THREE.Vector3 | undefined;
  private desiredPlaying = false;
  private mediaConfirmed = false;
  private contextReady = false;
  private playbackConfirmed = false;
  private audioGestureRequired = false;
  private masterGain = 0.7;
  private mixGain = 1;
  private authoritativeDuration: number | undefined;
  private currentSnapshot: PlaybackSnapshot = { state: 'empty', currentTimeSec: 0 };
  private activeGainRamp: GainRamp | undefined;
  private settledGain = 0;
  private loadWatchdog: ReturnType<typeof setTimeout> | undefined;
  private fadeCompletionTimer: ReturnType<typeof setTimeout> | undefined;
  private resumePromise: Promise<void> | undefined;
  private pendingOperation: PendingOperation | undefined;
  private nextProgressAtMs = 0;

  public constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly scene: THREE.Scene,
    options: SpatialAudioPlayerOptions,
  ) {
    if (
      !Number.isInteger(options.audioLoadTimeoutMs) ||
      options.audioLoadTimeoutMs < 1_000 ||
      options.audioLoadTimeoutMs > 120_000 ||
      !Number.isInteger(options.progressUpdateHz) ||
      options.progressUpdateHz < 1 ||
      options.progressUpdateHz > 10
    ) {
      throw new AppError('AUDIO_INITIALIZATION_FAILED');
    }

    this.audioLoadTimeoutMs = options.audioLoadTimeoutMs;
    this.progressIntervalMs = 1_000 / options.progressUpdateHz;
    this.ownsListener = options.sharedListener === undefined;

    let listener: THREE.AudioListener | undefined;
    let positional: THREE.PositionalAudio | undefined;
    let sourceObject: THREE.Object3D | undefined;
    let media: HTMLAudioElement | undefined;

    try {
      media = options.mediaElement ?? new Audio();
      media.preload = 'metadata';
      media.crossOrigin = 'anonymous';

      listener = options.sharedListener ?? new THREE.AudioListener();
      positional = new THREE.PositionalAudio(listener);
      sourceObject = new THREE.Object3D();

      if (this.ownsListener) {
        this.camera.add(listener);
      }
      sourceObject.add(positional);
      this.scene.add(sourceObject);

      positional.setMediaElementSource(media);
      positional.panner.panningModel = 'HRTF';
      positional.setDistanceModel('inverse');
      positional.setRefDistance(3);
      positional.setRolloffFactor(0);
      positional.setDirectionalCone(360, 360, 1);
      listener.gain.gain.setValueAtTime(1, listener.context.currentTime);
      positional.gain.gain.setValueAtTime(0, listener.context.currentTime);
    } catch (error) {
      if (positional !== undefined) {
        sourceObject?.remove(positional);
        positional.disconnect();
        positional.gain.disconnect();
      }
      if (listener !== undefined && this.ownsListener) {
        this.camera.remove(listener);
        listener.gain.disconnect();
      }
      if (sourceObject !== undefined) {
        this.scene.remove(sourceObject);
      }
      throw new AppError('AUDIO_INITIALIZATION_FAILED', { cause: error });
    }

    this.media = media;
    this.listener = listener;
    this.positional = positional;
    this.sourceObject = sourceObject;
    this.context = listener.context;
    this.replaceMediaHandlers(this.generation);
  }

  public classifyMimeType(mimeType?: string): PlaybackEligibility {
    this.assertLive();
    if (mimeType === undefined) {
      return 'probe-at-play';
    }

    try {
      const result = this.media.canPlayType(mimeType.trim());
      return result === 'maybe' || result === 'probably' ? 'eligible' : 'unsupported';
    } catch {
      return 'probe-at-play';
    }
  }

  public resumeContext(): Promise<void> {
    this.assertLive();
    if (this.context.state === 'running') {
      return Promise.resolve();
    }
    if (this.resumePromise !== undefined) {
      return this.resumePromise;
    }

    let resumeResult: Promise<void>;
    try {
      resumeResult = this.context.resume();
    } catch (error) {
      return Promise.reject(new AppError('AUDIO_CONTEXT_SUSPENDED', { cause: error }));
    }

    this.resumePromise = resumeResult
      .then(() => {
        if (this.context.state !== 'running') {
          throw new AppError('AUDIO_CONTEXT_SUSPENDED');
        }
      })
      .catch((error: unknown) => {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError('AUDIO_CONTEXT_SUSPENDED', { cause: error });
      })
      .finally(() => {
        this.resumePromise = undefined;
      });
    return this.resumePromise;
  }

  public select(
    generation: number,
    recording: NormalizedRecording,
    position: THREE.Vector3,
  ): Promise<void> {
    this.assertLive();
    const heldGain = this.adoptGeneration(generation);
    if (heldGain === undefined) {
      return Promise.resolve();
    }

    this.targetRecording = recording;
    this.targetPosition = position.clone();
    this.installOperationHandlers(generation);
    this.desiredPlaying = true;
    this.resetConfirmations();
    this.authoritativeDuration = undefined;
    this.nextProgressAtMs = 0;
    this.emitSnapshot('loading', 0);
    if (!this.isCurrent(generation)) {
      return Promise.resolve();
    }

    const operation = this.beginPendingOperation(generation);
    const oldSourceIsAudible =
      this.loadedRecordingId !== undefined && !this.media.paused && heldGain > 0;

    if (oldSourceIsAudible) {
      this.scheduleGainRamp(heldGain, 0, SELECTION_FADE_SECONDS);
      this.scheduleFadeCompletion(generation, SELECTION_FADE_SECONDS, () => {
        this.assignTargetAndAttemptPlayback(generation, 0);
      });
    } else {
      this.assignTargetAndAttemptPlayback(generation, heldGain);
    }

    return operation;
  }

  public play(generation: number): Promise<void> {
    this.assertLive();
    if (this.targetRecording === undefined) {
      return Promise.resolve();
    }
    const heldGain = this.adoptGeneration(generation);
    if (heldGain === undefined) {
      return Promise.resolve();
    }

    this.installOperationHandlers(generation);
    this.desiredPlaying = true;
    this.resetConfirmations();
    const previousState = this.currentSnapshot.state;
    if (
      this.loadedRecordingId === this.targetRecording.id &&
      (previousState === 'stopped' || previousState === 'ended')
    ) {
      this.trySetCurrentTime(0);
    }
    this.emitSnapshot('loading', this.loadedRecordingId === this.targetRecording.id
      ? finiteMediaTime(this.media.currentTime)
      : 0);
    if (!this.isCurrent(generation)) {
      return Promise.resolve();
    }
    const operation = this.beginPendingOperation(generation);

    if (this.loadedRecordingId !== this.targetRecording.id) {
      this.assignTargetAndAttemptPlayback(generation, heldGain);
      return operation;
    }

    this.cancelLoadWatchdog();
    this.startLoadWatchdog(generation, normalizedUrl(this.targetRecording.resolvedAudioUrl));
    this.attemptPlayback(generation, normalizedUrl(this.targetRecording.resolvedAudioUrl));
    return operation;
  }

  public pause(generation: number, reason: 'user' | 'lifecycle'): void {
    this.assertLive();
    if (this.targetRecording === undefined) {
      return;
    }
    const heldGain = this.adoptGeneration(generation);
    if (heldGain === undefined) {
      return;
    }

    this.installOperationHandlers(generation);
    this.desiredPlaying = false;
    this.resetConfirmations();
    this.resolvePendingOperation();

    if (this.loadedRecordingId !== this.targetRecording.id) {
      this.resetAssignedSource(heldGain);
      this.applyTargetPosition();
      this.replaceMediaHandlers(generation);
      this.emitSnapshot('paused', 0);
      return;
    }

    if (reason === 'user' && !this.media.paused && heldGain > 0) {
      this.scheduleGainRamp(heldGain, 0, SELECTION_FADE_SECONDS);
      this.scheduleFadeCompletion(generation, SELECTION_FADE_SECONDS, () => {
        this.media.pause();
        this.emitSnapshot('paused', finiteMediaTime(this.media.currentTime));
      });
      return;
    }

    this.holdAndZeroGain(heldGain);
    this.media.pause();
    this.emitSnapshot('paused', finiteMediaTime(this.media.currentTime));
  }

  public stop(generation: number): void {
    this.assertLive();
    if (this.targetRecording === undefined) {
      return;
    }
    const heldGain = this.adoptGeneration(generation);
    if (heldGain === undefined) {
      return;
    }

    this.installOperationHandlers(generation);
    this.desiredPlaying = false;
    this.resetConfirmations();
    this.resolvePendingOperation();

    if (this.loadedRecordingId !== this.targetRecording.id) {
      this.resetAssignedSource(heldGain);
      this.applyTargetPosition();
      this.replaceMediaHandlers(generation);
    } else {
      this.holdAndZeroGain(heldGain);
      this.media.pause();
      this.trySetCurrentTime(0);
    }
    this.emitSnapshot('stopped', 0);
  }

  public setPosition(position: THREE.Vector3): void {
    this.assertLive();
    this.targetPosition = position.clone();
    if (
      this.targetRecording !== undefined &&
      this.loadedRecordingId === this.targetRecording.id
    ) {
      this.sourceObject.position.copy(this.targetPosition);
      this.appliedPosition = this.targetPosition.clone();
    }
  }

  public setMasterGain(value: number): void {
    this.assertLive();
    if (!Number.isFinite(value)) {
      return;
    }
    this.masterGain = clamp(value, 0, 1);
    this.retargetCompositeGain();
  }

  public setMixGain(value: number): void {
    this.assertLive();
    if (!Number.isFinite(value)) {
      return;
    }
    this.mixGain = clamp(value, 0, 1);
    this.retargetCompositeGain();
  }

  public snapshot(): PlaybackSnapshot {
    this.assertLive();
    return { ...this.currentSnapshot };
  }

  public subscribe(listener: (event: AudioPlaybackEvent) => void): Unsubscribe {
    this.assertLive();
    this.subscribers.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this.subscribers.delete(listener);
    };
  }

  public resourceCounts(): AudioResourceCounts {
    this.assertLive();
    return {
      mediaElements: 1,
      mediaElementSourceNodes: 1,
      audioSourceObjects: 1,
      listeners: this.ownsListener ? 1 : 0,
      positionalAudioObjects: 1,
      panners: 1,
      registeredMediaHandlers: this.mediaHandlers.size === 10 ? 10 : 0,
      activeLoadWatchdogs: this.loadWatchdog === undefined ? 0 : 1,
      activeFadeCompletionTimers: this.fadeCompletionTimer === undefined ? 0 : 1,
    };
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.generation += 1;
    this.desiredPlaying = false;
    this.resolvePendingOperation();

    if (this.loadedRecordingId !== undefined || this.media.hasAttribute('src')) {
      this.resetAssignedSource();
    } else {
      this.cancelTimers();
      this.holdAndZeroGain();
      this.removeMediaHandlers();
      this.media.pause();
      this.media.removeAttribute('src');
      this.media.load();
    }

    this.sourceObject.remove(this.positional);
    this.scene.remove(this.sourceObject);
    if (this.ownsListener) {
      this.camera.remove(this.listener);
    }
    this.positional.disconnect();
    this.positional.gain.disconnect();
    if (this.ownsListener) {
      this.listener.gain.disconnect();
    }
    this.subscribers.clear();
    this.targetRecording = undefined;
    this.targetPosition = undefined;
    this.appliedPosition = undefined;
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new AppError('APP_DISPOSED');
    }
  }

  private adoptGeneration(generation: number): number | undefined {
    if (!Number.isSafeInteger(generation) || generation <= this.generation) {
      return undefined;
    }
    this.resolvePendingOperation();
    this.cancelTimers();
    const heldGain = this.cancelGainAutomation();
    this.removeMediaHandlers();
    this.generation = generation;
    return heldGain;
  }

  private installOperationHandlers(generation: number): void {
    const expectedUrl =
      this.targetRecording !== undefined &&
      this.loadedRecordingId === this.targetRecording.id
        ? normalizedUrl(this.targetRecording.resolvedAudioUrl)
        : undefined;
    this.replaceMediaHandlers(generation, expectedUrl);
  }

  private beginPendingOperation(generation: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pendingOperation = { generation, resolve };
    });
  }

  private resolvePendingOperation(): void {
    const pending = this.pendingOperation;
    this.pendingOperation = undefined;
    pending?.resolve();
  }

  private resolveCurrentOperation(generation: number): void {
    if (this.pendingOperation?.generation !== generation) {
      return;
    }
    this.resolvePendingOperation();
  }

  private resetConfirmations(): void {
    this.mediaConfirmed = false;
    this.contextReady = false;
    this.playbackConfirmed = false;
    this.audioGestureRequired = false;
  }

  private assignTargetAndAttemptPlayback(generation: number, heldGain: number): void {
    if (!this.isCurrent(generation) || this.targetRecording === undefined) {
      return;
    }

    if (this.loadedRecordingId !== undefined || this.media.hasAttribute('src')) {
      this.resetAssignedSource(heldGain);
    } else {
      this.cancelTimers();
      this.holdAndZeroGain(heldGain);
      this.replaceMediaHandlers(generation);
    }
    if (!this.isCurrent(generation) || this.targetRecording === undefined) {
      return;
    }

    this.applyTargetPosition();
    const expectedUrl = normalizedUrl(this.targetRecording.resolvedAudioUrl);
    this.replaceMediaHandlers(generation, expectedUrl);
    this.media.src = expectedUrl;
    this.media.load();
    this.trySetCurrentTime(0);
    this.loadedRecordingId = this.targetRecording.id;
    this.startLoadWatchdog(generation, expectedUrl);
    this.emitSnapshot('loading', 0);
    if (!this.isCurrentTarget(generation, expectedUrl)) {
      return;
    }
    this.attemptPlayback(generation, expectedUrl);
  }

  private applyTargetPosition(): void {
    if (this.targetPosition === undefined) {
      return;
    }
    this.sourceObject.position.copy(this.targetPosition);
    this.appliedPosition = this.targetPosition.clone();
  }

  private attemptPlayback(generation: number, expectedUrl: string): void {
    if (!this.isCurrentTarget(generation, expectedUrl)) {
      return;
    }

    const contextPromise = this.resumeContext();
    let playPromise: Promise<void>;
    try {
      playPromise = this.media.play();
    } catch (error) {
      playPromise = Promise.reject(error);
    }

    void contextPromise.then(
      () => {
        if (!this.isCurrentTarget(generation, expectedUrl)) {
          return;
        }
        if (!this.desiredPlaying) {
          this.media.pause();
          return;
        }
        this.contextReady = true;
        this.confirmPlaybackIfReady(generation, expectedUrl);
      },
      (error: unknown) => {
        if (!this.isCurrentTarget(generation, expectedUrl)) {
          return;
        }
        if (!this.desiredPlaying) {
          return;
        }
        this.handleGestureRequired(generation, 'AUDIO_CONTEXT_SUSPENDED', error);
      },
    );

    void playPromise.then(
      () => {
        if (!this.isCurrentTarget(generation, expectedUrl)) {
          return;
        }
        if (!this.desiredPlaying) {
          this.media.pause();
          return;
        }
        if (this.media.paused) {
          return;
        }
        this.mediaConfirmed = true;
        this.confirmPlaybackIfReady(generation, expectedUrl);
      },
      (error: unknown) => {
        if (!this.isCurrentTarget(generation, expectedUrl)) {
          return;
        }
        if (!this.desiredPlaying) {
          return;
        }
        const rejection = classifyPlayRejection(error);
        if (rejection.gestureRequired) {
          this.handleGestureRequired(generation, 'AUDIO_PLAY_REJECTED', error);
        } else {
          this.fail(generation, rejection.code, error);
        }
      },
    );
  }

  private confirmPlaybackIfReady(generation: number, expectedUrl: string): void {
    if (
      !this.isCurrentTarget(generation, expectedUrl) ||
      !this.desiredPlaying ||
      !this.contextReady ||
      !this.mediaConfirmed ||
      this.playbackConfirmed ||
      this.targetRecording === undefined ||
      this.loadedRecordingId !== this.targetRecording.id
    ) {
      return;
    }

    this.playbackConfirmed = true;
    this.audioGestureRequired = false;
    this.cancelLoadWatchdog();
    const heldGain = this.cancelGainAutomation();
    this.scheduleGainRamp(heldGain, this.effectiveGain(), SELECTION_FADE_SECONDS);
    this.scheduleFadeCompletion(generation, SELECTION_FADE_SECONDS, () => {
      this.activeGainRamp = undefined;
    });
    this.resolveCurrentOperation(generation);
    this.emitSnapshot('playing', finiteMediaTime(this.media.currentTime));
  }

  private handleGestureRequired(
    generation: number,
    code: 'AUDIO_PLAY_REJECTED' | 'AUDIO_CONTEXT_SUSPENDED',
    cause: unknown,
  ): void {
    if (!this.isCurrent(generation)) {
      return;
    }
    this.desiredPlaying = false;
    this.audioGestureRequired = true;
    this.cancelTimers();
    this.holdAndZeroGain();
    this.media.pause();
    this.emitSnapshot('paused', finiteMediaTime(this.media.currentTime), code);
    this.resolveCurrentOperation(generation);
    void cause;
  }

  private fail(generation: number, code: AppErrorCode, cause?: unknown): void {
    if (!this.isCurrent(generation)) {
      return;
    }
    this.desiredPlaying = false;
    this.cancelTimers();
    this.holdAndZeroGain();
    this.media.pause();
    this.emitSnapshot('error', finiteMediaTime(this.media.currentTime), code);
    this.resolveCurrentOperation(generation);
    void cause;
  }

  /**
   * Reschedule the composite gain from the logically held value after any gain
   * input (master or mix) changes, preserving an in-flight fade's destination
   * intent and completion time exactly as PRD gain-automation invariants
   * require.
   */
  private retargetCompositeGain(): void {
    const ramp = this.activeGainRamp;
    const now = this.context.currentTime;
    const heldGain = this.heldGain(now);
    this.positional.gain.gain.cancelScheduledValues(now);
    this.positional.gain.gain.setValueAtTime(heldGain, now);
    this.activeGainRamp = undefined;
    this.settledGain = heldGain;

    if (ramp !== undefined && ramp.endContextTime > now) {
      const destination = ramp.to === 0 ? 0 : this.effectiveGain();
      this.scheduleGainRamp(heldGain, destination, ramp.endContextTime - now);
      return;
    }

    if (this.desiredPlaying && this.playbackConfirmed) {
      this.scheduleGainRamp(heldGain, this.effectiveGain(), VOLUME_FADE_SECONDS);
    } else {
      this.positional.gain.gain.setValueAtTime(0, this.context.currentTime);
      this.settledGain = 0;
    }
  }

  private effectiveGain(): number {
    const gainDb = clamp(this.targetRecording?.gainDb ?? 0, -24, 6);
    return clamp(clamp(this.masterGain, 0, 1) * this.mixGain * 10 ** (gainDb / 20), 0, 1);
  }

  private heldGain(now = this.context.currentTime): number {
    const ramp = this.activeGainRamp;
    if (ramp === undefined) {
      return this.settledGain;
    }
    if (now <= ramp.startContextTime) {
      return ramp.from;
    }
    if (now >= ramp.endContextTime) {
      return ramp.to;
    }
    const progress =
      (now - ramp.startContextTime) / (ramp.endContextTime - ramp.startContextTime);
    return ramp.from + (ramp.to - ramp.from) * progress;
  }

  private cancelGainAutomation(): number {
    const now = this.context.currentTime;
    const held = this.heldGain(now);
    this.positional.gain.gain.cancelScheduledValues(now);
    this.positional.gain.gain.setValueAtTime(held, now);
    this.activeGainRamp = undefined;
    this.settledGain = held;
    return held;
  }

  private holdAndZeroGain(knownHeldGain?: number): void {
    const now = this.context.currentTime;
    const held = knownHeldGain ?? this.heldGain(now);
    this.positional.gain.gain.cancelScheduledValues(now);
    this.positional.gain.gain.setValueAtTime(held, now);
    this.positional.gain.gain.setValueAtTime(0, now);
    this.activeGainRamp = undefined;
    this.settledGain = 0;
  }

  private scheduleGainRamp(from: number, to: number, durationSeconds: number): void {
    const now = this.context.currentTime;
    this.positional.gain.gain.cancelScheduledValues(now);
    this.positional.gain.gain.setValueAtTime(from, now);
    this.positional.gain.gain.linearRampToValueAtTime(to, now + durationSeconds);
    this.settledGain = to;
    this.activeGainRamp = {
      from,
      to,
      startContextTime: now,
      endContextTime: now + durationSeconds,
    };
  }

  private scheduleFadeCompletion(
    generation: number,
    durationSeconds: number,
    callback: () => void,
  ): void {
    this.cancelFadeCompletion();
    this.fadeCompletionTimer = setTimeout(() => {
      this.fadeCompletionTimer = undefined;
      if (!this.isCurrent(generation)) {
        return;
      }
      this.activeGainRamp = undefined;
      callback();
    }, durationSeconds * 1_000);
  }

  private startLoadWatchdog(generation: number, expectedUrl: string): void {
    this.cancelLoadWatchdog();
    this.loadWatchdog = setTimeout(() => {
      this.loadWatchdog = undefined;
      if (!this.isCurrentTarget(generation, expectedUrl)) {
        return;
      }
      this.fail(generation, 'AUDIO_NETWORK');
    }, this.audioLoadTimeoutMs);
  }

  private cancelLoadWatchdog(): void {
    if (this.loadWatchdog === undefined) {
      return;
    }
    clearTimeout(this.loadWatchdog);
    this.loadWatchdog = undefined;
  }

  private cancelFadeCompletion(): void {
    if (this.fadeCompletionTimer === undefined) {
      return;
    }
    clearTimeout(this.fadeCompletionTimer);
    this.fadeCompletionTimer = undefined;
  }

  private cancelTimers(): void {
    this.cancelLoadWatchdog();
    this.cancelFadeCompletion();
  }

  private resetAssignedSource(knownHeldGain?: number): void {
    this.removeMediaHandlers();
    this.cancelTimers();
    this.holdAndZeroGain(knownHeldGain);
    this.media.pause();
    this.media.removeAttribute('src');
    this.media.load();
    this.loadedRecordingId = undefined;
  }

  private replaceMediaHandlers(generation: number, expectedAssignedUrl?: string): void {
    this.removeMediaHandlers();
    for (const name of MEDIA_EVENTS) {
      const handler: EventListener = () => {
        this.handleMediaEvent(name, generation, expectedAssignedUrl);
      };
      this.media.addEventListener(name, handler);
      this.mediaHandlers.set(name, handler);
    }
  }

  private removeMediaHandlers(): void {
    for (const [name, handler] of this.mediaHandlers) {
      this.media.removeEventListener(name, handler);
    }
    this.mediaHandlers.clear();
  }

  private handleMediaEvent(
    eventName: MediaEventName,
    generation: number,
    expectedAssignedUrl?: string,
  ): void {
    if (
      expectedAssignedUrl === undefined ||
      !this.isCurrentTarget(generation, expectedAssignedUrl)
    ) {
      return;
    }

    switch (eventName) {
      case 'loadedmetadata': {
        const duration = this.media.duration;
        if (Number.isFinite(duration) && duration >= 0) {
          this.authoritativeDuration = duration;
          this.emitSnapshot(
            this.currentSnapshot.state,
            finiteMediaTime(this.media.currentTime),
            this.currentSnapshot.errorCode,
          );
        }
        break;
      }
      case 'timeupdate': {
        const now = performance.now();
        if (now < this.nextProgressAtMs) {
          return;
        }
        this.nextProgressAtMs = now + this.progressIntervalMs;
        this.emitSnapshot(
          this.currentSnapshot.state,
          finiteMediaTime(this.media.currentTime),
          this.currentSnapshot.errorCode,
        );
        break;
      }
      case 'ended':
        if (
          this.media.ended &&
          this.targetRecording !== undefined &&
          this.loadedRecordingId === this.targetRecording.id
        ) {
          this.desiredPlaying = false;
          this.cancelTimers();
          this.holdAndZeroGain();
          this.emitSnapshot('ended', finiteMediaTime(this.media.currentTime));
          this.resolveCurrentOperation(generation);
        }
        break;
      case 'error':
        this.fail(generation, mediaErrorCode(this.media));
        break;
      case 'abort':
        this.fail(generation, 'AUDIO_ABORTED');
        break;
      case 'loadstart':
      case 'canplay':
      case 'playing':
      case 'pause':
      case 'stalled':
        break;
    }
  }

  private emitSnapshot(
    state: PlaybackSnapshot['state'],
    currentTimeSec: number,
    errorCode?: AppErrorCode,
  ): void {
    const target = this.targetRecording;
    if (target === undefined) {
      this.currentSnapshot = { state: 'empty', currentTimeSec: 0 };
    } else {
      const duration = this.authoritativeDuration ?? target.durationSec;
      this.currentSnapshot = {
        state,
        recordingId: target.id,
        ...(this.loadedRecordingId === undefined
          ? {}
          : { loadedRecordingId: this.loadedRecordingId }),
        currentTimeSec,
        ...(duration === undefined ? {} : { durationSec: duration }),
        ...(errorCode === undefined ? {} : { errorCode }),
      };
    }

    const event: AudioPlaybackEvent = {
      generation: this.generation,
      snapshot: { ...this.currentSnapshot },
    };
    for (const subscriber of [...this.subscribers]) {
      if (!this.subscribers.has(subscriber) || this.disposed) {
        continue;
      }
      try {
        subscriber(event);
      } catch {
        console.error('INTERNAL_LISTENER_ERROR');
      }
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private isCurrentTarget(generation: number, expectedUrl: string): boolean {
    return (
      this.isCurrent(generation) &&
      this.targetRecording !== undefined &&
      this.loadedRecordingId === this.targetRecording.id &&
      this.media.src === expectedUrl
    );
  }

  private trySetCurrentTime(value: number): void {
    try {
      this.media.currentTime = value;
    } catch {
      // Some browsers reject seeking before metadata. The stable snapshot still exposes zero.
    }
  }
}

export const createSpatialAudioPlayer: CreateSpatialAudioPlayer = (
  camera,
  scene,
  options,
) => new SpatialAudioPlayerImplementation(camera, scene, options);
