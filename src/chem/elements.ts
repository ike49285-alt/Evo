/**
 * Stage 0 (Origins) building blocks. This is the "higher-fidelity chemistry"
 * layer: real amino acid identities with their real physicochemical
 * properties, not an abstract token alphabet. Two standard, textbook tables
 * are hardcoded below rather than invented:
 *
 *  - Hydropathy: Kyte & Doolittle 1982's scale (the classic water-vs-oil
 *    affinity index used throughout structural biology).
 *  - Residue volume: Zamyatnin 1972's average volume-in-protein figures
 *    (Å³), rescaled here to a 0-1ish "size" used for lattice-folding cost
 *    and diffusion.
 *
 * Everything downstream (H/P folding class, charge, aromaticity) is
 * *derived* from these real numbers rather than hand-picked per residue, so
 * a residue's behavior in the sim traces back to its actual chemistry.
 */

export type AminoAcidCode =
  | 'A' | 'R' | 'N' | 'D' | 'C' | 'Q' | 'E' | 'G' | 'H' | 'I'
  | 'L' | 'K' | 'M' | 'F' | 'P' | 'S' | 'T' | 'W' | 'Y' | 'V';

export interface AminoAcid {
  code: AminoAcidCode;
  name: string;
  hydropathy: number; // Kyte-Doolittle, -4.5..4.5
  volume: number; // Zamyatnin, Angstrom^3
  charge: -1 | 0 | 1; // at physiological pH
  aromatic: boolean;
  flexible: boolean; // glycine: no side chain, extra backbone freedom
  kink: boolean; // proline: ring locks the backbone, breaks a fold's regularity
  formsDisulfide: boolean; // cysteine: can crosslink two chain positions
}

const RAW_AMINO_ACIDS: Array<Omit<AminoAcid, 'aromatic' | 'flexible' | 'kink' | 'formsDisulfide'>> = [
  { code: 'A', name: 'Alanine', hydropathy: 1.8, volume: 89, charge: 0 },
  { code: 'R', name: 'Arginine', hydropathy: -4.5, volume: 174, charge: 1 },
  { code: 'N', name: 'Asparagine', hydropathy: -3.5, volume: 114, charge: 0 },
  { code: 'D', name: 'Aspartate', hydropathy: -3.5, volume: 111, charge: -1 },
  { code: 'C', name: 'Cysteine', hydropathy: 2.5, volume: 109, charge: 0 },
  { code: 'Q', name: 'Glutamine', hydropathy: -3.5, volume: 144, charge: 0 },
  { code: 'E', name: 'Glutamate', hydropathy: -3.5, volume: 138, charge: -1 },
  { code: 'G', name: 'Glycine', hydropathy: -0.4, volume: 60, charge: 0 },
  { code: 'H', name: 'Histidine', hydropathy: -3.2, volume: 153, charge: 0 },
  { code: 'I', name: 'Isoleucine', hydropathy: 4.5, volume: 167, charge: 0 },
  { code: 'L', name: 'Leucine', hydropathy: 3.8, volume: 167, charge: 0 },
  { code: 'K', name: 'Lysine', hydropathy: -3.9, volume: 169, charge: 1 },
  { code: 'M', name: 'Methionine', hydropathy: 1.9, volume: 163, charge: 0 },
  { code: 'F', name: 'Phenylalanine', hydropathy: 2.8, volume: 190, charge: 0 },
  { code: 'P', name: 'Proline', hydropathy: -1.6, volume: 113, charge: 0 },
  { code: 'S', name: 'Serine', hydropathy: -0.8, volume: 89, charge: 0 },
  { code: 'T', name: 'Threonine', hydropathy: -0.7, volume: 116, charge: 0 },
  { code: 'W', name: 'Tryptophan', hydropathy: -0.9, volume: 228, charge: 0 },
  { code: 'Y', name: 'Tyrosine', hydropathy: -1.3, volume: 194, charge: 0 },
  { code: 'V', name: 'Valine', hydropathy: 4.2, volume: 140, charge: 0 },
];

const AROMATIC: ReadonlySet<AminoAcidCode> = new Set(['F', 'W', 'Y', 'H']);

export const AMINO_ACIDS: Record<AminoAcidCode, AminoAcid> = Object.fromEntries(
  RAW_AMINO_ACIDS.map((aa) => [
    aa.code,
    {
      ...aa,
      aromatic: AROMATIC.has(aa.code),
      flexible: aa.code === 'G',
      kink: aa.code === 'P',
      formsDisulfide: aa.code === 'C',
    },
  ]),
) as Record<AminoAcidCode, AminoAcid>;

