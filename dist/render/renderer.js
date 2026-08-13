import { ORGANELLE_COLORS } from '../sim/types.js';
import { isHydrophobic } from '../chem/elements.js';
function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}
const NUCLEOTIDE_COLOR = {
    // A common nucleotide-viewer convention (green/red/blue/yellow), not
    // invented for this project.
    A: '#5ad46a',
    U: '#e6584f',
    G: '#4f8cff',
    C: '#f5c542',
};
const CATALYST_COLOR = {
    replicase: '#c77dff',
    peptidyl: '#3fae5a',
    protease: '#e6584f',
    lipidsynthase: '#f5a623',
};
/**
 * One canvas, one camera, one continuous world. Life doesn't start on a
 * different screen from the one it goes on to live in — the primordial
 * pool (Origin's chemistry) is drawn as a real region *within* the dish,
 * at `poolOffset`, and whatever emerges from it just keeps existing in
 * the same space, swimming out into the wider dish as an ordinary
 * Virtunism. See main.ts for where a bootstrapped protocell actually
 * gets placed relative to the pool.
 */
export class Renderer {
    constructor(canvas) {
        this.dpr = 1;
        this.animT = 0; // free-running frame counter, drives flagella wiggle / energy pulse
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
    draw(world, origin, poolOffset, options = {}) {
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
        this.drawPool(origin, poolOffset);
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
            if (!cell.attachedTo)
                continue;
            const a = this.worldToScreen(cell.x, cell.y);
            const b = this.worldToScreen(cell.attachedTo.x, cell.attachedTo.y);
            ctx.lineWidth = Math.max(1, Math.min(cell.radius, cell.attachedTo.radius) * 0.5 * this.camera.zoom);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
        }
        let highlighted = null;
        for (const cell of world.cells) {
            const p = this.worldToScreen(cell.x, cell.y);
            const r = cell.radius * this.camera.zoom;
            if (cell.id === options.highlightId)
                highlighted = { cell, p, r };
            if (p.x < -r || p.y < -r || p.x > this.viewportWidth + r || p.y > this.viewportHeight + r)
                continue;
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
    /** The primordial pool: a real region within the same dish, not a
     * separate world. Amino acids, nucleotides, lipids and everything they
     * build sit here at `poolOffset` + their own local coordinates. */
    drawPool(origin, poolOffset) {
        const ctx = this.ctx;
        const topLeft = this.worldToScreen(poolOffset.x, poolOffset.y);
        const bottomRight = this.worldToScreen(poolOffset.x + origin.width, poolOffset.y + origin.height);
        const w = bottomRight.x - topLeft.x;
        const h = bottomRight.y - topLeft.y;
        if (topLeft.x > this.viewportWidth || topLeft.y > this.viewportHeight || bottomRight.x < 0 || bottomRight.y < 0)
            return;
        ctx.fillStyle = 'rgba(120, 90, 40, 0.12)';
        ctx.fillRect(topLeft.x, topLeft.y, w, h);
        ctx.strokeStyle = 'rgba(245, 200, 120, 0.3)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(topLeft.x, topLeft.y, w, h);
        for (const v of origin.vesicles.values()) {
            const p = this.worldToScreen(poolOffset.x + v.x, poolOffset.y + v.y);
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
            const s = this.worldToScreen(poolOffset.x + p.x, poolOffset.y + p.y);
            if (s.x < topLeft.x - 5 || s.y < topLeft.y - 5 || s.x > bottomRight.x + 5 || s.y > bottomRight.y + 5)
                continue;
            if (p.kind === 'aa') {
                const r = Math.max(1, 1.6 * this.camera.zoom * 0.4);
                ctx.fillStyle = isHydrophobic(p.code) ? 'rgba(230,140,90,0.85)' : 'rgba(120,170,235,0.85)';
                ctx.beginPath();
                ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
                ctx.fill();
            }
            else if (p.kind === 'nt') {
                const r = Math.max(1, 1.6 * this.camera.zoom * 0.4);
                ctx.fillStyle = NUCLEOTIDE_COLOR[p.code] ?? '#ccc';
                ctx.beginPath();
                ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
                ctx.fill();
            }
            else if (p.kind === 'lipid') {
                const r = Math.max(1, 1.4 * this.camera.zoom * 0.4);
                ctx.fillStyle = 'rgba(245, 220, 160, 0.75)';
                ctx.beginPath();
                ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
                ctx.fill();
            }
            else if (p.kind === 'energy') {
                const r = Math.max(1, 1.3 * this.camera.zoom * 0.4);
                const pulse = 0.6 + 0.4 * Math.sin(this.animT * 0.3 + p.id);
                ctx.fillStyle = `rgba(255, 240, 120, ${0.4 + pulse * 0.5})`;
                ctx.beginPath();
                ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
                ctx.fill();
            }
            else if (p.kind === 'peptide') {
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
            }
            else if (p.kind === 'rna') {
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
    }
    drawCell(cell, p, r, showVision) {
        const ctx = this.ctx;
        // eyes: each eye's own vision cone, drawn behind the body as a faint
        // headlight so a cell's actual coverage — not just a label — is visible.
        if (showVision) {
            for (const o of cell.genome.organelles) {
                if (o.kind !== 'eye')
                    continue;
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
            if (o.kind !== 'flagellum')
                continue;
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
            if (o.kind !== 'armor')
                continue;
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
            if (o.kind !== 'chloroplast')
                continue;
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
            if (o.kind !== 'eye')
                continue;
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
            if (o.kind !== 'bud')
                continue;
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
            if (o.kind !== 'mouth')
                continue;
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
