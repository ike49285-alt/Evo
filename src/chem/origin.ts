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
import {
  AMINO_ACID_CODES,
  AminoAcidCode,
  Lipid,
  NUCLEOTIDE_CODES,
  NucleotideCode,
  NUCLEOTIDES,
} from './elements.js';
import {
  AminoAcidParticle,
  EnergyParticle,
  LipidParticle,
  NucleotideParticle,
  Particle,
  PeptideParticle,
  RnaParticle,
  refoldPeptide,
  refoldRna,
} from './particle.js';
import { foldPeptide, foldRna } from './polymer.js';
import {
  DIVISION_LIPID_COUNT,
  isBootstrapEligible,
  MIN_VESICLE_LIPIDS,
  radiusForLipidCount,
  Vesicle,
} from './vesicle.js';

export interface OriginStatsSnapshot {
  tick: number;
  freeAminoAcids: number;
  freeNucleotides: number;
  freeLipids: number;
  freeEnergy: number;
  peptideCount: number;
  rnaCount: number;
  catalystCount: number;
  ribozymeCount: number;
  longestPeptide: number;
  longestRna: number;
  vesicleCount: number;
  totalReplicationEvents: number;
  bootstrapReady: number;
}

/** What a stabilized protocell hands off to the next stage — see bridge.ts. */
export interface BootstrapCandidate {
  vesicleId: number;
  tick: number;
  radius: number;
  peptides: PeptideParticle[];
  rnas: RnaParticle[];
  lipidCount: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

const MIN_TEMPLATE_LENGTH = 6;
const MAX_POLYMER_LENGTH = 40; // a hard cap keeps fold search + memory bounded

export class Origin {
  readonly width: number;
  readonly height: number;
  readonly rng: Rng;

  particles = new Map<number, Particle>();
  vesicles = new Map<number, Vesicle>();
  tick = 0;
  history: OriginStatsSnapshot[] = [];
  perf = { lastTickMs: 0 };
  /** Every protocell that's ever crossed the bootstrap bar, most recent
   * last. main.ts drains this to offer a hand-off into the Virtunism dish. */
  bootstrapCandidates: BootstrapCandidate[] = [];

  // --- tunables --------------------------------------------------------
  readonly bondRadius = 13;
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
  readonly catalystRadius = 26;
  readonly baseCondensationRate = 0.05;
  readonly baseHydrolysisRate = 0.0018;
  readonly catalystBoost = 10; // a strong nearby catalyst multiplies bonding odds up to ~11x
  readonly mutationRate = 0.03; // per-base chance a templated copy mispairs
  readonly energyCapacity = 140;
  readonly energyFluxPerTick = 1.6; // expected new energy particles/tick (fractional, accumulated)
  readonly lipidAssemblyRadius = 7;
  readonly membranePermeability = 0.02; // per-tick chance a small molecule crosses a nearby membrane
  // Bumped from an initial 1000: per-attempt diagnostics after fixing the
  // substrate-radius bottleneck showed real attempts reaching 70-83% of
  // their template before timing out — close enough that the timeout
  // itself, not the underlying rate, looked like the remaining ceiling.
  readonly copyStallTimeout = 1800;
  readonly substrateRadius = 42; // nucleotide search radius during templated copying — see templatedReplication's comment
  readonly statsSampleInterval = 20;
  readonly maxHistory = 500;

  private readonly grid = new SpatialGrid<Particle>(14);
  private nextId = 1;
  private nextVesicleId = 1;
  private energyDebt = 0; // fractional accumulator for energyFluxPerTick

  constructor(width: number, height: number, seed: number) {
    this.width = width;
    this.height = height;
    this.rng = new Rng(seed);
  }

  static seedPrimordialSoup(width: number, height: number, seed: number): Origin {
    const o = new Origin(width, height, seed);
    // Every canonical amino acid and nucleotide gets a real shot at being
    // in the soup — no thumb on the scale toward whichever ones happen to
    // fold well. ~9 copies of each of the 20 real amino acids and ~35
    // copies of each of the 4 real nucleotides, plus a lipid bath dense
    // enough that membrane self-assembly is actually reachable in a
    // headless run rather than a multi-million-tick rare event.
    for (const code of AMINO_ACID_CODES) for (let i = 0; i < 9; i++) o.spawnAminoAcid(code);
    for (const code of NUCLEOTIDE_CODES) for (let i = 0; i < 35; i++) o.spawnNucleotide(code);
    for (let i = 0; i < 160; i++) o.spawnLipid();
    for (let i = 0; i < 30; i++) o.spawnEnergy();
    return o;
  }

