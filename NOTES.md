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
