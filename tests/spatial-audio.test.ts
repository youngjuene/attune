import { beforeEach, describe, expect, it, vi } from 'vitest';

const threeAudioHarness = vi.hoisted(() => ({
  contexts: [] as unknown[],
  listeners: [] as unknown[],
  positionals: [] as unknown[],
}));

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();

  class FakeAudioParam {
    // Deliberately never mirrors scheduled automation. Production code must use its
    // logical ramp descriptor rather than assuming AudioParam.value is instantaneous.
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
    public resumeFactory: (() => Promise<void>) | undefined;

    public resume(): Promise<void> {
      this.resumeCalls += 1;
      if (this.resumeFactory !== undefined) {
        return this.resumeFactory();
      }
      this.state = 'running';
      return Promise.resolve();
    }
  }

  class FakeAudioListener extends actual.Object3D {
    public readonly context = new FakeAudioContext();
    public readonly gain = new FakeGainNode();

    public constructor() {
      super();
      threeAudioHarness.contexts.push(this.context);
      threeAudioHarness.listeners.push(this);
    }
  }

  class FakePositionalAudio extends actual.Object3D {
    public readonly gain = new FakeGainNode();
    public readonly panner = { panningModel: 'equalpower' as PanningModelType };
    public mediaElementSourceCalls = 0;
    public disconnectCalls = 0;
    public distanceModel = '';
    public refDistance = 0;
    public rolloffFactor = -1;
    public cone: readonly number[] = [];

    public constructor(_listener: FakeAudioListener) {
      super();
      threeAudioHarness.positionals.push(this);
    }

    public setMediaElementSource(_media: HTMLMediaElement): this {
      this.mediaElementSourceCalls += 1;
      return this;
    }

    public setDistanceModel(value: string): this {
      this.distanceModel = value;
      return this;
    }

    public setRefDistance(value: number): this {
      this.refDistance = value;
      return this;
    }

    public setRolloffFactor(value: number): this {
      this.rolloffFactor = value;
      return this;
    }

    public setDirectionalCone(inner: number, outer: number, outerGain: number): this {
      this.cone = [inner, outer, outerGain];
      return this;
    }

    public disconnect(): this {
      this.disconnectCalls += 1;
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

import { createSpatialAudioPlayer } from '../src/audio/SpatialAudioPlayer';
import type { NormalizedRecording, SpatialAudioPlayer } from '../src/domain/types';
import { domException, MockMediaElement } from './mocks/media';

interface TestAudioParam {
  value: number;
  commands: Array<readonly [string, number, number]>;
}

interface TestContext {
  currentTime: number;
  state: AudioContextState;
  resumeCalls: number;
  resumeFactory?: () => Promise<void>;
}

interface TestPositional extends THREE.Object3D {
  gain: { gain: TestAudioParam };
  panner: { panningModel: PanningModelType };
  mediaElementSourceCalls: number;
  disconnectCalls: number;
  distanceModel: string;
  refDistance: number;
  rolloffFactor: number;
  cone: readonly number[];
}

function record(id: string, audioUrl = `${id}.wav`, gainDb = 0): NormalizedRecording {
  return {
    id,
    title: id.toUpperCase(),
    audioUrl,
    resolvedAudioUrl: new URL(audioUrl, document.baseURI).href,
    location: { lat: 0, lon: 0 },
    spatialFormat: 'point-source',
    durationSec: 12,
    tags: [],
    gainDb,
  };
}

function createHarness(timeoutMs = 20_000): {
  player: SpatialAudioPlayer;
  media: MockMediaElement;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  context: TestContext;
  positional: TestPositional;
} {
  const media = new MockMediaElement();
  const camera = new THREE.PerspectiveCamera();
  const scene = new THREE.Scene();
  const player = createSpatialAudioPlayer(camera, scene, {
    audioLoadTimeoutMs: timeoutMs,
    progressUpdateHz: 4,
    mediaElement: media.asElement(),
  });
  return {
    player,
    media,
    camera,
    scene,
    context: threeAudioHarness.contexts.at(-1) as TestContext,
    positional: threeAudioHarness.positionals.at(-1) as TestPositional,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('SpatialAudioPlayer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    threeAudioHarness.contexts.length = 0;
    threeAudioHarness.listeners.length = 0;
    threeAudioHarness.positionals.length = 0;
  });

  it('constructs one reusable HRTF graph and classifies MIME hints on its media element', () => {
    const { player, media, camera, scene, positional } = createHarness();
    media.canPlayTypeImpl = (mime) => (mime === 'audio/wav' ? 'probably' : '');

    expect(player.classifyMimeType()).toBe('probe-at-play');
    expect(player.classifyMimeType(' audio/wav ')).toBe('eligible');
    expect(player.classifyMimeType('audio/unknown')).toBe('unsupported');
    media.canPlayTypeImpl = () => {
      throw new Error('probe failure');
    };
    expect(player.classifyMimeType('audio/wav')).toBe('probe-at-play');

    expect(media.preload).toBe('metadata');
    expect(media.crossOrigin).toBe('anonymous');
    expect(positional.mediaElementSourceCalls).toBe(1);
    expect(positional.panner.panningModel).toBe('HRTF');
    expect(positional.distanceModel).toBe('inverse');
    expect(positional.refDistance).toBe(3);
    expect(positional.rolloffFactor).toBe(0);
    expect(positional.cone).toEqual([360, 360, 1]);
    expect(camera.children).toHaveLength(1);
    expect(scene.children).toHaveLength(1);
    expect(media.listenerCount()).toBe(10);
    expect(player.resourceCounts()).toEqual({
      mediaElements: 1,
      mediaElementSourceNodes: 1,
      audioSourceObjects: 1,
      listeners: 1,
      positionalAudioObjects: 1,
      panners: 1,
      registeredMediaHandlers: 10,
      activeLoadWatchdogs: 0,
      activeFadeCompletionTimers: 0,
    });
  });

  it('runs idle assignment/load and confirms only the captured play promise', async () => {
    const { player, media, positional } = createHarness();
    const targetPosition = new THREE.Vector3(1, 2, 3);
    const events: string[] = [];
    player.subscribe(({ snapshot }) => events.push(snapshot.state));

    const selection = player.select(1, record('a'), targetPosition);
    targetPosition.set(9, 9, 9);

    expect(media.loadCalls).toBe(1);
    expect(media.playCalls).toBe(1);
    expect(player.snapshot()).toMatchObject({
      state: 'loading',
      recordingId: 'a',
      loadedRecordingId: 'a',
      currentTimeSec: 0,
    });
    expect(player.resourceCounts().activeLoadWatchdogs).toBe(1);
    expect((positional.parent as THREE.Object3D).position.toArray()).toEqual([1, 2, 3]);

    media.emit('canplay');
    media.emit('playing');
    await flushPromises();
    expect(player.snapshot().state).toBe('loading');

    media.playAttempts[0]?.resolve();
    await selection;
    expect(player.snapshot().state).toBe('playing');
    expect(events.filter((state) => state === 'playing')).toHaveLength(1);
    expect(player.resourceCounts()).toMatchObject({
      activeLoadWatchdogs: 0,
      activeFadeCompletionTimers: 1,
    });
  });

  it('replaces all ten handlers and ignores stale queued handlers and play promises', async () => {
    const { player, media } = createHarness();
    const aSelection = player.select(1, record('a'), new THREE.Vector3(1, 0, 0));
    const oldErrorHandler = [...(media.added.get('error') ?? [])][0];
    expect(oldErrorHandler).toBeTypeOf('function');

    const bSelection = player.select(2, record('b'), new THREE.Vector3(2, 0, 0));
    expect(media.listenerCount()).toBe(10);
    for (const handlers of media.added.values()) {
      expect(handlers.size).toBe(1);
    }

    media.playAttempts[0]?.resolve();
    await flushPromises();
    expect(player.snapshot()).toMatchObject({ state: 'loading', recordingId: 'b' });

    media.error = { code: 2 };
    (oldErrorHandler as EventListener)(new Event('error'));
    expect(player.snapshot()).toMatchObject({ state: 'loading', recordingId: 'b' });

    media.playAttempts[1]?.resolve();
    await bSelection;
    await aSelection;
    expect(player.snapshot()).toMatchObject({
      state: 'playing',
      recordingId: 'b',
      loadedRecordingId: 'b',
    });
  });

  it('does not let a reentrant subscriber continue an older generation', async () => {
    const { player, media } = createHarness();
    let bSelection: Promise<void> | undefined;
    let switched = false;
    player.subscribe(({ generation, snapshot }) => {
      if (!switched && generation === 1 && snapshot.state === 'loading') {
        switched = true;
        bSelection = player.select(2, record('b'), new THREE.Vector3(2, 0, 0));
      }
    });

    const aSelection = player.select(1, record('a'), new THREE.Vector3(1, 0, 0));
    expect(media.src).toContain('/b.wav');
    expect(media.loadUrls.some((url) => url.endsWith('/a.wav'))).toBe(false);
    media.playAttempts[0]?.resolve();
    await aSelection;
    await bSelection;
    expect(player.snapshot()).toMatchObject({
      state: 'playing',
      recordingId: 'b',
      loadedRecordingId: 'b',
    });
  });

  it('keeps A loaded during B/C fade and assigns only the latest C target', async () => {
    const { player, media, context } = createHarness();
    const aSelection = player.select(1, record('a'), new THREE.Vector3(1, 0, 0));
    media.playAttempts[0]?.resolve();
    await aSelection;
    context.currentTime = 0.15;
    await vi.advanceTimersByTimeAsync(150);

    const bSelection = player.select(2, record('b'), new THREE.Vector3(2, 0, 0));
    expect(player.snapshot()).toMatchObject({
      state: 'loading',
      recordingId: 'b',
      loadedRecordingId: 'a',
    });
    expect(media.src).toContain('/a.wav');

    context.currentTime = 0.225;
    const cSelection = player.select(3, record('c'), new THREE.Vector3(3, 0, 0));
    await bSelection;
    expect(media.src).toContain('/a.wav');

    context.currentTime = 0.375;
    await vi.advanceTimersByTimeAsync(150);
    expect(media.src).toContain('/c.wav');
    expect(media.loadUrls.some((url) => url.endsWith('/b.wav'))).toBe(false);
    expect(media.loadUrls.filter((url) => url.endsWith('.wav'))).toEqual([
      'http://localhost:3000/a.wav',
      'http://localhost:3000/c.wav',
    ]);

    media.playAttempts.at(-1)?.resolve();
    await cSelection;
    expect(player.snapshot()).toMatchObject({
      state: 'playing',
      recordingId: 'c',
      loadedRecordingId: 'c',
    });
  });

  it('restarts identity and time for different IDs that share an audio URL', async () => {
    const { player, media, context } = createHarness();
    const aSelection = player.select(1, record('a', 'shared.wav'), new THREE.Vector3(1, 0, 0));
    media.playAttempts[0]?.resolve();
    await aSelection;
    context.currentTime = 0.15;
    await vi.advanceTimersByTimeAsync(150);
    media.currentTime = 8;

    const bSelection = player.select(2, record('b', 'shared.wav'), new THREE.Vector3(2, 0, 0));
    context.currentTime = 0.3;
    await vi.advanceTimersByTimeAsync(150);
    expect(media.currentTime).toBe(0);
    expect(player.snapshot()).toMatchObject({
      state: 'loading',
      recordingId: 'b',
      loadedRecordingId: 'b',
      currentTimeSec: 0,
    });
    media.playAttempts.at(-1)?.resolve();
    await bSelection;
    expect(player.snapshot()).toMatchObject({ state: 'playing', recordingId: 'b' });
  });

  it('clears old loaded identity when Pause interrupts a pre-assignment switch and Play loads the target', async () => {
    const { player, media, context } = createHarness();
    const aSelection = player.select(1, record('a'), new THREE.Vector3(1, 0, 0));
    media.playAttempts[0]?.resolve();
    await aSelection;
    context.currentTime = 0.15;
    await vi.advanceTimersByTimeAsync(150);

    void player.select(2, record('b'), new THREE.Vector3(2, 0, 0));
    player.pause(3, 'user');
    expect(player.snapshot()).toEqual({
      state: 'paused',
      recordingId: 'b',
      currentTimeSec: 0,
      durationSec: 12,
    });
    expect(media.src).toBe('');
    expect(player.resourceCounts()).toMatchObject({
      activeLoadWatchdogs: 0,
      activeFadeCompletionTimers: 0,
    });

    const play = player.play(4);
    expect(media.src).toContain('/b.wav');
    expect(player.snapshot()).toMatchObject({
      state: 'loading',
      recordingId: 'b',
      loadedRecordingId: 'b',
    });
    media.playAttempts.at(-1)?.resolve();
    await play;
    expect(player.snapshot()).toMatchObject({ state: 'playing', recordingId: 'b' });
  });

  it.each([
    ['stop', 'stopped'],
    ['lifecycle', 'paused'],
  ] as const)(
    '%s clears old loaded identity during a pre-assignment switch',
    async (command, expectedState) => {
      const { player, media, context } = createHarness();
      const aSelection = player.select(1, record('a'), new THREE.Vector3(1, 0, 0));
      media.playAttempts[0]?.resolve();
      await aSelection;
      context.currentTime = 0.15;
      await vi.advanceTimersByTimeAsync(150);

      void player.select(2, record('b'), new THREE.Vector3(2, 0, 0));
      if (command === 'stop') {
        player.stop(3);
      } else {
        player.pause(3, 'lifecycle');
      }

      expect(player.snapshot()).toMatchObject({
        state: expectedState,
        recordingId: 'b',
        currentTimeSec: 0,
      });
      expect(player.snapshot()).not.toHaveProperty('loadedRecordingId');
      expect(media.src).toBe('');
      expect(player.resourceCounts()).toMatchObject({
        activeLoadWatchdogs: 0,
        activeFadeCompletionTimers: 0,
      });

      const play = player.play(4);
      expect(media.src).toContain('/b.wav');
      media.playAttempts.at(-1)?.resolve();
      await play;
      expect(player.snapshot()).toMatchObject({
        state: 'playing',
        recordingId: 'b',
        loadedRecordingId: 'b',
      });
    },
  );

  it('applies guarded user-pause fades but lifecycle Pause and Stop are immediate', async () => {
    const { player, media, context } = createHarness();
    const selection = player.select(1, record('a'), new THREE.Vector3());
    media.playAttempts[0]?.resolve();
    await selection;
    context.currentTime = 0.15;
    await vi.advanceTimersByTimeAsync(150);
    media.currentTime = 4;

    player.pause(2, 'user');
    expect(media.paused).toBe(false);
    expect(player.resourceCounts().activeFadeCompletionTimers).toBe(1);
    context.currentTime = 0.3;
    await vi.advanceTimersByTimeAsync(150);
    expect(media.paused).toBe(true);
    expect(player.snapshot()).toMatchObject({ state: 'paused', currentTimeSec: 4 });

    const replay = player.play(3);
    media.playAttempts.at(-1)?.resolve();
    await replay;
    player.pause(4, 'lifecycle');
    expect(media.paused).toBe(true);
    expect(player.snapshot()).toMatchObject({ state: 'paused', currentTimeSec: 4 });
    expect(player.resourceCounts().activeFadeCompletionTimers).toBe(0);

    const replayAgain = player.play(5);
    media.playAttempts.at(-1)?.resolve();
    await replayAgain;
    media.currentTime = 7;
    player.stop(6);
    expect(media.currentTime).toBe(0);
    expect(player.snapshot()).toMatchObject({ state: 'stopped', currentTimeSec: 0 });
    expect(player.resourceCounts()).toMatchObject({
      activeLoadWatchdogs: 0,
      activeFadeCompletionTimers: 0,
    });
  });

  it('requires explicit Play after autoplay rejection and restarts the watchdog', async () => {
    const { player, media } = createHarness(1_000);
    const selection = player.select(1, record('a'), new THREE.Vector3());
    media.playAttempts[0]?.reject(domException('NotAllowedError'));
    await selection;
    expect(player.snapshot()).toMatchObject({
      state: 'paused',
      recordingId: 'a',
      loadedRecordingId: 'a',
      errorCode: 'AUDIO_PLAY_REJECTED',
    });
    expect(player.resourceCounts().activeLoadWatchdogs).toBe(0);

    const explicitPlay = player.play(2);
    expect(player.resourceCounts().activeLoadWatchdogs).toBe(1);
    media.playAttempts[1]?.resolve();
    await explicitPlay;
    expect(player.snapshot()).toMatchObject({ state: 'playing', recordingId: 'a' });
    expect(player.snapshot()).not.toHaveProperty('errorCode');
  });

  it.each([
    [domException('SecurityError'), 'AUDIO_CORS'],
    [domException('NotSupportedError'), 'AUDIO_UNSUPPORTED'],
    [domException('AbortError'), 'AUDIO_ABORTED'],
    [new Error('playback failure'), 'AUDIO_PLAY_REJECTED'],
  ] as const)('maps play rejection to stable %s error state', async (error, code) => {
    const { player, media } = createHarness();
    const selection = player.select(1, record('a'), new THREE.Vector3());
    media.playAttempts[0]?.reject(error);
    await selection;
    expect(player.snapshot()).toMatchObject({ state: 'error', errorCode: code });
  });

  it('maps a watchdog timeout to a stable network error and resolves the operation', async () => {
    const { player } = createHarness(1_000);
    const selection = player.select(1, record('a'), new THREE.Vector3());
    await vi.advanceTimersByTimeAsync(1_000);
    await selection;
    expect(player.snapshot()).toMatchObject({
      state: 'error',
      recordingId: 'a',
      loadedRecordingId: 'a',
      errorCode: 'AUDIO_NETWORK',
    });
    expect(player.resourceCounts()).toMatchObject({
      activeLoadWatchdogs: 0,
      activeFadeCompletionTimers: 0,
    });
  });

  it.each([
    [1, 'AUDIO_ABORTED'],
    [2, 'AUDIO_NETWORK'],
    [3, 'AUDIO_DECODE'],
    [4, 'AUDIO_UNSUPPORTED'],
  ] as const)('maps MediaError code %i to %s', async (mediaCode, expectedCode) => {
    const { player, media } = createHarness();
    const selection = player.select(1, record('a'), new THREE.Vector3());
    media.error = { code: mediaCode };
    media.emit('error');
    await selection;
    expect(player.snapshot()).toMatchObject({ state: 'error', errorCode: expectedCode });
  });

  it('maps a current target abort event but ignores the abort emitted by app-owned reset', async () => {
    const { player, media, context } = createHarness();
    const firstSelection = player.select(1, record('a'), new THREE.Vector3());
    media.emit('abort');
    await firstSelection;
    expect(player.snapshot()).toMatchObject({ state: 'error', errorCode: 'AUDIO_ABORTED' });

    const retry = player.select(2, record('a'), new THREE.Vector3());
    media.playAttempts.at(-1)?.resolve();
    await retry;
    context.currentTime = 0.15;
    await vi.advanceTimersByTimeAsync(150);
    media.emitAbortOnEmptyLoad = true;

    const switchSelection = player.select(3, record('b'), new THREE.Vector3(2, 0, 0));
    context.currentTime = 0.3;
    await vi.advanceTimersByTimeAsync(150);
    expect(player.snapshot()).toMatchObject({ state: 'loading', recordingId: 'b' });
    expect(player.snapshot()).not.toHaveProperty('errorCode');
    media.playAttempts.at(-1)?.resolve();
    await switchSelection;
  });

  it('maps suspended-context recovery failure and permits a later explicit recovery', async () => {
    const { player, media, context } = createHarness();
    context.state = 'suspended';
    context.resumeFactory = () => Promise.reject(new Error('suspended'));
    const selection = player.select(1, record('a'), new THREE.Vector3());
    media.playAttempts[0]?.resolve();
    await selection;
    expect(player.snapshot()).toMatchObject({
      state: 'paused',
      errorCode: 'AUDIO_CONTEXT_SUSPENDED',
    });

    context.resumeFactory = () => {
      context.state = 'running';
      return Promise.resolve();
    };
    const play = player.play(2);
    media.playAttempts[1]?.resolve();
    await play;
    expect(player.snapshot().state).toBe('playing');
  });

  it('computes held gain from the logical ramp and preserves its completion time on volume change', async () => {
    const { player, media, context, positional } = createHarness();
    const selection = player.select(1, record('a'), new THREE.Vector3());
    media.playAttempts[0]?.resolve();
    await selection;
    context.currentTime = 0.075;

    player.setMasterGain(0.5);
    const commands = positional.gain.gain.commands;
    const heldSet = commands.filter(([name]) => name === 'set').at(-1);
    const replacementRamp = commands.filter(([name]) => name === 'linear').at(-1);
    expect(heldSet?.[1]).toBeCloseTo(0.35, 6);
    expect(replacementRamp?.[1]).toBeCloseTo(0.5, 6);
    expect(replacementRamp?.[2]).toBeCloseTo(0.15, 6);
  });

  it('carries the logical held gain through generation adoption without rereading AudioParam.value', async () => {
    const { player, media, context, positional } = createHarness();
    const selection = player.select(1, record('a'), new THREE.Vector3());
    media.playAttempts[0]?.resolve();
    await selection;
    context.currentTime = 0.075;

    player.pause(2, 'user');
    const commands = positional.gain.gain.commands;
    const heldSet = commands.filter(([name]) => name === 'set').at(-1);
    const pauseRamp = commands.filter(([name]) => name === 'linear').at(-1);
    expect(positional.gain.gain.value).toBe(0.93);
    expect(heldSet?.[1]).toBeCloseTo(0.35, 6);
    expect(pauseRamp?.[1]).toBe(0);
    expect(pauseRamp?.[2]).toBeCloseTo(0.225, 6);
  });

  it('uses authoritative metadata duration, throttles progress, and accepts only natural ended', async () => {
    const { player, media } = createHarness();
    const events: number[] = [];
    player.subscribe(({ snapshot }) => events.push(snapshot.currentTimeSec));
    void player.select(1, record('a'), new THREE.Vector3());
    media.duration = 21;
    media.emit('loadedmetadata');
    expect(player.snapshot().durationSec).toBe(21);

    media.currentTime = 2;
    media.emit('timeupdate');
    media.currentTime = 3;
    media.emit('timeupdate');
    expect(events.filter((time) => time === 2)).toHaveLength(1);
    expect(events.filter((time) => time === 3)).toHaveLength(0);

    media.emit('ended');
    expect(player.snapshot().state).toBe('loading');
    media.ended = true;
    media.currentTime = 21;
    media.emit('ended');
    expect(player.snapshot()).toMatchObject({ state: 'ended', currentTimeSec: 21 });

    const replay = player.play(2);
    expect(media.currentTime).toBe(0);
    expect(player.snapshot()).toMatchObject({ state: 'loading', currentTimeSec: 0 });
    media.playAttempts.at(-1)?.resolve();
    await replay;
    expect(player.snapshot()).toMatchObject({ state: 'playing', currentTimeSec: 0 });
  });

  it('delivers subscribers in order, honors removal during dispatch, and isolates listener errors', () => {
    const { player } = createHarness();
    const calls: string[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let unsubscribeSecond = (): void => undefined;
    player.subscribe(() => {
      calls.push('first');
      unsubscribeSecond();
    });
    unsubscribeSecond = player.subscribe(() => calls.push('second'));
    player.subscribe(() => {
      calls.push('throws');
      throw new Error('subscriber failure');
    });
    player.subscribe(() => calls.push('last'));

    void player.select(1, record('a'), new THREE.Vector3());
    expect(calls).toEqual(['first', 'throws', 'last', 'first', 'throws', 'last']);
    expect(consoleError).toHaveBeenCalledWith('INTERNAL_LISTENER_ERROR');
  });

  it('disposes handlers, timers, graph roots, and assigned media deterministically', () => {
    const { player, media, camera, scene, positional } = createHarness();
    void player.select(1, record('a'), new THREE.Vector3());
    const loadsBeforeDispose = media.loadCalls;

    player.dispose();
    expect(media.listenerCount()).toBe(0);
    expect(media.src).toBe('');
    expect(media.loadCalls).toBe(loadsBeforeDispose + 1);
    expect(camera.children).toHaveLength(0);
    expect(scene.children).toHaveLength(0);
    expect(positional.disconnectCalls).toBe(1);

    player.dispose();
    expect(media.loadCalls).toBe(loadsBeforeDispose + 1);
    expect(() => player.snapshot()).toThrowError('APP_DISPOSED');
  });
});
