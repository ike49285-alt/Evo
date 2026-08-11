import { World } from '../sim/world.js';
import { ORGANELLE_COLORS } from '../sim/types.js';
import { Virtunism } from '../sim/virtunism.js';

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
  private animT = 0; // free-running frame counter, drives flagella wiggle
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

  draw(world: World, options: { showVision?: boolean; highlightId?: number | null } = {}): void {
    const ctx = this.ctx;
    this.animT += 1;
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

    // carrion — the only discrete food item; there's no ambient plant food
    ctx.fillStyle = '#b5502f';
    for (const f of world.meatFood) {
      const p = this.worldToScreen(f.x, f.y);
      const r = Math.max(1.5, f.radius * this.camera.zoom);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // bond membranes — draw first so cell bodies sit on top of the joints
    ctx.strokeStyle = 'rgba(220, 230, 245, 0.4)';
    for (const cell of world.cells) {
      if (!cell.attachedTo) continue;
      const a = this.worldToScreen(cell.x, cell.y);
      const b = this.worldToScreen(cell.attachedTo.x, cell.attachedTo.y);
      ctx.lineWidth = Math.max(1, Math.min(cell.radius, cell.attachedTo.radius) * 0.5 * this.camera.zoom);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    let highlighted: { cell: Virtunism; p: { x: number; y: number }; r: number } | null = null;
    for (const cell of world.cells) {
      const p = this.worldToScreen(cell.x, cell.y);
      const r = cell.radius * this.camera.zoom;
      if (cell.id === options.highlightId) highlighted = { cell, p, r };
      if (p.x < -r || p.y < -r || p.x > this.viewportWidth + r || p.y > this.viewportHeight + r) continue;
      this.drawCell(cell, p, r, !!options.showVision);
    }

    // Tree-of-life selection marker — drawn last so it's never occluded by
    // a neighbor, a slowly pulsing ring so it reads as "selected", not
    // just "player-designed" (which gets its own always-on thin ring).
    if (highlighted) {
      const pulse = 3 + Math.sin(this.animT * 0.12) * 1.5;
      ctx.strokeStyle = 'rgba(255, 220, 90, 0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(highlighted.p.x, highlighted.p.y, highlighted.r + 7 + pulse, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawCell(cell: Virtunism, p: { x: number; y: number }, r: number, showVision: boolean): void {
    const ctx = this.ctx;

    // eyes: each eye's own vision cone, drawn behind the body as a faint
    // headlight so a cell's actual coverage — not just a label — is visible.
    if (showVision) {
      for (const o of cell.genome.organelles) {
        if (o.kind !== 'eye') continue;
        const halfFov = (((50 + o.size * 40) * Math.PI) / 180) * 0.5;
        const mountAngle = cell.heading + o.angle;
        const rangePx = cell.genome.senseRadius * this.camera.zoom;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.arc(p.x, p.y, rangePx, mountAngle - halfFov, mountAngle + halfFov);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 240, 160, 0.05)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 240, 160, 0.16)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // flagella: wavy tails trailing the rim, wiggling faster the harder the
    // cell is currently pushing.
    const wiggleSpeed = 0.25 + cell.speed * 2.5;
    for (const o of cell.genome.organelles) {
      if (o.kind !== 'flagellum') continue;
      const mountAngle = cell.heading + o.angle;
      const baseX = p.x + Math.cos(mountAngle) * r;
      const baseY = p.y + Math.sin(mountAngle) * r;
      const length = r * (1.1 + o.size * 0.9);
      const wag = Math.sin(this.animT * wiggleSpeed + o.angle * 3) * (0.25 + o.size * 0.2);
      const perpAngle = mountAngle + Math.PI / 2;
      const tipX = baseX + Math.cos(mountAngle) * length + Math.cos(perpAngle) * wag * length * 0.35;
      const tipY = baseY + Math.sin(mountAngle) * length + Math.sin(perpAngle) * wag * length * 0.35;
      const midX = baseX + Math.cos(mountAngle) * length * 0.55 + Math.cos(perpAngle) * wag * length * 0.2;
      const midY = baseY + Math.sin(mountAngle) * length * 0.55 + Math.sin(perpAngle) * wag * length * 0.2;
      ctx.strokeStyle = ORGANELLE_COLORS.flagellum;
      ctx.lineWidth = Math.max(0.8, r * 0.12);
      ctx.beginPath();
      ctx.moveTo(baseX, baseY);
      ctx.quadraticCurveTo(midX, midY, tipX, tipY);
      ctx.stroke();
    }

    // body
    const energyFrac = clamp(cell.energy / cell.maxEnergy, 0.15, 1);
    const lightness = 30 + energyFrac * 30;
    ctx.fillStyle = `hsl(${cell.genome.hue}, 65%, ${lightness}%)`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.12);
    ctx.strokeStyle = 'rgba(8, 12, 20, 0.55)';
    ctx.stroke();

    if (cell.isPlayerDesigned) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 2, 0, Math.PI * 2);
      ctx.stroke();
    }

    // armor: a thicker rim segment centered on the organelle's mount angle
    for (const o of cell.genome.organelles) {
      if (o.kind !== 'armor') continue;
      const mountAngle = cell.heading + o.angle;
      const arcHalf = 0.35 + o.size * 0.15;
      ctx.strokeStyle = ORGANELLE_COLORS.armor;
      ctx.lineWidth = Math.max(1.5, r * 0.32 * o.size);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.92, mountAngle - arcHalf, mountAngle + arcHalf);
      ctx.stroke();
    }

    // chloroplasts: small green discs embedded near the rim
    for (const o of cell.genome.organelles) {
      if (o.kind !== 'chloroplast') continue;
      const mountAngle = cell.heading + o.angle;
      const cx = p.x + Math.cos(mountAngle) * r * 0.62;
      const cy = p.y + Math.sin(mountAngle) * r * 0.62;
      ctx.beginPath();
      ctx.ellipse(cx, cy, r * 0.28 * o.size, r * 0.18 * o.size, mountAngle, 0, Math.PI * 2);
      ctx.fillStyle = ORGANELLE_COLORS.chloroplast;
      ctx.fill();
    }

    // eyes: tiny dots at their mount point
    for (const o of cell.genome.organelles) {
      if (o.kind !== 'eye') continue;
      const mountAngle = cell.heading + o.angle;
      const ex = p.x + Math.cos(mountAngle) * r * 0.75;
      const ey = p.y + Math.sin(mountAngle) * r * 0.75;
      ctx.beginPath();
      ctx.arc(ex, ey, Math.max(0.9, r * 0.14), 0, Math.PI * 2);
      ctx.fillStyle = ORGANELLE_COLORS.eye;
      ctx.fill();
    }

    // bud gland: small marker showing this lineage can grow attached
    // offspring — distinct from the sexual-mode "nucleus" marker below.
    for (const o of cell.genome.organelles) {
      if (o.kind !== 'bud') continue;
      const mountAngle = cell.heading + o.angle;
      const bx = p.x + Math.cos(mountAngle) * r * 0.7;
      const by = p.y + Math.sin(mountAngle) * r * 0.7;
      ctx.beginPath();
      ctx.arc(bx, by, Math.max(1, r * 0.16), 0, Math.PI * 2);
      ctx.fillStyle = ORGANELLE_COLORS.bud;
      ctx.fill();
    }

    // mouths: a notch bitten into the rim at each mouth's mount angle
    for (const o of cell.genome.organelles) {
      if (o.kind !== 'mouth') continue;
      const mountAngle = cell.heading + o.angle;
      const halfAngle = 0.16 + o.size * 0.12;
      const depth = r * (0.35 + o.size * 0.25);
      const tipX = p.x + Math.cos(mountAngle) * (r + depth * 0.4);
      const tipY = p.y + Math.sin(mountAngle) * (r + depth * 0.4);
      const baseAX = p.x + Math.cos(mountAngle - halfAngle) * r;
      const baseAY = p.y + Math.sin(mountAngle - halfAngle) * r;
      const baseBX = p.x + Math.cos(mountAngle + halfAngle) * r;
      const baseBY = p.y + Math.sin(mountAngle + halfAngle) * r;
      ctx.beginPath();
      ctx.moveTo(baseAX, baseAY);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(baseBX, baseBY);
      ctx.closePath();
      ctx.fillStyle = ORGANELLE_COLORS.mouth;
      ctx.fill();
    }

    // sexual-reproduction marker: a small pale core, roughly a "nucleus"
    if (cell.genome.reproductionMode === 'sexual') {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1, r * 0.22), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fill();
    }
  }
}
