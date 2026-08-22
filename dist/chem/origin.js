/**
 * Stage 0: the primordial soup. This is the actual "start from amino
 * acids" simulation — free monomers Brownian-motion around a dish, bond
 * into polymers when energized collisions happen to work out, those
 * polymers fold (or don't), a lucky fold catalyzes more of the same
 * chemistry nearby, RNA that's long and structured enough starts
 * templating copies of itself (with the occasional copying error), lipids
 * self-assemble into membranes with no energy input at all, and a
 * replicator system that happens to end up enclosed in a membrane that
 * survives and divides is the first thing in this dish with real heredity.
 *
 * Same closed-loop philosophy as the organelle/Virtunism dish downstream
 * (see World in ../sim/world.ts): matter (amino acids, nucleotides,
 * lipids) is a fixed pool set at t=0 and only ever gets rearranged —
 * nothing is created from nothing except the energy flux itself (this
 * stage's "sunlight" — an abstracted stand-in for whatever real prebiotic
 * chemistry actually couples to: mineral-surface catalysis, hydrothermal
 * gradients, UV, lightning). Condensation reactions are endergonic in
 * water and consume a unit of that energy; hydrolysis runs the other way
 * for free, which is exactly why sustained polymerization needs a
 * continuous energy supply and not just proximity.
 */
