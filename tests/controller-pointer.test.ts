import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { XRRuntimeEvent } from '../src/domain/types';
import {
  MockXRFrame,
  MockXRSession,
  MockXRSystem,
  connectController,
  createMockSceneState,
  disconnectController,
  inputSource,
  type MockSceneState,
} from './mocks/webxr';

const sceneStates: MockSceneState[] = [];

vi.mock('../src/xr/scene', () => ({
  createXRSceneResources: (root: HTMLElement): MockSceneState['resources'] => {
    const state = createMockSceneState(root);
    sceneStates.push(state);
    return state.resources;
  },
}));

import { createXRSessionController } from '../src/xr/XRSessionController';

describe('XR tracked-pointer routing', () => {
  beforeEach(() => {
    sceneStates.length = 0;
    document.querySelector<HTMLElement>('#app')!.replaceChildren();
  });

  it('filters/rebinds preferred sources and consumes one queued select on the next valid frame', async () => {
    let nowMs = 100;
    const system = new MockXRSystem();
    const session = new MockXRSession();
    system.enqueue(session);
    const controller = createXRSessionController({
      root: document.querySelector<HTMLElement>('#app')!,
      xrSystem: system.asSystem(),
      windowRef: window,
      monotonicNowMs: () => nowMs,
    });
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.72), new THREE.MeshBasicMaterial());
    panel.position.set(0, 0, -2);
    panel.updateMatrixWorld(true);
    controller.getScene().add(panel);
    controller.setInteractionSurface({ object: panel, widthPx: 1024, heightPx: 768 });
    const events: XRRuntimeEvent[] = [];
    controller.subscribe((event) => events.push(event));
    await controller.start().result;
    const state = sceneStates[0]!;
    const [firstGroup, secondGroup] = state.resources.controllerGroups;
    const left = inputSource('left');
    const right = inputSource('right');
    const gaze = inputSource('none', 'gaze');

    connectController(firstGroup, gaze);
    expect(controller.resourceCounts().controllerBindings).toBe(0);
    connectController(firstGroup, left);
    expect(controller.resourceCounts().controllerBindings).toBe(1);
    expect(state.resources.controllerRays[0].visible).toBe(true);
    connectController(secondGroup, right);
    expect(state.resources.controllerRays[0].visible).toBe(false);
    expect(state.resources.controllerRays[1].visible).toBe(true);
    expect(events.filter((event) => event.type === 'inputAvailabilityChanged')).toEqual([
      { sessionGeneration: 1, type: 'inputAvailabilityChanged', hasTrackedPointer: true },
    ]);

    session.emitSelect(left);
    state.runFrame(new MockXRFrame());
    expect(events.some((event) => event.type === 'primarySelect')).toBe(false);

    nowMs = 456;
    session.emitSelect(right);
    session.emitSelect(right);
    expect(events.some((event) => event.type === 'primarySelect')).toBe(false);
    state.runFrame(new MockXRFrame());
    state.runFrame(new MockXRFrame());
    const selections = events.filter((event) => event.type === 'primarySelect');
    expect(selections).toHaveLength(1);
    expect(selections[0]).toMatchObject({
      sessionGeneration: 1,
      type: 'primarySelect',
      nowMs: 456,
    });
    expect(selections[0]?.type === 'primarySelect' ? selections[0].canvasX : undefined).toBeCloseTo(512);
    expect(selections[0]?.type === 'primarySelect' ? selections[0].canvasY : undefined).toBeCloseTo(384);

    session.emitSelect(right);
    disconnectController(secondGroup, right);
    state.runFrame(new MockXRFrame());
    expect(events.filter((event) => event.type === 'primarySelect')).toHaveLength(1);
    expect(state.resources.controllerRays[0].visible).toBe(true);
    disconnectController(firstGroup, left);
    expect(controller.resourceCounts().controllerBindings).toBe(0);
    expect(state.resources.controllerRays.every((ray) => !ray.visible)).toBe(true);
    expect(events.filter((event) => event.type === 'inputAvailabilityChanged')).toEqual([
      { sessionGeneration: 1, type: 'inputAvailabilityChanged', hasTrackedPointer: true },
      { sessionGeneration: 1, type: 'inputAvailabilityChanged', hasTrackedPointer: false },
    ]);

    panel.geometry.dispose();
    panel.material.dispose();
    await controller.dispose();
  });

  it('clears a pending selection when inputsourceschange removes the bound source', async () => {
    const system = new MockXRSystem();
    const session = new MockXRSession();
    system.enqueue(session);
    const controller = createXRSessionController({
      root: document.querySelector<HTMLElement>('#app')!,
      xrSystem: system.asSystem(),
      windowRef: window,
      monotonicNowMs: () => 999,
    });
    const events: XRRuntimeEvent[] = [];
    controller.subscribe((event) => events.push(event));
    await controller.start().result;
    const state = sceneStates[0]!;
    const source = inputSource('right');
    connectController(state.resources.controllerGroups[0], source);
    session.emitSelect(source);
    session.emitInputSourcesChange([], [source]);
    state.runFrame(new MockXRFrame());

    expect(controller.resourceCounts().controllerBindings).toBe(0);
    expect(events.some((event) => event.type === 'primarySelect')).toBe(false);
    await controller.dispose();
  });

  it('does not deliver later events to a listener removed during dispatch', async () => {
    const system = new MockXRSystem();
    const session = new MockXRSession();
    system.enqueue(session);
    const controller = createXRSessionController({
      root: document.querySelector<HTMLElement>('#app')!,
      xrSystem: system.asSystem(),
      windowRef: window,
      monotonicNowMs: () => 0,
    });
    const calls: string[] = [];
    let removeSecond = (): void => undefined;
    controller.subscribe(() => {
      calls.push('first');
      removeSecond();
    });
    removeSecond = controller.subscribe(() => calls.push('second'));
    await controller.start().result;
    session.emitVisibility('hidden');

    expect(calls).toEqual(['first']);
    await controller.dispose();
  });
});
