import { CATALYSIS_CLASS_COLORS } from '../sim/types.js';
import { hasBud } from '../sim/genome.js';
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
    // motor/photoreceptor peptides can fold in the primordial pool same as
    // any other (the fold doesn't know it's "supposed" to be a Virtunism-
    // only class) — Stage 0's own reaction chemistry just never checks for
    // these two, so they're cosmetically catalytic-looking but functionally
    // inert there. Still needs a real color for this exhaustive lookup.
    motor: '#cdd8ee',
    photoreceptor: '#fefefe',
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
/** Screen radius below which an organism is drawn as a plain dot rather
 * than full anatomy. At this size the anatomy is sub-pixel anyway. */
const LOD_RADIUS_PX = 3.5;
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
    draw(world, origin, poolOffset, 
    // hidePool: once Stage 0 retires, origin.update() stops running (see
    // main.ts's frame loop) but the pool's last real state is still sitting
    // there — drawing it forever after would mean a permanently frozen
    // (and, once a population is old enough, potentially oversized —
    // vesicles keep whatever state they had at the instant retirement
    // fired) pool cluttering the view for a stage that's not coming back.
    options = {}) {
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
        // A faint reference grid, clipped to the dish — the dish's own fill
        // (`#0f1c30`) is only barely lighter than the canvas background behind
        // it (`#0b1220`), so a zoomed-in view of any genuinely empty stretch of
        // the dish (there's a lot of one early on: the population starts at
        // zero and the pool itself only covers a fraction of the space) reads
        // as flat, featureless nothing — indistinguishable from having scrolled
        // clean off the world, even though the camera math is working
        // correctly. This exists purely so "empty" still visibly reads as
        // "inside the dish, currently empty" at any zoom level, not "did
        // something break." Spaced at a fixed *world* interval (not a fixed
        // screen interval) so it also doubles as a real distance reference:
        // the physical size of a grid cell doesn't change as you zoom.
        const gridStep = 200;
        ctx.save();
        ctx.beginPath();
        ctx.rect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
        ctx.clip();
        ctx.strokeStyle = 'rgba(120,160,220,0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let gx = 0; gx <= world.width; gx += gridStep) {
            const p = this.worldToScreen(gx, 0);
            ctx.moveTo(p.x, topLeft.y);
            ctx.lineTo(p.x, bottomRight.y);
        }
        for (let gy = 0; gy <= world.height; gy += gridStep) {
            const p = this.worldToScreen(0, gy);
            ctx.moveTo(topLeft.x, p.y);
            ctx.lineTo(bottomRight.x, p.y);
        }
        ctx.stroke();
        ctx.restore();
        // The light field, painted under everything. Without this the dish's
        // terrain is invisible: organisms cluster in bright regions and avoid
        // dark ones for reasons the player has no way to see, which reads as
        // unexplained clumping rather than as habitat.
        //
        // Drawn as one rectangle per simulation region, not sub-sampled into a
        // smooth gradient. The sim samples this field per region, so a smoother
        // picture would be a prettier lie about where the boundaries actually
        // are — and the boundaries are the whole point, since they are what a
        // population spreads along.
        if (typeof world.lightAt === 'function' && world.lightCols > 0) {
            const rw = world.width / world.lightCols;
            const rh = world.height / world.lightRows;
            for (let ry = 0; ry < world.lightRows; ry++) {
                for (let rx = 0; rx < world.lightCols; rx++) {
                    const a = this.worldToScreen(rx * rw, ry * rh);
                    const b = this.worldToScreen((rx + 1) * rw, (ry + 1) * rh);
                    if (b.x < 0 || b.y < 0 || a.x > this.viewportWidth || a.y > this.viewportHeight)
                        continue;
                    // Centred on 1.0 = average light, so brighter regions warm up and
                    // dimmer ones sink toward the background rather than being tinted
                    // a colour the dish does not otherwise use.
                    const k = Math.max(-1, Math.min(1, (world.lightAt((rx + 0.5) * rw, (ry + 0.5) * rh) - 1) * 1.1));
                    ctx.fillStyle = k >= 0
                        ? `rgba(255, 238, 175, ${(k * 0.26).toFixed(3)})`
                        : `rgba(3, 6, 14, ${(-k * 0.45).toFixed(3)})`;
                    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
                }
            }
        }
        if (!options.hidePool)
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
        // Level of detail. drawCell renders real anatomy — body, eyes, buds,
        // flagella, protein arcs, armour — which is 5-15 canvas operations per
        // organism. That is fine for a few hundred and impossible for several
        // thousand: Canvas 2D will not hold a frame rate at ~100k operations.
        //
        // Below LOD_RADIUS_PX an organism is a few pixels across and every one
        // of those details is already sub-pixel, so nothing is actually lost by
        // drawing a single dot. Batched by fill colour is tempting but the hue
        // is per-genome and varies continuously, so this keeps one fill per
        // organism and simply makes each one cheap.
        for (const cell of world.cells) {
            const p = this.worldToScreen(cell.x, cell.y);
            const r = cell.radius * this.camera.zoom;
            if (cell.id === options.highlightId)
                highlighted = { cell, p, r };
            if (p.x < -r || p.y < -r || p.x > this.viewportWidth + r || p.y > this.viewportHeight + r)
                continue;
            if (r < LOD_RADIUS_PX) {
                const energyFrac = clamp(cell.energy / cell.maxEnergy, 0.15, 1);
                ctx.fillStyle = `hsl(${cell.genome.hue}, 65%, ${30 + energyFrac * 30}%)`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, Math.max(0.6, r), 0, Math.PI * 2);
                ctx.fill();
                continue;
            }
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
    /** The primordial pool: not a separate world, and — as of Phase B —
     * not even a distinguished sub-region of the dish anymore. Origin's
     * own coordinate space is now coextensive with World's (poolOffset is
     * always {0,0}), so there's no longer a smaller rectangle to tint or
     * border here (that used to draw the exact same rect as the dish
     * boundary already drawn just before this call, once the two spaces
     * became the same size — removed rather than left as a redundant
     * full-screen wash). The vent marker and the particles/vesicles
     * themselves are what still say "chemistry lives here." Amino acids,
     * nucleotides, lipids and everything they build sit here at
     * `poolOffset` + their own local coordinates. */
    drawPool(origin, poolOffset) {
        const ctx = this.ctx;
        const topLeft = this.worldToScreen(poolOffset.x, poolOffset.y);
        const bottomRight = this.worldToScreen(poolOffset.x + origin.width, poolOffset.y + origin.height);
        // Origin and World are the same size now, so this is effectively
        // always false in practice — kept as a real safety net (not deleted)
        // in case a future Origin is ever smaller than its World again.
        if (topLeft.x > this.viewportWidth || topLeft.y > this.viewportHeight || bottomRight.x < 0 || bottomRight.y < 0)
            return;
        // The vent — a visual confirmation the mechanic is actually doing
        // something, not just a number in the chemistry stats. A hot
        // orange/red glow (distinct from the cooler pale-gold/purple palette
        // everything else in the pool uses) reusing the same pulse technique
        // energy particles already use below.
        if (origin.vent) {
            const vp = this.worldToScreen(poolOffset.x + origin.vent.x, poolOffset.y + origin.vent.y);
            const pulse = 0.5 + 0.5 * Math.sin(this.animT * 0.15);
            const r = (4 + pulse * 2) * this.camera.zoom * 0.4;
            ctx.beginPath();
            ctx.arc(vp.x, vp.y, r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255, 110, 60, ${0.35 + pulse * 0.35})`;
            ctx.fill();
            ctx.strokeStyle = 'rgba(255, 160, 100, 0.6)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
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
        // photoreceptor-class proteins: each one's own vision cone, drawn
        // behind the body as a faint headlight so a cell's actual coverage —
        // not just a label — is visible. Real fold-derived strength, not a
        // hand-picked size, sets how wide the cone reads.
        if (showVision) {
            for (const pr of cell.genome.proteins) {
                if (pr.fold.catalysisClass !== 'photoreceptor')
                    continue;
                const halfFov = (((50 + pr.fold.catalysisStrength * 40) * Math.PI) / 180) * 0.5;
                const mountAngle = cell.heading + pr.angle;
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
        // motor-class proteins: wavy tails trailing the rim, wiggling faster
        // the harder the cell is currently pushing — same visual role
        // flagella organelles used to play, now driven by real fold strength.
        const wiggleSpeed = 0.25 + cell.speed * 2.5;
        for (const pr of cell.genome.proteins) {
            if (pr.fold.catalysisClass !== 'motor')
                continue;
            const strength = pr.fold.catalysisStrength;
            const mountAngle = cell.heading + pr.angle;
            const baseX = p.x + Math.cos(mountAngle) * r;
            const baseY = p.y + Math.sin(mountAngle) * r;
            const length = r * (1.1 + strength * 0.9);
            const wag = Math.sin(this.animT * wiggleSpeed + pr.angle * 3) * (0.25 + strength * 0.2);
            const perpAngle = mountAngle + Math.PI / 2;
            const tipX = baseX + Math.cos(mountAngle) * length + Math.cos(perpAngle) * wag * length * 0.35;
            const tipY = baseY + Math.sin(mountAngle) * length + Math.sin(perpAngle) * wag * length * 0.35;
            const midX = baseX + Math.cos(mountAngle) * length * 0.55 + Math.cos(perpAngle) * wag * length * 0.2;
            const midY = baseY + Math.sin(mountAngle) * length * 0.55 + Math.sin(perpAngle) * wag * length * 0.2;
            ctx.strokeStyle = CATALYSIS_CLASS_COLORS.motor;
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
        // lipidsynthase-class proteins: a thicker rim segment centered on the
        // protein's mount angle — real structural/membrane investment reading
        // as armor, same visual role the old armor organelle played.
        for (const pr of cell.genome.proteins) {
            if (pr.fold.catalysisClass !== 'lipidsynthase')
                continue;
            const strength = pr.fold.catalysisStrength;
            const mountAngle = cell.heading + pr.angle;
            const arcHalf = 0.35 + strength * 0.15;
            ctx.strokeStyle = CATALYSIS_CLASS_COLORS.lipidsynthase;
            ctx.lineWidth = Math.max(1.5, r * 0.32 * strength);
            ctx.beginPath();
            ctx.arc(p.x, p.y, r * 0.92, mountAngle - arcHalf, mountAngle + arcHalf);
            ctx.stroke();
        }
        // peptidyl-class proteins: small green discs embedded near the rim —
        // real anabolic/energy-capture investment, same visual role
        // chloroplasts used to play.
        for (const pr of cell.genome.proteins) {
            if (pr.fold.catalysisClass !== 'peptidyl')
                continue;
            const strength = pr.fold.catalysisStrength;
            const mountAngle = cell.heading + pr.angle;
            const cx = p.x + Math.cos(mountAngle) * r * 0.62;
            const cy = p.y + Math.sin(mountAngle) * r * 0.62;
            ctx.beginPath();
            ctx.ellipse(cx, cy, r * 0.28 * strength, r * 0.18 * strength, mountAngle, 0, Math.PI * 2);
            ctx.fillStyle = CATALYSIS_CLASS_COLORS.peptidyl;
            ctx.fill();
        }
        // photoreceptor-class proteins: tiny dots at their mount point
        for (const pr of cell.genome.proteins) {
            if (pr.fold.catalysisClass !== 'photoreceptor')
                continue;
            const mountAngle = cell.heading + pr.angle;
            const ex = p.x + Math.cos(mountAngle) * r * 0.75;
            const ey = p.y + Math.sin(mountAngle) * r * 0.75;
            ctx.beginPath();
            ctx.arc(ex, ey, Math.max(0.9, r * 0.14), 0, Math.PI * 2);
            ctx.fillStyle = CATALYSIS_CLASS_COLORS.photoreceptor;
            ctx.fill();
        }
        // budding capability: a whole-cell marker (hasBud is a threshold on
        // aggregate replicase strength now, not a discrete organelle, so it
        // isn't tied to any one protein's own mount angle).
        if (hasBud(cell.genome)) {
            const mountAngle = cell.heading + Math.PI * 0.85;
            const bx = p.x + Math.cos(mountAngle) * r * 0.7;
            const by = p.y + Math.sin(mountAngle) * r * 0.7;
            ctx.beginPath();
            ctx.arc(bx, by, Math.max(1, r * 0.16), 0, Math.PI * 2);
            ctx.fillStyle = CATALYSIS_CLASS_COLORS.replicase;
            ctx.fill();
        }
        // protease-class proteins: a notch bitten into the rim at each one's
        // mount angle — real predation investment, same visual role mouths
        // used to play.
        for (const pr of cell.genome.proteins) {
            if (pr.fold.catalysisClass !== 'protease')
                continue;
            const strength = pr.fold.catalysisStrength;
            const mountAngle = cell.heading + pr.angle;
            const halfAngle = 0.16 + strength * 0.12;
            const depth = r * (0.35 + strength * 0.25);
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
            ctx.fillStyle = CATALYSIS_CLASS_COLORS.protease;
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
