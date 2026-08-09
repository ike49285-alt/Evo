import { World } from '../sim/world.js';
import { DIET_COLORS } from '../sim/types.js';

interface Camera {
  x: number; // world-space point shown at screen center
  y: number;
  zoom: number; // screen pixels per world unit
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  camera: Camera = { x: 0, y: 0, zoom: 1 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
  }

  get viewportWidth(): number {
    return this.canvas.width / this.dpr;
  }

  get viewportHeight(): number {
    return this.canvas.height / this.dpr;
  }

  fitToWorld(world: World): void {
    const margin = 0.92;
    const zoomX = (this.viewportWidth / world.width) * margin;
    const zoomY = (this.viewportHeight / world.height) * margin;
    this.camera.zoom = Math.min(zoomX, zoomY);
    this.camera.x = world.width / 2;
    this.camera.y = world.height / 2;
  }

  panByScreenDelta(dxScreen: number, dyScreen: number): void {
    this.camera.x -= dxScreen / this.camera.zoom;
    this.camera.y -= dyScreen / this.camera.zoom;
  }

  zoomAt(screenX: number, screenY: number, factor: number): void {
    const before = this.screenToWorld(screenX, screenY);
    this.camera.zoom = clamp(this.camera.zoom * factor, 0.08, 4);
    const after = this.screenToWorld(screenX, screenY);
    this.camera.x += before.x - after.x;
    this.camera.y += before.y - after.y;
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: this.camera.x + (sx - this.viewportWidth / 2) / this.camera.zoom,
      y: this.camera.y + (sy - this.viewportHeight / 2) / this.camera.zoom,
    };
  }

  private worldToScreen(x: number, y: number): { x: number; y: number } {
    return {
      x: this.viewportWidth / 2 + (x - this.camera.x) * this.camera.zoom,
      y: this.viewportHeight / 2 + (y - this.camera.y) * this.camera.zoom,
    };
  }

  draw(world: World): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, this.viewportWidth, this.viewportHeight);

    // dish boundary
    const topLeft = this.worldToScreen(0, 0);
    const bottomRight = this.worldToScreen(world.width, world.height);
    ctx.fillStyle = '#0f1c30';
    ctx.fillRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
    ctx.strokeStyle = 'rgba(120,160,220,0.35)';
    ctx.lineWidth = 2;
    ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);

    // plant food
    ctx.fillStyle = '#3fae5a';
    for (const f of world.plantFood) {
      const p = this.worldToScreen(f.x, f.y);
      const r = Math.max(1.2, f.radius * this.camera.zoom);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // meat food (corpses / carrion)
    ctx.fillStyle = '#b5502f';
    for (const f of world.meatFood) {
      const p = this.worldToScreen(f.x, f.y);
      const r = Math.max(1.5, f.radius * this.camera.zoom);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // cells
    for (const cell of world.cells) {
      const p = this.worldToScreen(cell.x, cell.y);
      const r = cell.radius * this.camera.zoom;
      if (p.x < -r || p.y < -r || p.x > this.viewportWidth + r || p.y > this.viewportHeight + r) continue;

      const energyFrac = clamp(cell.energy / cell.maxEnergy, 0.15, 1);
      const lightness = 30 + energyFrac * 30;
      ctx.fillStyle = `hsl(${cell.genome.hue}, 65%, ${lightness}%)`;

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.lineWidth = Math.max(1, r * 0.18);
      ctx.strokeStyle = DIET_COLORS[cell.genome.diet];
      ctx.stroke();

      if (cell.isPlayerDesigned) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 2, 0, Math.PI * 2);
        ctx.stroke();
      }

      // heading indicator
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = Math.max(1, r * 0.15);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + Math.cos(cell.heading) * (r + 4), p.y + Math.sin(cell.heading) * (r + 4));
      ctx.stroke();
    }

    ctx.restore();
  }
}
