import { beforeEach, describe, expect, it, vi } from 'vitest';

const threeAudioHarness = vi.hoisted(() => ({
  listeners: [] as unknown[],
  positionals: [] as unknown[],
}));

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();

  class FakeAudioParam {
    public value = 0.93;
    public readonly commands: Array<readonly [string, number, number]> = [];

    public cancelScheduledValues(time: number): void {
      this.commands.push(['cancel', this.value, time]);
    }

    public setValueAtTime(value: number, time: number): void {
      this.commands.push(['set', value, time]);
    }

    public linearRampToValueAtTime(value: number, time: number): void {
      this.commands.push(['linear', value, time]);
    }
  }

  class FakeGainNode {
    public readonly gain = new FakeAudioParam();
    public disconnectCalls = 0;

    public disconnect(): void {
      this.disconnectCalls += 1;
    }
  }

  class FakeAudioContext {
    public currentTime = 0;
    public state: AudioContextState = 'running';
    public resumeCalls = 0;

    public resume(): Promise<void> {
      this.resumeCalls += 1;
      this.state = 'running';
      return Promise.resolve();
    }

    public createDynamicsCompressor(): DynamicsCompressorNode {
      return {
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 0 },
        attack: { value: 0 },
        release: { value: 0 },
        disconnect: () => undefined,
      } as unknown as DynamicsCompressorNode;
    }
  }

  class FakeAudioListener extends actual.Object3D {
    public readonly context = new FakeAudioContext();
    public readonly gain = new FakeGainNode();
    public filter: unknown = null;

    public constructor() {
      super();
      threeAudioHarness.listeners.push(this);
    }

    public setFilter(filter: unknown): this {
      this.filter = filter;
      return this;
    }

    public removeFilter(): this {
      this.filter = null;
      return this;
    }
  }

  class FakePositionalAudio extends actual.Object3D {
    public readonly gain = new FakeGainNode();
    public readonly panner = { panningModel: 'equalpower' as PanningModelType };

    public constructor(_listener: FakeAudioListener) {
      super();
      threeAudioHarness.positionals.push(this);
    }

    public setMediaElementSource(_media: HTMLMediaElement): this {
      return this;
    }

    public setDistanceModel(_value: string): this {
      return this;
    }

    public setRefDistance(_value: number): this {
      return this;
    }

    public setRolloffFactor(_value: number): this {
      return this;
    }

    public setDirectionalCone(_inner: number, _outer: number, _outerGain: number): this {
      return this;
    }

    public disconnect(): this {
      return this;
    }
  }

  return {
    ...actual,
    AudioListener: FakeAudioListener,
    PositionalAudio: FakePositionalAudio,
  };
});

import * as THREE from 'three';

import { createSoundscapePlayer } from '../src/audio/SoundscapePlayer';
import type { NormalizedRecording, SoundscapeEvent, SoundscapePlayer } from '../src/domain/types';
import { MockMediaElement } from './mocks/media';

interface TestListener {
  gain: { disconnectCalls: number };
}

interface TestPositional {
  gain: { gain: { commands: Array<readonly [string, number, number]> } };
}

function record(id: string, audioUrl = `${id}.wav`): NormalizedRecording {
  return {
    id,
    title: id.toUpperCase(),
    audioUrl,
    resolvedAudioUrl: new URL(audioUrl, document.baseURI).href,
    location: { lat: 0, lon: 0 },
    spatialFormat: 'point-source',
    durationSec: 12,
    tags: [],
    gainDb: 0,
  };
}

function createHarness(cap: number): {
  player: SoundscapePlayer;
  medias: MockMediaElement[];
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  listener: TestListener;
} {
  const medias = Array.from({ length: cap }, () => new MockMediaElement());
  const camera = new THREE.PerspectiveCamera();
  const scene = new THREE.Scene();
  const player = createSoundscapePlayer(camera, scene, {
    audioLoadTimeoutMs: 20_000,
    progressUpdateHz: 4,
    maxSimultaneousSources: cap,
    mediaElements: medias.map((media) => media.asElement()),
  });
  return {
    player,
    medias,
    camera,
    scene,
    listener: threeAudioHarness.listeners.at(-1) as TestListener,
  };
}

