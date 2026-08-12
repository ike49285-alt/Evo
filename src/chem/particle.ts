import { GridPoint } from '../sim/grid.js';
import { AminoAcidCode, NucleotideCode } from './elements.js';
import { foldPeptide, foldRna, PeptideFold, RnaFold } from './polymer.js';

export interface BaseParticle extends GridPoint {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Which protocell currently encloses this particle, if any. Small
   * molecules can cross a membrane (slowly); polymers and lipids can't
   * once they're on one side of it. */
  vesicleId: number | null;
}

export interface AminoAcidParticle extends BaseParticle {
  kind: 'aa';
  code: AminoAcidCode;
}

export interface NucleotideParticle extends BaseParticle {
  kind: 'nt';
  code: NucleotideCode;
}

export interface LipidParticle extends BaseParticle {
  kind: 'lipid';
  tailLength: number;
}

/** An abstracted high-energy carrier (stand-in for the mineral-surface /
 * hydrothermal-vent / UV-driven activation real prebiotic chemistry needs
 * to couple to condensation reactions — those are endergonic in water and
 * don't just happen from proximity alone). This is this stage's sole
 * external energy input, the direct analog of "sunlight" in the dish
 * stage: everything else in the soup is a fixed, conserved pool of matter
 * that only gets rearranged, never created from nothing. */
export interface EnergyParticle extends BaseParticle {
  kind: 'energy';
}

export interface PeptideParticle extends BaseParticle {
  kind: 'peptide';
  sequence: AminoAcidCode[];
  fold: PeptideFold;
}

/** `copying` tracks an in-progress templated copy growing off this strand —
 * the actual heredity mechanism. It detaches into its own independent
 * RnaParticle once complete. `startedTick` backs a stall timeout: the
 * template is shielded from hydrolysis while copying (see origin.ts's
 * hydrolyze()), so a copy that can never find its next matching nucleotide
 * — drifted into a nucleotide-poor patch, say — needs some way to give up
 * and dissociate, or it freezes that strand at a fixed length forever
 * instead of just failing like a real stalled replication complex would. */
export interface RnaParticle extends BaseParticle {
  kind: 'rna';
  sequence: NucleotideCode[];
  fold: RnaFold;
  copying: { built: NucleotideCode[]; startedTick: number } | null;
}

export type Particle =
  | AminoAcidParticle
  | NucleotideParticle
  | LipidParticle
  | EnergyParticle
  | PeptideParticle
  | RnaParticle;

export function refoldPeptide(p: PeptideParticle): void {
  p.fold = foldPeptide(p.sequence);
}

export function refoldRna(p: RnaParticle): void {
  p.fold = foldRna(p.sequence);
}
