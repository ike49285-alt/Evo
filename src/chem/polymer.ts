/**
 * Folding and catalysis. This is where a random sequence turns into
 * *function* — the actual mechanism natural selection has something to
 * bite on, since an unfolded chain does nothing but sit there waiting to
 * hydrolyze back into monomers.
 *
 * Peptides fold via a simplified version of Dill's HP lattice model
 * (1985): walk the sequence out on a 2D square lattice, self-avoiding,
 * greedily maximizing non-sequential hydrophobic-hydrophobic contacts —
 * the same "bury the oily residues, leave the charged/polar ones exposed
 * to water" principle that drives real hydrophobic collapse. It's a
 * heuristic, not a real energy-minimization solver (full HP folding is
 * NP-hard), but it's deterministic per sequence — Anfinsen's dogma, sequence
 * determines structure — so results memoize cleanly.
 *
 * RNA folds via a simplified hairpin search: the best self-complementary
 * stem (a stretch that can fold back and Watson-Crick pair with itself
 * around a small loop), which is the same structural idea real ribozymes
 * (hammerhead, hairpin, etc.) use to build a catalytic pocket — just
 * brute-forced over short sequences instead of a full Zuker-style
 * dynamic-programming predictor.
 */
import { AminoAcidCode, AMINO_ACIDS, isHydrophobic, NucleotideCode, NUCLEOTIDES } from './elements.js';

// `motor` and `photoreceptor` exist for the Virtunism layer (see
// sim/genome.ts) — Stage 0's own pool chemistry only ever checks for one
// specific class per reaction (see origin.ts's `wantClass` checks), so a
// peptide that folds into either of these is simply inert in the pool,
// exactly as it should be (this soup has no use for a motor protein or a
// photoreceptor — those are Virtunism-body capabilities, not prebiotic
// reactions).
export type CatalysisClass = 'replicase' | 'peptidyl' | 'lipidsynthase' | 'protease' | 'motor' | 'photoreceptor';
export const CATALYSIS_CLASSES: readonly CatalysisClass[] = ['replicase', 'peptidyl', 'lipidsynthase', 'protease', 'motor', 'photoreceptor'];

export interface PeptideFold {
  folded: boolean; // false = too short, or got boxed in before finishing
  contacts: number; // non-sequential H-H lattice contacts
  stability: number; // 0..1ish compactness score
  isCatalyst: boolean;
  catalysisClass: CatalysisClass | null;
  catalysisStrength: number; // 0..1ish, scales reaction-rate multiplier
}

export interface RnaFold {
  stemLength: number;
  bondStrength: number; // sum of H-bond counts across the stem
  isRibozyme: boolean;
  catalysisStrength: number;
}

