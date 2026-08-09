import { DIET_COLORS } from '../sim/types.js';
function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}
export class Renderer {
    constructor(canvas) {
        this.dpr = 1;
        this.camera = { x: 0, y: 0, zoom: 1 };
        this.canvas = canvas;
        const ctx = canvas.getContext('2d');
        if (!ctx)
            throw new Error('Canvas 2D context unavailable');
        this.ctx = ctx;
    }
    resize() {
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);
        const rect = this.canvas.getBoundingClientRect();
        this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
        this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    }
    get viewportWidth() {
        return this.canvas.width / this.dpr;
    }
    get viewportHeight() {
        return this.canvas.height / this.dpr;
    }
    fitToWorld(world) {
        const margin = 0.92;
        const zoomX = (this.viewportWidth / world.width) * margin;
        const zoomY = (this.viewportHeight / world.height) * margin;
        this.camera.zoom = Math.min(zoomX, zoomY);
        this.camera.x = world.width / 2;
        this.camera.y = world.height / 2;
    }
    panByScreenDelta(dxScreen, dyScreen) {
        this.camera.x -= dxScreen / this.camera.zoom;
        this.camera.y -= dyScreen / this.camera.zoom;
    }
    zoomAt(screenX, screenY, factor) {
        const before = this.screenToWorld(screenX, screenY);
        this.camera.zoom = clamp(this.camera.zoom * factor, 0.08, 4);
        const after = this.screenToWorld(screenX, screenY);
        this.camera.x += before.x - after.x;
        this.camera.y += before.y - after.y;
    }
    screenToWorld(sx, sy) {
        return {
            x: this.camera.x + (sx - this.viewportWidth / 2) / this.camera.zoom,
            y: this.camera.y + (sy - this.viewportHeight / 2) / this.camera.zoom,
        };
    }
    worldToScreen(x, y) {
        return {
            x: this.viewportWidth / 2 + (x - this.camera.x) * this.camera.zoom,
            y: this.viewportHeight / 2 + (y - this.camera.y) * this.camera.zoom,
        };
    }
    draw(world, options = {}) {
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
            if (p.x < -r || p.y < -r || p.x > this.viewportWidth + r || p.y > this.viewportHeight + r)
                continue;
            // "eyes": the vision cone this cell actually senses through, drawn
            // behind everything else so it reads as a faint headlight rather than
            // clutter. Full 360° cells skip this (there's no cone to show).
            if (options.showVision && cell.genome.visionAngle < 359.9) {
                const halfFov = ((cell.genome.visionAngle * Math.PI) / 180) * 0.5;
                const rangePx = cell.genome.senseRadius * this.camera.zoom;
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
                ctx.arc(p.x, p.y, rangePx, cell.heading - halfFov, cell.heading + halfFov);
                ctx.closePath();
                ctx.fillStyle = 'rgba(255, 240, 160, 0.05)';
                ctx.fill();
                ctx.strokeStyle = 'rgba(255, 240, 160, 0.18)';
                ctx.lineWidth = 1;
                ctx.stroke();
            }
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
            // "mouth": a notch at the front, sized by genome.mouthSize — this is
            // the same trait that changes bite size and effective prey range.
            const mouthHalfAngle = 0.16 + cell.genome.mouthSize * 0.12;
            const mouthDepth = r * (0.35 + cell.genome.mouthSize * 0.25);
            const tipX = p.x + Math.cos(cell.heading) * (r + mouthDepth * 0.4);
            const tipY = p.y + Math.sin(cell.heading) * (r + mouthDepth * 0.4);
            const baseAX = p.x + Math.cos(cell.heading - mouthHalfAngle) * r;
            const baseAY = p.y + Math.sin(cell.heading - mouthHalfAngle) * r;
            const baseBX = p.x + Math.cos(cell.heading + mouthHalfAngle) * r;
            const baseBY = p.y + Math.sin(cell.heading + mouthHalfAngle) * r;
            ctx.beginPath();
            ctx.moveTo(baseAX, baseAY);
            ctx.lineTo(tipX, tipY);
            ctx.lineTo(baseBX, baseBY);
            ctx.closePath();
            ctx.fillStyle = 'rgba(10, 15, 25, 0.75)';
            ctx.fill();
            // sexual-reproduction marker: a small pale core, roughly a "nucleus"
            if (cell.genome.reproductionMode === 'sexual') {
                ctx.beginPath();
                ctx.arc(p.x, p.y, Math.max(1, r * 0.28), 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(255,255,255,0.55)';
                ctx.fill();
            }
        }
        ctx.restore();
    }
}
