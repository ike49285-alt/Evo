# Evo — notes on the current design

Two tiers now, not one. Stage 0 (`src/chem/`, the "Origins" screen) is a
from-amino-acids abiogenesis sandbox; Stage 1 (`src/sim/`, the "Dish"
screen) is the organelle/Virtunism ecosystem from the previous attempt,
unchanged in spirit but no longer hand-seeded — it starts empty and only
gets founders by bootstrapping a stabilized protocell out of Origins, or by
hand-designing a species in the Designer tab. Both engines tick every
frame regardless of which screen is on top.

## Stage 0: Origins — the core idea

A small, concentrated primordial soup: free amino acids and nucleotides
(the real 20/4-letter alphabets, real physicochemical properties, not
abstract tokens) drift and occasionally bond into polymers when an
energized collision happens to work out. Folded peptides can become
catalysts; RNA long and structured enough can start templating copies of
itself, mutations included. Lipids self-assemble into membranes for free —
no energy or catalyst needed, real fatty-acid vesicle chemistry works this
way — and a membrane that closes around a working replicator becomes a
protocell with real heredity. Nothing here is scripted to succeed; a
protocell has to actually earn its way to the Dish.

Same closed-loop philosophy as the Dish: matter (amino acids, nucleotides,
lipids) is a fixed pool set at seed time and only ever gets rearranged.
The one thing that enters from outside is an abstracted energy flux (this
stage's "sunlight") that condensation reactions consume and hydrolysis
doesn't need.

## Stage 0 mechanics

- **Real chemistry tables**, not invented ones: Kyte-Doolittle hydropathy
  and Zamyatnin residue volume for all 20 amino acids; real RNA
  Watson-Crick pairing with real H-bond counts (A-U=2, G-C=3).
- **Peptide folding** via a simplified HP lattice model (Dill 1985):
  hydrophobic/polar class falls out of the real hydropathy sign, not a
  hand-picked label. **RNA folding** via a bounded hairpin-stem search
  (a simplified, brute-forced version of the same idea real ribozyme
  secondary structure prediction uses).
- **Catalysis derived from fold chemistry**: a folded peptide's exposed
  surface residues determine its catalytic class — e.g. a
  positively-charged surface catalyzes RNA ligation, which is real
  electrostatics (RNA's backbone is anionic, so real RNA-binding
  proteins/ribozyme cofactors are Arg/Lys-rich).
- **Templated RNA replication with mutation** is the actual heredity
  mechanism: a long-enough RNA strand can start templating a
  complementary copy off free nucleotides, occasionally mispairing.
  Shielded from hydrolysis while actively copying (a real stalled-vs-
  active replication complex distinction), with a stall timeout so a copy
  that can't find its next base dissociates instead of freezing the
  strand's length forever.
- **Lipid vesicles**: a dense-enough free-lipid cluster spontaneously
  closes into a membrane once it wraps most of the way around its own
  centroid; membrane recruits nearby free lipids and grows; divides once
  its membrane is large enough, splitting contents stochastically between
  daughters — model protocell growth-division cycling, the same mechanism
  real fatty-acid-vesicle origin-of-life research (Szostak lab) studies.
- **Bootstrap bar**: a protocell only becomes eligible to seed the Dish
  once it has an active catalyst, has completed at least 2 real
  replication events, and has survived a division with a replicator still
  inside — a lucky one-off capture doesn't count as heritable.
- **Bootstrap translation** (`bridge.ts`): a protocell's evolved catalyst
  repertoire deterministically becomes a founder organelle loadout —
  anabolic (peptide-bond-forming) catalysts seed chloroplasts, hydrolytic
  (protease-class) catalysts seed mouths, membrane-associated catalysts
  seed armor, and strong replicase activity seeds a mobility head start.
  This is a documented translation-layer choice, not a claim that real
  biology works this way mechanistically — an actual genetic code and
  ribosomal translation are still out of scope.

## What was actually verified this round (be honest about this again)

- Monomer condensation into polymers, peptide/RNA folding producing real
  catalytic peptides (verified via direct fold-distribution sampling, not
  just eyeballing the sim), and lipid vesicle formation + membrane growth
  all reliably occur within tens of thousands of ticks, headless-verified
  across multiple seeds.
- Two real bugs were found and fixed via headless verification, not just
  parameter tuning: (1) the greedy peptide fold's tie-break always
  preferred continuing straight, a shape that can *never* produce a
  non-sequential contact regardless of sequence — chains were folding out
  as straight lines, and fixing the tie-break took mean fold stability
  from ~0.02-0.03 to ~0.12-0.16 across lengths 8-30; (2) a template
  mid-copy had no hydrolysis protection, so a copy starting right at the
  minimum length was routinely orphaned by a single hydrolysis tick —
  replication never completed in a 150k-tick run despite catalysts
  existing, even though the *rate* math said it should have.
- **Not yet verified: a completed RNA self-replication event, or a
  bootstrap into the Dish.** A 5-seed batch (150k-300k ticks each) with
  the two bug fixes above reliably produced catalytic peptides (all 5
  seeds, 9k-34k ticks) and occasionally a ribozyme (2 of 5 seeds), but
  zero completed replications and zero bootstraps. Direct progress
  tracking showed why: copy attempts were stalling at 15-50% of their
  template length well before the stall timeout, not from bad luck but
  from a per-base extension rate that was calibrated too low (0.04) to
  realistically finish a 6-9-base copy — since fixed to 0.12 along with
  a wasted-tick edge case in the mismatch logic, but this hasn't been
  re-verified end-to-end yet. Don't claim replication or bootstrap work
  until one is actually witnessed completing in a headless run — this is
  the same discipline the original Dish notes insisted on, and it's
  exactly the mistake honesty here is meant to catch.

## Performance lessons (reapplied + new)

- Spatial hash grid for every neighbor query, same as the Dish.
- RNA's hairpin search is bounded to realistic tetraloop-sized loops
  (3-8nt) rather than searched up to the full sequence length — this
  turned an O(n^3) search into O(n^2), and mattered in practice: an
  earlier unbounded version was the dominant per-tick cost once strands
  reached ~30-40nt.
- Fold results are memoized by sequence (bounded cache, cleared rather
  than left to grow forever) — identical sequences fold identically
  (Anfinsen's dogma), and a long run re-forms the same short peptides
  constantly.
- Vesicle division threshold is calibrated against the *actual* lipid
  economy, not picked in the abstract: a fixed ~160-220 lipid pool split
  across the several vesicles that typically coexist settles out to
  roughly 10-25 lipids each, so a 40-lipid bar made division structurally
  unreachable no matter how long a run went; recalibrated to 22.
- The soup arena is deliberately small/concentrated (a "tide pool," not
  an ocean) — real dilute-solution prebiotic chemistry runs into a
  genuine "concentration problem," and an early larger-arena version
  never grew a polymer past 2 monomers in a 60k-tick, 5-seed run as a
  direct result.

## Dish (Stage 1) — unchanged from the previous attempt

Everything below carries over as-is; see git history for the original
design rationale.

- **Sunlight as the only external input**, drawn via chloroplast organelles,
  shared across a finite dish-wide budget.
- **Organelle-based physical evolution:** flagella, mouths, chloroplasts,
  eyes, armor, a bud gland for multicellularity — each has upkeep cost;
  mutation adds/removes/resizes/repositions organelles each generation.
- **Brain as a small neural net:** ~15 sensor inputs → 10 hidden neurons →
  2 outputs. Offspring inherit a mutated copy of parent weights.
- **Three reproduction modes:** asexual, sexual, budded.
- **Carrying capacity, twice over:** shared sunlight budget, and no
  single lineage can occupy more than ~65% of the population cap.
- **No hard-coded species tiers** — diet, size, speed, defense are all
  just organelle counts/sizes, whether a founder came from the Designer
  or from a bootstrapped protocell.
- **Tree of Life view** and **Ecosystem tab**, both bounded (pruned
  ancestry tree, capped/decaying carrion) rather than growing forever.

Previously verified (Dandelion/Rabbit hand-seeded runs, kept for
reference — the Dish itself is unchanged, only how it gets founders has):
trait divergence real over 30,000+ ticks; predator lineage established in
~67% of 15 seeds, the rest a real starvation collapse; a full multi-tier
food web was never directly witnessed end-to-end.

## Tech constraint from last time

Original build environment blocked the npm registry/CDNs (git-only
access), which is why it's vanilla TypeScript + Canvas 2D instead of
Phaser/PixiJS. This session confirmed a local global `tsc` is available
without npm, so the build still works the same way.
