import * as THREE from 'three';

import { AppError } from '../app/errors';
import type {
  AudioPlaybackEvent,
  CreateSoundscapePlayer,
  NormalizedRecording,
  PlaybackEligibility,
  PlaybackSnapshot,
  SoundscapeEvent,
  SoundscapePlayer,
  SoundscapePlayerOptions,
  SoundscapeResourceCounts,
  SpatialAudioPlayer,
  Unsubscribe,
} from '../domain/types';
import { ensembleTrim } from './mixGain';
import { createSpatialAudioPlayer } from './SpatialAudioPlayer';

const EMPTY_SNAPSHOT: Readonly<PlaybackSnapshot> = Object.freeze({
  state: 'empty' as const,
  currentTimeSec: 0,
});

interface UnitSlot {
  readonly unit: SpatialAudioPlayer;
  recordingId: string | undefined;
  /**
   * Monotonic activation stamp for evict-oldest. Stale stamps on freed slots
   * are harmless: free slots are always preferred before eviction scans.
   */
  activatedAt: number;
  /** Stored distance gain for the assigned source; composed with the trim. */
  distanceGain: number;
}

/**
 * Coordinator over a fixed pool of SpatialAudioPlayer units (ADR 0003). The
 * pool is allocated once at construction — units are recycled by select(),
 * never created per selection, honoring the once-per-element rule of
 * createMediaElementSource — and every unit shares this coordinator's one
 * listener on the page-global AudioContext.
 */
class SoundscapePlayerImplementation implements SoundscapePlayer {
  private readonly listener: THREE.AudioListener;
  private readonly slots: UnitSlot[] = [];
  private readonly unitUnsubscribes: Unsubscribe[] = [];
  private readonly subscribers = new Set<(event: SoundscapeEvent) => void>();
  private activationSequence = 0;
  private disposed = false;

  public constructor(
    private readonly camera: THREE.PerspectiveCamera,
    scene: THREE.Scene,
    options: SoundscapePlayerOptions,
  ) {
    const cap = options.maxSimultaneousSources;
    if (!Number.isInteger(cap) || cap < 1 || cap > 8) {
      throw new AppError('AUDIO_INITIALIZATION_FAILED');
    }

    this.listener = new THREE.AudioListener();
    this.camera.add(this.listener);
    // Safety limiter between the shared listener's gain and the destination
    // (PRD v1.7 delta D-3): summed simultaneous sources must not clip.
    const limiter = this.listener.context.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    this.listener.setFilter(limiter);
    const createUnit = options.createUnit ?? createSpatialAudioPlayer;

    try {
      for (let index = 0; index < cap; index += 1) {
        const mediaElement = options.mediaElements?.[index];
        const unit = createUnit(camera, scene, {
          audioLoadTimeoutMs: options.audioLoadTimeoutMs,
          progressUpdateHz: options.progressUpdateHz,
          sharedListener: this.listener,
          ...(mediaElement === undefined ? {} : { mediaElement }),
        });
        const slot: UnitSlot = { unit, recordingId: undefined, activatedAt: 0, distanceGain: 1 };
        this.slots.push(slot);
        this.unitUnsubscribes.push(unit.subscribe((event) => this.forwardUnitEvent(slot, event)));
      }
    } catch (cause) {
      for (const slot of this.slots) {
        try {
          slot.unit.dispose();
        } catch {
          // Best-effort cleanup; the construction failure below is the error that matters.
        }
      }
      this.listener.removeFilter();
      this.camera.remove(this.listener);
      this.listener.gain.disconnect();
      throw cause;
    }
  }

  public classifyMimeType(mimeType?: string): PlaybackEligibility {
    this.assertLive();
    return this.firstUnit().classifyMimeType(mimeType);
  }

  public resumeContext(): Promise<void> {
    this.assertLive();
    // All units share the page-global context; resuming through any one suffices.
    return this.firstUnit().resumeContext();
  }

  public activate(
    generation: number,
    recording: NormalizedRecording,
    position: THREE.Vector3,
  ): Promise<void> {
    this.assertLive();
    const slot =
      this.slots.find((candidate) => candidate.recordingId === recording.id)
      ?? this.slots.find((candidate) => candidate.recordingId === undefined)
      ?? this.slots.reduce((oldest, candidate) =>
        candidate.activatedAt < oldest.activatedAt ? candidate : oldest,
      );
    slot.recordingId = recording.id;
    slot.activatedAt = ++this.activationSequence;
    slot.distanceGain = 1;
    this.recomputeMixGains();
    return slot.unit.select(generation, recording, position);
  }

  public deactivate(generation: number, recordingId: string): void {
    this.assertLive();
    const slot = this.slotFor(recordingId);
    if (slot === undefined) {
      return;
    }
    slot.unit.stop(generation);
    slot.recordingId = undefined;
    slot.distanceGain = 1;
    this.recomputeMixGains();
  }

  public playById(generation: number, recordingId: string): Promise<void> {
    this.assertLive();
    return this.slotFor(recordingId)?.unit.play(generation) ?? Promise.resolve();
  }

  public pauseById(generation: number, recordingId: string, reason: 'user' | 'lifecycle'): void {
    this.assertLive();
    this.slotFor(recordingId)?.unit.pause(generation, reason);
  }

