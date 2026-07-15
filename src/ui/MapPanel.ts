import * as THREE from 'three';

import { AppError } from '../app/errors';
import type {
  CreateMapPanel,
  MapMarkerModel,
  MapPanel,
  MapPanelAction,
  MapPanelModel,
  PlaybackSnapshot,
} from '../domain/types';
import { MapHitTester } from './hitTest';
import {
  DETAIL_COLUMN_RECT,
  FOOTER_RECT,
  HEADER_RECT,
  MAP_CANVAS_HEIGHT,
  MAP_CANVAS_SCALE,
  MAP_CANVAS_WIDTH,
  MAP_CENTER,
  MAP_CONTROLS,
  MAP_DRAWABLE_RADIUS_PX,
  MAP_WORLD_HEIGHT_M,
  MAP_WORLD_WIDTH_M,
  MARKER_VISUAL_RADIUS_PX,
  PROGRESS_RECT,
  SELECTED_DETAIL_RECT,
  type CanvasRect,
} from './mapLayout';

const PANEL_DISTANCE_M = 1.25;
const PANEL_VERTICAL_OFFSET_M = -0.08;
const MINIMUM_HORIZONTAL_FORWARD = 0.25;
const LOCAL_POSITIVE_Z = new THREE.Vector3(0, 0, 1);

const COLORS = Object.freeze({
  background: 'rgba(11, 27, 29, 0.88)',
  panel: 'rgba(16, 39, 42, 0.92)',
  panelAlt: 'rgba(13, 32, 34, 0.9)',
  line: '#47726b',
  muted: '#91aaa3',
  text: '#e9f6f1',
  accent: '#8edcc5',
  selected: '#fff4b8',
  warning: '#ffd28a',
  error: '#ff9e9e',
  disabled: '#6d7b78',
});

function formatTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '--:--';
  }
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${String(wholeSeconds % 60).padStart(2, '0')}`;
}

function fitText(context: CanvasRenderingContext2D, value: string, maximumWidth: number): string {
  if (context.measureText(value).width <= maximumWidth) {
    return value;
  }
  const suffix = '…';
  let result = value;
  while (result.length > 0 && context.measureText(`${result}${suffix}`).width > maximumWidth) {
    result = result.slice(0, -1);
  }
  return `${result}${suffix}`;
}

function markerLayer(marker: MapMarkerModel, hoveredRecordingId: string | null): number {
  if (
    marker.state === 'selected' ||
    marker.state === 'loading' ||
    marker.state === 'playing' ||
    marker.state === 'failed'
  ) {
    return 2;
  }
  if (marker.recordingId === hoveredRecordingId || marker.state === 'hovered') {
    return 1;
  }
  return 0;
}

function markerLabel(model: MapPanelModel, marker: MapMarkerModel): string {
  return model.selected?.recordingId === marker.recordingId
    ? model.selected.title
    : marker.recordingId;
}

function playbackControlLabel(playback: PlaybackSnapshot): string {
  return playback.state === 'playing' || playback.state === 'loading' ? 'Pause' : 'Play';
}

class CanvasMapPanel implements MapPanel {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly hitTester = new MapHitTester();
  private readonly lastValidPanelForward = new THREE.Vector3(0, 0, -1);
  private model: MapPanelModel | null = null;
  private hoveredRecordingId: string | null = null;
  private internalOverlapCycle: { index: number; count: number } | null = null;
  private disposed = false;

  public constructor(private readonly scene: THREE.Scene) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = MAP_CANVAS_WIDTH * MAP_CANVAS_SCALE;
    this.canvas.height = MAP_CANVAS_HEIGHT * MAP_CANVAS_SCALE;
    this.canvas.dataset.attuneOwned = 'map-canvas';
    const context = this.canvas.getContext('2d');
    if (context === null) {
      throw new AppError('XR_RENDERER_INIT_FAILED');
    }
    // Every draw() call works in logical 1024x768 coordinates; this transform maps them
    // onto the larger backing bitmap. setTransform (not scale) is absolute, so it does not
    // compound across the many redraws.
    context.setTransform(MAP_CANVAS_SCALE, 0, 0, MAP_CANVAS_SCALE, 0, 0);
    this.context = context;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.geometry = new THREE.PlaneGeometry(MAP_WORLD_WIDTH_M, MAP_WORLD_HEIGHT_M);
    this.plane = new THREE.Mesh(this.geometry, this.material);
    this.plane.name = 'attune-map-panel';
    this.plane.frustumCulled = false;
    this.plane.renderOrder = 10;
    this.scene.add(this.plane);
    this.draw();
  }

  public setModel(model: MapPanelModel): void {
    this.assertLive();
    if (model === this.model) {
      return;
    }
    const geometryChanged = this.hitTester.setMarkers(model.markers);
    this.model = model;
    if (geometryChanged) {
      this.internalOverlapCycle = null;
      this.hoveredRecordingId = null;
    }
    this.draw();
  }

  public getCanvas(): HTMLCanvasElement {
    this.assertLive();
    return this.canvas;
  }

  public setPoseFromCamera(camera: THREE.Camera): void {
    this.assertLive();
    const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
    const rawHorizontal = camera.getWorldDirection(new THREE.Vector3());
    rawHorizontal.y = 0;
    if (rawHorizontal.length() >= MINIMUM_HORIZONTAL_FORWARD) {
      this.lastValidPanelForward.copy(rawHorizontal).normalize();
    }

    this.plane.position.copy(cameraPosition).addScaledVector(this.lastValidPanelForward, PANEL_DISTANCE_M);
    this.plane.position.y = cameraPosition.y + PANEL_VERTICAL_OFFSET_M;
    const toCameraHorizontal = cameraPosition.clone().sub(this.plane.position);
    toCameraHorizontal.y = 0;
    if (toCameraHorizontal.lengthSq() > 0) {
      toCameraHorizontal.normalize();
      this.plane.quaternion.setFromUnitVectors(LOCAL_POSITIVE_Z, toCameraHorizontal);
    }
  }

  public updateHover(canvasX: number, canvasY: number, _nowMs: number): void {
    this.assertLive();
    const nextHover = this.hitTester.hover(canvasX, canvasY)?.recordingId ?? null;
    if (nextHover === this.hoveredRecordingId) {
      return;
    }
    this.hoveredRecordingId = nextHover;
    this.draw();
  }

  public clearHover(): void {
    this.assertLive();
    if (this.hoveredRecordingId === null) {
      return;
    }
    this.hoveredRecordingId = null;
    this.draw();
  }

  public hitTest(canvasX: number, canvasY: number, nowMs: number): MapPanelAction | null {
    this.assertLive();
    const model = this.model;
    if (model === null) {
      return null;
    }
    const hit = this.hitTester.select(model, canvasX, canvasY, nowMs);
    const previousCycle = this.internalOverlapCycle;
    this.internalOverlapCycle = hit?.kind === 'marker' && hit.overlapCount > 1
      ? { index: hit.overlapIndex, count: hit.overlapCount }
      : null;
    if (
      previousCycle?.index !== this.internalOverlapCycle?.index
      || previousCycle?.count !== this.internalOverlapCycle?.count
    ) {
      this.draw();
    }
    return hit?.action ?? null;
  }

  public getObject3D(): THREE.Object3D {
    this.assertLive();
    return this.plane;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.scene.remove(this.plane);
    this.texture.dispose();
    this.material.dispose();
    this.geometry.dispose();
    this.hitTester.resetCycle();
    this.model = null;
    this.hoveredRecordingId = null;
    this.internalOverlapCycle = null;
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new AppError('APP_DISPOSED');
    }
  }

  private draw(): void {
    const context = this.context;
    context.clearRect(0, 0, MAP_CANVAS_WIDTH, MAP_CANVAS_HEIGHT);
    context.fillStyle = COLORS.background;
    context.fillRect(0, 0, MAP_CANVAS_WIDTH, MAP_CANVAS_HEIGHT);
    this.drawRegion(HEADER_RECT, COLORS.panel);
    this.drawRegion(DETAIL_COLUMN_RECT, COLORS.panelAlt);
    this.drawRegion(FOOTER_RECT, COLORS.panel);

    context.fillStyle = COLORS.accent;
    context.font = '700 24px system-ui, sans-serif';
    context.fillText(this.model?.collectionTitle ?? 'attune', 28, 52);
    this.drawRadialMap();
    this.drawDetails();
    this.drawControls();
    this.drawFooter();
    this.texture.needsUpdate = true;
  }

  private drawRegion(rect: Readonly<CanvasRect>, color: string): void {
    this.context.fillStyle = color;
    this.context.fillRect(rect.x, rect.y, rect.width, rect.height);
  }

  private drawRadialMap(): void {
    const context = this.context;
    const model = this.model;
    context.strokeStyle = COLORS.line;
    context.fillStyle = COLORS.muted;
    context.lineWidth = 2;
    context.font = '600 16px system-ui, sans-serif';

    const rings = model?.distanceRings ?? [];
    for (const ring of rings) {
      const radius = MAP_DRAWABLE_RADIUS_PX * ring.normalizedRadius;
      context.beginPath();
      context.arc(MAP_CENTER.x, MAP_CENTER.y, radius, 0, Math.PI * 2);
      context.stroke();
      context.fillText(ring.distanceText, MAP_CENTER.x + radius + 6, MAP_CENTER.y - 6);
    }

    context.fillStyle = COLORS.text;
    context.font = '700 20px system-ui, sans-serif';
    context.fillText('N', MAP_CENTER.x - 7, MAP_CENTER.y - MAP_DRAWABLE_RADIUS_PX - 18);
    context.fillText('E', MAP_CENTER.x + MAP_DRAWABLE_RADIUS_PX + 12, MAP_CENTER.y + 7);
    context.fillText('S', MAP_CENTER.x - 7, MAP_CENTER.y + MAP_DRAWABLE_RADIUS_PX + 28);
    context.fillText('W', MAP_CENTER.x - MAP_DRAWABLE_RADIUS_PX - 32, MAP_CENTER.y + 7);

    context.strokeStyle = COLORS.accent;
    context.lineWidth = 3;
    context.beginPath();
    context.arc(MAP_CENTER.x, MAP_CENTER.y, 9, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.moveTo(MAP_CENTER.x - 14, MAP_CENTER.y);
    context.lineTo(MAP_CENTER.x + 14, MAP_CENTER.y);
    context.moveTo(MAP_CENTER.x, MAP_CENTER.y - 14);
    context.lineTo(MAP_CENTER.x, MAP_CENTER.y + 14);
    context.stroke();

    if (model === null) {
      return;
    }
    const ordered = model.markers
      .map((marker, index) => ({ marker, index, layer: markerLayer(marker, this.hoveredRecordingId) }))
      .sort((left, right) => left.layer - right.layer || left.index - right.index);
    for (const { marker } of ordered) {
      this.drawMarker(model, marker);
    }
  }

  private drawMarker(model: MapPanelModel, marker: MapMarkerModel): void {
    if (!Number.isFinite(marker.xPx) || !Number.isFinite(marker.yPx)) {
      return;
    }
    const context = this.context;
    const hovered = marker.recordingId === this.hoveredRecordingId || marker.state === 'hovered';
    const selected =
      marker.state === 'selected' ||
      marker.state === 'loading' ||
      marker.state === 'playing' ||
      marker.state === 'failed';
    const outlineRadius = hovered || selected ? 11 : MARKER_VISUAL_RADIUS_PX;

    context.save();
    context.lineWidth = selected ? 4 : hovered ? 3 : 2;
    context.strokeStyle = marker.state === 'failed'
      ? COLORS.error
      : selected
        ? COLORS.selected
        : hovered
          ? COLORS.accent
          : COLORS.line;
    context.fillStyle = !marker.enabled
      ? COLORS.disabled
      : marker.state === 'failed'
        ? COLORS.error
        : marker.state === 'loading'
          ? COLORS.warning
          : marker.state === 'playing'
            ? COLORS.accent
            : selected
              ? COLORS.selected
              : COLORS.accent;
    if (!marker.enabled || marker.state === 'disabled') {
      context.beginPath();
      context.moveTo(marker.xPx - outlineRadius, marker.yPx - outlineRadius);
      context.lineTo(marker.xPx + outlineRadius, marker.yPx + outlineRadius);
      context.moveTo(marker.xPx + outlineRadius, marker.yPx - outlineRadius);
      context.lineTo(marker.xPx - outlineRadius, marker.yPx + outlineRadius);
      context.stroke();
    } else if (marker.state === 'failed') {
      context.beginPath();
      context.arc(marker.xPx, marker.yPx, outlineRadius, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.moveTo(marker.xPx - 6, marker.yPx - 6);
      context.lineTo(marker.xPx + 6, marker.yPx + 6);
      context.moveTo(marker.xPx + 6, marker.yPx - 6);
      context.lineTo(marker.xPx - 6, marker.yPx + 6);
      context.stroke();
    } else if (marker.state === 'playing') {
      context.beginPath();
      context.moveTo(marker.xPx - 7, marker.yPx - 10);
      context.lineTo(marker.xPx + 10, marker.yPx);
      context.lineTo(marker.xPx - 7, marker.yPx + 10);
      context.lineTo(marker.xPx - 7, marker.yPx - 10);
      context.fill();
      context.stroke();
    } else if (marker.state === 'loading') {
      context.beginPath();
      context.arc(marker.xPx, marker.yPx, outlineRadius, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.arc(marker.xPx, marker.yPx, 3, 0, Math.PI * 2);
      context.fill();
    } else if (selected) {
      context.beginPath();
      context.moveTo(marker.xPx, marker.yPx - outlineRadius);
      context.lineTo(marker.xPx + outlineRadius, marker.yPx);
      context.lineTo(marker.xPx, marker.yPx + outlineRadius);
      context.lineTo(marker.xPx - outlineRadius, marker.yPx);
      context.lineTo(marker.xPx, marker.yPx - outlineRadius);
      context.fill();
      context.stroke();
    } else {
      context.beginPath();
      context.arc(marker.xPx, marker.yPx, MARKER_VISUAL_RADIUS_PX, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }

    if (hovered || selected) {
      const disabledSuffix = !marker.enabled ? ' — Unsupported audio type' : '';
      const label = fitText(context, `${markerLabel(model, marker)}${disabledSuffix}`, 260);
      context.font = '600 15px system-ui, sans-serif';
      context.fillStyle = COLORS.background;
      context.fillRect(marker.xPx + 13, marker.yPx - 23, context.measureText(label).width + 12, 24);
      context.fillStyle = marker.enabled ? COLORS.text : COLORS.muted;
      context.fillText(label, marker.xPx + 19, marker.yPx - 6);
    }
    context.restore();
  }

  private drawDetails(): void {
    const context = this.context;
    const model = this.model;
    const selected = model?.selected;
    context.fillStyle = COLORS.text;
    context.font = '700 24px system-ui, sans-serif';
    context.fillText(
      fitText(context, selected?.title ?? 'Select a recording', SELECTED_DETAIL_RECT.width),
      SELECTED_DETAIL_RECT.x,
      138,
    );
    context.font = '500 16px system-ui, sans-serif';
    context.fillStyle = COLORS.muted;
    if (selected !== undefined) {
      const detailLines = [
        `${selected.latitudeText}, ${selected.longitudeText}`,
        selected.distanceText,
        selected.bearingText,
        selected.description ?? '',
        selected.credit === undefined ? '' : `Credit: ${selected.credit}`,
      ].filter((line) => line.length > 0);
      detailLines.forEach((line, index) => {
        context.fillText(fitText(context, line, SELECTED_DETAIL_RECT.width), SELECTED_DETAIL_RECT.x, 174 + index * 30);
      });
    }

    const playback = model?.playback ?? { state: 'empty', currentTimeSec: 0 };
    const duration = playback.durationSec;
    const progress = duration !== undefined && Number.isFinite(duration) && duration > 0
      ? Math.min(1, Math.max(0, playback.currentTimeSec / duration))
      : 0;
    context.fillStyle = COLORS.line;
    context.fillRect(PROGRESS_RECT.x, PROGRESS_RECT.y + 18, PROGRESS_RECT.width, 8);
    context.fillStyle = COLORS.accent;
    context.fillRect(PROGRESS_RECT.x, PROGRESS_RECT.y + 18, PROGRESS_RECT.width * progress, 8);
    context.fillStyle = COLORS.text;
    context.font = '600 14px system-ui, sans-serif';
    context.fillText(
      `${playback.state}  ${formatTime(playback.currentTimeSec)} / ${formatTime(duration)}`,
      PROGRESS_RECT.x,
      PROGRESS_RECT.y + 13,
    );
  }

  private drawControls(): void {
    const context = this.context;
    const model = this.model;
    for (const control of MAP_CONTROLS) {
      if (model?.xrControlsVisible === false && (
        control.id === 'exit-xr' ||
        control.id === 'recenter' ||
        control.id === 'recalibrate'
      )) {
        continue;
      }
      const active = model?.calibrationReady !== false || control.id === 'exit-xr';
      context.fillStyle = active ? COLORS.panel : COLORS.background;
      context.strokeStyle = active ? COLORS.line : COLORS.disabled;
      context.lineWidth = 2;
      context.fillRect(control.rect.x, control.rect.y, control.rect.width, control.rect.height);
      context.strokeRect(control.rect.x, control.rect.y, control.rect.width, control.rect.height);
      context.fillStyle = active ? COLORS.text : COLORS.disabled;
      context.font = '600 15px system-ui, sans-serif';
      const label = control.id === 'play-pause' && model !== null
        ? playbackControlLabel(model.playback)
        : control.label;
      context.fillText(
        fitText(context, label, control.rect.width - 16),
        control.rect.x + 8,
        control.rect.y + 34,
      );
    }
    context.fillStyle = COLORS.muted;
    context.font = '500 14px system-ui, sans-serif';
    context.fillText(`Volume ${Math.round((model?.masterGain ?? 0.7) * 10) / 10}`, 868, 642);
  }

  private drawFooter(): void {
    const context = this.context;
    const model = this.model;
    const overlap = model?.overlapCycle ?? this.internalOverlapCycle ?? undefined;
    let status = model?.xrControlsVisible === false
      ? ''
      : model?.calibrationReady === false
        ? 'Face true north and press trigger to calibrate.'
        : model?.controllerAvailable === false
          ? 'No tracked controller. Use the Quest system control to exit Mixed Reality.'
          : '';
    if (overlap !== undefined && overlap.count > 1) {
      status = `item ${overlap.index + 1} of ${overlap.count}`;
    }
    if (this.hoveredRecordingId !== null) {
      const hovered = model?.markers.find((marker) => marker.recordingId === this.hoveredRecordingId);
      if (hovered?.enabled === false) {
        status = 'Unsupported audio type';
      }
    }
    if (model?.warningText !== undefined) {
      status = model.warningText;
      context.fillStyle = COLORS.warning;
    } else if (model?.errorCode !== undefined) {
      status = model.errorCode;
      context.fillStyle = COLORS.error;
    } else {
      context.fillStyle = COLORS.muted;
    }
    context.font = '500 14px system-ui, sans-serif';
    context.fillText(fitText(context, status, FOOTER_RECT.width - 40), 20, 762);
  }
}

export const createMapPanel: CreateMapPanel = (scene) => new CanvasMapPanel(scene);
