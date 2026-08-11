// Abiogenesis: the primordial soup. Amino acids drift, bond into proteins,
// and — sometimes, probabilistically, never guaranteed — a dense enough
// local cluster of proteins spontaneously condenses into the first
// individual of a lineage. This module owns the particle simulation;
// world.ts owns wiring it into the tick loop, and genome.ts's
// `genomeFromComposition` owns turning a condensed cluster into an actual
// genome. No DOM dependency, same as the rest of sim/.

import { Rng } from './rng.js';
import { GridEntry, SpatialGrid } from './grid.js';
import { Genome, ProteinFunction, genomeFromComposition, ACTIVE_ORGANELLE_TYPES } from './genome.js';
import { clamp } from './types.js';

/** Every flavor the soup can synthesize: the two chemistry-only functions,
 *  plus whichever organelle types are currently switched on. If an
 *  organelle type is gated off (see genome.ts's ACTIVE_ORGANELLE_TYPES),
 *  the soup stops synthesizing its amino acid too — the gate applies all
 *  the way down, not just at the genome layer. */
export const AMINO_FLAVORS: readonly ProteinFunction[] = ['structural', 'regulatory', ...ACTIVE_ORGANELLE_TYPES];

export interface AminoAcid extends GridEntry {
  flavor: ProteinFunction;
  vx: number;
  vy: number;
}

export interface Protein extends GridEntry {
  /** Monomer count by function — composition, not sequence; see genome.ts's docs on why. */
  composition: Partial<Record<ProteinFunction, number>>;
  length: number;
  age: number;
  vx: number;
  vy: number;
}

// ---- Tunables --------------------------------------------------------

export const MAX_AMINO_ACIDS = 900;
export const AMINO_SPAWN_PER_SEC = 25; // background abiotic synthesis, trickled in up to the cap
const DRIFT_ACCEL = 26; // units/sec^2 of random walk jitter
const MAX_DRIFT_SPEED = 14; // units/sec
const BOND_RADIUS = 16;
const BOND_CHANCE_PER_SEC = 2.4; // converted to a per-tick probability via dt
export const MAX_PROTEINS = 260;
const MAX_PROTEIN_LENGTH = 12;
// NOTE: `age` on a particle accumulates dt (seconds), not tick count, same
// convention as Carrion.age in food.ts — so despite the name this is a
// lifespan in seconds, not ticks. A protein that never gets consumed by
// condensation or extended by a fresh amino acid falls back apart after
// about a minute of sim time.
const PROTEIN_DECAY_TICKS = 60;
const CONDENSATION_RADIUS = 42;
const MIN_CONDENSATION_MASS = 40; // total monomer-units needed in a local cluster to even be a candidate
const MIN_STRUCTURAL_MASS = 9; // no membrane, no cell, regardless of everything else present
const CONDENSATION_CHANCE_PER_SEC = 0.045; // nucleation rate once a cluster clears the threshold

let nextParticleId = 1;

export function spawnAminoAcid(rng: Rng, x: number, y: number): AminoAcid {
  return {
    id: nextParticleId++,
    x,
    y,
    vx: rng.range(-MAX_DRIFT_SPEED, MAX_DRIFT_SPEED),
    vy: rng.range(-MAX_DRIFT_SPEED, MAX_DRIFT_SPEED),
    flavor: rng.pick(AMINO_FLAVORS),
  };
}

/** Background abiotic synthesis: trickles new amino acids in up to the cap.
 *  Returns the updated carry-over remainder (fractional spawns accumulate
 *  across ticks rather than rounding away at low framerates). */
export function supplyAminoAcids(
  aminoAcids: AminoAcid[],
  carryover: number,
  rng: Rng,
  width: number,
  height: number,
  dt: number,
): { aminoAcids: AminoAcid[]; carryover: number } {
  if (aminoAcids.length >= MAX_AMINO_ACIDS) return { aminoAcids, carryover };
  let budget = carryover + AMINO_SPAWN_PER_SEC * dt;
  const out = aminoAcids;
  while (budget >= 1 && out.length < MAX_AMINO_ACIDS) {
    out.push(spawnAminoAcid(rng, rng.range(0, width), rng.range(0, height)));
    budget -= 1;
  }
  return { aminoAcids: out, carryover: budget };
}

function driftAndWrap(p: { x: number; y: number; vx: number; vy: number }, dt: number, width: number, height: number, rng: Rng): void {
  // Uniform jitter, not Gaussian: this is background Brownian-ish motion,
  // not a value anything downstream needs to be normally distributed, and
  // `gaussian()`'s Box-Muller (log/sqrt/cos) is real money at up to ~1000
  // particles ticking 30x/sec. Visually indistinguishable, much cheaper.
  p.vx = clamp(p.vx + rng.range(-DRIFT_ACCEL, DRIFT_ACCEL) * dt, -MAX_DRIFT_SPEED, MAX_DRIFT_SPEED);
  p.vy = clamp(p.vy + rng.range(-DRIFT_ACCEL, DRIFT_ACCEL) * dt, -MAX_DRIFT_SPEED, MAX_DRIFT_SPEED);
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  if (p.x < 0) p.x += width;
  else if (p.x >= width) p.x -= width;
  if (p.y < 0) p.y += height;
  else if (p.y >= height) p.y -= height;
}

export function driftChemistry(aminoAcids: AminoAcid[], proteins: Protein[], dt: number, width: number, height: number, rng: Rng): void {
  for (const a of aminoAcids) driftAndWrap(a, dt, width, height, rng);
  for (const p of proteins) driftAndWrap(p, dt, width, height, rng);
}