  public stopById(generation: number, recordingId: string): void {
    this.assertLive();
    this.slotFor(recordingId)?.unit.stop(generation);
  }

  public pauseAll(generation: number, reason: 'user' | 'lifecycle'): void {
    this.assertLive();
    for (const slot of this.assignedSlots()) {
      slot.unit.pause(generation, reason);
    }
  }

  public stopAll(generation: number): void {
    this.assertLive();
    for (const slot of this.assignedSlots()) {
      slot.unit.stop(generation);
    }
  }

  public setPosition(recordingId: string, position: THREE.Vector3): void {
    this.assertLive();
    this.slotFor(recordingId)?.unit.setPosition(position);
  }

  public setMasterGain(value: number): void {
    this.assertLive();
    for (const slot of this.slots) {
      slot.unit.setMasterGain(value);
    }
  }

  public setDistanceGain(recordingId: string, value: number): void {
    this.assertLive();
    if (!Number.isFinite(value)) {
      return;
    }
    const slot = this.slotFor(recordingId);
    if (slot === undefined) {
      return;
    }
    slot.distanceGain = Math.min(1, Math.max(0, value));
    this.recomputeMixGains();
  }

  /** Compose stored distance gains with the equal-power trim for every assigned unit. */
  private recomputeMixGains(): void {
    const assigned = this.assignedSlots();
    const trim = ensembleTrim(assigned.length);
    for (const slot of assigned) {
      slot.unit.setMixGain(slot.distanceGain * trim);
    }
  }

  public activeRecordingIds(): readonly string[] {
    this.assertLive();
    return this.assignedSlots()
      .slice()
      .sort((left, right) => left.activatedAt - right.activatedAt)
      .map((slot) => slot.recordingId as string);
  }

  public snapshotById(recordingId: string): PlaybackSnapshot {
    this.assertLive();
    const slot = this.slotFor(recordingId);
    return slot === undefined ? { ...EMPTY_SNAPSHOT } : slot.unit.snapshot();
  }

  public subscribe(listener: (event: SoundscapeEvent) => void): Unsubscribe {
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

  public resourceCounts(): SoundscapeResourceCounts {
    this.assertLive();
    const totals: SoundscapeResourceCounts = {
      mediaElements: 0,
      mediaElementSourceNodes: 0,
      audioSourceObjects: 0,
      listeners: 1,
      positionalAudioObjects: 0,
      panners: 0,
      registeredMediaHandlers: 0,
      activeLoadWatchdogs: 0,
      activeFadeCompletionTimers: 0,
    };
    for (const slot of this.slots) {
      const counts = slot.unit.resourceCounts();
      totals.mediaElements += counts.mediaElements;
      totals.mediaElementSourceNodes += counts.mediaElementSourceNodes;
      totals.audioSourceObjects += counts.audioSourceObjects;
      totals.listeners += counts.listeners;
      totals.positionalAudioObjects += counts.positionalAudioObjects;
      totals.panners += counts.panners;
      totals.registeredMediaHandlers += counts.registeredMediaHandlers;
      totals.activeLoadWatchdogs += counts.activeLoadWatchdogs;
      totals.activeFadeCompletionTimers += counts.activeFadeCompletionTimers;
    }
    return totals;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const unsubscribe of this.unitUnsubscribes) {
      unsubscribe();
    }
    this.unitUnsubscribes.length = 0;
    for (const slot of this.slots) {
      slot.unit.dispose();
      slot.recordingId = undefined;
    }
    this.listener.removeFilter();
    this.camera.remove(this.listener);
    this.listener.gain.disconnect();
    this.subscribers.clear();
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new AppError('APP_DISPOSED');
    }
  }

  private firstUnit(): SpatialAudioPlayer {
    return (this.slots[0] as UnitSlot).unit;
  }

  private slotFor(recordingId: string): UnitSlot | undefined {
    return this.slots.find((slot) => slot.recordingId === recordingId);
  }

  private assignedSlots(): UnitSlot[] {
    return this.slots.filter((slot) => slot.recordingId !== undefined);
  }

  private forwardUnitEvent(slot: UnitSlot, event: AudioPlaybackEvent): void {
    // The unit's snapshot names its target recording authoritatively (it may
    // still reference an id this coordinator has since unassigned, e.g. a
    // final 'stopped' after deactivate); fall back to the slot assignment for
    // snapshots that carry no id, and drop unattributable 'empty' resets.
    const recordingId = event.snapshot.recordingId ?? slot.recordingId;
    if (recordingId === undefined || this.disposed) {
      return;
    }
    const forwarded: SoundscapeEvent = {
      generation: event.generation,
      recordingId,
      snapshot: { ...event.snapshot },
    };
    for (const subscriber of [...this.subscribers]) {
      if (!this.subscribers.has(subscriber) || this.disposed) {
        continue;
      }
      try {
        subscriber(forwarded);
      } catch {
        console.error('INTERNAL_LISTENER_ERROR');
      }
    }
  }
}

export const createSoundscapePlayer: CreateSoundscapePlayer = (camera, scene, options) =>
  new SoundscapePlayerImplementation(camera, scene, options);