async function activatePlaying(
  player: SoundscapePlayer,
  media: MockMediaElement,
  generation: number,
  id: string,
): Promise<void> {
  const activation = player.activate(generation, record(id), new THREE.Vector3());
  media.playAttempts.at(-1)?.resolve();
  await activation;
}

describe('SoundscapePlayer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    threeAudioHarness.listeners.length = 0;
    threeAudioHarness.positionals.length = 0;
  });

  it('rejects caps outside 1-8 and cleans up nothing on rejection', () => {
    for (const cap of [0, 9, 2.5]) {
      expect(() =>
        createSoundscapePlayer(new THREE.PerspectiveCamera(), new THREE.Scene(), {
          audioLoadTimeoutMs: 20_000,
          progressUpdateHz: 4,
          maxSimultaneousSources: cap,
        }),
      ).toThrowError('AUDIO_INITIALIZATION_FAILED');
    }
  });

  it('builds a fixed pool sharing one coordinator-owned listener', () => {
    const { player, camera, scene } = createHarness(3);

    expect(camera.children).toHaveLength(1);
    expect(scene.children).toHaveLength(3);
    expect(threeAudioHarness.listeners).toHaveLength(1);
    expect(player.resourceCounts()).toEqual({
      mediaElements: 3,
      mediaElementSourceNodes: 3,
      audioSourceObjects: 3,
      listeners: 1,
      positionalAudioObjects: 3,
      panners: 3,
      registeredMediaHandlers: 30,
      activeLoadWatchdogs: 0,
      activeFadeCompletionTimers: 0,
    });
    expect(player.activeRecordingIds()).toEqual([]);
  });

  it('activates up to the cap with independent playback and tagged events', async () => {
    const { player, medias } = createHarness(2);
    const events: SoundscapeEvent[] = [];
    player.subscribe((event) => events.push(event));

    await activatePlaying(player, medias[0] as MockMediaElement, 1, 'a');
    await activatePlaying(player, medias[1] as MockMediaElement, 2, 'b');

    expect(player.snapshotById('a').state).toBe('playing');
    expect(player.snapshotById('b').state).toBe('playing');
    expect(player.activeRecordingIds()).toEqual(['a', 'b']);
    expect(events.some((event) => event.recordingId === 'a' && event.snapshot.state === 'playing')).toBe(true);
    expect(events.some((event) => event.recordingId === 'b' && event.snapshot.state === 'playing')).toBe(true);
  });

  it('evicts the oldest active source through its unit select crossfade', async () => {
    const { player, medias } = createHarness(2);
    await activatePlaying(player, medias[0] as MockMediaElement, 1, 'a');
    await activatePlaying(player, medias[1] as MockMediaElement, 2, 'b');
    // Let the confirm fades settle so a's unit holds an audible gain.
    await vi.advanceTimersByTimeAsync(150);

    const eviction = player.activate(3, record('c'), new THREE.Vector3());
    // a's unit keeps the old source audible through the 150 ms fade before swapping.
    expect(medias[0]?.src).toContain('a.wav');
    await vi.advanceTimersByTimeAsync(150);
    medias[0]?.playAttempts.at(-1)?.resolve();
    await eviction;

    expect(medias[0]?.src).toContain('c.wav');
    expect(player.activeRecordingIds()).toEqual(['b', 'c']);
    expect(player.snapshotById('c').state).toBe('playing');
    expect(player.snapshotById('a')).toEqual({ state: 'empty', currentTimeSec: 0 });
  });

  it('deactivates by id and reuses the freed unit before evicting', async () => {
    const { player, medias } = createHarness(2);
    await activatePlaying(player, medias[0] as MockMediaElement, 1, 'a');
    await activatePlaying(player, medias[1] as MockMediaElement, 2, 'b');

    player.deactivate(3, 'a');
    expect(medias[0]?.pauseCalls).toBeGreaterThan(0);
    expect(player.activeRecordingIds()).toEqual(['b']);
    expect(player.snapshotById('a')).toEqual({ state: 'empty', currentTimeSec: 0 });

    await activatePlaying(player, medias[0] as MockMediaElement, 4, 'd');
    expect(medias[0]?.src).toContain('d.wav');
    expect(medias[1]?.src).toContain('b.wav');
    expect(player.activeRecordingIds()).toEqual(['b', 'd']);
  });

  it('broadcasts pause to every assigned unit with one shared generation', async () => {
    const { player, medias } = createHarness(2);
    await activatePlaying(player, medias[0] as MockMediaElement, 1, 'a');
    await activatePlaying(player, medias[1] as MockMediaElement, 2, 'b');

    player.pauseAll(3, 'lifecycle');

    expect(player.snapshotById('a').state).toBe('paused');
    expect(player.snapshotById('b').state).toBe('paused');
  });

  it('composes equal-power trim with distance gain and refreshes on membership changes', async () => {
    const { player, medias } = createHarness(2);
    const positionals = threeAudioHarness.positionals as TestPositional[];
    const lastLinear = (positional: TestPositional): number | undefined =>
      positional.gain.gain.commands.filter(([name]) => name === 'linear').at(-1)?.[1];

    await activatePlaying(player, medias[0] as MockMediaElement, 1, 'a');
    // Solo: trim 1, so the confirm ramp lands on the 0.7 master default.
    expect(lastLinear(positionals[0] as TestPositional)).toBeCloseTo(0.7, 4);

    await activatePlaying(player, medias[1] as MockMediaElement, 2, 'b');
    // Duo: both sources retarget to master x 1/sqrt(2).
    expect(lastLinear(positionals[0] as TestPositional)).toBeCloseTo(0.7 / Math.SQRT2, 4);
    expect(lastLinear(positionals[1] as TestPositional)).toBeCloseTo(0.7 / Math.SQRT2, 4);

    player.setDistanceGain('b', 0.5);
    expect(lastLinear(positionals[1] as TestPositional)).toBeCloseTo((0.7 * 0.5) / Math.SQRT2, 4);

    player.setMasterGain(0.5);
    expect(lastLinear(positionals[0] as TestPositional)).toBeCloseTo(0.5 / Math.SQRT2, 4);
    expect(lastLinear(positionals[1] as TestPositional)).toBeCloseTo((0.5 * 0.5) / Math.SQRT2, 4);

    player.deactivate(3, 'b');
    // Trim returns to 1 for the remaining solo source.
    expect(lastLinear(positionals[0] as TestPositional)).toBeCloseTo(0.5, 4);
  });

  it('installs a safety limiter on the shared listener', () => {
    const { listener } = createHarness(1);
    const filter = (listener as unknown as {
      filter: { ratio: { value: number }; threshold: { value: number } };
    }).filter;
    expect(filter.ratio.value).toBe(12);
    expect(filter.threshold.value).toBe(-6);
  });

  it('repositions and drives transport by id', async () => {
    const { player, medias, scene } = createHarness(2);
    await activatePlaying(player, medias[0] as MockMediaElement, 1, 'a');

    player.setPosition('a', new THREE.Vector3(4, 5, 6));
    const sourceObject = scene.children.find((child) => child.children.length > 0);
    expect(sourceObject?.position.toArray()).toEqual([4, 5, 6]);

    player.pauseById(2, 'a', 'user');
    await vi.advanceTimersByTimeAsync(150);
    expect(player.snapshotById('a').state).toBe('paused');

    const replay = player.playById(3, 'a');
    medias[0]?.playAttempts.at(-1)?.resolve();
    await replay;
    expect(player.snapshotById('a').state).toBe('playing');

    await expect(player.playById(4, 'missing')).resolves.toBeUndefined();
  });

  it('disposes the pool and its own listener exactly once', async () => {
    const { player, medias, camera, scene, listener } = createHarness(2);
    await activatePlaying(player, medias[0] as MockMediaElement, 1, 'a');

    player.dispose();
    expect(camera.children).toHaveLength(0);
    expect(scene.children).toHaveLength(0);
    expect(listener.gain.disconnectCalls).toBe(1);
    expect(medias[0]?.listenerCount()).toBe(0);
    expect(medias[1]?.listenerCount()).toBe(0);

    player.dispose();
    expect(listener.gain.disconnectCalls).toBe(1);
    expect(() => player.snapshotById('a')).toThrowError('APP_DISPOSED');
  });
});