import { SpatialGrid } from '../sim/grid.js';
import { Rng } from '../sim/rng.js';
import { AMINO_ACID_CODES, NUCLEOTIDE_CODES, NUCLEOTIDES, } from './elements.js';
import { refoldPeptide, refoldRna, } from './particle.js';
import { foldPeptide, foldRna } from './polymer.js';
import { DIVISION_LIPID_COUNT, isBootstrapEligible, MIN_VESICLE_LIPIDS, radiusForLipidCount, } from './vesicle.js';
function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}
const MIN_TEMPLATE_LENGTH = 6;
const MAX_POLYMER_LENGTH = 40; // a hard cap keeps fold search + memory bounded
export class Origin {
    constructor(width, height, seed) {
        this.particles = new Map();
        this.vesicles = new Map();
        this.tick = 0;
        this.history = [];
        this.perf = { lastTickMs: 0 };
        /** Every protocell that's ever crossed the bootstrap bar, most recent
         * last. main.ts drains this to offer a hand-off into the Virtunism dish. */
        this.bootstrapCandidates = [];
        /** Every completed templated-RNA-replication event, in or out of a
         * vesicle — this is the dish-wide total. `Vesicle.replicationEvents`
         * (see vesicle.ts) is a separate, narrower per-protocell count used
         * only for the bootstrap-eligibility bar, which specifically cares
         * whether heredity happened *inside* that vesicle. An earlier version
         * of this stat only summed the per-vesicle counts, so free-floating
         * replication (the overwhelming majority of it, since only a small
         * fraction of RNA ever ends up inside a vesicle) was invisible here —
         * worth flagging since it looked like replication "never completed" in
         * several verification runs when the real problem was this stat being
         * blind to it, not replication itself failing. */
        this.totalReplicationEvents = 0;
        // --- tunables --------------------------------------------------------
        this.bondRadius = 13;
        // Energy is checked over a wider radius than a literal monomer-monomer
        // collision — a "well-mixed local currency" assumption (real systems-
        // biology models usually treat fast-diffusing small metabolites like
        // ATP as well-mixed on reaction timescales rather than needing an exact
        // molecular collision), and empirically necessary: an early version that
        // required an energy particle within the same tight bondRadius as the
        // monomer pairing needed *two* independent low-probability coincidences
        // at once, and a 60,000-tick headless run across 5 seeds never produced
        // a peptide or RNA strand longer than 2 monomers as a result — real
        // dilute-solution abiogenesis is dogged by exactly this "concentration
        // problem", but a soup this thin doesn't make an interesting sandbox.
        this.catalystRadius = 26;
        // Raised from 0.05 as part of a modest, deliberate "make natural
        // abiogenesis actually reachable" calibration pass — see NOTES.md.
        // Left roughly 2x rather than pushed further so this stays a real
        // rare-event simulation, not a guaranteed-outcome one.
        this.baseCondensationRate = 0.1;
        this.baseHydrolysisRate = 0.0018;
        // Raised from 10 (up to ~16x now) as part of the same pass — a bigger
        // reward for a catalyst actually being present, without changing what
        // "present" means or how catalysts form in the first place.
        this.catalystBoost = 15; // a strong nearby catalyst multiplies bonding odds up to ~16x
        this.mutationRate = 0.03; // per-base chance a templated copy mispairs
        // Both raised together (not just the reaction rates above) — pushing
        // condensation/replication rates up without more energy throughput
        // would just shift the bottleneck onto energy availability instead of
        // actually removing it.
        this.energyCapacity = 200;
        this.energyFluxPerTick = 2.5; // expected new energy particles/tick (fractional, accumulated)
        this.lipidAssemblyRadius = 7;
        // Raised from 0.02 as part of the second abiogenesis-tuning pass (see
        // NOTES.md) — a vesicle's interior nucleotide/energy supply is
        // otherwise only whatever got trapped at formation plus whatever's
        // slowly diffused in since, so a working interior replicator can stall
        // on local depletion even with every reaction rate raised; a higher
        // exchange rate keeps it resupplied from the surrounding soup instead.
        this.membranePermeability = 0.035; // per-tick chance a small molecule crosses a nearby membrane
        // A real, headless-diagnosed gap in what the model represented: being
        // inside a vesicle was previously *only* a constraint (a smaller,
        // same-vesicle-only reaction candidate pool), with none of the actual
        // real-world advantage compartmentalization is supposed to provide —
        // protection from the open dilute solution, and local concentration of
        // whatever reactants did get trapped together. A dedicated diagnostic
        // (see NOTES.md) found this was the real bottleneck behind the whole
        // first tuning pass: across an 80,000-tick sweep, replication completed
        // reasonably often free-floating in the open soup, but no vesicle ever
        // once accumulated 2 completions *inside* itself. This multiplier
        // stacks with (doesn't replace) the existing replicase-catalyst boost —
        // applied only in templatedReplication(), only when the template
        // currently has a vesicleId.
        this.inVesicleReplicationBoost = 1.75;
        // Real fatty-acid protocells fuse on contact about as readily as they
        // divide (Zhu & Szostak 2009; Budin & Szostak 2011 growth/division
        // dynamics) — fission and fusion are both normal parts of real protocell
        // population dynamics, not just growth-then-split. Without this, two
        // protocells that each independently captured half of what a real
        // bootstrap needs (one a catalyst, one a replicator) had no way to ever
        // combine — a headless diagnostic (see NOTES.md) found a live catalyst
        // and a live replicator never once co-occurred inside the same vesicle
        // across a full run, which is the real bottleneck this targets. Kept
        // well under 1 (a real membrane-fusion event is stochastic even at
        // close range, not certain on first contact) so this stays a real rare-
        // event mechanism rather than an instant merge-on-touch shortcut.
        this.vesicleFusionChance = 0.05; // per-tick chance two touching vesicles fuse
        // Real precedent: surfaces that concentrate prebiotic chemistry —
        // montmorillonite clay in particular (Hanczyc, Fujikawa & Szostak 2003)
        // — are documented to also nucleate vesicle formation around themselves,
        // and amphipathic peptides co-assemble with lipids rather than staying
        // chemically inert to membrane formation. Today's lipidAssembly() only
        // attracts free lipids to other free lipids, so *where* a vesicle closes
        // has zero correlation with where the dish's rare active chemistry
        // happens to be — a second, independent contributor to the same
        // co-occurrence bottleneck vesicleFusionChance targets. This is a soft
        // bias, not a guarantee: about half the strength of the lipid-lipid pull
        // it stacks with, so a vesicle can still close around empty soup most of
        // the time, same as reality.
        this.nucleationSeedRadius = 14; // catalyst/RNA search radius during lipid clustering — 2x lipidAssemblyRadius, a "seed" pulls in lipids from further out than a same-species neighbor would
        this.nucleationBiasStrength = 0.01;
        // A *per-base* allowance rather than one flat number — headless
        // verification found RNA strands growing past 30nt via ordinary
        // condensation (which has no completion requirement) while a fixed
        // absolute timeout gave a 6nt template and a 33nt template the exact
        // same window to finish copying in. That's not just unfair, it's a
        // structural dead end: replication can never even in principle keep
        // pace with unconstrained growth once a template gets long enough that
        // copying it exceeds the timeout on expectation alone, and 200,000+
        // ticks with zero completions across every seed traced back to exactly
        // this. Scaling per base keeps the odds comparable regardless of how
        // long a given template happens to be.
        this.copyStallTicksPerBase = 220;
        this.copyStallTimeoutFloor = 300;
        this.substrateRadius = 42; // nucleotide search radius during templated copying — see templatedReplication's comment
        this.statsSampleInterval = 20;
        this.maxHistory = 500;
        this.grid = new SpatialGrid(14);
        this.nextId = 1;
        this.nextVesicleId = 1;
        this.energyDebt = 0; // fractional accumulator for energyFluxPerTick
        this.width = width;
        this.height = height;
        this.rng = new Rng(seed);
    }
    static seedPrimordialSoup(width, height, seed) {
        const o = new Origin(width, height, seed);
        // Every canonical amino acid and nucleotide gets a real shot at being
        // in the soup — no thumb on the scale toward whichever ones happen to
        // fold well. ~18 copies of each of the 20 real amino acids and ~70
        // copies of each of the 4 real nucleotides, plus a lipid bath dense
        // enough that membrane self-assembly is actually reachable in a
        // headless run rather than a multi-million-tick rare event. Roughly
        // doubled from an earlier calibration as part of a deliberate "make
        // natural abiogenesis actually reachable" pass — the same real
        // "concentration problem" bondRadius's own comment already documents
        // (dilute-solution prebiotic chemistry struggles to react at all),
        // leaned into further rather than in a new direction. Same 800x500
        // footprint — this raises density, not area.
        for (const code of AMINO_ACID_CODES)
            for (let i = 0; i < 18; i++)
                o.spawnAminoAcid(code);
        for (const code of NUCLEOTIDE_CODES)
            for (let i = 0; i < 70; i++)
                o.spawnNucleotide(code);
        for (let i = 0; i < 240; i++)
            o.spawnLipid();
        for (let i = 0; i < 60; i++)
            o.spawnEnergy();
        return o;
    }
    // --- spawning ----------------------------------------------------------
    randomPos() {
        return { x: this.rng.range(0, this.width), y: this.rng.range(0, this.height) };
    }
    spawnAminoAcid(code) {
        const p = {
            id: this.nextId++,
            kind: 'aa',
            code,
            ...this.randomPos(),
            vx: this.rng.range(-0.3, 0.3),
            vy: this.rng.range(-0.3, 0.3),
            vesicleId: null,
        };
        this.particles.set(p.id, p);
        return p;
    }
    spawnNucleotide(code) {
        const p = {
            id: this.nextId++,
            kind: 'nt',
            code,
            ...this.randomPos(),
            vx: this.rng.range(-0.3, 0.3),
            vy: this.rng.range(-0.3, 0.3),
            vesicleId: null,
        };
        this.particles.set(p.id, p);
        return p;
    }
    spawnLipid() {
        const p = {
            id: this.nextId++,
            kind: 'lipid',
            tailLength: this.rng.bool(0.5) ? 1 : 2,
            ...this.randomPos(),
            vx: this.rng.range(-0.2, 0.2),
            vy: this.rng.range(-0.2, 0.2),
            vesicleId: null,
        };
        this.particles.set(p.id, p);
        return p;
    }
    spawnEnergy() {
        const p = {
            id: this.nextId++,
            kind: 'energy',
            ...this.randomPos(),
            vx: this.rng.range(-0.5, 0.5),
            vy: this.rng.range(-0.5, 0.5),
            vesicleId: null,
        };
        this.particles.set(p.id, p);
        return p;
    }
    // --- main loop -----------------------------------------------------------
    update(steps = 1) {
        const start = performance.now();
        for (let i = 0; i < steps; i++)
            this.tickOnce();
        this.perf.lastTickMs = performance.now() - start;
    }
    // tickOnce() is a flat, ordered list of small, independently-tunable,
    // commented private methods, each running against a freshly rebuilt grid.
    // That's the deliberate "bolt-on" shape for this file: a new mechanism —
    // another environmental or chemical dimension — is just one more method
    // in this list plus its own named constants above, grounded the same way
    // every existing one is (a real citation or a headless-verified reason,
    // not an arbitrary knob). Candidates that fit this pattern without any
    // further design change: wet-dry/concentration cycling (the Damer &
    // Deamer hot-spring hypothesis — periodic evaporation pulses that
    // concentrate reactants and reorganize vesicles), mineral-surface
    // catalysis, UV-driven mutagenesis.
    tickOnce() {
        this.tick++;
        this.grid.rebuild([...this.particles.values()]);
        this.moveParticles();
        this.spawnEnergyFlux();
        // Each of these passes removes and creates particles, so the grid
        // built above goes stale the moment the first one runs — rebuilding
        // between every pass, not just once per tick, is what this fixes.
        // Left stale (as an earlier version did), a later pass can still
        // "find" a particle an earlier pass already deleted this same tick:
        // the grid's bucket arrays hold object references, not live lookups,
        // so the detached zombie object still passes every kind/length/
        // vesicleId check. Extending or bonding into that zombie mutates an
        // object nothing else references — a silent no-op for the sim state
        // — while the *real* monomer that was "merged into it" still gets
        // deleted for real. That's genuine mass destruction, not just a
        // double-count: headless verification traced it directly (a hydrolysis
        // event's freshly spawned replacement nucleotide vanishing in the same
        // tick, consumed by an extend call whose target was an rna already
        // deleted moments earlier by hydrolyze()) and confirmed it as the
        // reason the free nucleotide pool was slowly starving out from under
        // replication regardless of how generous the reaction rates were.
        this.hydrolyze();
        this.grid.rebuild([...this.particles.values()]);
        this.condensePolymers('aa');
        this.grid.rebuild([...this.particles.values()]);
        this.condensePolymers('nt');
        this.grid.rebuild([...this.particles.values()]);
        this.templatedReplication();
        this.grid.rebuild([...this.particles.values()]);
        this.lipidAssembly();
        this.grid.rebuild([...this.particles.values()]);
        this.recruitAndDivideVesicles();
        this.grid.rebuild([...this.particles.values()]);
        this.fuseVesicles();
        this.grid.rebuild([...this.particles.values()]);
        this.membraneDiffusion();
        if (this.tick % this.statsSampleInterval === 0)
            this.sampleStats();
        this.detectBootstrap();
    }
    // --- movement --------------------------------------------------------
    moveParticles() {
        for (const p of this.particles.values()) {
            const drag = 0.96;
            p.vx = p.vx * drag + this.rng.gaussian(0, 0.06);
            p.vy = p.vy * drag + this.rng.gaussian(0, 0.06);
            const speedCap = p.kind === 'peptide' || p.kind === 'rna' ? 0.6 : 1.1;
            const speed = Math.hypot(p.vx, p.vy);
            if (speed > speedCap) {
                p.vx = (p.vx / speed) * speedCap;
                p.vy = (p.vy / speed) * speedCap;
            }
            p.x += p.vx;
            p.y += p.vy;
            if (p.x < 0 || p.x > this.width) {
                p.x = clamp(p.x, 0, this.width);
                p.vx *= -1;
            }
            if (p.y < 0 || p.y > this.height) {
                p.y = clamp(p.y, 0, this.height);
                p.vy *= -1;
            }
        }
        // Membrane-enclosed particles get pulled back inside if drift pushed
        // them past their vesicle's radius — the membrane containing them,
        // not a special case in the reaction logic.
        for (const v of this.vesicles.values()) {
            for (const id of v.memberIds) {
                const p = this.particles.get(id);
                if (!p)
                    continue;
                const dx = p.x - v.x;
                const dy = p.y - v.y;
                const dist = Math.hypot(dx, dy);
                if (dist > v.radius && dist > 0) {
                    const pull = v.radius / dist;
                    p.x = v.x + dx * pull;
                    p.y = v.y + dy * pull;
                }
            }
        }
    }
    spawnEnergyFlux() {
        this.energyDebt += this.energyFluxPerTick;
        let freeEnergy = 0;
        for (const p of this.particles.values())
            if (p.kind === 'energy')
                freeEnergy++;
        while (this.energyDebt >= 1 && freeEnergy < this.energyCapacity) {
            this.energyDebt -= 1;
            this.spawnEnergy();
            freeEnergy++;
        }
    }
    // --- catalysis lookup --------------------------------------------------
    nearbyCatalystBoost(x, y, wantClass) {
        const near = this.grid.queryRadius(x, y, this.catalystRadius);
        let best = 0;
        for (const p of near) {
            if (p.kind === 'peptide' && p.fold.isCatalyst && p.fold.catalysisClass === wantClass) {
                best = Math.max(best, p.fold.catalysisStrength);
            }
        }
        return 1 + best * this.catalystBoost;
    }
    // --- hydrolysis ----------------------------------------------------------
    hydrolyze() {
        for (const p of [...this.particles.values()]) {
            if (p.kind === 'peptide') {
                const resistance = 1 - p.fold.stability * 0.8;
                if (this.rng.bool(this.baseHydrolysisRate * resistance))
                    this.shrinkPeptide(p);
            }
            else if (p.kind === 'rna') {
                // A strand actively templating a copy is shielded from hydrolysis
                // for the duration — the real-world analog is that RNA bound in a
                // replication complex is physically protected, not floating free.
                // Without this, a copy that started on a template just barely at
                // MIN_TEMPLATE_LENGTH routinely got orphaned by a single
                // hydrolysis event trimming it one base shorter (headless-verified
                // as the actual reason completed replication was never observed —
                // copies were starting and immediately stalling at 0-1 bases
                // built, not failing from genuine improbability).
                if (p.copying)
                    continue;
                const resistance = 1 - Math.min(0.85, p.fold.stemLength / Math.max(4, p.sequence.length));
                if (this.rng.bool(this.baseHydrolysisRate * resistance))
                    this.shrinkRna(p);
            }
        }
    }
    shrinkPeptide(p) {
        const fromStart = this.rng.bool(0.5);
        const code = fromStart ? p.sequence.shift() : p.sequence.pop();
        if (code) {
            const mono = this.spawnAminoAcid(code);
            mono.x = p.x + this.rng.range(-3, 3);
            mono.y = p.y + this.rng.range(-3, 3);
            mono.vesicleId = p.vesicleId;
            if (p.vesicleId !== null)
                this.vesicles.get(p.vesicleId)?.memberIds.add(mono.id);
        }
        if (p.sequence.length === 0)
            this.removeParticle(p.id);
        else
            refoldPeptide(p);
    }
    shrinkRna(p) {
        const fromStart = this.rng.bool(0.5);
        const code = fromStart ? p.sequence.shift() : p.sequence.pop();
        if (code) {
            const mono = this.spawnNucleotide(code);
            mono.x = p.x + this.rng.range(-3, 3);
            mono.y = p.y + this.rng.range(-3, 3);
            mono.vesicleId = p.vesicleId;
            if (p.vesicleId !== null)
                this.vesicles.get(p.vesicleId)?.memberIds.add(mono.id);
        }
        if (p.sequence.length === 0)
            this.removeParticle(p.id);
        else
            refoldRna(p);
    }
    removeParticle(id) {
        const p = this.particles.get(id);
        if (p?.vesicleId !== null && p?.vesicleId !== undefined) {
            const v = this.vesicles.get(p.vesicleId);
            v?.memberIds.delete(id);
            if (v)
                v.lipidIds = v.lipidIds.filter((lid) => lid !== id);
        }
        this.particles.delete(id);
    }
    // --- condensation (random polymerization) -------------------------------
    condensePolymers(macro) {
        const consumed = new Set();
        const monomers = [...this.particles.values()].filter((p) => p.kind === macro);
        for (const m of monomers) {
            if (consumed.has(m.id))
                continue;
            const near = this.grid.queryRadius(m.x, m.y, this.bondRadius);
            // A same-vesicle-or-both-free pairing only — a membrane wall
            // shouldn't let two molecules on opposite sides react through it.
            const partner = near.find((o) => o.id !== m.id &&
                !consumed.has(o.id) &&
                o.vesicleId === m.vesicleId &&
                ((macro === 'aa' && (o.kind === 'aa' || (o.kind === 'peptide' && o.sequence.length < MAX_POLYMER_LENGTH))) ||
                    // A template mid-copy is excluded — ordinary random
                    // condensation growing it from either end while a templated
                    // copy is reading positions off it would desync the reading
                    // frame (see templatedReplication's nextTemplateIndex).
                    (macro === 'nt' && (o.kind === 'nt' || (o.kind === 'rna' && o.sequence.length < MAX_POLYMER_LENGTH && !o.copying)))));
            if (!partner)
                continue;
            const energyNear = this.grid.queryRadius(m.x, m.y, this.catalystRadius);
            const energyNearby = energyNear.find((o) => o.kind === 'energy' && o.vesicleId === m.vesicleId && !consumed.has(o.id));
            if (!energyNearby)
                continue;
            const wantClass = macro === 'aa' ? 'peptidyl' : 'replicase';
            const rate = this.baseCondensationRate * this.nearbyCatalystBoost(m.x, m.y, wantClass);
            if (!this.rng.bool(rate))
                continue;
            consumed.add(m.id);
            consumed.add(partner.id);
            consumed.add(energyNearby.id);
            this.removeParticle(energyNearby.id);
            if (partner.kind === 'peptide' || partner.kind === 'rna') {
                this.extendPolymer(partner, m);
            }
            else if (macro === 'aa') {
                this.formDimer(m, partner);
            }
            else {
                this.formDimer(m, partner);
            }
        }
    }
    extendPolymer(poly, monomer) {
        if (poly.kind === 'peptide' && monomer.kind === 'aa') {
            if (this.rng.bool(0.5))
                poly.sequence.unshift(monomer.code);
            else
                poly.sequence.push(monomer.code);
            refoldPeptide(poly);
        }
        else if (poly.kind === 'rna' && monomer.kind === 'nt') {
            if (this.rng.bool(0.5))
                poly.sequence.unshift(monomer.code);
            else
                poly.sequence.push(monomer.code);
            refoldRna(poly);
        }
        this.removeParticle(monomer.id);
    }
    formDimer(a, b) {
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        const vesicleId = a.vesicleId;
        if (a.kind === 'aa' && b.kind === 'aa') {
            const poly = {
                id: this.nextId++,
                kind: 'peptide',
                sequence: [a.code, b.code],
                fold: foldPeptide([a.code, b.code]),
                x: cx,
                y: cy,
                vx: 0,
                vy: 0,
                vesicleId,
            };
            this.particles.set(poly.id, poly);
            if (vesicleId !== null)
                this.vesicles.get(vesicleId)?.memberIds.add(poly.id);
        }
        else if (a.kind === 'nt' && b.kind === 'nt') {
            const poly = {
                id: this.nextId++,
                kind: 'rna',
                sequence: [a.code, b.code],
                fold: foldRna([a.code, b.code]),
                copying: null,
                x: cx,
                y: cy,
                vx: 0,
                vy: 0,
                vesicleId,
            };
            this.particles.set(poly.id, poly);
            if (vesicleId !== null)
                this.vesicles.get(vesicleId)?.memberIds.add(poly.id);
        }
        this.removeParticle(a.id);
        this.removeParticle(b.id);
    }
    // --- templated RNA replication (the actual heredity mechanism) ---------
    templatedReplication() {
        // Guards against two different templates picking the *same* free
        // nucleotide (or the same energy particle) within this one pass —
        // mirrors condensePolymers()'s own `consumed` Set, which this
        // function was missing. The grid snapshot this pass reads from isn't
        // rebuilt between templates (only between whole passes — see
        // tickOnce()'s comment on why), so without this, a later template in
        // the same tick can still "find" a nucleotide/energy particle an
        // earlier template already removed a few iterations ago: removing an
        // already-gone id is a harmless no-op, but `p.copying.built.push(...)`
        // still runs regardless, silently minting a nucleotide-equivalent
        // that was never actually backed by a real free particle. A real
        // headless mass-conservation run caught this directly — a modest
        // rate increase (see NOTES.md) was enough to make the within-pass
        // collision non-negligible, where at the old, lower rates it had
        // apparently never fired often enough to show up.
        const consumed = new Set();
        for (const p of [...this.particles.values()]) {
            if (p.kind !== 'rna')
                continue;
            // The minimum-length bar only gates *starting* a new copy — an
            // already in-progress one must be allowed to keep going even if it
            // (still theoretically, though hydrolysis now spares actively-
            // copying strands) sits right at the line, or one unlucky tick
            // permanently strands it a base short of ever finishing.
            if (!p.copying && p.sequence.length < MIN_TEMPLATE_LENGTH)
                continue;
            if (!p.copying) {
                // A ribozyme's own fold can catalyze its own copying (cis), same as
                // a nearby replicase-class peptide (trans) — either is real
                // "RNA world" chemistry. There's also a tiny uncatalyzed leak rate:
                // template-directed copying can happen without a catalyst at all,
                // just extremely slowly, which is exactly why a catalyst is such a
                // large fitness advantage once one exists.
                const selfBoost = p.fold.isRibozyme ? 1 + p.fold.catalysisStrength * this.catalystBoost : 1;
                const transBoost = this.nearbyCatalystBoost(p.x, p.y, 'replicase');
                // Raised from 0.0015 as part of the "make natural abiogenesis
                // actually reachable" calibration pass (see NOTES.md) — this was
                // the single rarest roll in the whole pipeline (an eligible RNA
                // only had a 0.15%/tick shot at ever starting to copy at all,
                // before any of the downstream per-base extension odds even come
                // into play), so it's the one constant in this pass raised a
                // full 2x rather than a fraction of that.
                const vesicleBoost = p.vesicleId !== null ? this.inVesicleReplicationBoost : 1;
                const startRate = 0.003 * Math.max(selfBoost, transBoost) * vesicleBoost;
                if (this.rng.bool(startRate))
                    p.copying = { built: [], startedTick: this.tick };
                continue;
            }
            // A stalled complex eventually falls apart rather than freezing the
            // template at a fixed length forever (see particle.ts's doc comment
            // on RnaParticle.copying) — headless-verified as necessary: without
            // it, RNA length plateaued hard the instant the first copy attempt
            // got stuck, for the entire rest of a 150,000-tick run.
            const stallTimeout = this.copyStallTimeoutFloor + p.sequence.length * this.copyStallTicksPerBase;
            if (this.tick - p.copying.startedTick > stallTimeout) {
                // The bases already built don't just vanish with the complex —
                // headless-verified as a real, previously-silent mass-destruction
                // bug: every abandoned copy was quietly deleting however many
                // nucleotides it had successfully assembled before giving up,
                // which (since most attempts don't complete) was steadily
                // starving the free nucleotide pool out from under every other
                // attempt still in progress.
                for (const code of p.copying.built) {
                    const mono = this.spawnNucleotide(code);
                    mono.x = p.x + this.rng.range(-4, 4);
                    mono.y = p.y + this.rng.range(-4, 4);
                    mono.vesicleId = p.vesicleId;
                    if (p.vesicleId !== null)
                        this.vesicles.get(p.vesicleId)?.memberIds.add(mono.id);
                }
                p.copying = null;
                continue;
            }
            // Extend the in-progress copy by one base per successful tick: find a
            // free nucleotide nearby that Watson-Crick pairs with the next
            // template position (reading from the far end inward), preferring a
            // correct partner but occasionally accepting a mismatch — the actual
            // mutation mechanism.
            const nextTemplateIndex = p.sequence.length - 1 - p.copying.built.length;
            const templateBase = p.sequence[nextTemplateIndex];
            const correctBase = NUCLEOTIDES[templateBase].pairsWith;
            // A wider net than ordinary condensation's blind bondRadius
            // collision — a templated copy is a guided, selective process (it's
            // looking for a *specific* base, not just any collision partner),
            // and real polymerases/ribozymes have an effective capture radius
            // well beyond van der Waals contact. Headless-verified as necessary,
            // not just a nicety: at bondRadius, a mostly-stationary template's
            // own tiny neighborhood of free nucleotides (~130-140 total spread
            // across the whole dish) was thin enough that most copy attempts —
            // tracked individually, not just by a discouraging aggregate —
            // ended with *zero* successful extensions before hitting the stall
            // timeout, not one.
            const near = this.grid
                .queryRadius(p.x, p.y, this.substrateRadius)
                .filter((o) => o.kind === 'nt' && o.vesicleId === p.vesicleId && !consumed.has(o.id));
            if (near.length === 0)
                continue;
            const correct = near.filter((n) => n.code === correctBase);
            // Only actually attempt a mismatch when there's a wrong base on hand
            // to make one with — otherwise "meant to mismatch, only correct
            // bases nearby" was just wasting the tick's one shot at progress for
            // no mutational effect.
            const mismatchRoll = this.rng.bool(this.mutationRate) && correct.length < near.length;
            const chosen = !mismatchRoll && correct.length > 0 ? this.rng.pick(correct) : this.rng.pick(near);
            // Phosphodiester bond formation is just as endergonic as a peptide
            // bond — templated copying needs the same energy currency, not a
            // free pass just for having a template to work from.
            const energyNearby = this.grid
                .queryRadius(p.x, p.y, this.catalystRadius)
                .find((o) => o.kind === 'energy' && o.vesicleId === p.vesicleId && !consumed.has(o.id));
            if (!energyNearby)
                continue;
            // Calibrated up from an initial 0.04, then again from 0.12 as part
            // of the "make natural abiogenesis actually reachable" pass (see
            // NOTES.md): headless verification showed copies routinely
            // stalling at ~15-20% of their template length before hitting the
            // stall timeout even with an active ribozyme nearby — the base
            // rate, not just catalysis, was too low to realistically finish a
            // 6-9-base copy inside a ~1000-tick window.
            const vesicleBoost = p.vesicleId !== null ? this.inVesicleReplicationBoost : 1;
            const boost = this.nearbyCatalystBoost(p.x, p.y, 'replicase') * (p.fold.isRibozyme ? 1 + p.fold.catalysisStrength * 4 : 1) * vesicleBoost;
            if (!this.rng.bool(Math.min(0.9, 0.2 * boost)))
                continue;
            consumed.add(energyNearby.id);
            consumed.add(chosen.id);
            this.removeParticle(energyNearby.id);
            p.copying.built.push(chosen.code);
            this.removeParticle(chosen.id);
            if (p.copying.built.length >= p.sequence.length) {
                const child = {
                    id: this.nextId++,
                    kind: 'rna',
                    sequence: p.copying.built,
                    fold: foldRna(p.copying.built),
                    copying: null,
                    x: p.x + this.rng.range(-4, 4),
                    y: p.y + this.rng.range(-4, 4),
                    vx: this.rng.range(-0.3, 0.3),
                    vy: this.rng.range(-0.3, 0.3),
                    vesicleId: p.vesicleId,
                };
                this.particles.set(child.id, child);
                this.totalReplicationEvents++;
                if (p.vesicleId !== null) {
                    const v = this.vesicles.get(p.vesicleId);
                    if (v) {
                        v.memberIds.add(child.id);
                        v.replicationEvents++;
                    }
                }
                p.copying = null;
            }
        }
    }
    // --- lipid self-assembly (no energy needed — pure aggregation) ---------
    lipidAssembly() {
        // Free lipids drift toward nearby free lipids — the hydrophobic effect
        // clustering tails together — before any vesicle exists to recruit
        // them into a membrane.
        const freeLipids = [...this.particles.values()].filter((p) => p.kind === 'lipid' && p.vesicleId === null);
        for (const l of freeLipids) {
            const near = this.grid
                .queryRadius(l.x, l.y, this.lipidAssemblyRadius)
                .filter((o) => o.kind === 'lipid' && o.id !== l.id && o.vesicleId === null);
            if (near.length === 0)
                continue;
            let ax = 0;
            let ay = 0;
            for (const n of near) {
                ax += n.x - l.x;
                ay += n.y - l.y;
            }
            l.vx += (ax / near.length) * 0.02;
            l.vy += (ay / near.length) * 0.02;
            // A second, independent attractor: catalytically active peptides and
            // long-enough RNA also draw nearby free lipids in — real membrane
            // nucleation isn't blind to what's already there (see
            // nucleationBiasStrength's comment above for the citations). This is
            // what lets a *newly forming* vesicle land on top of active
            // chemistry instead of a uniformly random patch of empty soup.
            const seeds = this.grid
                .queryRadius(l.x, l.y, this.nucleationSeedRadius)
                .filter((o) => (o.kind === 'peptide' && o.fold.isCatalyst) ||
                (o.kind === 'rna' && (o.fold.isRibozyme || o.sequence.length >= MIN_TEMPLATE_LENGTH)));
            if (seeds.length > 0) {
                let sx = 0;
                let sy = 0;
                for (const s of seeds) {
                    sx += s.x - l.x;
                    sy += s.y - l.y;
                }
                l.vx += (sx / seeds.length) * this.nucleationBiasStrength;
                l.vy += (sy / seeds.length) * this.nucleationBiasStrength;
            }
        }
        // A dense-enough free-lipid cluster spontaneously closes into a
        // vesicle. Flood-fill the neighbor graph to find clusters, and require
        // rough angular coverage around the centroid (not just a blob) so what
        // closes is actually ring-like, the way a real bilayer patch curls
        // into a sphere rather than staying a flat sheet.
        const visited = new Set();
        for (const l of freeLipids) {
            if (visited.has(l.id) || l.vesicleId !== null)
                continue;
            const cluster = [];
            const stack = [l];
            visited.add(l.id);
            while (stack.length) {
                const cur = stack.pop();
                cluster.push(cur);
                const near = this.grid
                    .queryRadius(cur.x, cur.y, this.lipidAssemblyRadius)
                    .filter((o) => o.kind === 'lipid' && o.vesicleId === null && !visited.has(o.id));
                for (const n of near) {
                    visited.add(n.id);
                    stack.push(n);
                }
            }
            if (cluster.length < MIN_VESICLE_LIPIDS)
                continue;
            let cx = 0;
            let cy = 0;
            for (const c of cluster) {
                cx += c.x;
                cy += c.y;
            }
            cx /= cluster.length;
            cy /= cluster.length;
            const sectors = new Set();
            for (const c of cluster)
                sectors.add(Math.floor((Math.atan2(c.y - cy, c.x - cx) + Math.PI) / (Math.PI / 4)));
            if (sectors.size < 6)
                continue; // not wrapped all the way around yet
            this.formVesicle(cluster, cx, cy);
        }
    }
    formVesicle(lipids, cx, cy) {
        const v = {
            id: this.nextVesicleId++,
            x: cx,
            y: cy,
            radius: radiusForLipidCount(lipids.length),
            lipidIds: lipids.map((l) => l.id),
            memberIds: new Set(lipids.map((l) => l.id)),
            createdTick: this.tick,
            divisions: 0,
            replicationEvents: 0,
        };
        for (const l of lipids)
            l.vesicleId = v.id;
        // Whatever else was drifting inside the closing radius at the moment
        // of closure gets trapped along with it — the actual encapsulation
        // event. Nothing here biases *what* gets captured; it's whatever
        // happened to be nearby, for better or worse.
        const enclosed = this.grid.queryRadius(cx, cy, v.radius);
        for (const p of enclosed) {
            if (p.vesicleId !== null)
                continue;
            const dist = Math.hypot(p.x - cx, p.y - cy);
            if (dist <= v.radius) {
                p.vesicleId = v.id;
                v.memberIds.add(p.id);
            }
        }
        this.vesicles.set(v.id, v);
    }
    recruitAndDivideVesicles() {
        for (const v of [...this.vesicles.values()]) {
            // Recompute centroid from the membrane itself so a vesicle drifts
            // with its lipids rather than staying pinned at its birth position.
            let cx = 0;
            let cy = 0;
            let n = 0;
            for (const id of v.lipidIds) {
                const p = this.particles.get(id);
                if (!p)
                    continue;
                cx += p.x;
                cy += p.y;
                n++;
            }
            if (n === 0) {
                this.vesicles.delete(v.id);
                continue;
            }
            v.x = cx / n;
            v.y = cy / n;
            v.radius = radiusForLipidCount(v.lipidIds.length);
            const nearbyFree = this.grid
                .queryRadius(v.x, v.y, v.radius + 3)
                .filter((p) => p.kind === 'lipid' && p.vesicleId === null);
            for (const l of nearbyFree) {
                l.vesicleId = v.id;
                v.lipidIds.push(l.id);
                v.memberIds.add(l.id);
            }
            if (nearbyFree.length > 0)
                v.radius = radiusForLipidCount(v.lipidIds.length);
            if (v.lipidIds.length >= DIVISION_LIPID_COUNT)
                this.divideVesicle(v);
        }
    }
    divideVesicle(v) {
        const lipids = v.lipidIds.map((id) => this.particles.get(id)).filter((p) => !!p);
        if (lipids.length < MIN_VESICLE_LIPIDS * 2)
            return; // not enough to make two viable daughters yet
        // Split the membrane ring roughly in half by angle around the
        // centroid — an equator, the same way a real growing vesicle actually
        // fissions.
        const sorted = lipids
            .map((l) => ({ l, angle: Math.atan2(l.y - v.y, l.x - v.x) }))
            .sort((a, b) => a.angle - b.angle);
        const mid = Math.floor(sorted.length / 2);
        const groupA = sorted.slice(0, mid).map((s) => s.l);
        const groupB = sorted.slice(mid).map((s) => s.l);
        const centroidOf = (group) => {
            let x = 0;
            let y = 0;
            for (const g of group) {
                x += g.x;
                y += g.y;
            }
            return { x: x / group.length, y: y / group.length };
        };
        const ca = centroidOf(groupA);
        const cb = centroidOf(groupB);
        // Both daughters inherit the parent's full replicationEvents count,
        // not split or reset — a lineage's replicative track record belongs
        // to both branches of a division equally, the same way a real
        // daughter cell inherits its parent's actual working molecular
        // machinery (ribosomes, enzymes, genetic material) rather than
        // re-earning replication capability from a cold start. This doesn't
        // weaken isBootstrapEligible's real gate: hasActiveCatalyst/
        // hasReplicatorNow are still checked live, fresh from whatever's
        // physically inside each specific vesicle at the moment it's
        // evaluated — a daughter that ends up with the catalyst separated
        // from the replicator (division partitions purely by spatial
        // proximity to each new centroid; real protocells at this stage have
        // no active segregation machinery, so this stays passive on purpose)
        // still fails that check immediately either way. What this removes
        // is the previous, structural requirement that a vesicle complete
        // *two more* full replication events specifically timed after its
        // first division before it could ever qualify — on top of already
        // having proven it could replicate before splitting at all. That
        // compounding of two independently-rare events in a specific order
        // is the likely reason a natural bootstrap was never once observed
        // in 200,000+ verification ticks despite every individual mechanism
        // (folding, catalysis, replication, division) working on its own.
        const daughterA = {
            id: this.nextVesicleId++,
            x: ca.x,
            y: ca.y,
            radius: radiusForLipidCount(groupA.length),
            lipidIds: groupA.map((l) => l.id),
            memberIds: new Set(groupA.map((l) => l.id)),
            createdTick: this.tick,
            divisions: v.divisions + 1,
            replicationEvents: v.replicationEvents,
        };
        const daughterB = {
            id: this.nextVesicleId++,
            x: cb.x,
            y: cb.y,
            radius: radiusForLipidCount(groupB.length),
            lipidIds: groupB.map((l) => l.id),
            memberIds: new Set(groupB.map((l) => l.id)),
            createdTick: this.tick,
            divisions: v.divisions + 1,
            replicationEvents: v.replicationEvents,
        };
        for (const l of groupA)
            l.vesicleId = daughterA.id;
        for (const l of groupB)
            l.vesicleId = daughterB.id;
        // Non-membrane contents (peptides, RNA, trapped monomers) partition to
        // whichever daughter's centroid they ended up closer to — a stochastic
        // but not perfectly even split, same as real vesicle fission.
        for (const id of v.memberIds) {
            if (v.lipidIds.includes(id))
                continue;
            const p = this.particles.get(id);
            if (!p)
                continue;
            const da = Math.hypot(p.x - ca.x, p.y - ca.y);
            const db = Math.hypot(p.x - cb.x, p.y - cb.y);
            const target = da <= db ? daughterA : daughterB;
            p.vesicleId = target.id;
            target.memberIds.add(id);
        }
        this.vesicles.delete(v.id);
        this.vesicles.set(daughterA.id, daughterA);
        this.vesicles.set(daughterB.id, daughterB);
    }
    // --- vesicle fusion ------------------------------------------------------
    // See vesicleFusionChance's comment (with this.tunables above) for the
    // real precedent and why this exists: without it, a protocell holding a
    // catalyst and one holding a replicator can drift side by side forever
    // and never combine into a single bootstrap-eligible unit.
    fuseVesicles() {
        const list = [...this.vesicles.values()];
        const consumed = new Set();
        for (let i = 0; i < list.length; i++) {
            const a = list[i];
            if (consumed.has(a.id) || !this.vesicles.has(a.id))
                continue;
            for (let j = i + 1; j < list.length; j++) {
                const b = list[j];
                if (consumed.has(b.id) || !this.vesicles.has(b.id))
                    continue;
                if (Math.hypot(a.x - b.x, a.y - b.y) > a.radius + b.radius)
                    continue; // membranes not touching
                if (!this.rng.bool(this.vesicleFusionChance))
                    continue; // contact alone isn't instant fusion
                const [big, small] = a.lipidIds.length >= b.lipidIds.length ? [a, b] : [b, a];
                this.mergeVesicles(big, small);
                consumed.add(small.id);
                if (small.id === a.id)
                    break; // a was absorbed — nothing left to pair it with this tick
            }
        }
    }
    /** Merges `absorbed` into `keep` — both membranes' full contents end up
     * in one combined vesicle. `keep` happens to be whichever one had more
     * lipids at the moment of contact (arbitrary as a matter of bookkeeping;
     * physically the two membranes contribute equally). */
    mergeVesicles(keep, absorbed) {
        for (const id of absorbed.memberIds) {
            const p = this.particles.get(id);
            if (p)
                p.vesicleId = keep.id;
            keep.memberIds.add(id);
        }
        keep.lipidIds.push(...absorbed.lipidIds);
        // The more evolved lineage's track record carries forward — same
        // inheritance principle already used for division (see divideVesicle's
        // comment above): a merged protocell's real molecular machinery is
        // whichever parent actually had it, not reset to zero because it
        // arrived by fusion instead of by growth.
        keep.replicationEvents = Math.max(keep.replicationEvents, absorbed.replicationEvents);
        keep.divisions = Math.max(keep.divisions, absorbed.divisions);
        // Recompute the merged membrane's centroid/radius now rather than
        // waiting for the next recruitAndDivideVesicles pass, so
        // detectBootstrap() sees accurate state in the same tick fusion happens.
        let cx = 0;
        let cy = 0;
        let n = 0;
        for (const id of keep.lipidIds) {
            const p = this.particles.get(id);
            if (!p)
                continue;
            cx += p.x;
            cy += p.y;
            n++;
        }
        if (n > 0) {
            keep.x = cx / n;
            keep.y = cy / n;
        }
        keep.radius = radiusForLipidCount(keep.lipidIds.length);
        this.vesicles.delete(absorbed.id);
    }
    // --- membrane permeability ---------------------------------------------
    membraneDiffusion() {
        for (const p of this.particles.values()) {
            if (p.kind === 'peptide' || p.kind === 'rna' || p.kind === 'lipid')
                continue; // too big to cross
            if (!this.rng.bool(this.membranePermeability))
                continue;
            if (p.vesicleId === null) {
                // Try to enter any vesicle whose membrane it's currently touching.
                const near = this.grid.queryRadius(p.x, p.y, 4);
                for (const o of near) {
                    if (o.kind !== 'lipid' || o.vesicleId === null)
                        continue;
                    const v = this.vesicles.get(o.vesicleId);
                    if (!v)
                        continue;
                    p.vesicleId = v.id;
                    v.memberIds.add(p.id);
                    break;
                }
            }
            else {
                const v = this.vesicles.get(p.vesicleId);
                if (v && Math.hypot(p.x - v.x, p.y - v.y) > v.radius * 0.85) {
                    v.memberIds.delete(p.id);
                    p.vesicleId = null;
                }
            }
        }
    }
    // --- bootstrap detection -------------------------------------------------
    /** One real scan of a vesicle's current contents, shared by
     * detectBootstrap() and getBootstrapProgress() so "what does this
     * vesicle actually, currently hold" is computed one way in one place. */
    scanVesicleContents(v) {
        let hasActiveCatalyst = false;
        let hasReplicator = false;
        const peptides = [];
        const rnas = [];
        for (const id of v.memberIds) {
            const p = this.particles.get(id);
            if (!p)
                continue;
            if (p.kind === 'peptide') {
                peptides.push(p);
                if (p.fold.isCatalyst)
                    hasActiveCatalyst = true;
            }
            else if (p.kind === 'rna') {
                rnas.push(p);
                if (p.sequence.length >= MIN_TEMPLATE_LENGTH)
                    hasReplicator = true;
                if (p.fold.isRibozyme)
                    hasActiveCatalyst = true;
            }
        }
        return { hasActiveCatalyst, hasReplicator, peptides, rnas };
    }
    detectBootstrap() {
        for (const v of this.vesicles.values()) {
            const { hasActiveCatalyst, hasReplicator, peptides, rnas } = this.scanVesicleContents(v);
            if (isBootstrapEligible(v, hasActiveCatalyst, hasReplicator)) {
                const already = this.bootstrapCandidates.some((c) => c.vesicleId === v.id);
                if (!already) {
                    this.bootstrapCandidates.push({
                        vesicleId: v.id,
                        tick: this.tick,
                        x: v.x,
                        y: v.y,
                        radius: v.radius,
                        peptides,
                        rnas,
                        lipidCount: v.lipidIds.length,
                    });
                    if (this.bootstrapCandidates.length > 20)
                        this.bootstrapCandidates.shift();
                }
            }
        }
    }
    // --- stats ---------------------------------------------------------------
    sampleStats() {
        const snap = this.getStats();
        this.history.push(snap);
        if (this.history.length > this.maxHistory)
            this.history.shift();
    }
    getStats() {
        let freeAA = 0;
        let freeNT = 0;
        let freeLipid = 0;
        let freeEnergy = 0;
        let peptideCount = 0;
        let rnaCount = 0;
        let catalystCount = 0;
        let ribozymeCount = 0;
        let longestPeptide = 0;
        let longestRna = 0;
        for (const p of this.particles.values()) {
            if (p.kind === 'aa')
                freeAA++;
            else if (p.kind === 'nt')
                freeNT++;
            else if (p.kind === 'lipid')
                freeLipid++;
            else if (p.kind === 'energy')
                freeEnergy++;
            else if (p.kind === 'peptide') {
                peptideCount++;
                longestPeptide = Math.max(longestPeptide, p.sequence.length);
                if (p.fold.isCatalyst)
                    catalystCount++;
            }
            else if (p.kind === 'rna') {
                rnaCount++;
                longestRna = Math.max(longestRna, p.sequence.length);
                if (p.fold.isRibozyme)
                    ribozymeCount++;
            }
        }
        return {
            tick: this.tick,
            freeAminoAcids: freeAA,
            freeNucleotides: freeNT,
            freeLipids: freeLipid,
            freeEnergy,
            peptideCount,
            rnaCount,
            catalystCount,
            ribozymeCount,
            longestPeptide,
            longestRna,
            vesicleCount: this.vesicles.size,
            totalReplicationEvents: this.totalReplicationEvents,
            bootstrapReady: this.bootstrapCandidates.length,
        };
    }
    /** The single vesicle currently ranked closest to bootstrap eligibility
     * — ranked first by whether it *currently* has a live catalyst +
     * replicator (what actually matters right now), then by real
     * historical replicationEvents, then divisions. Shared by
     * getBootstrapProgress() and estimateBootstrapChance() so both read
     * off the exact same notion of "leading". */
    findLeadingVesicle() {
        let leading = null;
        let leadingScore = -Infinity;
        for (const v of this.vesicles.values()) {
            const { hasActiveCatalyst, hasReplicator } = this.scanVesicleContents(v);
            const score = (hasActiveCatalyst && hasReplicator ? 1000000 : 0) + v.replicationEvents * 1000 + v.divisions;
            if (score > leadingScore) {
                leadingScore = score;
                leading = { v, hasActiveCatalyst, hasReplicator };
            }
        }
        return leading;
    }
    /** Real, currently-observable progress toward a natural bootstrap — not
     * a prediction, just what's actually true about the dish right now.
     * The Chemistry tab's "closest to bootstrap" detail block reads this
     * directly. */
    getBootstrapProgress() {
        const leading = this.findLeadingVesicle();
        return {
            vesicleCount: this.vesicles.size,
            bootstrapReady: this.bootstrapCandidates.length,
            leading: leading
                ? {
                    hasActiveCatalyst: leading.hasActiveCatalyst,
                    hasReplicatorNow: leading.hasReplicator,
                    replicationEvents: leading.v.replicationEvents,
                    divisionsSoFar: leading.v.divisions,
                    lipidCount: leading.v.lipidIds.length,
                }
                : null,
        };
    }
    /** A cheap, always-live *heuristic* estimate of the odds this dish
     * produces a natural bootstrap within the next `horizonTicks` — this is
     * deliberately NOT a simulated probability. A real one would mean
     * actually cloning the dish and fast-forwarding many independent
     * trials (Monte Carlo), and headless timing this session put a single
     * 10,000-tick trial at ~10-15s — far too slow to recompute live every
     * tick, or even every few seconds. This instead reuses the exact real
     * formulas templatedReplication() itself rolls against (start-rate,
     * extension-rate, the same catalyst/ribozyme/in-vesicle boosts),
     * evaluated for whatever the actual leading vesicle's actual current
     * fold/catalyst state is, and projects forward with a Poisson
     * approximation for "at least K more completions in the next
     * `horizonTicks` ticks." Grounded in real numbers, but still a rough
     * approximation, not a validated probability — it ignores the
     * stall-timeout mechanic, assumes local substrate stays available, and
     * (see divisionReadiness below) treats "enough replication" and
     * "enough lipid growth" as independent when they aren't really. The
     * UI labels this as an estimate for exactly this reason — don't
     * present it as more precise than it is. */
    estimateBootstrapChance(horizonTicks = 10000) {
        const leading = this.findLeadingVesicle();
        if (!leading || !leading.hasActiveCatalyst || !leading.hasReplicator)
            return 0;
        // The representative template: whichever RNA is actively mid-copy
        // (the most concrete evidence of live progress), else the longest
        // real replicator candidate currently inside.
        let template = null;
        for (const id of leading.v.memberIds) {
            const p = this.particles.get(id);
            if (!p || p.kind !== 'rna' || p.sequence.length < MIN_TEMPLATE_LENGTH)
                continue;
            if (p.copying) {
                template = p;
                break;
            }
            if (!template || p.sequence.length > template.sequence.length)
                template = p;
        }
        if (!template)
            return 0;
        // Same formulas as templatedReplication()'s two real rolls (see
        // there for what each factor means) — not reinvented here.
        const selfBoost = template.fold.isRibozyme ? 1 + template.fold.catalysisStrength * this.catalystBoost : 1;
        const transBoost = this.nearbyCatalystBoost(template.x, template.y, 'replicase');
        const startRate = 0.003 * Math.max(selfBoost, transBoost) * this.inVesicleReplicationBoost;
        const extBoost = this.nearbyCatalystBoost(template.x, template.y, 'replicase') *
            (template.fold.isRibozyme ? 1 + template.fold.catalysisStrength * 4 : 1) *
            this.inVesicleReplicationBoost;
        const extensionRate = Math.min(0.9, 0.2 * extBoost);
        const basesRemaining = template.copying ? template.sequence.length - template.copying.built.length : template.sequence.length;
        const ticksToExtend = extensionRate > 0 ? basesRemaining / extensionRate : Infinity;
        const ticksToStart = template.copying ? 0 : startRate > 0 ? 1 / startRate : Infinity;
        const expectedTicksPerCompletion = ticksToStart + ticksToExtend;
        if (!Number.isFinite(expectedTicksPerCompletion) || expectedTicksPerCompletion <= 0)
            return 0;
        // Treat full-copy completions as a Poisson process at this rate —
        // P(>= K events in `horizonTicks`) = 1 - e^-lambda * sum_{i=0}^{K-1} lambda^i/i!
        const completionsPerTick = 1 / expectedTicksPerCompletion;
        const neededCompletions = Math.max(1, 2 - leading.v.replicationEvents);
        const lambda = completionsPerTick * horizonTicks;
        let cdf = 0;
        let term = Math.exp(-lambda);
        for (let i = 0; i < neededCompletions; i++) {
            cdf += term;
            term *= lambda / (i + 1);
        }
        const replicationChance = clamp(1 - cdf, 0, 1);
        // Division readiness: a coarse current-progress proxy (lipid count
        // vs. the real DIVISION_LIPID_COUNT bar), not a real rate-based
        // time-to-event projection — this engine doesn't track a specific
        // vesicle's lipid count history over time, so there's no real trend
        // to extrapolate from. Documented simplification, not hidden.
        const divisionReadiness = leading.v.divisions >= 1 ? 1 : clamp(leading.v.lipidIds.length / DIVISION_LIPID_COUNT, 0, 1);
        return clamp(replicationChance * divisionReadiness, 0, 1);
    }
    // --- save/restore ----------------------------------------------------
    // Particles are already plain, JSON-safe data (even the union's peptide/
    // rna variants — `fold`/`copying` are plain objects, no class instances,
    // no circular refs) — only the Maps and each Vesicle's `memberIds` Set
    // need flattening to arrays.
    serialize() {
        return {
            width: this.width,
            height: this.height,
            tick: this.tick,
            rngState: this.rng.getState(),
            nextId: this.nextId,
            nextVesicleId: this.nextVesicleId,
            energyDebt: this.energyDebt,
            totalReplicationEvents: this.totalReplicationEvents,
            particles: [...this.particles.values()],
            vesicles: [...this.vesicles.values()].map((v) => ({ ...v, memberIds: [...v.memberIds] })),
            history: this.history,
            bootstrapCandidates: this.bootstrapCandidates,
        };
    }
    static deserialize(data) {
        const o = new Origin(data.width, data.height, 0);
        o.rng = Rng.fromState(data.rngState);
        o.tick = data.tick;
        o.nextId = data.nextId;
        o.nextVesicleId = data.nextVesicleId;
        o.energyDebt = data.energyDebt;
        o.totalReplicationEvents = data.totalReplicationEvents;
        for (const p of data.particles)
            o.particles.set(p.id, p);
        for (const v of data.vesicles)
            o.vesicles.set(v.id, { ...v, memberIds: new Set(v.memberIds) });
        o.history = data.history;
        o.bootstrapCandidates = data.bootstrapCandidates;
        return o;
    }
}