export const AMINO_ACID_CODES = Object.keys(AMINO_ACIDS) as AminoAcidCode[];

/** Binary hydrophobic/polar class for lattice folding (Dill's HP model,
 * 1985) — not hand-assigned, it just falls out of which side of zero the
 * real Kyte-Doolittle value lands on. */
export function isHydrophobic(code: AminoAcidCode): boolean {
  return AMINO_ACIDS[code].hydropathy > 0;
}

// ---------------------------------------------------------------------------

export type NucleotideCode = 'A' | 'U' | 'G' | 'C';

export interface Nucleotide {
  code: NucleotideCode;
  pairsWith: NucleotideCode;
  bondStrength: number; // H-bond count in the real base pair: A-U=2, G-C=3
  purine: boolean;
}

export const NUCLEOTIDES: Record<NucleotideCode, Nucleotide> = {
  A: { code: 'A', pairsWith: 'U', bondStrength: 2, purine: true },
  U: { code: 'U', pairsWith: 'A', bondStrength: 2, purine: false },
  G: { code: 'G', pairsWith: 'C', bondStrength: 3, purine: true },
  C: { code: 'C', pairsWith: 'G', bondStrength: 3, purine: false },
};

export const NUCLEOTIDE_CODES = Object.keys(NUCLEOTIDES) as NucleotideCode[];

/**
 * The real standard genetic code — not invented, the same 64-codon table
 * every known organism (with rare exceptions) actually uses to translate
 * RNA into protein. This is what makes a virtunism's protein genes a
 * literal translation rather than an abstract decode: the same codon
 * redundancy real biology has (several codons per amino acid) means some
 * point mutations are silent at the protein level, and a mutation that
 * introduces a premature STOP genuinely truncates the resulting protein —
 * both real mutational classes that fall out of using the actual code,
 * not something hand-tuned in.
 */
export type Codon = `${NucleotideCode}${NucleotideCode}${NucleotideCode}`;

const CODON_TABLE_RAW: Record<Codon, AminoAcidCode | 'STOP'> = {
  UUU: 'F', UUC: 'F', UUA: 'L', UUG: 'L',
  CUU: 'L', CUC: 'L', CUA: 'L', CUG: 'L',
  AUU: 'I', AUC: 'I', AUA: 'I', AUG: 'M',
  GUU: 'V', GUC: 'V', GUA: 'V', GUG: 'V',

  UCU: 'S', UCC: 'S', UCA: 'S', UCG: 'S',
  CCU: 'P', CCC: 'P', CCA: 'P', CCG: 'P',
  ACU: 'T', ACC: 'T', ACA: 'T', ACG: 'T',
  GCU: 'A', GCC: 'A', GCA: 'A', GCG: 'A',

  UAU: 'Y', UAC: 'Y', UAA: 'STOP', UAG: 'STOP',
  CAU: 'H', CAC: 'H', CAA: 'Q', CAG: 'Q',
  AAU: 'N', AAC: 'N', AAA: 'K', AAG: 'K',
  GAU: 'D', GAC: 'D', GAA: 'E', GAG: 'E',

  UGU: 'C', UGC: 'C', UGA: 'STOP', UGG: 'W',
  CGU: 'R', CGC: 'R', CGA: 'R', CGG: 'R',
  AGU: 'S', AGC: 'S', AGA: 'R', AGG: 'R',
  GGU: 'G', GGC: 'G', GGA: 'G', GGG: 'G',
};
export const CODON_TABLE: ReadonlyMap<Codon, AminoAcidCode | 'STOP'> = new Map(Object.entries(CODON_TABLE_RAW) as [Codon, AminoAcidCode | 'STOP'][]);

// ---------------------------------------------------------------------------

/**
 * A single simplified lipid: an amphiphile with a polar head and a
 * nonpolar tail, modeled on fatty-acid protocell membranes (Szostak lab —
 * simple single-chain amphiphiles self-assemble into bilayer vesicles from
 * concentration alone, no enzyme required, unlike peptide/RNA bond
 * formation which needs energy input). One archetype is enough to get
 * self-assembly; `tailLength` just perturbs packing/stability a little so
 * membranes aren't perfectly uniform.
 */
export interface Lipid {
  tailLength: number; // 1..2, cosmetic + slight stability effect
}