const MIN_FOLD_LENGTH = 8;
// Calibrated empirically against what the (fixed — see the turn-bias
// comment below) greedy walk actually produces: a 2000-sequence sample
// across lengths 8-30 puts this right around the 80th-90th percentile,
// so "catalytic" stays a real minority outcome (roughly 10-20% of folds
// at a given length) rather than either "nearly everything qualifies" or
// "almost nothing ever does" — both of which showed up at earlier,
// un-calibrated threshold values during headless tuning.
const CATALYTIC_STABILITY_THRESHOLD = 0.3;
const DIRS: Array<[number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

// Memoized by sequence — identical sequences always fold identically, and a
// long run will keep re-forming the same short random peptides over and
// over. Bounded the same way everything else in this project is bounded:
// not by never growing, but by not growing *forever* (see grid.ts / the
// tree-of-life pruning in world.ts for the same philosophy).
const peptideFoldCache = new Map<string, PeptideFold>();
const rnaFoldCache = new Map<string, RnaFold>();
const FOLD_CACHE_LIMIT = 6000;

function cacheSet<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.size >= FOLD_CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

export function foldPeptide(sequence: readonly AminoAcidCode[]): PeptideFold {
  const key = sequence.join('');
  const cached = peptideFoldCache.get(key);
  if (cached) return cached;

  if (sequence.length < MIN_FOLD_LENGTH) {
    return cacheSet(peptideFoldCache, key, {
      folded: false,
      contacts: 0,
      stability: 0,
      isCatalyst: false,
      catalysisClass: null,
      catalysisStrength: 0,
    });
  }

  const occupied = new Map<string, number>(); // "x,y" -> chain index
  const positions: Array<[number, number]> = [[0, 0]];
  occupied.set('0,0', 0);
  let contacts = 0;
  let boxedIn = false;

  for (let i = 1; i < sequence.length; i++) {
    const [px, py] = positions[i - 1];
    const isH = isHydrophobic(sequence[i]);
    const proline = AMINO_ACIDS[sequence[i]].kink;
    const prevDir = i >= 2 ? [px - positions[i - 2][0], py - positions[i - 2][1]] : null;

    let bestDir: [number, number] | null = null;
    let bestScore = -Infinity;
    let bestTrueGain = 0;
    for (const [dx, dy] of DIRS) {
      // Proline's ring locks the backbone dihedral — it can't continue
      // straight through the same bond direction as the residue before it.
      if (proline && prevDir && dx === prevDir[0] && dy === prevDir[1]) continue;
      const nx = px + dx;
      const ny = py + dy;
      const nkey = `${nx},${ny}`;
      if (occupied.has(nkey)) continue;
      let gain = 0;
      if (isH) {
        for (const [ex, ey] of DIRS) {
          const ni = occupied.get(`${nx + ex},${ny + ey}`);
          if (ni !== undefined && ni !== i - 1 && isHydrophobic(sequence[ni])) gain++;
        }
      }
      // Tie-break toward turning rather than continuing straight, scored
      // separately from the real contact count so the turn preference
      // never gets counted as a fractional "contact". Without this, every
      // early step (before any real structure exists to score against)
      // ties at gain=0 across all four directions, and picking the
      // first-in-order candidate every time means "continue straight"
      // always wins — which walks the whole chain out as a straight line,
      // a shape that can *never* produce a non-sequential contact no
      // matter how hydrophobic the sequence is. Real backbones coil, not
      // run straight for 10+ residues, so a small penalty on repeating
      // the previous bond direction is both a better heuristic and closer
      // to the real physics. (Verified this was the actual cause, not
      // just a guess: an empirical sweep before this fix found peptides
      // landing at essentially 0 contacts regardless of sequence — mean
      // stability ~0.02 across lengths 6-30 — because they were folding
      // out straight; after it, typical folds actually coil and pick up
      // real contacts.)
      const straight = prevDir !== null && dx === prevDir[0] && dy === prevDir[1];
      const score = gain - (straight ? 0.5 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestTrueGain = gain;
        bestDir = [dx, dy];
      }
    }

    if (!bestDir) {
      boxedIn = true;
      break;
    }
    const nx = px + bestDir[0];
    const ny = py + bestDir[1];
    positions.push([nx, ny]);
    occupied.set(`${nx},${ny}`, i);
    contacts += bestTrueGain;
  }

  // A couple of cysteines that end up lattice-adjacent form a disulfide
  // crosslink — real extra stability beyond hydrophobic packing alone.
  let disulfides = 0;
  for (let i = 0; i < positions.length; i++) {
    if (!AMINO_ACIDS[sequence[i]].formsDisulfide) continue;
    const [x, y] = positions[i];
    for (const [dx, dy] of DIRS) {
      const ni = occupied.get(`${x + dx},${y + dy}`);
      if (ni !== undefined && ni > i && AMINO_ACIDS[sequence[ni]].formsDisulfide) disulfides++;
    }
  }

  const n = sequence.length;
  const stability = Math.min(1, (contacts + disulfides * 1.5) / (0.55 * n));
  const isCatalyst = !boxedIn && stability >= CATALYTIC_STABILITY_THRESHOLD;

  let catalysisClass: CatalysisClass | null = null;
  let catalysisStrength = 0;
  if (isCatalyst) {
    // Surface residues: lattice positions with fewer than 3 occupied
    // neighbors are exposed to solvent rather than buried in the core —
    // that's where a binding/catalytic pocket actually forms.
    let posSurface = 0;
    let negSurface = 0;
    let aromaticSurface = 0;
    let hydrophobicSurface = 0;
    let serineSurface = 0;
    let histidineSurface = 0;
    let cysCount = 0;
    for (let i = 0; i < positions.length; i++) {
      const [x, y] = positions[i];
      let neighbors = 0;
      for (const [dx, dy] of DIRS) if (occupied.has(`${x + dx},${y + dy}`)) neighbors++;
      const aa = AMINO_ACIDS[sequence[i]];
      if (aa.formsDisulfide) cysCount++;
      if (neighbors >= 3) continue; // buried
      if (aa.charge > 0) posSurface++;
      if (aa.charge < 0) negSurface++;
      if (aa.aromatic) aromaticSurface++;
      if (isHydrophobic(sequence[i])) hydrophobicSurface++;
      if (sequence[i] === 'S') serineSurface++;
      if (sequence[i] === 'H') histidineSurface++;
    }

    // Each class's score is grounded in a real structural-biology pattern:
    //  - replicase: RNA's backbone is a chain of negative phosphates, so
    //    real RNA-binding proteins/ribozyme cofactors are Arg/Lys-rich.
    //  - protease: real hydrolytic active sites (chymotrypsin-style
    //    catalytic triads) lean on Ser + His, with aromatics lining the
    //    binding pocket.
    //  - lipidsynthase: anything that has to work at a membrane needs a
    //    hydrophobic face to sit against the lipid tails.
    //  - peptidyl: Cys thioester chemistry and general acid/base catalysis
    //    (negative residues) are the classic path to activating a peptide
    //    bond for ligation.
    //  - motor: real motor assemblies (flagellar motors, myosin/dynein-
    //    type domains) are large, membrane-associated structural
    //    complexes with a nucleotide-binding (ATP-hydrolyzing) site —
    //    the same hydrophobic-face reasoning lipidsynthase uses, plus a
    //    real positive-charge component (P-loop NTPase motifs are
    //    characteristically Gly/Lys-rich) so it's not just lipidsynthase
    //    under another name. Deliberately kept as a pure surface-count
    //    score like every other class here, not weighted by `stability`
    //    — headless-verified that multiplying by stability handicapped
    //    it against the other classes' unweighted integer-count scores
    //    in this same argmax comparison, so it almost never won even
    //    when it should have (99% of sampled genomes had zero motor
    //    protein at all before this fix).
    //  - photoreceptor: real photoreceptor proteins (the rhodopsin
    //    family) hold a light-absorbing chromophore in an aromatic-rich
    //    binding pocket — aromatic surface exposure is the cheapest
    //    honest proxy this fold model has for that.
    const scores: Record<CatalysisClass, number> = {
      replicase: posSurface * 2,
      protease: aromaticSurface * 1.5 + serineSurface + histidineSurface * 1.5,
      lipidsynthase: hydrophobicSurface,
      peptidyl: cysCount * 2 + negSurface,
      motor: hydrophobicSurface * 1.2 + posSurface * 0.5,
      photoreceptor: aromaticSurface * 2,
    };
    let best: CatalysisClass = 'replicase';
    let bestScore = -Infinity;
    (Object.keys(scores) as CatalysisClass[]).forEach((k) => {
      if (scores[k] > bestScore) {
        bestScore = scores[k];
        best = k;
      }
    });
    if (bestScore > 0) {
      catalysisClass = best;
      catalysisStrength = Math.min(1, stability * (0.4 + bestScore / n));
    } else {
      // Stable fold, but nothing resembling an active site — a structural
      // peptide, not an enzyme. Common outcome, not a bug.
      catalysisClass = null;
    }
  }

  return cacheSet(peptideFoldCache, key, {
    folded: !boxedIn,
    contacts,
    stability,
    isCatalyst: isCatalyst && catalysisClass !== null,
    catalysisClass,
    catalysisStrength,
  });
}

const MIN_STEM = 3;
const MIN_LOOP = 3;
// Real hairpin loops are short — classic "tetraloops" run 4-8nt — so
// capping the search window here isn't just a performance shortcut, it's
// closer to the real structural pattern than trying every loop size up to
// the full sequence length would be. Bounding it also turns what would be
// an O(n^3) search (all loop starts x all loop sizes x stem extension)
// into O(n^2): this mattered in practice — an earlier unbounded version of
// this search was the dominant cost of a headless run once RNA strands
// started reaching ~30-40nt.
const MAX_LOOP = 8;

export function foldRna(sequence: readonly NucleotideCode[]): RnaFold {
  const key = sequence.join('');
  const cached = rnaFoldCache.get(key);
  if (cached) return cached;

  const n = sequence.length;
  let bestStem = 0;
  let bestBondStrength = 0;

  for (let loopStart = 0; loopStart < n - MIN_LOOP; loopStart++) {
    const maxLoopSize = Math.min(MAX_LOOP, n - loopStart - 1);
    for (let loopSize = MIN_LOOP; loopSize <= maxLoopSize; loopSize++) {
      let left = loopStart;
      let right = loopStart + loopSize;
      let stem = 0;
      let bondStrength = 0;
      while (left >= 0 && right < n && NUCLEOTIDES[sequence[left]].pairsWith === sequence[right]) {
        stem++;
        bondStrength += NUCLEOTIDES[sequence[left]].bondStrength;
        left--;
        right++;
      }
      if (bondStrength > bestBondStrength) {
        bestBondStrength = bondStrength;
        bestStem = stem;
      }
    }
  }

  // A pure-GC 3-stem hits bondStrength 9 exactly (3 H-bonds x 3 pairs); a
  // pure-AU 3-stem only reaches 6. Requiring exactly 9 meant a stem's raw
  // *length* barely mattered next to its GC content, which isn't right —
  // a longer, mostly-AU stem is a real structure too. 7 lets a 4-pair
  // mostly-AU stem (or any mixed 3-4 pair stem) qualify without accepting
  // a bare 3-pair AU stem, which is genuinely too short to hold together.
  const isRibozyme = bestStem >= MIN_STEM && bestBondStrength >= 7;
  const result: RnaFold = {
    stemLength: bestStem,
    bondStrength: bestBondStrength,
    isRibozyme,
    catalysisStrength: isRibozyme ? Math.min(1, bestBondStrength / (2.5 * n)) : 0,
  };
  return cacheSet(rnaFoldCache, key, result);
}
