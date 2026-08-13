# Evo — notes on the current design

One continuous world, not two screens. `src/chem/` (the chemistry — free
amino acids and nucleotides bonding, folding, catalyzing, replicating) and
`src/sim/` (the organelle/Virtunism ecosystem from the previous attempt)
are two separate engines, but they share one dish: the chemistry runs in a
small, concentrated "primordial pool" region positioned *within* the same
coordinate space the ecosystem lives in, drawn together on one canvas by
one Renderer (see renderer.ts's `drawPool`). A protocell that proves
itself doesn't get handed to a different screen — it spawns as a small
founding population right at the pool, in the same frame, automatically
(see main.ts's `autoBootstrap`). This replaced an earlier tab-switcher
version (Origins/Dish as separate full-screen stages you manually clicked
between) that read as two toys bolted together instead of one thing
growing out of another — worth remembering if the temptation to re-split
them ever comes back.

Both engines tick every frame; the Dish starts empty and only gets
founders by a protocell bootstrapping out of the pool, or by hand-
designing a species in the Designer tab.

## The primordial pool — the core idea

A small, concentrated primordial soup: free amino acids and nucleotides
(the real 20/4-letter alphabets, real physicochemical properties, not
abstract tokens) drift and occasionally bond into polymers when an
energized collision happens to work out. Folded peptides can become
catalysts; RNA long and structured enough can start templating copies of
itself, mutations included. Lipids self-assemble into membranes for free —
no energy or catalyst needed, real fatty-acid vesicle chemistry works this
way — and a membrane that closes around a working replicator becomes a
protocell with real heredity. Nothing here is scripted to succeed; a
protocell has to actually earn its way out into the wider dish.

Same closed-loop philosophy as the Dish: matter (amino acids, nucleotides,
lipids) is a fixed pool set at seed time and only ever gets rearranged.
The one thing that enters from outside is an abstracted energy flux (this
stage's "sunlight") that condensation reactions consume and hydrolysis
doesn't need.

## Pool mechanics

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
- **Bootstrap translation** (`bridge.ts`): a founder's genes are built
  directly from its ancestral protocell's own real RNA nucleotide content
  — chunked/wrapped into `GENE_LENGTH`-sized genes (`Gene` is literally
  `NucleotideCode[]`, the exact same 4-letter alphabet Stage 0's RNA uses)
  — not an abstract stat translation. The catalyst repertoire still
  matters, just for a narrower role: it decides *how many* organelle
  genes a founder gets (peptidyl-heavy → leans more chloroplast genes,
  protease-heavy → more mouth genes, lipidsynthase → more armor, strong
  replicase → a mobility head start), and patches in one chloroplast gene
  only in the rare case real RNA content decoded to zero mouths *and*
  zero chloroplasts (a guaranteed-extinction edge case, not a normal
  outcome). This is still a documented translation-layer choice, not a
  claim that real biology works this way mechanistically — an actual
  genetic code and ribosomal translation are still out of scope — but the
  *symbols* themselves are no longer invented; "from abiogenesis to
  evolving life" is now a literal unbroken molecular sequence, not just a
  spatial/visual one.

## Genes and emergent species

The old "genome" was a flat struct of independent continuous fields
(`size`, `senseRadius`, `maxAge`, `hue`, `organelles[]`) each jittered
independently on reproduction — no real sequence, no real mutation
classes, and "species" was just `lineageId`, a label assigned once at
founding time and never anything the simulation itself discovered.

- **`src/sim/genes.ts`**: a real linear `GeneSequence` made of the same
  4-letter nucleotide alphabet Stage 0's RNA uses. `genes[0..4]` are
  fixed-locus core genes (size, senseRadius, maxAge, hue,
  reproductionMode — reproductionMode is now a real evolvable/mutable
  locus, not "inherited unchanged, never mutates" as before). `genes[5..]`
  is a *variable-length* run of organelle genes — variable length is the
  actual mechanism for structural change now, not a hand-rolled "5%
  chance to lose one, 6% chance to gain one" special case.
- **Mutation operators modeled on real chromosomal mutation classes**:
  point mutation (per-symbol, guaranteed to substitute a *different* base
  so the effective rate isn't silently 3/4 of the stated one), gene
  duplication, gene deletion, and inversion of a short contiguous run —
  all capped at `TRAIT_LIMITS.maxOrganelles`.
- **Unequal crossover** for sexual reproduction's organelle genes: an
  independent cut fraction in each parent's organelle-gene run, spliced
  together, so a child's organelle count doesn't have to match either
  parent's. This is a real biological route to gene duplication/deletion
  in its own right, not just a crossover mechanic borrowed for
  convenience. Core loci still assort independently, per-gene.
- **`genome.ts` keeps a cached phenotype**: `Genome.sequence` is the real
  heredity; `size`/`organelles`/etc. are a decode of it, refreshed on
  every construction/mutation/crossover. This was the deliberate move
  that kept the blast radius small — Virtunism, World, and the renderer
  never had to change, they still just read `genome.size` etc.
- **Emergent speciation** (`World.checkSpeciation`, called right before an
  individual actually reproduces — not at birth, so a one-off mutant that
  never passes anything on doesn't get to register as a "species"): if a
  cell's genome has diverged past `speciationThreshold` (0.34) from its
  lineage's `referenceSequence`, it founds a brand-new lineage right
  there — new id, its own genome becomes the new reference,
  `parentLineageId` set to the old lineage, itself and its descendants
  reassigned. Threshold (0.34) came from a direct population-scale sweep,
  not the offline single-lineage ensemble average that was tried first —
  see the verification section below for why the ensemble approach
  under-predicted the real firing rate by over an order of magnitude.
- **`geneticDistance`** is an explicitly documented proxy, not a rigorous
  population-genetics statistic: 0.5× per-locus core-trait distance +
  0.5× an alignment-free organelle-kind histogram distance. Real sequence
  alignment between two variable-length, independently-duplicated/deleted
  gene runs is a much harder problem than this needed to solve for a
  usable divergence signal.
- **Procedural species names** (`speciesNames.ts`): deterministic
  binomial-style names hashed from the founding genome's own sequence —
  same genome always names the same way, and naming has no side effect on
  simulation determinism (doesn't touch the world's rng stream).
- **Tree of Life** renders a speciation event as a visually distinct
  edge (dashed, colored by the new lineage's hue) and a dashed ring
  around the founding node, instead of an ordinary parent→child line —
  see `TreeNode.isSpeciationEvent` / `ui/treeview.ts`.

### Genes/speciation — verified, including a real bug caught and fixed

- **Gene mutation/crossover stress-tested at scale**: 20,000+ random
  mutation/crossover cycles, including deliberately adversarial edge
  cases (0-organelle and 1-organelle genomes run through 2,000
  consecutive mutation generations each) — organelle count always stayed
  within `TRAIT_LIMITS.maxOrganelles`, decoded traits always stayed
  in-bounds, zero crashes. `geneticDistance` sanity-checked over 2,000
  random pairs: symmetric, 0 for identical genomes, bounded to [0,1].
- **A real bug, caught by headless verification, not guessed at**: the
  first `checkSpeciation` implementation used a threshold (0.22) picked
  from an offline *ensemble average* of genetic distance after N
  generations of drift on a single isolated lineage. At actual population
  scale it was wrong by over an order of magnitude — 126 speciation
  events in 20,000 ticks against a capped, continuously-reproducing
  320-individual population, a new species roughly every 132 ticks. Root
  cause: the gene decode was positional base-4 (place-value), so a single
  point mutation to a gene's *first* symbol could swing a decoded trait
  by up to 75% of its whole range in one generation — an ensemble
  *average* doesn't surface that kind of heavy-tailed single-mutation
  jump, and hundreds of reproduction attempts per tick turned even a
  modest per-individual chance of a big jump into near-constant firing.
  Fixed by switching `decodeUnitFromSymbols` to sum-based decoding, where
  every symbol contributes equally and boundedly (~1/`GENE_LENGTH` of the
  range) — also a more realistic many-small-effect-loci model than one
  dominant digit.
- **Threshold recalibrated against real population dynamics**, not
  re-guessed: a direct sweep (same 320-cap scenario, 20k ticks each) —
  0.22 → 126 events, first@3479; 0.28 → 21, first@15484; 0.32 → 25,
  first@10332; 0.36 → 9, first@16031. Settled on 0.34.
- **Longer-horizon, multi-seed confirmation at the final threshold**
  (60k ticks, 3 seeds): speciation fired reliably in all three (first
  event between tick 6,589 and 10,332 — never absent, never instant).
  Total historical founding events were high (111-237 over the run) but
  almost all of those newly-founded lineages went extinct shortly after
  — expected, since a promoted individual isn't handed a safety-net
  founder population the way `addSpecies`/bootstrap founders are, it's
  just the one diverged individual and whatever it manages to reproduce.
  What actually matters for the player-facing "Living species" stat is
  *standing* diversity, not historical churn: it settled to 8-22
  concurrently-living species across the three seeds by tick 60,000 (the
  Tree of Life view is already pruned to living lineages + their
  ancestors, so this churn doesn't clutter it either). Worth flagging
  honestly for future reading: this model doesn't converge to a fixed
  species count — `geneticDistance` itself saturates rather than growing
  unboundedly, and a promoted lineage's reference resets to 0 distance,
  so *any* threshold below the saturation ceiling is eventually crossed
  again by a deep-enough lineage. Recurring speciation waves in a very
  long run are an inherent property of this design, not a bug; the
  tuning question was the steady-state cadence, not eliminating
  recurrence entirely.
- **Bootstrap founder genes verified against synthetic-but-structurally-
  real `BootstrapCandidate`s**: confirmed deterministic (same candidate →
  same sequence), confirmed the wraparound path produces a valid full
  gene sequence even from RNA content shorter than one gene's worth of
  symbols, and confirmed the one preserved viability guarantee (a founder
  never decodes to zero mouths *and* zero chloroplasts) held across
  catalyst-rich, catalyst-poor, and zero-catalyst synthetic candidates.
  **Not yet verified: a bootstrap-derived founder's genes surviving and
  visibly evolving over a long run** — the translation pipeline itself is
  confirmed correct and deterministic, but whether a real RNA-derived
  starting sequence behaves any differently in practice from a
  hand-designed one over thousands of generations is still open.

## What was actually verified this round (be honest about this again)

- Monomer condensation into polymers, peptide/RNA folding producing real
  catalytic peptides, and lipid vesicle formation + membrane growth all
  reliably occur within tens of thousands of ticks, headless-verified
  across many seeds. Ribozymes (self-catalytic RNA folds) form reliably
  too, typically within 10k-40k ticks.
- **RNA self-replication has been directly witnessed completing** — a
  full templated copy, mutation mechanism included, detaching as an
  independent RnaParticle — in 2 of 4 seeds in the most recent batch
  (150k ticks each). This took five real bugs, found by tracing actual
  particle IDs through individual ticks rather than by guessing at
  parameters:
  1. The greedy peptide fold's tie-break always preferred continuing
     straight, a shape that can *never* produce a non-sequential
     contact — chains were folding out as straight lines. Fixing the
     tie-break took mean fold stability from ~0.02-0.03 to ~0.12-0.16.
  2. A template mid-copy had no hydrolysis protection, so a copy
     starting near the minimum length was routinely orphaned by a
     single hydrolysis tick.
  3. **The dominant bug**: the spatial grid was rebuilt once per tick,
     but every reaction pass mutates the particle set — a later pass
     could still "find" and merge into a particle an earlier pass had
     already deleted that same tick, silently destroying real matter
     (a zombie object mutation nothing else references, while the real
     monomer merged "into" it got deleted for real). This was slowly
     starving the whole simulation of free nucleotides no matter how
     generous the reaction rates were tuned — confirmed by direct
     mass-ledger tracking (free + embedded-in-polymer + embedded-mid-
     copy nucleotide count), which held exactly constant at 140 for
     hundreds of ticks and then started leaking, tick-by-tick traced to
     this exact mechanism. Fixed by rebuilding the grid between every
     pass, not just once per tick.
  4. A second mass leak: an abandoned (timed-out) copy discarded its
     already-built bases instead of returning them to the free pool.
  5. The stall timeout was one flat number regardless of template
     length, so once RNA started growing past ~20nt via ordinary
     (uncapped, unrelated-to-replication) condensation, no template
     that long could structurally finish copying inside the window —
     confirmed by a run where RNA reached length 33 with an active
     ribozyme and still completed nothing in 150k ticks. Fixed by
     scaling the timeout per base.
  Also caught and fixed along the way: `totalReplicationEvents` in
  `getStats()` only summed each vesicle's own count, so it was blind to
  the (much more common) free-floating completions — several
  verification runs reported "zero replication" when the real answer
  was "the stat can't see most of it."
- **Not yet verified: a full bootstrap occurring *naturally*.** This
  needs 2+ replication events *inside the same vesicle* plus that
  vesicle surviving a division — a much rarer compound event than a
  single free-floating completion. An extended run on the one seed
  that had produced a completion (to 75k further ticks past its first)
  didn't produce a second, and a dedicated 200k-tick run afterward
  produced zero. This is a real, unresolved rarity question, not a
  bug — don't claim a natural bootstrap has been seen until one has.
- **What *is* verified: the bootstrap-to-founder pipeline itself is
  correct**, tested directly rather than waited on. Pushed a
  synthetic-but-structurally-real `BootstrapCandidate` (built from
  actual peptides/RNA the engine had produced) into a live Origin,
  confirmed `autoBootstrap()` drains it, `translateBootstrapCandidate`
  produces a valid genome, `World.addSpecies`'s new `spawnCenter`
  places all 4 founders within the expected radius of the pool
  location the candidate came from, and — the real test — the
  resulting lineage isn't DOA: left running for 2000 more ticks, it
  grew from 4 to 16 individuals, all alive. So: the machinery that
  *would* fire on a natural bootstrap is confirmed sound; whether a
  natural one is common enough to actually see in a normal play
  session is the part still genuinely open.

## Performance lessons (reapplied + new)

- Spatial hash grid for every neighbor query, same as the Dish — but
  rebuilt *between every reaction pass* within a tick, not once at the
  start of it. Costs more (~7 rebuilds/tick instead of 1, ~25-30%
  slower overall) but a stale mid-tick grid is a correctness bug, not
  just a performance nuance — see the mass-conservation bug above. At
  this particle count (hundreds, not thousands) the extra rebuilds are
  still sub-millisecond; worth revisiting if particle counts ever grow
  enough to make that not true.
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

## The wider dish — unchanged ecosystem mechanics

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