  // --- spawning ----------------------------------------------------------
  private randomPos(): { x: number; y: number } {
    return { x: this.rng.range(0, this.width), y: this.rng.range(0, this.height) };
  }

  private spawnAminoAcid(code: AminoAcidCode): AminoAcidParticle {
    const p: AminoAcidParticle = {
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

  private spawnNucleotide(code: NucleotideCode): NucleotideParticle {
    const p: NucleotideParticle = {
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

  private spawnLipid(): LipidParticle {
    const p: LipidParticle = {
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

  private spawnEnergy(): EnergyParticle {
    const p: EnergyParticle = {
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
  update(steps = 1): void {
    const start = performance.now();
    for (let i = 0; i < steps; i++) this.tickOnce();
    this.perf.lastTickMs = performance.now() - start;
  }

  private tickOnce(): void {
    this.tick++;
    this.grid.rebuild([...this.particles.values()]);

    this.moveParticles();
    this.spawnEnergyFlux();
    this.hydrolyze();
    this.condensePolymers('aa');
    this.condensePolymers('nt');
    this.templatedReplication();
    this.lipidAssembly();
    this.recruitAndDivideVesicles();
    this.membraneDiffusion();

    if (this.tick % this.statsSampleInterval === 0) this.sampleStats();
    this.detectBootstrap();
  }

  // --- movement --------------------------------------------------------
  private moveParticles(): void {
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
        if (!p) continue;
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

  private spawnEnergyFlux(): void {
    this.energyDebt += this.energyFluxPerTick;
    let freeEnergy = 0;
    for (const p of this.particles.values()) if (p.kind === 'energy') freeEnergy++;
    while (this.energyDebt >= 1 && freeEnergy < this.energyCapacity) {
      this.energyDebt -= 1;
      this.spawnEnergy();
      freeEnergy++;
    }
  }

  // --- catalysis lookup --------------------------------------------------
  private nearbyCatalystBoost(x: number, y: number, wantClass: string): number {
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
  private hydrolyze(): void {
    for (const p of [...this.particles.values()]) {
      if (p.kind === 'peptide') {
        const resistance = 1 - p.fold.stability * 0.8;
        if (this.rng.bool(this.baseHydrolysisRate * resistance)) this.shrinkPeptide(p);
      } else if (p.kind === 'rna') {
        // A strand actively templating a copy is shielded from hydrolysis
        // for the duration — the real-world analog is that RNA bound in a
        // replication complex is physically protected, not floating free.
        // Without this, a copy that started on a template just barely at
        // MIN_TEMPLATE_LENGTH routinely got orphaned by a single
        // hydrolysis event trimming it one base shorter (headless-verified
        // as the actual reason completed replication was never observed —
        // copies were starting and immediately stalling at 0-1 bases
        // built, not failing from genuine improbability).
        if (p.copying) continue;
        const resistance = 1 - Math.min(0.85, p.fold.stemLength / Math.max(4, p.sequence.length));
        if (this.rng.bool(this.baseHydrolysisRate * resistance)) this.shrinkRna(p);
      }
    }
  }

  private shrinkPeptide(p: PeptideParticle): void {
    const fromStart = this.rng.bool(0.5);
    const code = fromStart ? p.sequence.shift() : p.sequence.pop();
    if (code) {
      const mono = this.spawnAminoAcid(code);
      mono.x = p.x + this.rng.range(-3, 3);
      mono.y = p.y + this.rng.range(-3, 3);
      mono.vesicleId = p.vesicleId;
      if (p.vesicleId !== null) this.vesicles.get(p.vesicleId)?.memberIds.add(mono.id);
    }
    if (p.sequence.length === 0) this.removeParticle(p.id);
    else refoldPeptide(p);
  }

  private shrinkRna(p: RnaParticle): void {
    if ((globalThis as any).__ORIGIN_DEBUG__ && p.copying) {
      console.log(`[repl] tick=${this.tick} rna=${p.id} HYDROLYZED mid-copy (len ${p.sequence.length}->${p.sequence.length - 1}, built=${p.copying.built.length})`);
    }
    const fromStart = this.rng.bool(0.5);
    const code = fromStart ? p.sequence.shift() : p.sequence.pop();
    if (code) {
      const mono = this.spawnNucleotide(code);
      mono.x = p.x + this.rng.range(-3, 3);
      mono.y = p.y + this.rng.range(-3, 3);
      mono.vesicleId = p.vesicleId;
      if (p.vesicleId !== null) this.vesicles.get(p.vesicleId)?.memberIds.add(mono.id);
    }
    if (p.sequence.length === 0) this.removeParticle(p.id);
    else refoldRna(p);
  }

  private removeParticle(id: number): void {
    const p = this.particles.get(id);
    if (p?.vesicleId !== null && p?.vesicleId !== undefined) {
      const v = this.vesicles.get(p.vesicleId);
      v?.memberIds.delete(id);
      if (v) v.lipidIds = v.lipidIds.filter((lid) => lid !== id);
    }
    this.particles.delete(id);
  }

  // --- condensation (random polymerization) -------------------------------
  private condensePolymers(macro: 'aa' | 'nt'): void {
    const consumed = new Set<number>();
    const monomers = [...this.particles.values()].filter(
      (p): p is AminoAcidParticle | NucleotideParticle => p.kind === macro,
    );
    for (const m of monomers) {
      if (consumed.has(m.id)) continue;
      const near = this.grid.queryRadius(m.x, m.y, this.bondRadius);
      // A same-vesicle-or-both-free pairing only — a membrane wall
      // shouldn't let two molecules on opposite sides react through it.
      const partner = near.find(
        (o): o is AminoAcidParticle | NucleotideParticle | PeptideParticle | RnaParticle =>
          o.id !== m.id &&
          !consumed.has(o.id) &&
          o.vesicleId === m.vesicleId &&
          ((macro === 'aa' && (o.kind === 'aa' || (o.kind === 'peptide' && o.sequence.length < MAX_POLYMER_LENGTH))) ||
            // A template mid-copy is excluded — ordinary random
            // condensation growing it from either end while a templated
            // copy is reading positions off it would desync the reading
            // frame (see templatedReplication's nextTemplateIndex).
            (macro === 'nt' && (o.kind === 'nt' || (o.kind === 'rna' && o.sequence.length < MAX_POLYMER_LENGTH && !o.copying)))),
      );
      if (!partner) continue;
      const energyNear = this.grid.queryRadius(m.x, m.y, this.catalystRadius);
      const energyNearby = energyNear.find((o) => o.kind === 'energy' && o.vesicleId === m.vesicleId && !consumed.has(o.id));
      if (!energyNearby) continue;

      const wantClass = macro === 'aa' ? 'peptidyl' : 'replicase';
      const rate = this.baseCondensationRate * this.nearbyCatalystBoost(m.x, m.y, wantClass);
      if (!this.rng.bool(rate)) continue;

      consumed.add(m.id);
      consumed.add(partner.id);
      consumed.add(energyNearby.id);
      this.removeParticle(energyNearby.id);

      if (partner.kind === 'peptide' || partner.kind === 'rna') {
        this.extendPolymer(partner, m as AminoAcidParticle | NucleotideParticle);
      } else if (macro === 'aa') {
        this.formDimer(m as AminoAcidParticle, partner as AminoAcidParticle);
      } else {
        this.formDimer(m as NucleotideParticle, partner as NucleotideParticle);
      }
    }
  }

  private extendPolymer(poly: PeptideParticle | RnaParticle, monomer: AminoAcidParticle | NucleotideParticle): void {
    if (poly.kind === 'peptide' && monomer.kind === 'aa') {
      if (this.rng.bool(0.5)) poly.sequence.unshift(monomer.code);
      else poly.sequence.push(monomer.code);
      refoldPeptide(poly);
    } else if (poly.kind === 'rna' && monomer.kind === 'nt') {
      if (this.rng.bool(0.5)) poly.sequence.unshift(monomer.code);
      else poly.sequence.push(monomer.code);
      refoldRna(poly);
    }
    this.removeParticle(monomer.id);
  }

  private formDimer(a: AminoAcidParticle | NucleotideParticle, b: AminoAcidParticle | NucleotideParticle): void {
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const vesicleId = a.vesicleId;
    if (a.kind === 'aa' && b.kind === 'aa') {
      const poly: PeptideParticle = {
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
      if (vesicleId !== null) this.vesicles.get(vesicleId)?.memberIds.add(poly.id);
    } else if (a.kind === 'nt' && b.kind === 'nt') {
      const poly: RnaParticle = {
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
      if (vesicleId !== null) this.vesicles.get(vesicleId)?.memberIds.add(poly.id);
    }
    this.removeParticle(a.id);
    this.removeParticle(b.id);
  }

  // --- templated RNA replication (the actual heredity mechanism) ---------
  private templatedReplication(): void {
    for (const p of [...this.particles.values()]) {
      if (p.kind !== 'rna') continue;
      // The minimum-length bar only gates *starting* a new copy — an
      // already in-progress one must be allowed to keep going even if it
      // (still theoretically, though hydrolysis now spares actively-
      // copying strands) sits right at the line, or one unlucky tick
      // permanently strands it a base short of ever finishing.
      if (!p.copying && p.sequence.length < MIN_TEMPLATE_LENGTH) continue;

      if (!p.copying) {
        // A ribozyme's own fold can catalyze its own copying (cis), same as
        // a nearby replicase-class peptide (trans) — either is real
        // "RNA world" chemistry. There's also a tiny uncatalyzed leak rate:
        // template-directed copying can happen without a catalyst at all,
        // just extremely slowly, which is exactly why a catalyst is such a
        // large fitness advantage once one exists.
        const selfBoost = p.fold.isRibozyme ? 1 + p.fold.catalysisStrength * this.catalystBoost : 1;
        const transBoost = this.nearbyCatalystBoost(p.x, p.y, 'replicase');
        const startRate = 0.0015 * Math.max(selfBoost, transBoost);
        if (this.rng.bool(startRate)) p.copying = { built: [], startedTick: this.tick };
        continue;
      }

      // A stalled complex eventually falls apart rather than freezing the
      // template at a fixed length forever (see particle.ts's doc comment
      // on RnaParticle.copying) — headless-verified as necessary: without
      // it, RNA length plateaued hard the instant the first copy attempt
      // got stuck, for the entire rest of a 150,000-tick run.
      if (this.tick - p.copying.startedTick > this.copyStallTimeout) {
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
        .filter((o): o is NucleotideParticle => o.kind === 'nt' && o.vesicleId === p.vesicleId);
      if (near.length === 0) continue;
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
        .find((o) => o.kind === 'energy' && o.vesicleId === p.vesicleId);
      if (!energyNearby) continue;

      // Calibrated up from an initial 0.04: headless verification showed
      // copies routinely stalling at ~15-20% of their template length
      // before hitting the stall timeout even with an active ribozyme
      // nearby — the base rate, not just catalysis, was too low to
      // realistically finish a 6-9-base copy inside a ~1000-tick window.
      const boost = this.nearbyCatalystBoost(p.x, p.y, 'replicase') * (p.fold.isRibozyme ? 1 + p.fold.catalysisStrength * 4 : 1);
      if (!this.rng.bool(Math.min(0.9, 0.12 * boost))) continue;

      this.removeParticle(energyNearby.id);
      p.copying.built.push(chosen.code);
      this.removeParticle(chosen.id);

      if (p.copying.built.length >= p.sequence.length) {
        const child: RnaParticle = {
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
  private lipidAssembly(): void {
    // Free lipids drift toward nearby free lipids — the hydrophobic effect
    // clustering tails together — before any vesicle exists to recruit
    // them into a membrane.
    const freeLipids = [...this.particles.values()].filter(
      (p): p is LipidParticle => p.kind === 'lipid' && p.vesicleId === null,
    );
    for (const l of freeLipids) {
      const near = this.grid
        .queryRadius(l.x, l.y, this.lipidAssemblyRadius)
        .filter((o): o is LipidParticle => o.kind === 'lipid' && o.id !== l.id && o.vesicleId === null);
      if (near.length === 0) continue;
      let ax = 0;
      let ay = 0;
      for (const n of near) {
        ax += n.x - l.x;
        ay += n.y - l.y;
      }
      l.vx += (ax / near.length) * 0.02;
      l.vy += (ay / near.length) * 0.02;
    }

    // A dense-enough free-lipid cluster spontaneously closes into a
    // vesicle. Flood-fill the neighbor graph to find clusters, and require
    // rough angular coverage around the centroid (not just a blob) so what
    // closes is actually ring-like, the way a real bilayer patch curls
    // into a sphere rather than staying a flat sheet.
    const visited = new Set<number>();
    for (const l of freeLipids) {
      if (visited.has(l.id) || l.vesicleId !== null) continue;
      const cluster: LipidParticle[] = [];
      const stack = [l];
      visited.add(l.id);
      while (stack.length) {
        const cur = stack.pop()!;
        cluster.push(cur);
        const near = this.grid
          .queryRadius(cur.x, cur.y, this.lipidAssemblyRadius)
          .filter((o): o is LipidParticle => o.kind === 'lipid' && o.vesicleId === null && !visited.has(o.id));
        for (const n of near) {
          visited.add(n.id);
          stack.push(n);
        }
      }
      if (cluster.length < MIN_VESICLE_LIPIDS) continue;
      let cx = 0;
      let cy = 0;
      for (const c of cluster) {
        cx += c.x;
        cy += c.y;
      }
      cx /= cluster.length;
      cy /= cluster.length;
      const sectors = new Set<number>();
      for (const c of cluster) sectors.add(Math.floor((Math.atan2(c.y - cy, c.x - cx) + Math.PI) / (Math.PI / 4)));
      if (sectors.size < 6) continue; // not wrapped all the way around yet

      this.formVesicle(cluster, cx, cy);
    }
  }

  private formVesicle(lipids: LipidParticle[], cx: number, cy: number): void {
    const v: Vesicle = {
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
    for (const l of lipids) l.vesicleId = v.id;
    // Whatever else was drifting inside the closing radius at the moment
    // of closure gets trapped along with it — the actual encapsulation
    // event. Nothing here biases *what* gets captured; it's whatever
    // happened to be nearby, for better or worse.
    const enclosed = this.grid.queryRadius(cx, cy, v.radius);
    for (const p of enclosed) {
      if (p.vesicleId !== null) continue;
      const dist = Math.hypot(p.x - cx, p.y - cy);
      if (dist <= v.radius) {
        p.vesicleId = v.id;
        v.memberIds.add(p.id);
      }
    }
    this.vesicles.set(v.id, v);
  }

  private recruitAndDivideVesicles(): void {
    for (const v of [...this.vesicles.values()]) {
      // Recompute centroid from the membrane itself so a vesicle drifts
      // with its lipids rather than staying pinned at its birth position.
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (const id of v.lipidIds) {
        const p = this.particles.get(id);
        if (!p) continue;
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
        .filter((p): p is LipidParticle => p.kind === 'lipid' && p.vesicleId === null);
      for (const l of nearbyFree) {
        l.vesicleId = v.id;
        v.lipidIds.push(l.id);
        v.memberIds.add(l.id);
      }
      if (nearbyFree.length > 0) v.radius = radiusForLipidCount(v.lipidIds.length);

      if (v.lipidIds.length >= DIVISION_LIPID_COUNT) this.divideVesicle(v);
    }
  }

  private divideVesicle(v: Vesicle): void {
    const lipids = v.lipidIds.map((id) => this.particles.get(id)).filter((p): p is LipidParticle => !!p);
    if (lipids.length < MIN_VESICLE_LIPIDS * 2) return; // not enough to make two viable daughters yet

    // Split the membrane ring roughly in half by angle around the
    // centroid — an equator, the same way a real growing vesicle actually
    // fissions.
    const sorted = lipids
      .map((l) => ({ l, angle: Math.atan2(l.y - v.y, l.x - v.x) }))
      .sort((a, b) => a.angle - b.angle);
    const mid = Math.floor(sorted.length / 2);
    const groupA = sorted.slice(0, mid).map((s) => s.l);
    const groupB = sorted.slice(mid).map((s) => s.l);

    const centroidOf = (group: LipidParticle[]): { x: number; y: number } => {
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

    const daughterA: Vesicle = {
      id: this.nextVesicleId++,
      x: ca.x,
      y: ca.y,
      radius: radiusForLipidCount(groupA.length),
      lipidIds: groupA.map((l) => l.id),
      memberIds: new Set(groupA.map((l) => l.id)),
      createdTick: this.tick,
      divisions: v.divisions + 1,
      replicationEvents: 0,
    };
    const daughterB: Vesicle = {
      id: this.nextVesicleId++,
      x: cb.x,
      y: cb.y,
      radius: radiusForLipidCount(groupB.length),
      lipidIds: groupB.map((l) => l.id),
      memberIds: new Set(groupB.map((l) => l.id)),
      createdTick: this.tick,
      divisions: v.divisions + 1,
      replicationEvents: 0,
    };
    for (const l of groupA) l.vesicleId = daughterA.id;
    for (const l of groupB) l.vesicleId = daughterB.id;

    // Non-membrane contents (peptides, RNA, trapped monomers) partition to
    // whichever daughter's centroid they ended up closer to — a stochastic
    // but not perfectly even split, same as real vesicle fission.
    for (const id of v.memberIds) {
      if (v.lipidIds.includes(id)) continue;
      const p = this.particles.get(id);
      if (!p) continue;
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

  // --- membrane permeability ---------------------------------------------
  private membraneDiffusion(): void {
    for (const p of this.particles.values()) {
      if (p.kind === 'peptide' || p.kind === 'rna' || p.kind === 'lipid') continue; // too big to cross
      if (!this.rng.bool(this.membranePermeability)) continue;
      if (p.vesicleId === null) {
        // Try to enter any vesicle whose membrane it's currently touching.
        const near = this.grid.queryRadius(p.x, p.y, 4);
        for (const o of near) {
          if (o.kind !== 'lipid' || o.vesicleId === null) continue;
          const v = this.vesicles.get(o.vesicleId);
          if (!v) continue;
          p.vesicleId = v.id;
          v.memberIds.add(p.id);
          break;
        }
      } else {
        const v = this.vesicles.get(p.vesicleId);
        if (v && Math.hypot(p.x - v.x, p.y - v.y) > v.radius * 0.85) {
          v.memberIds.delete(p.id);
          p.vesicleId = null;
        }
      }
    }
  }

  // --- bootstrap detection -------------------------------------------------
  private detectBootstrap(): void {
    for (const v of this.vesicles.values()) {
      let hasActiveCatalyst = false;
      let hasReplicator = false;
      const peptides: PeptideParticle[] = [];
      const rnas: RnaParticle[] = [];
      for (const id of v.memberIds) {
        const p = this.particles.get(id);
        if (!p) continue;
        if (p.kind === 'peptide') {
          peptides.push(p);
          if (p.fold.isCatalyst) hasActiveCatalyst = true;
        } else if (p.kind === 'rna') {
          rnas.push(p);
          if (p.sequence.length >= MIN_TEMPLATE_LENGTH) hasReplicator = true;
          if (p.fold.isRibozyme) hasActiveCatalyst = true;
        }
      }
      if (isBootstrapEligible(v, hasActiveCatalyst, hasReplicator)) {
        const already = this.bootstrapCandidates.some((c) => c.vesicleId === v.id);
        if (!already) {
          this.bootstrapCandidates.push({
            vesicleId: v.id,
            tick: this.tick,
            radius: v.radius,
            peptides,
            rnas,
            lipidCount: v.lipidIds.length,
          });
          if (this.bootstrapCandidates.length > 20) this.bootstrapCandidates.shift();
        }
      }
    }
  }

  // --- stats ---------------------------------------------------------------
  private sampleStats(): void {
    const snap = this.getStats();
    this.history.push(snap);
    if (this.history.length > this.maxHistory) this.history.shift();
  }

  getStats(): OriginStatsSnapshot {
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
      if (p.kind === 'aa') freeAA++;
      else if (p.kind === 'nt') freeNT++;
      else if (p.kind === 'lipid') freeLipid++;
      else if (p.kind === 'energy') freeEnergy++;
      else if (p.kind === 'peptide') {
        peptideCount++;
        longestPeptide = Math.max(longestPeptide, p.sequence.length);
        if (p.fold.isCatalyst) catalystCount++;
      } else if (p.kind === 'rna') {
        rnaCount++;
        longestRna = Math.max(longestRna, p.sequence.length);
        if (p.fold.isRibozyme) ribozymeCount++;
      }
    }
    let totalReplicationEvents = 0;
    for (const v of this.vesicles.values()) totalReplicationEvents += v.replicationEvents;

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
      totalReplicationEvents,
      bootstrapReady: this.bootstrapCandidates.length,
    };
  }
}

export type { Lipid };
