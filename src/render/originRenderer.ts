import { Origin } from '../chem/origin.js';
import { isHydrophobic } from '../chem/elements.js';
import { CatalysisClass } from '../chem/polymer.js';

interface Camera {
  x: number;
  y: number;
  zoom: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

const NUCLEOTIDE_COLOR: Record<string, string> = {
  // A common nucleotide-viewer convention (green/red/blue/yellow), not
  // invented for this project.
  A: '#5ad46a',
  U: '#e6584f',
  G: '#4f8cff',
  C: '#f5c542',
};

const CATALYST_COLOR: Record<CatalysisClass, string> = {
  replicase: '#c77dff',
  peptidyl: '#3fae5a',
  protease: '#e6584f',
  lipidsynthase: '#f5a623',
};

export class OriginRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private animT = 0;
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

  fitToWorld(origin: Origin): void {
    const margin = 0.94;
    this.camera.zoom = Math.min((this.viewportWidth / origin.width) * margin, (this.viewportHeight / origin.height) * margin);
    this.camera.x = origin.width / 2;
    this.camera.y = origin.height / 2;
  }

  panByScreenDelta(dx: number, dy: number): void {
    this.camera.x -= dx / this.camera.zoom;
    this.camera.y -= dy / this.camera.zoom;
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToWorld(sx, sy);
    this.camera.zoom = clamp(this.camera.zoom * factor, 0.15, 6);
    const after = this.screenToWorld(sx, sy);
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

  draw(origin: Origin): void {
    const ctx = this.ctx;
    this.animT += 1;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    ctx.fillStyle = '#070b12';
    ctx.fillRect(0, 0, this.viewportWidth, this.viewportHeight);

    const topLeft = this.worldToScreen(0, 0);
    const bottomRight = this.worldToScreen(origin.width, origin.height);
    ctx.fillStyle = '#0a1420';
    ctx.fillRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
    ctx.strokeStyle = 'rgba(120,160,220,0.3)';
    ctx.lineWidth = 2;
    ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);

    // Vesicle membranes first, so everything else draws on top of them.
    for (const v of origin.vesicles.values()) {
      const p = this.worldToScreen(v.x, v.y);
      const r = v.radius * this.camera.zoom;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(245, 220, 160, 0.05)';
      ctx.fill();
      ctx.strokeStyle = v.replicationEvents > 0 ? 'rgba(199, 125, 255, 0.55)' : 'rgba(245, 220, 160, 0.35)';
      ctx.lineWidth = Math.max(1, 1.5 * this.camera.zoom * 0.3);
      ctx.stroke();
    }

    for (const p of origin.particles.values()) {
      const s = this.worldToScreen(p.x, p.y);
      if (s.x < -20 || s.y < -20 || s.x > this.viewportWidth + 20 || s.y > this.viewportHeight + 20) continue;

      if (p.kind === 'aa') {
        const r = Math.max(1, 1.6 * this.camera.zoom * 0.4);
        ctx.fillStyle = isHydrophobic(p.code) ? 'rgba(230,140,90,0.85)' : 'rgba(120,170,235,0.85)';
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'nt') {
        const r = Math.max(1, 1.6 * this.camera.zoom * 0.4);
        ctx.fillStyle = NUCLEOTIDE_COLOR[p.code] ?? '#ccc';
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'lipid') {
        const r = Math.max(1, 1.4 * this.camera.zoom * 0.4);
        ctx.fillStyle = 'rgba(245, 220, 160, 0.75)';
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'energy') {
        const r = Math.max(1, 1.3 * this.camera.zoom * 0.4);
        const pulse = 0.6 + 0.4 * Math.sin(this.animT * 0.3 + p.id);
        ctx.fillStyle = `rgba(255, 240, 120, ${0.4 + pulse * 0.5})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'peptide') {
        const r = Math.max(1.5, (2 + Math.sqrt(p.sequence.length)) * this.camera.zoom * 0.4);
        const color = p.fold.isCatalyst && p.fold.catalysisClass ? CATALYST_COLOR[p.fold.catalysisClass] : 'rgba(180,180,190,0.7)';
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (p.fold.isCatalyst) {
          ctx.strokeStyle = 'rgba(255,255,255,0.6)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      } else if (p.kind === 'rna') {
        const r = Math.max(1.5, (2 + Math.sqrt(p.sequence.length)) * this.camera.zoom * 0.4);
        ctx.fillStyle = p.fold.isRibozyme ? 'rgba(199, 125, 255, 0.95)' : 'rgba(180, 150, 210, 0.6)';
        ctx.beginPath();
        // A small diamond distinguishes RNA from the round peptide dots at a glance.
        ctx.moveTo(s.x, s.y - r);
        ctx.lineTo(s.x + r, s.y);
        ctx.lineTo(s.x, s.y + r);
        ctx.lineTo(s.x - r, s.y);
        ctx.closePath();
        ctx.fill();
        if (p.copying) {
          ctx.strokeStyle = 'rgba(255,255,255,0.7)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }

    ctx.restore();
  }
}
