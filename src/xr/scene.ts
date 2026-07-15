import * as THREE from 'three';

export interface XRSceneResources {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly appCamera: THREE.PerspectiveCamera;
  readonly controllerGroups: readonly [THREE.XRTargetRaySpace, THREE.XRTargetRaySpace];
  readonly controllerRays: readonly [THREE.Line, THREE.Line];
  resize(): void;
  poseSurfaceFromCamera(surface: THREE.Object3D, camera: THREE.Camera): boolean;
  dispose(): void;
}

const DEFAULT_FORWARD = new THREE.Vector3(0, 0, -1);
const LOCAL_POSITIVE_Z = new THREE.Vector3(0, 0, 1);

function finiteVector(vector: THREE.Vector3): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

export function createXRSceneResources(root: HTMLElement, windowRef: Window): XRSceneResources {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  try {
    const scene = new THREE.Scene();
    scene.background = null;

    const width = Math.max(1, windowRef.innerWidth);
    const height = Math.max(1, windowRef.innerHeight);
    const appCamera = new THREE.PerspectiveCamera(70, width / height, 0.01, 100);
    appCamera.position.set(0, 1.6, 0);
    appCamera.quaternion.identity();
    appCamera.updateMatrixWorld(true);

    renderer.setClearAlpha(0);
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local');
    renderer.setSize(width, height);
    root.append(renderer.domElement);

    const rayGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1),
    ]);
    const rayMaterial = new THREE.LineBasicMaterial({ color: 0xffffff });
    const firstGroup = renderer.xr.getController(0);
    const secondGroup = renderer.xr.getController(1);
    const firstRay = new THREE.Line(rayGeometry, rayMaterial);
    const secondRay = new THREE.Line(rayGeometry, rayMaterial);
    firstRay.name = 'attune-controller-ray-0';
    secondRay.name = 'attune-controller-ray-1';
    firstRay.visible = false;
    secondRay.visible = false;
    firstGroup.add(firstRay);
    secondGroup.add(secondRay);
    scene.add(firstGroup, secondGroup);

    let lastValidPanelForward = DEFAULT_FORWARD.clone();
    let disposed = false;

    const resize = (): void => {
      if (disposed) {
        return;
      }
      const nextWidth = Math.max(1, windowRef.innerWidth);
      const nextHeight = Math.max(1, windowRef.innerHeight);
      appCamera.aspect = nextWidth / nextHeight;
      appCamera.updateProjectionMatrix();
      renderer.setSize(nextWidth, nextHeight);
    };

    const poseSurfaceFromCamera = (surface: THREE.Object3D, camera: THREE.Camera): boolean => {
      const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
      const cameraForward = camera.getWorldDirection(new THREE.Vector3());
      if (!finiteVector(cameraPosition) || !finiteVector(cameraForward)) {
        return false;
      }

      const rawHorizontal = new THREE.Vector3(cameraForward.x, 0, cameraForward.z);
      if (rawHorizontal.length() >= 0.25) {
        lastValidPanelForward = rawHorizontal.normalize().clone();
      }

      const horizontalForward = lastValidPanelForward.clone();
      const panelPosition = cameraPosition.clone().addScaledVector(horizontalForward, 1.25);
      panelPosition.y = cameraPosition.y - 0.08;
      const toCameraHorizontal = cameraPosition.clone().sub(panelPosition);
      toCameraHorizontal.y = 0;
      if (!finiteVector(panelPosition) || toCameraHorizontal.lengthSq() === 0) {
        return false;
      }

      toCameraHorizontal.normalize();
      surface.position.copy(panelPosition);
      surface.quaternion.setFromUnitVectors(LOCAL_POSITIVE_Z, toCameraHorizontal);
      surface.updateMatrixWorld(true);
      return true;
    };

    const dispose = (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      firstRay.visible = false;
      secondRay.visible = false;
      firstGroup.remove(firstRay);
      secondGroup.remove(secondRay);
      scene.remove(firstGroup, secondGroup);
      rayGeometry.dispose();
      rayMaterial.dispose();
      renderer.setAnimationLoop(null);
      renderer.dispose();
      renderer.domElement.remove();
      scene.clear();
    };

    return {
      renderer,
      scene,
      appCamera,
      controllerGroups: [firstGroup, secondGroup],
      controllerRays: [firstRay, secondRay],
      resize,
      poseSurfaceFromCamera,
      dispose,
    };
  } catch (cause) {
    try {
      renderer.setAnimationLoop(null);
    } catch {
      // Preserve the construction failure while still attempting all cleanup.
    }
    try {
      renderer.dispose();
    } catch {
      // Preserve the construction failure while still attempting all cleanup.
    }
    renderer.domElement.remove();
    throw cause;
  }
}
