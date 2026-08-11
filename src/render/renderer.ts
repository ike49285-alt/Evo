// Canvas2D renderer. Pure presentation — reads World state, draws it,
// touches nothing. Every visible shape traces back to genome data: the
// chassis is bodyPlan.radius, each organelle is drawn at its own
// angle/distance/size and color-coded by type.

import { World } from '../sim/world.js';
import { Organism } from '../sim/organism.js';
import { OrganelleType } from '../sim/genome.js';

const ORGANELLE_COLOR: Record<OrganelleType, string> = {
  mouth: '#e05c5c',
  chloroplast: '#4caf6e',
  flagellum: '#5c9ce0',
  eye: '#e0d15c',
  armor: '#9a9aa5',
};

export interface ViewTransform {
  offsetX: number;
  offsetY: number;
  zoom: number;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
  }

  render(world: World, view: ViewTransform, showVision: boolean): void {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.save();
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0c1712';
    ctx.fillRect(0, 0, width, height);

    ctx.translate(view.offsetX, view.offsetY);
    ctx.scale(view.zoom, view.zoom);

    this.drawDishBounds(world);

    for (const c of world.carrion) {
      ctx.beginPath();
      ctx.fillStyle = 'rgba(150, 120, 90, 0.6)';
      ctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const org of world.organisms) {
      this.drawOrganism(org, showVision);
    }

    ctx.restore();
  }

  private drawDishBounds(world: World): void {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, world.width, world.height);
  }

  private drawOrganism(org: Organism, showVision: boolean): void {
    const ctx = this.ctx;
    const { bodyPlan, hue } = org.genome;

    ctx.save();
    ctx.translate(org.x, org.y);

    if (showVision && org.stats.visionRange > 0) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      const half = org.stats.visionArc / 2;
      ctx.arc(0, 0, org.stats.visionRange, org.heading - half, org.heading + half);
      ctx.closePath();
      ctx.fillStyle = 'rgba(224, 209, 92, 0.06)';
      ctx.fill();
    }

    ctx.rotate(org.heading);

    // Organelles first (drawn under the chassis rim so the chassis reads as the body).
    for (const o of bodyPlan.organelles) {
      const ox = Math.cos(o.angle) * bodyPlan.radius * o.distance;
      const oy = Math.sin(o.angle) * bodyPlan.radius * o.distance;
      ctx.beginPath();
      ctx.fillStyle = ORGANELLE_COLOR[o.type];
      ctx.arc(ox, oy, Math.max(1, o.size), 0, Math.PI * 2);
      ctx.fill();
    }

    // Chassis.
    ctx.beginPath();
    ctx.fillStyle = `hsl(${hue}, 55%, 45%)`;
    ctx.strokeStyle = `hsl(${hue}, 55%, 70%)`;
    ctx.lineWidth = 1;
    ctx.arc(0, 0, bodyPlan.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Heading tick, so direction reads at a glance even without organelles.
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.moveTo(0, 0);
    ctx.lineTo(bodyPlan.radius + 3, 0);
    ctx.stroke();

    ctx.restore();
  }
}