// Reused across calls to avoid allocating a fresh array per grid query —
// at up to ~1000 particles ticking 30x/sec, that allocation churn was the
// dominant cost (see world.ts's perf notes on this module).
const scratchProteins: Protein[] = [];
const scratchAminos: AminoAcid[] = [];

/** Amino acids bond to each other or extend existing proteins on contact.
 *  A free amino acid can only take part in one bond per tick. */
export function bondPass(
  aminoAcids: AminoAcid[],
  proteins: Protein[],
  aminoGrid: SpatialGrid<AminoAcid>,
  proteinGrid: SpatialGrid<Protein>,
  dt: number,
  rng: Rng,
): { aminoAcids: AminoAcid[]; proteins: Protein[] } {
  const bondChance = 1 - Math.exp(-BOND_CHANCE_PER_SEC * dt);
  const consumedAmino = new Set<number>();
  const touchedProtein = new Set<number>();
  const survivingProteins = proteins.slice();

  for (const a of aminoAcids) {
    if (consumedAmino.has(a.id)) continue;
    if (!rng.chance(bondChance)) continue;

    // Prefer extending an existing protein over the pool's exhausted.
    scratchProteins.length = 0;
    proteinGrid.queryRadius(a, BOND_RADIUS, scratchProteins);
    let bestProtein: Protein | null = null;
    let candidateCount = 0;
    for (const p of scratchProteins) {
      if (touchedProtein.has(p.id) || p.length >= MAX_PROTEIN_LENGTH) continue;
      candidateCount++;
      // Reservoir-sample of size 1 so every candidate has equal odds without a second array.
      if (rng.chance(1 / candidateCount)) bestProtein = p;
    }
    if (bestProtein) {
      bestProtein.composition[a.flavor] = (bestProtein.composition[a.flavor] ?? 0) + 1;
      bestProtein.length += 1;
      bestProtein.age = 0;
      consumedAmino.add(a.id);
      touchedProtein.add(bestProtein.id);
      continue;
    }

    if (survivingProteins.length >= MAX_PROTEINS) continue; // at cap, can't start a new chain
    scratchAminos.length = 0;
    aminoGrid.queryRadius(a, BOND_RADIUS, scratchAminos);
    let partner: AminoAcid | null = null;
    let partnerCount = 0;
    for (const b of scratchAminos) {
      if (b.id === a.id || consumedAmino.has(b.id)) continue;
      partnerCount++;
      if (rng.chance(1 / partnerCount)) partner = b;
    }
    if (!partner) continue;

    const composition: Partial<Record<ProteinFunction, number>> = {};
    composition[a.flavor] = (composition[a.flavor] ?? 0) + 1;
    composition[partner.flavor] = (composition[partner.flavor] ?? 0) + 1;
    survivingProteins.push({
      id: nextParticleId++,
      x: (a.x + partner.x) / 2,
      y: (a.y + partner.y) / 2,
      vx: (a.vx + partner.vx) / 2,
      vy: (a.vy + partner.vy) / 2,
      composition,
      length: 2,
      age: 0,
    });
    consumedAmino.add(a.id);
    consumedAmino.add(partner.id);
  }

  return {
    aminoAcids: consumedAmino.size ? aminoAcids.filter((a) => !consumedAmino.has(a.id)) : aminoAcids,
    proteins: survivingProteins,
  };
}

export function decayProteins(proteins: Protein[], dt: number): Protein[] {
  const out: Protein[] = [];
  for (const p of proteins) {
    p.age += dt;
    if (p.age < PROTEIN_DECAY_TICKS) out.push(p);
  }
  return out;
}

export interface Spark {
  genome: Genome;
  x: number;
  y: number;
}

/** The origin event. For each protein cluster that clears the threshold,
 *  rolls a nucleation check; on success the whole cluster is consumed and
 *  becomes a Spark for World to spawn as a founder. No viability check —
 *  see genome.ts's `genomeFromComposition` docs. */
export function attemptCondensation(
  proteins: Protein[],
  proteinGrid: SpatialGrid<Protein>,
  dt: number,
  rng: Rng,
): { proteins: Protein[]; sparks: Spark[] } {
  const nucleationChance = 1 - Math.exp(-CONDENSATION_CHANCE_PER_SEC * dt);
  const consumed = new Set<number>();
  const sparks: Spark[] = [];

  for (const p of proteins) {
    if (consumed.has(p.id)) continue;
    scratchProteins.length = 0;
    proteinGrid.queryRadius(p, CONDENSATION_RADIUS, scratchProteins);

    let totalMass = 0;
    let clusterSize = 0;
    const massByFunction: Partial<Record<ProteinFunction, number>> = {};
    for (const q of scratchProteins) {
      if (consumed.has(q.id)) continue;
      clusterSize++;
      for (const fn of Object.keys(q.composition) as ProteinFunction[]) {
        const m = q.composition[fn] ?? 0;
        massByFunction[fn] = (massByFunction[fn] ?? 0) + m;
        totalMass += m;
      }
    }
    if (totalMass < MIN_CONDENSATION_MASS) continue;
    if ((massByFunction.structural ?? 0) < MIN_STRUCTURAL_MASS) continue;
    if (!rng.chance(nucleationChance)) continue;

    let cx = 0;
    let cy = 0;
    for (const q of scratchProteins) {
      if (consumed.has(q.id)) continue;
      consumed.add(q.id);
      cx += q.x;
      cy += q.y;
    }
    cx /= clusterSize;
    cy /= clusterSize;

    sparks.push({ genome: genomeFromComposition(massByFunction, rng), x: cx, y: cy });
  }

  return {
    proteins: consumed.size ? proteins.filter((p) => !consumed.has(p.id)) : proteins,
    sparks,
  };
}
