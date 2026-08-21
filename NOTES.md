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
- **A sixth mass-conservation bug, caught by the same discipline,
  during the later abiogenesis-tuning session**: `templatedReplication`
  had no `consumed`-id tracking within its own single pass —
  `condensePolymers` already has this exact pattern (a `Set` of ids
  used so far this pass), it just was never applied here. Since the
  grid snapshot a pass reads from isn't rebuilt *within* a single pass
  (only between passes — see #3 above), two different templates in the
  same tick could target the same free nucleotide or energy particle;
  the second one's `removeParticle()` on an already-gone id is a
  harmless no-op, but `p.copying.built.push()` ran regardless, silently
  minting a nucleotide-equivalent with no real free particle behind it.
  Invisible at the old (lower) reaction rates; a direct mass-ledger
  check (free + in-polymer + mid-copy-built counts, tracked every 2000
  ticks) caught +5 phantom nucleotides over 30k ticks the moment rates
  were raised as part of the "make natural abiogenesis actually
  reachable" pass. Fixed with the same `consumed`-Set pattern
  `condensePolymers` already uses; re-verified as exactly zero drift
  (aa/nt/lipid all held constant) over the same 30k-tick run.
- **Still not verified: a full bootstrap occurring *naturally* — but
  the reason changed, and it's worth recording precisely.** A later
  session ("make natural abiogenesis actually reachable") found and
  fixed a real structural bug: `divideVesicle()` hard-reset
  `replicationEvents: 0` on both daughters, while `isBootstrapEligible`
  requires `replicationEvents >= 2 && divisions >= 1` on the *same*
  vesicle object — meaning a vesicle was structurally incapable of ever
  qualifying on replication it completed before its first split; the
  instant it divided, both daughters needed two brand-new completions
  specifically timed *after* that division. Fixed by carrying the count
  through division in full (a lineage's replicative track record
  belongs to both branches equally — real daughter cells inherit
  working machinery, they don't re-earn it), verified in isolation with
  a synthetic vesicle (5 pre-division replicationEvents → both
  daughters correctly inherit 5, and the daughter that keeps its
  catalyst+replicator together becomes eligible immediately, no further
  replication needed). Paired with a modest (~1.5-2x) concentration/rate
  nudge — same 800x500 footprint, more copies of everything, higher
  condensation/catalyst-boost/replication-start/replication-extension
  rates, more energy throughput to match — chosen deliberately modest
  rather than aggressive.

  Headless-verified the *result* honestly, not assumed: across a
  10-seed x 80,000-tick sweep (800,000 total ticks), every single seed
  now reaches at least one real division (most within 10k-26k ticks,
  2 of 10 reaching a second division) — a dramatic, measured
  improvement in that specific milestone's reliability. But zero of the
  10 seeds reached a full natural bootstrap. A dedicated diagnostic
  pass on top (tracking, tick by tick, whether *any* vesicle ever
  simultaneously held `replicationEvents >= 2 && divisions >= 1`) found
  that gate was never once cleared in an 80,000-tick seed — meaning the
  fixed division-reset bug, real as it was, was not actually the
  proximate bottleneck in practice: the dominant rare event is still
  just getting 2 full templated copies to complete *specifically while
  the template is trapped inside a vesicle*, independent of division
  entirely. This lines up with what the file already documented above —
  the overwhelming majority of real completions happen free-floating in
  the open soup, not inside membranes — and explains why raising
  concentration/rates alone (which helped every *other* milestone
  measurably) didn't move this one enough on its own. A further,
  bigger push specifically on in-vesicle replication odds (or accepting
  a much longer real-world time horizon) is the honest next lever, not
  anything more with the division logic, which is now demonstrably
  correct.
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

## The wider dish — real emergent function, not organelles

This replaced an earlier hard-coded system (flagellum/mouth/chloroplast/
eye/armor/bud, decoded via a weighted-bucket lookup table from a gene's
sum-decoded value) — a fixed catalog where evolution could only ever pick
from 6 predetermined kinds, never discover a 7th or blend two. The
watchword for this rewrite was scientific accuracy: genes now translate
through the real standard genetic code into amino-acid sequences, fold
via the exact same HP-lattice mechanism Stage 0's own chemistry already
used (`chem/polymer.ts`'s `foldPeptide`), and whatever functional class
the fold's real surface chemistry produces *is* the organism's capability
— no lookup table, no fixed catalog, unbounded in combination.

- **Real translation**: `sim/genes.ts`'s protein-coding genes
  (`PROTEIN_GENE_LENGTH` = 60 symbols = 20 codons) read left-to-right
  through `chem/elements.ts`'s `CODON_TABLE` (the real 64-codon standard
  genetic code), stopping at the gene's end or the first STOP codon —
  which makes STOP-codon-introduced protein truncation a real,
  biologically grounded large-effect mutation, not a hand-injected one.
- **Six catalysis classes**, all scored from the fold's real surface-
  chemistry descriptors (posSurface/negSurface/aromaticSurface/
  hydrophobicSurface/serineSurface/histidineSurface/glycineSurface/
  cysCount/stability) via an argmax "best-scoring class wins" comparison
  — `replicase`/`peptidyl`/`lipidsynthase`/`protease` (Stage 0's original
  four) plus `motor` and `photoreceptor` (added for the Virtunism layer;
  inert in Stage 0's own pool chemistry, which only ever checks for one
  specific class per reaction). Class → capability: peptidyl → energy
  capture, protease → predation, lipidsynthase → structural defense,
  motor → motility + turn rate, photoreceptor → its own vision cone at
  its own gene-encoded mount angle, replicase → reproduction efficiency
  and (past a threshold) budding/colony growth.
- **Gene-expression scaling** (`GENE_EXPRESSION_SCALE` = 12,
  headless-tuned): a single fold's `catalysisStrength` is one molecule's
  worth of activity, but real cellular capability depends on how many
  copies get expressed — applied once in `classPower()`, not baked into
  the fold measurement itself.
- **Rich vs. cheap simulation fidelity**, decided once at birth from the
  population size at that moment (`World.richChemistryPopulationThreshold`
  = 60) and never re-evaluated — an individual born into a small
  population keeps running its richer simulation for its whole life even
  after the population grows past the threshold. Rich-mode individuals
  get a live, per-tick Ornstein-Uhlenbeck stochastic "expression noise"
  process (real transcriptional/translational bursting, not a frozen
  constant) that scales both capability and upkeep together each tick;
  cheap-mode individuals use the same deterministic formulas as before.
  Headless-verified both modes coexist and the split actually happens as
  designed (early founders rich, later births cheap) without either mode
  ever going extinct on its own.
- **Stage 0 retirement**: once the dish's population has stayed at or
  above a threshold for a sustained tick count, `main.ts` stops calling
  `origin.update()`/`autoBootstrap()` — a fresh abiogenesis event has
  effectively no chance of taking root against an already-established,
  many-generations-deep population, so that compute goes back to the
  living population. This is *not* an unconditional one-way latch: a
  headless run caught that if the population later collapses to true
  extinction, staying retired forever leaves the world permanently dead
  with no recovery path, so retirement un-latches the moment population
  hits 0, handing the compute budget back to abiogenesis. Verified
  against the exact seed that originally exposed the bug.
- **Sunlight as the only external input**, drawn via peptidyl-class
  proteins, shared across a finite dish-wide budget.
- **Brain as a small neural net:** ~15 sensor inputs → 10 hidden neurons →
  2 outputs. Offspring inherit a mutated copy of parent weights.
- **Three reproduction modes:** asexual, sexual, budded.
- **Carrying capacity, twice over:** shared sunlight budget, and no
  single lineage can occupy more than ~65% of the population cap.
- **No hard-coded species tiers** — diet, size, speed, defense are all
  just real protein-fold-derived class power, whether a founder came from
  the Designer (now a random-valid-genome test-seed tool, not a hand-
  picked loadout editor — there's no catalog left to hand-pick from) or
  from a bootstrapped protocell.
- **Tree of Life view** and **Ecosystem tab**, both bounded (pruned
  ancestry tree, capped/decaying carrion) rather than growing forever.

### Real bugs this rewrite surfaced (all headless-caught, all fixed)

Emergent, argmax-based class scoring is much easier to get subtly wrong
than a lookup table, and every one of these was a real behavioral bug
that shipped before a headless ensemble run caught it — worth keeping as
a reminder of why the "verify via actual runs, don't assume" discipline
matters more here, not less:

- **`motor` mathematically dominated `lipidsynthase`**: an early formula
  scored `motor` as `hydrophobicSurface * 1.2 + posSurface * 0.5` —
  strictly ≥ `lipidsynthase`'s plain `hydrophobicSurface` for every
  possible input, so `lipidsynthase` measured at a real, exact 0% across
  a 44,717-protein sample. Fixed by giving `motor` its own real,
  independent axis: glycine-rich surface content, the actual Walker-motif
  P-loop signature of real NTPase motor domains — not a bigger
  coefficient on an axis another class already owned.
- **`trimToProteinCap` couldn't tell classes apart**: its "keep
  functional genes first" trim only meant *any* of the six classes, and
  once `lipidsynthase` became the single most common catalytic outcome,
  a long founder-viability search could accumulate plenty of
  non-viability-relevant functional genes and silently push the one gene
  that actually cleared viability past the cap. Measured directly:
  founder viability dropped to ~87% instead of the ~100% the search's own
  attempt-count calibration predicted. Fixed with `prioritizeFounderGenes`,
  which sorts viability-relevant genes (peptidyl/protease/motor) ahead of
  everything else before the generic cap-down trim runs.
- **Bridge.ts's bootstrap-founder reroll collapsed for clean-multiple RNA
  lengths**: the search cursor advanced by a full `PROTEIN_GENE_LENGTH`
  (60) each attempt, which repeats the *identical* read whenever the RNA
  length shares a large common factor with 60 — viability actually got
  *worse* for longer RNA (0% at length 300, vs. 9% at length 12) because
  longer-but-60-divisible RNA collapsed to fewer genuinely distinct reads,
  not more. Fixed by advancing one nucleotide per attempt instead (a real
  frameshift-reading analog), capped at `rnaSymbols.length` attempts since
  further repeats are guaranteed once every offset's been tried.
- **A real ~2.2x per-tick performance regression**: `canEat` (and related
  per-protein-class checks) re-scanned `genome.proteins` from scratch on
  every call, and `World.buildInputs()` calls these for every nearby
  individual a virtunism senses, every tick, for every cell. Genomes now
  routinely carry 10-16 real proteins (up from ~9 before the reroll-cap
  recalibration below), so this scaled up enough that a `node --prof`
  profile showed `canEat` alone consuming ~25% of total runtime — more
  than the actual physics (distance math, neural-net forward passes)
  combined. Fixed by caching each class's total power and count on the
  `Genome` object once at construction (`classPowerCache`/
  `classCountCache` — genome.proteins never changes after a Genome is
  built), turning those checks into O(1) reads. Measured 17.12ms/tick →
  7.78ms/tick (solo, uncontended, identical deterministic run) at
  population ~220.
- **Founder-viability reroll cap needed real recalibration, twice**: the
  original cap (120 attempts) was tuned against an earlier, unbalanced
  class formula. Once all six classes competed fairly, a direct
  50,000-gene sample measured real single-gene hit rates of ~0.6%
  peptidyl / ~0.95% protease / ~0.24% motor — a 120-attempt cap measured
  at only ~59% actual founder-viability success. A cap-vs-success sweep
  found 800 attempts reaches ~99.8% and 1200 reaches 100% over 5,000
  trials; 1200 is used for real margin. This also exposed that the
  original reroll loop was accidentally O(attempts²) (re-decoding the
  whole accumulated gene list every attempt) — fine at 120, a real
  problem at the low thousands — fixed by tracking viability
  incrementally instead.

Previously verified (Dandelion/Rabbit hand-seeded runs, kept for
reference — the Dish's core loop is unchanged, only how genes decode into
capability and how founders arrive has): trait divergence real over
30,000+ ticks; predator lineage established in ~67% of 15 seeds, the rest
a real starvation collapse; a full multi-tier food web was never directly
witnessed end-to-end.

Newly verified this rewrite (all headless, node --prof where noted):
translation/fold ensemble confirms all six catalysis classes reachable
with real nonzero representation (no class mathematically stuck at 0%);
founder viability ~99.98% (up from a measured 58.7% mid-fix, before the
prioritizeFounderGenes/cap fixes landed); cheap-mode-only population
survived 50,000 ticks (40→209, one bottleneck down to 3 that recovered,
106 generations); rich/cheap mode split confirmed behaving as designed
(early founders rich, later births cheap, neither mode going extinct on
its own) over 20,000 ticks; Stage-0 retirement fires and its extinction
safety-valve un-latches correctly against the exact seed that first
exposed the "retired into a permanently dead world" bug; a fresh
50,000-tick survival run (post perf-fix) reached a stable population of
~320 (near max capacity) through at least 30,000 ticks with no extinction
before hitting the verification script's own wall-clock budget — it
stopped because it was thriving, not because it crashed.

**Not yet directly observed**: a full 50,000-tick run completing beyond
tick 30,000 in one continuous headless session (the perf-fixed build is
still ~4x slower per tick than the original organelle-based baseline at
comparable population, a real and accepted cost of genuinely richer
per-organism data — 10-16 real proteins instead of a fixed 2-6 organelle
slots — not further chased down given "less concerned it run smoothly
than that it run at all"); a live rich-mode population still containing
rich-mode individuals at the moment it's compared against a pure
cheap-mode baseline over an equally long window (rich founders
consistently aged out and died before either verification run's midpoint
in every headless run so far — expected, since maxAge is typically well
under the tick counts being tested, not a sign rich mode doesn't work).

## Tech constraint from last time

Original build environment blocked the npm registry/CDNs (git-only
access), which is why it's vanilla TypeScript + Canvas 2D instead of
Phaser/PixiJS. This session confirmed a local global `tsc` is available
without npm, so the build still works the same way.
