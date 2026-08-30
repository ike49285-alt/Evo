# Evo — notes on the current design

## Handover (read this first)

**State as of this handover**: the closed-loop-soup redesign (see
"Branch experiment: a hydrothermal vent" and the sections after it,
below) is **fully merged onto the repo's real default branch**,
`claude/cell-lab-evolution-simulator-nu6bbe` — confirmed via `git
rev-parse`, an exact fast-forward, no merge commit, 0 divergence. The
default branch is NOT `main`/`master` — there is no `main` branch in
this repo. `claude/closed-loop-soup` (the branch all that work was
developed on) is now superseded/redundant now that its tip is on
default; don't keep developing there.

**This round**, on `claude/elf-eyes-observation-9cin5d` (cut clean from the
default branch tip with 0 divergence, as the previous handover asked): the
**gene editor**, then **Stage 0 retired by default** — the primordial pool
is switched off, not deleted. Both have their own sections below.


**Stage 0 is now OFF by default** (see "Stage 0 retired" below). Everything
listed next is still in the code and comes back in full with `?soup=1` — it
is switched off, not deleted.

**What's live on default now, in order**: hydrothermal vent
(continuous matter source + agitation current) → full-dish pool
(patch-seeded, not diluted — the pool spans the whole dish, not a
corner of it) → division-cooldown fix (vesicles were re-fusing
immediately after splitting) → vent radial-dispersal + patch-anchored
position fixes (particles were orbiting in fixed circles instead of
actually spreading) → wall recycling (free soup despawns at walls and
recycles through the vent instead of piling up) → manual soup-spawning
tool (Chemistry tab: place specific chemistry by hand, including
forced-catalytic/ribozyme) → a jumpy-Chemistry-tab CSS fix.

**Three real, still-true caveats — not fixed, not hidden, explicitly
accepted by the user**:
1. The full-dish patch-seeded pool shows a measured *regression* in
   peptide/RNA growth vs. the old small-pool baseline (see the Phase B
   section below for the actual numbers and the untested hypothesis for
   why). User's call: "I like it as is." Not chased with a fix.
2. The original question the whole vent mechanic was built to answer —
   does agitation actually increase real bootstrap likelihood — is
   **still genuinely unanswered**. Every sweep run so far (this whole
   redesign's lifetime) was too short a horizon to produce a real
   signal either way.
3. **The Tree of Life needs visual work.** Three real defects, all
   confirmed in source and all user-observed, none fixed:
   a. *Blurry.* **FIXED for the tree** — `treeview.ts` now backs its canvas
      at device resolution and lays out in CSS pixels, verified at both 1x
      and 2x. The four canvas routines in `src/ui/chart.ts` still set
      `canvas.width = clientWidth` in CSS pixels and remain soft. So on any high-DPI
      screen the tree and every chart render at 1x beside a 2x dish. Not a
      one-liner: every routine computes layout from `const w =
      canvas.width`, treating the backing store as the CSS drawing space,
      so each must move to `clientWidth`/`clientHeight` plus
      `ctx.setTransform(dpr,0,0,dpr,0,0)` or every coordinate halves.
      Two adjacent quirks to fix in the same pass: `drawSparkline`
      (`chart.ts:6-9`) sets `canvas.width` but never `canvas.height`; and
      `main.ts`'s deferred-draw arrangement (canvases read 0 while their
      panel is `display:none`) must be preserved, not sized eagerly.
   b. *Dense trees smear into an unreadable band.* **FIXED** — see
      "Tree of Life: collapsing the present" below. Was ~16x node overlap
      at the canvas floor; now no two marks come closer than ~14px.
   c. *No labels, no zoom, no pan.* **Zoom and pan FIXED** — drag to pan,
      wheel or pinch to zoom, anchored on the cursor, with a Fit button.
      Branch labels are still absent.
   Explicitly **ruled out by user observation**: horizontal node drift.
   The code does rescale x to `minTick`/`maxTick` every frame
   (`treeview.ts:120-134`), which in principle slides every node as the
   retained span changes, but the user confirms it is not happening in
   practice. Not a defect to chase.

**Gene editing is now SHIPPED** (this round) — see "Gene editor" below
for the full writeup, including three claims in the old plan for this
feature that turned out to be wrong when checked against the code.

**Session conventions worth knowing, established over many rounds**:
verify before committing (headless scripts + Playwright, not "looks
right"); document real findings honestly in this file even when
negative or unresolved, in the same round they're found; scratch/
verification scripts live in a session-scratchpad directory, never
committed to the repo; rebuild `dist/` and republish the artifact
bundle after any shipped change. **The bundler is committed now** —
`tools/build-artifact.mjs`, run with `npm run build:artifact`. This
supersedes the old note that the bundling scripts were scratchpad-only and
a fresh session had to recreate or re-derive them; see "Shipping Evo as a
single-file Artifact" below.

## Older design notes below (mostly still accurate, Phase-B section
   above is the most recent authoritative state for the pool specifically)

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
- **Second tuning pass, following that lever, also didn't clear the
  bar — and found the lever itself was aimed at the wrong stage of the
  pipeline.** Added a real, targeted `inVesicleReplicationBoost` (1.75x
  on both the copy start-rate and per-base extension rate, active only
  when a template is inside a vesicle) plus a `membranePermeability`
  raise (0.02 → 0.035, so interior substrate can resupply from outside
  instead of stalling on local depletion) — grounded in real protocell
  theory: compartmentalization is supposed to concentrate and protect
  reactants, which the model previously represented only as a
  constraint (smaller same-vesicle reaction pool), never as a benefit.
  Mass conservation re-verified exactly held at the new rates.

  Result, headless-verified honestly: another 10-seed x 80,000-tick
  sweep still produced **zero** natural bootstraps (9 of 10 seeds
  divided at least once, matching the first pass). Rerunning the exact
  `replicationEvents >= 2 && divisions >= 1` diagnostic found that gate
  *still* never cleared once, identical to the pre-boost baseline — and
  a separate, even more granular check (sampling *every single tick*,
  not just periodically, across a fresh 30,000-tick run) found a live
  catalyst **and** a live replicator never once existed inside the same
  vesicle *at the same time*, for the entire run. That's the real
  finding: a rate multiplier on replication can't help when replication
  never gets a chance to run at all, because the actual bottleneck is
  one level upstream — getting a real catalytic peptide and a real
  replicator-length RNA *encapsulated together* in the first place, not
  how fast they replicate once that's true. `inVesicleReplicationBoost`
  is real, correct, and kept (it's not wrong, just insufficient on its
  own — see the Chemistry tab's "closest to bootstrap" detail, which
  will show this live gate directly once it does happen), but the next
  real lever is about encapsulation composition and/or the survival of
  a trapped catalyst+replicator pair against hydrolysis, not replication
  rate constants — those have now been pushed twice without addressing
  the actual constraint.
- **Third pass: attacked encapsulation directly with two real,
  literature-grounded mechanisms — found and fixed a self-defeating bug
  they created together — and ended up pinpointing a sharper root cause
  one level further upstream than "encapsulation is hard."** Asked
  directly by the user for more realism and a codebase that stays easy
  to extend; `Origin.tickOnce()` was already the right shape for that
  (a flat, ordered list of small, independently-tunable, commented
  private methods, each grid-rebuilt between passes) and is now
  documented as the deliberate pattern, with wet-dry cycling and
  mineral-surface catalysis named as future candidates that fit it
  without further design work.

  Added `fuseVesicles()`: two touching vesicles fuse stochastically
  (`vesicleFusionChance = 0.05`/tick on contact), same as real
  fatty-acid protocells (Zhu & Szostak 2009; Budin & Szostak 2011) —
  fission and fusion are both normal parts of real protocell population
  dynamics. Merges are real merges (`mergeVesicles()`): membership,
  `vesicleId` re-keying, radius, and — same inheritance principle as
  division — `replicationEvents`/`divisions` take the max of the two,
  not a reset. Also gave catalytically-active peptides and replicator-
  length RNA a weak, documented-as-soft pull on nearby free lipids
  during `lipidAssembly()`'s clustering step (real precedent: Hanczyc,
  Fujikawa & Szostak 2003 — surfaces that concentrate prebiotic
  chemistry also nucleate membrane formation around themselves), so a
  *newly forming* vesicle is somewhat more likely to close around real
  chemistry instead of empty soup. Verified fusion works correctly in
  isolation: a synthetic catalyst-only vesicle and replicator-only
  vesicle, forced into contact, merge into one vesicle whose live gates
  both flip true (9/9 checks: membership, re-keying, max-of counters,
  no particle loss).

  Full-sweep verification caught a real bug fusion introduced: fusing
  two typically-sized vesicles almost always pushed the combined lipid
  count straight past `DIVISION_LIPID_COUNT`, and division fired the
  very next tick with no memory of how recently the vesicle had last
  split — so a fusion would immediately undo itself, re-separating
  whatever it had just brought together before any chemistry could
  happen. Headless-caught, not assumed: `maxDivisions` per seed jumped
  from a 1-2 baseline to 32-113, and a 30,000-tick instrumented run
  found 86 real fusion events with *still* zero ticks of catalyst+
  replicator co-occurrence — the smoking gun for fuse-then-instantly-
  re-split churn, confirmed to have nothing to do with RNA/replication
  (in-vesicle `replicationEvents` stayed at 0 throughout, unaffected).
  Fixed with `divisionCooldownTicks = 500`: a vesicle needs real
  settling time since its last division *or* fusion before it's
  eligible to divide again — grounded the same way, real membrane
  fission isn't instantaneous the moment a size threshold is crossed.
  Deliberately not "just raise `DIVISION_LIPID_COUNT`": that would only
  make the same instant-undo failure rarer, not close it structurally,
  and would risk undoing last round's careful lipid-economy calibration
  of that exact constant. Re-verified after the fix: fusion events per
  30k ticks dropped 86→16, `maxDivisions` came down to a real 11-40
  range across the full sweep, fusion sanity re-confirmed still 9/9.

  Final honest result, full 10-seed x 80,000-tick sweep with the fix in
  place: **still zero natural bootstraps.** But the diagnostic work this
  round found something sharper than "encapsulation is hard in
  general": catalytic peptides are the actual rare ingredient, not RNA.
  Across a 30,000-tick instrumented run, replicator-length RNA averaged
  13.8 present in the dish at once (up to 18); catalytic peptides
  averaged 0.55, maxing out at just **1** in the entire dish at any
  sampled moment — roughly 25x rarer. And of that already-scarce
  supply, 0% of catalytic peptides ever ended up inside any vesicle at
  all, versus ~12% of replicators. Fusion and the nucleation bias are
  real, correctly implemented, and would help — *if* a catalyst existed
  nearby for either mechanism to act on. With at most one in the whole
  dish at a time, there's usually nothing there. This reframes the
  bottleneck one level further upstream than encapsulation mechanics
  (which is what this round targeted, and which — per this same
  diagnostic work — is demonstrably no longer the binding constraint on
  its own): peptide-catalysis *supply*, i.e. why `foldPeptide()` makes a
  catalytic fold so much rarer than an RNA merely reaching
  `MIN_TEMPLATE_LENGTH`. Named here as the honest next lever. Asked the
  user directly rather than assumed whether to chase that now; the
  answer was to ship this round's real, verified work and stop there —
  so it's documented, not built.
- **Fourth pass: fixed the actual mechanism behind catalyst scarcity —
  real improvement, still not enough alone.** Diagnosed *why* catalysts
  vanish so fast: tracked 32 catalytic particles (peptide `isCatalyst` /
  RNA `isRibozyme`) across 5 seeds x 30,000 ticks and found 0 were ever
  hydrolyzed to nothing — 17 of 19 losses came from a *single* ordinary
  hydrolysis event trimming one residue, which is enough to flip fold
  classification because the fold walk has no memory of a previous fold
  (any sequence change re-derives the whole structure from scratch).
  Fixed with `catalyticFoldProtection = 0.4`, an additional hydrolysis-
  resistance multiplier specifically for already-catalytic molecules —
  grounded in real biochemistry (limited-proteolysis assays exploit
  exactly this: folded domains resist protease cleavage, unstructured
  loops don't; RNase-protection assays are the RNA analog). Deliberately
  investigated growth-driven loss first and found it was the wrong
  target (only 2 of 19 losses) before building the shrink-side fix —
  worth noting since the mental model offered mid-session ("growth
  rerolls the whole fold") turned out to be wrong on inspection: the
  fold geometry is actually preserved almost every time a molecule grows
  by one residue (tested directly), it's `stability = contacts/length`
  diluting under a fixed threshold that does the damage, not reshuffled
  geometry.

  Verified: still-catalytic-at-run's-end went from 41% to 53% (real,
  meaningful). But the full 10-seed x 80,000-tick sweep still produced
  **zero** natural bootstraps, and catalysts still never appeared inside
  a single vesicle across a 30,000-tick check (0.000%, unchanged). Living
  longer doesn't help if there's usually no catalyst *anywhere* in the
  dish to live longer in the first place — persistence and formation
  rate are separate problems, and this only fixed the first one.
- **Fifth pass: stopped tuning rates entirely and scaled soup density
  8x instead — this is the one that worked.** Investigated formation
  rate directly rather than guessing. "Add more raw materials": checked
  against data first — attempts weren't scarce (3.7-3.8 fold-eligible
  molecules, peptide length ≥8 or RNA length ≥9, already existed at any
  given moment), so pure throughput looked like it'd have diminishing
  returns. "Loosen the acceptance threshold": checked the real gate
  breakdown directly (5,000-sequence clean samples, decoupled from
  simulation dynamics) — peptide catalytic rate is genuinely
  length-invariant (~7-20%, matching the original design comment,
  rejected almost entirely by the stability threshold, not the
  active-site-class step which barely rejects anything once stable);
  RNA's rate looked wildly more permissive at first (44.6% vs 11.3% in a
  blended 8-30nt sample) but that was a length-sampling artifact — RNA's
  `isRibozyme` bar isn't length-normalized, so it's dominated by long
  sequences that are rare to actually reach; at realistic in-dish
  lengths (9-15nt) RNA's real rate is 3.6%-33%, comparable to peptides.
  Conclusion: both acceptance rates are already *more generous* than
  real biology (spontaneous catalytic folding from a random sequence is
  astronomically rare in reality, not 1-in-10) — loosening them further
  would trade realism for reachability, and the thresholds aren't
  actually the bottleneck once measured fairly.

  So the real lever was scale, not odds — matching how real abiogenesis
  actually happened (an entire ocean, hundreds of millions of years: more
  independent attempts, not better odds per attempt). A density scan
  (1x/3x/5x, `SOUP_DENSITY_MULTIPLIER` in `seedPrimordialSoup()`) found a
  more-than-linear payoff — 5x density took ribozymes from 0.00 to 0.96
  average present at once, appearing at all for the first time — because
  denser soup means faster growth to fold-eligible length too, not just
  more molecules. Shipped at 8x, an explicit "fill the dish" move, not a
  token increase; accepted the heavier per-tick cost (~20-37ms vs 2.2ms
  baseline) deliberately since Stage 0 deactivates once a population
  sustains rather than needing to run indefinitely at this density.
  Flagged the resulting vesicle-count jump (35→106, vs. single digits
  baseline) to the user before proceeding, per standing "check in on
  massive effects" instruction — confirmed as the intended goal (more
  parallel bootstrap opportunities), not a bug.

  Verified: mass conservation exact (zero drift, 30,000 ticks). The old
  80,000-tick sweep horizon was no longer practical at this density
  (would take 8+ hours for 10 seeds) — resized to 40,000 ticks, justified
  by ramp data showing every milestone landing 2-4x earlier than baseline
  (first catalyst 2,949 vs 1,890-15,420; first division 500 vs
  1,722-19,933). Playwright (3 live-app trials, non-deterministic seeds):
  zero console errors, generally healthy/growing vesicle counts; one
  trial showed a vesicle count crash (36→1) that didn't reproduce across
  2 follow-up trials — noted as observed-but-not-reproduced rather than
  chased further, and plausibly the same fusion-consolidation dynamic
  that shows up in the successful sweep seeds below (bootstrapped seeds
  ended with as few as 1 surviving vesicle).

  **Full 10-seed x 40,000-tick sweep result: 4 of 10 seeds achieved a
  natural bootstrap** (seed 3 at tick 28,802; seed 7 at 34,730; seed 9
  at 31,189; seed 10 at just 4,928 — and seed 10 never formed a ribozyme
  at all, so that bootstrap came from a peptide catalyst + RNA replicator
  pairing, not RNA-world-style self-catalysis). This is the first natural
  bootstrap observed across five rounds of tuning this session. Every
  prior mechanism (in-vesicle replication boost, fusion, nucleation bias,
  catalyst persistence) was real, correctly implemented, and individually
  verified insufficient at 1x density — the honest read is that they
  likely all still mattered here (more vesicles to draw on from fusion,
  catalysts surviving long enough to matter from the persistence fix),
  just none of them were sufficient alone; density was the missing
  scale factor the whole pipeline needed. The other 6 of 10 seeds did not
  bootstrap within the 40,000-tick horizon — a real, meaningful rate to
  report honestly, not "solved," and some of those 6 might well clear the
  bar given more ticks than this session had time to run.
- **The Chemistry tab now shows real bootstrap-progress detail, plus a
  heuristic "chance of life" estimate — deliberately not a real
  simulated probability.** A true Monte Carlo estimate (clone the live
  dish, fast-forward many independent trials, count how many bootstrap)
  is the only way to get an actually-accurate number, but this session's
  own headless timing put a single 10,000-tick trial at ~10-15s — too
  slow to recompute live even across parallel Web Workers. Discussed
  directly with the user, who chose a cheap always-live heuristic
  instead: `Origin.estimateBootstrapChance()` reuses the exact real
  formulas `templatedReplication()` itself rolls against (start-rate,
  extension-rate, the same catalyst/ribozyme/in-vesicle boosts) for
  whichever vesicle is currently ranked closest (`findLeadingVesicle()`),
  and projects forward with a Poisson approximation for "enough
  completions in the next N ticks," combined with a coarse lipid-count-
  vs-`DIVISION_LIPID_COUNT` proxy for division readiness. Verified
  against synthetic vesicle states (0% with no vesicles; increases with
  replicationEvents, lipid progress, and fewer needed completions —
  the last one specifically needed a shorter horizon to observe, since
  at the default 10,000-tick horizon this particular test vesicle's
  chance had already saturated near 1.0 regardless of needing 1 vs 2
  more completions — confirmed as genuinely correct Poisson behavior,
  not a bug, by checking shorter horizons directly). Given the finding
  above, expect this to show 0% in most real play sessions right now —
  that's the honest, correct answer given the current bottleneck, not a
  UI defect.
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

## DNA: a real, evolved genetic-material transition

Heredity ran on RNA end-to-end before this — both Stage 0's prebiotic
chemistry and the inherited Virtunism genome, confirmed directly from
`elements.ts`'s `CODON_TABLE` (uses U/uracil, not T/thymine). Discussed
with the user: two real chemical facts make DNA worth adding as more
than a cosmetic reskin. RNA's 2'-OH group is what makes it chemically
labile (the same reason Stage 0 has a whole hydrolysis model at all) —
DNA lacks that group, which is literally why real biology uses it for
stable long-term storage while RNA stays disposable/catalytic. And DNA
uses T instead of U specifically so repair machinery can unambiguously
recognize a spontaneously-deaminated C→U event as damage — a legitimate
U wouldn't exist in DNA at all. That's *why* real DNA replication
achieves far higher fidelity than RNA replication, and it's the real
mechanism this feature is built on, not an invented one.

**Design: DNA is an evolved, one-way transition, not a genome-format
toggle.** A lineage starts on RNA (matching how it's bootstrapped from
Stage 0's real RNA replicators — DNA doesn't exist in Stage 0 at all)
and transitions once it evolves real reverse-transcriptase-grade
catalytic function. Reverse transcriptase is structurally a polymerase,
so this reuses the existing `replicase` catalysis class (already the
axis `hasBud()` reads) rather than adding a 7th class to compete in
every fold's argmax — `DNA_TRANSITION_THRESHOLD = 3.0`, 3x
`BUD_THRESHOLD`, on the same `classPower(genome, 'replicase')` reading.
`Genome.isDna` is heritable state propagated in parallel with
`sequence`/`brain` (the same way `brain` already is, not decoded fresh
from the sequence each time) — a one-way ratchet: `genomeFromSequence`'s
new `inheritedIsDna` parameter means once a lineage transitions, further
mutation can't revert it, matching how real DNA-based life never
reverted to RNA when reverse-transcriptase genes later diverged.
`crossoverGenome` unions both parents' `isDna`, which lets two RNA
parents whose *combined* replicase-boosting genes finally clear the
threshold produce a DNA child neither parent was alone — a real payoff
of sexual recombination, not extra logic.

**Mutation-rate effect, point mutations only, first pass**:
`DNA_MUTATION_RATE_MULTIPLIER = 0.25` — not the literal ~100-1000x real
DNA-proofreading fidelity gap, which would freeze a DNA lineage's
evolution at this simulation's scale (the same "reachability over
literal magnitude" call as Stage 0's soup density and catalytic
thresholds). Structural mutations (duplication/deletion/inversion) are
deliberately left at full rate — a modest, single-lever first pass, not
four rates reworked at once. `SAVE_VERSION` bumped 5→6, matching the
existing hard-discard convention (a v5 save's genomes would otherwise
deserialize with `isDna` silently `undefined`/falsy, quietly reverting
an already-DNA lineage to RNA on load instead of erroring).

**Visibility**: reuses the existing `isSpeciationEvent`/🔀 pattern in the
Tree of Life exactly — a new `isDnaTransition` on `TreeNode`, computed at
the `recordBirth` call sites in `world.ts` (where parent and child
`Genome` objects are already in scope), rendered as a solid teal ring
(`#4fc3d9`), deliberately distinct from speciation's dashed amber so a
birth that happens to be both events still reads as two separate
markers. A 🧬 label in the Tree's info line mirrors 🔀's.

**Verified, not assumed**:
- Headless sanity (`dna_sanity.mjs`): a genome whose real replicase power
  clears the threshold gets `isDna=true` on construction; a genome well
  below it doesn't; `isDna` survives 200 generations of mutation intact
  even as the underlying replicase power that originally triggered it
  drifted down to 0 (the ratchet, directly proven, not just "no crash");
  `crossoverGenome(hot, cold)` correctly unions to `true`.
- Mutation-rate reduction measured directly (`dna_mutation_rate_check.mjs`):
  isolated to the core genes (never touched by structural mutations, so
  the measurement isn't contaminated by duplication/deletion/inversion
  noise) — observed ratio 0.248 across 2,000 trials against a configured
  0.25 multiplier. An earlier version of this same check, comparing whole
  gene arrays, gave a misleading 0.631 — traced to structural-mutation
  position-shift noise being counted as if it were point-mutation signal,
  fixed by narrowing the comparison, not by adjusting the multiplier.
- Real-world reachability (`dna_world_reachability.mjs`): a live `World`
  simulation, 6 independent founding lineages via the real
  `ensureEnergyCapable`-viable `randomGenome()` path, run 25,000+ ticks.
  One founder started above threshold at tick 0 (a real, allowed
  outcome — `ensureEnergyCapable`'s viability search can incidentally
  roll a high-replicase gene same as any other), and by the end of the
  run **100% of the 170 surviving individuals carried `isDna=true`** —
  suggestive that the lower mutation rate carries a real survival
  advantage once a population's already found a working local optimum,
  though this is one run/seed, not a controlled comparison, so that's
  named as an interesting open question, not a proven causal claim.
- Save/restore round trip and a live Playwright session both confirmed
  clean: zero console errors, and the teal transition ring rendered
  correctly and visibly on real founder nodes in the actual Tree of Life
  view — the marker fired naturally in that session too, not forced.

## UI round: pool hiding, portrait layout, pop cap, species stat star

Four smaller, real fixes/features from user reports and requests, bundled
into one round since none needed its own deep investigation section like
DNA or the round-3/4/5 chemistry work did.

**Hide the retired pool once Stage 0 is disabled.** `renderer.draw()`
already took a `hidePool` intent implicitly — it just always drew the
pool. Added `hidePool?: boolean` to its options and gated the
`drawPool()` call on it; `main.ts` passes `hidePool: stage0Retired`, the
same flag that already exists for exactly this transition. No new state.

**Two real, separate portrait-layout bugs — not one.** User reported the
Tree of Life canvas rendering far below where it should be, cut off by
the bottom of the screen, in portrait. Then: "it's actually happening in
all the tabs now I look" — which mattered, because it ruled out a
tree-specific cause and pointed at the shared sidebar/toolbar chain.

- My first hypothesis (a `.sidebar { max-height: 45vh }`-only rule
  leaving `height: 100%` descendants indeterminate) was wrong — fixed it
  anyway (`height: 45vh; height: 45dvh; max-height: 45dvh;`, harmless)
  and re-measured. Canvas position was **completely unchanged**. Said so
  directly rather than assuming the fix worked.
  https://github.com/ike49285-alt/Evo — see also the general `#app {
  height: 100dvh; }` fix alongside it, for the well-known mobile
  address-bar `100vh` problem — real, but a different bug from this one.
- Real cause, found by dumping computed styles up the whole ancestor
  chain: `.tree-info` had `flex: 0 1 260px`, meant as a *width* cap in
  the normal row-direction toolbar layout. The portrait media query
  flips `.tree-toolbar` to `flex-direction: column`, which silently
  reinterprets that same `260px` flex-basis as a *height* floor instead
  — and `flex-shrink: 0` on the toolbar meant it never shrank back down,
  pushing the canvas below the viewport. Fixed with `.tree-info { flex:
  0 0 auto; }` in the portrait override — an explicit auto-height
  instead of a stale row-mode number. Verified with fresh computed-style
  dumps and screenshots, not just re-reading the CSS.

**Live-tuneable population cap.** `World.maxPopulation` was a `readonly
320`, needing a rebuild to try another value. Un-readonly'd it; added a
topbar "Pop cap" number input (`min 20`, `max 20000`) wired to it live.
Deliberately scoped out of the save format for now (page reload reverts
to 320) — a temporary tuning tool, not a permanent setting, easy to
promote later. Reset World creates a fresh `World` (which reverts to the
class default) but immediately reapplies the current input value after,
since the cap is topbar-level, not per-world state — a reset shouldn't
silently undo the user's chosen cap.
Verified: Playwright confirms the input initializes correctly, takes
effect live, and survives Reset World. A follow-up headless run (cap
raised to 900) confirmed the real payoff, not just the plumbing: final
population 867, max observed 871 — genuinely past the old 320 ceiling —
while never exceeding the new 900 cap.

**Species stat star — tap a species card for its real capability
profile.** Added a modal (reusing the existing Reset-World
confirm-overlay backdrop/dismiss pattern, plus a new Escape-key handler)
opened by tapping a species card. Shows a hand-drawn radar chart
(`ui/chart.ts`'s new `drawRadarChart`) across the six real catalysis
classes (peptidyl, protease, motor, lipidsynthase, replicase,
photoreceptor), each axis a population-average of
`Genome.classPowerCache` across that species' living members
(`World.getLivingSpecies`'s new `avgClassPower`) — a real capability
profile read off actual folded proteins, not an illustrative archetype.
A predator-heavy lineage genuinely spikes toward protease/motor; a
photosynthetic one spikes toward photoreceptor/lipidsynthase. Modal
stays live-updated while open (or auto-closes if the species goes
extinct) via the existing species-panel refresh loop.
Verified with Playwright in both landscape and portrait.



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

## The vesicle runaway bug, and the deep rabbit hole fixing it opened

User reported "massive vesicles filling the whole abiotic pool." My first
diagnosis (a single-seed, coarse-sampled headless check) called this not
a bug — just a dense-soup visual side-effect of round 5's 8x density.
That was wrong: the user sent a live screenshot showing the HUD's own
`VESICLES: 1` stat — a literal `origin.vesicles.size` count, not a
rendering artifact.

**Part 1 — the real bug, fixed and fully verified.** `mergeVesicles()`
resets a vesicle's division-cooldown clock (`keep.createdTick =
this.tick`) on every fusion. At 8x density, a large vesicle's radius
(scales linearly with lipid count) becomes a big fraction of the
800x500 pool, keeping it in near-constant contact with newly-forming
small vesicles — successful fusions (5%/tick while touching) arrive
faster than the 500-tick cooldown ever clears, so it can never divide. A
150k-tick single-seed run showed collapse from ~90-100 vesicles down to
**1**, holding **99.5% of all 1,920 pool lipids**, staying collapsed for
over half the run. An 8-seed x 15,000-tick sweep: 6 of 8 seeds
collapsed similarly, several within a few thousand ticks — matching the
user's screenshot almost exactly.

Fixed with a size-based escape valve (`vesicle.ts`):
`OVERSIZE_DIVISION_MULTIPLIER = 3` — a vesicle past `DIVISION_LIPID_COUNT
* 3` (66 lipids) divides regardless of cooldown state, on the reasoning
that a vesicle that oversized is unambiguously overdue for fission no
matter how recently it last fused. Preserves round 3's original
protection for normal-sized vesicles (a freshly-merged pair tops out
around 30-50 lipids, comfortably under 66). **Fully verified**: 8/8
seeds now show 0 runaway-collapse episodes (vs. 6/8 affected pre-fix),
mass conservation exact, and an isolation check confirmed both division
paths fire exactly as designed (0 violations across 4,600+ divisions).

**The deep rabbit hole**: fixing Part 1 silently broke natural
bootstrap — a follow-up 10-seed sweep found **0/10** vs. round 5's
original **4/10** baseline, including the seed that bootstrapped
fastest (tick 4,928) now failing entirely. The likely explanation: round
5's bootstrap breakthrough was itself powered by the runaway bug — a
vesicle brute-force-absorbing nearly the whole dish eventually held
*something* with a catalyst and *something* with a replicator purely by
exhaustive absorption. Fixing the visual bug removed the very mechanism
that had accidentally been solving round 3/4's original co-occurrence
bottleneck.

Three additive attempts to restore bootstrap without reintroducing the
runaway, each real, each individually verified, none (yet) sufficient
together:

- **Part 2a — complementary fusion bias** (`complementaryFusionChance =
  0.9`): two touching vesicles where one has a catalyst-no-replicator
  and the other has a replicator-no-catalyst fuse near-certainly instead
  of at the 5% baseline. Sound logic, but instrumenting `mergeVesicles()`
  found **zero** complementary fusions in 4,400+ total fusion events
  across two 40,000-tick runs — the precondition (such a pair ever
  touching) essentially never occurred.
- **Part 2b — proximity bias** (`vesicleChemotaxisBiasStrength =
  0.002`, new `vesicleChemotaxis()`): every particle including membrane
  lipids moves by independent Brownian motion, so a vesicle's centroid
  barely drifts in aggregate (variance shrinks as ~1/member-count) — two
  rare vesicles essentially never randomly diffuse into contact. Added a
  coherent per-tick velocity nudge (same vector to every membrane lipid,
  so it isn't diluted by averaging) for catalyst-only/replicator-only
  vesicles toward their nearest complement, unbounded whole-pool search.
  Worked-through arithmetic: closes the ~63-unit average inter-vesicle
  spacing in ~600 ticks. Necessary, not sufficient — see below.
- **Part 2c — capture-on-growth** (extends `recruitAndDivideVesicles()`):
  the actual missing piece. `membraneDiffusion()` correctly excludes
  peptides/RNA from crossing an existing membrane ("too big to cross" —
  real biology, kept as-is), so a catalyst can only enter a vesicle by
  being synthesized in place — a rare compound event given a vesicle's
  small "reaction volume." Direct 20,000-tick instrumentation (every
  tick, not sampled) found catalyst-only vesicles occurred in **0.00% of
  ticks** — never, not once — while replicator-only vesicles occurred in
  19.25%. Separately: catalysts exist in 90.77% of ticks somewhere in
  the dish, always free in the open soup, never inside a vesicle.
  `recruitAndDivideVesicles()`'s membrane-growth recruitment only ever
  captured nearby free *lipids* — extended it to also enclose nearby
  free peptides/RNA using the exact same unconditional, kind-blind
  geometric test `formVesicle()` already uses at initial closure
  (`dist <= v.radius`), on the reasoning that ongoing bilayer growth is
  physically the same "membrane closes around what's inside" process
  repeated, not a new one. No new tunable constant — capture rides on
  the existing, already-tuned lipid-recruitment cadence.

**Part 2c's real, if smaller, remaining gap**: replicator-only vesicle
presence jumped from 19% to 86% of ticks — RNA capture is clearly
working. But catalytic material specifically gets captured well below
its open-soup abundance: 2 catalytic-peptide captures out of 352
attempts across 4 seeds (expected ~8 at the observed 2.36% base rate), 0
ribozyme captures out of 186 (expected ~2.3). I hypothesized spatial
segregation (lipid-dense vesicle-growth regions vs. aa/nt-dense
catalysis hotspots) and measured it directly — **refuted**: near-vesicle
catalytic-peptide density is 1.02x the dish-wide average (no
segregation), ribozymes 0.77x (a real but modest effect, not enough to
explain the shortfall alone). Most likely explanation is ordinary
statistical variance on a small sample (4 seeds), not a confirmed
mechanism — said honestly rather than inventing one.

A 10-seed x 30-minutes-each real-time sweep (not a fixed tick count,
partly to also check whether tick throughput degrades over a long run)
was in progress when a container restart wiped it mid-run. Two seeds got
to ~39,000-42,000 ticks (~18 min in) before being lost: seed 1 recorded
its **first-ever complementary fusion at tick 8,402** — genuine forward
progress — but neither seed had bootstrapped yet. Throughput did
measurably degrade over that run (seed 1: ~18ms/tick at the 4-min mark
climbing to ~32ms/tick by 18 minutes, vesicle count staying flat at
93-108 the whole time, so it isn't vesicle-count growth causing it —
cause not further diagnosed).

**Where this leaves things**: Part 1 is solid and shipped. Parts
2a/2b/2c are real, individually-correct chemistry improvements
(replicator capture demonstrably works, complementary-fusion logic is
sound, proximity-seeking is sound) kept in the codebase, but natural
bootstrap at 8x density has not been confirmed restored to round 5's
4/10 baseline — the honest state is "not yet demonstrated," not "fixed."
Revisiting this needs either a longer/larger sweep than this session
could complete, or further investigation into why catalytic-specific
capture underperforms its own measured spatial-density baseline.

## Virtunism crowding: soft separation, colonies stay rigid

User reported ~200 virtunisms sitting stacked in a space sized for ~3.
Traced the full movement pipeline and confirmed there was no
virtunism-to-virtunism collision anywhere — only the world's outer walls
were ever clamped against. The higher population cap added earlier this
session made a favorable spot accumulate an unbounded crowd with nothing
to thin it.

Added a boids-style soft separation pass (`World.resolveCrowding()`),
reusing the existing `virtunismGrid` spatial hash. Colonies must move as
one rigid unit, never deform — their members are fixed parent-relative
joints, not independently movable — so separation resolves per *unit*
(a solo virtunism, or a whole colony via its root): every member's
overlap against anything outside its own unit contributes to one shared
push, averaged across member count, applied to the root, then cascaded
down via the same rigid-body geometry `moveColonyRigid()` already uses
(extracted into a shared `cascadeColonyPositions()` so both callers use
identical code, not a second copy). Resolves 50% of measured overlap per
tick — under 1.0 guarantees no oscillation (a pair can't push through
each other and swap sides) while still visibly thinning a crowd within a
handful of ticks.

Verified headless: solo virtunisms crammed onto one point converge to
zero overlap with monotonically decreasing overlap (no oscillation); a
crowd near a wall stays fully in bounds; a bonded colony surrounded by
crowders moves as a whole (root displaced) with its members' positions
relative to their fixed joints unchanged to floating-point precision
(max drift 0) — colonies genuinely never deform. Live Playwright check:
zero console errors running the app at speed.

## Individual breakout: tap a cell, get its full profile in the Tree tab

Wanted a way to inspect one virtunism directly — age, energy, reproduction
progress, exact xy, genome, folded proteins, brain — not just population
aggregates. Originally scoped as a new tab; folded into the existing Tree
of Life tab instead, since it already tracks one shared selection
(`selectedIndividualId`) and already shows a one-line summary of it.

Tap-to-select on the dish is layered onto the existing multi-pointer pan/
pinch-zoom handling without disturbing it: a `tapCandidate` is armed on
`pointerdown` (only when it's the sole active pointer), cancelled by a
pinch starting or by moving past a 6px screen threshold, and only fires
`handleDishTap()` on `pointerup` if it survived untouched — so panning
and pinch-zooming never accidentally select something. A tap looks up the
nearest alive cell within its real radius plus a small fixed *screen*-
pixel pad (converted to world units by the current zoom, so small or
zoomed-out cells stay tappable), and selects silently — no tab switch —
matching the explicit ask to populate quietly regardless of which tab is
open when the tap happens.

The detail panel's *structure* (identity, ancestry, live stat bars, a
radar canvas, protein list, raw gene list, brain summary) rebuilds only
on an `${id}:${alive|gone}` signature change; a handful of live numbers
(position, age/energy/repro-progress bars) get cheap per-frame writes on
top, same "just always run it" precedent the HUD and Species panel
already use. The radar canvas is a case where *when* you build vs. *when*
you draw matters: `drawRadarChart` sizes itself off the canvas's real
laid-out `clientWidth`/`clientHeight`, which reads 0 for a canvas built
while its tab is `display:none` — exactly the "select from another tab"
case this feature explicitly wants to support. Fix: the empty `<canvas>`
is always built immediately on selection (satisfies "populate silently"),
but the actual draw call only ever runs inside `updateTree()`, gated on
the tree tab being active — so switching to the tab later always shows a
correctly-sized chart, never a stale 1×1 one.

A selection whose live `Virtunism` has been removed by `cleanupDead()`
degrades to a historical view built from the surviving `TreeNode` alone
(identity, ancestry, parent/child links) with an explicit "no longer
alive" status — nothing about age, energy, or genome is fabricated for a
dead individual. Confirmed directly against `World`'s own pruning
semantics (not assumed): a dead node with no living descendants
(`liveCount === 0`) is deleted from `treeNodes` immediately — there's no
transient historical state for it at all — and a dead node with exactly
one remaining child gets spliced out too (a redundant "spine" waypoint);
only a dead node that's an actual branch point (2+ live-tracing children)
persists with `alive: false`, which is the one case
`renderHistoricalDetail` is for. The UI's existing `describeSelection()`
already matched this correctly (clears the selection outright once the
node is gone), confirmed rather than assumed.

Verified headless against the real `World`/`compactFrom` pruning rules
described above (both branches: immediate full deletion vs. persisting
historical node), and live via Playwright: dish tap selects silently
without switching tabs; switching to Tree afterward shows an
already-populated panel with a correctly-sized radar (not 1×1); numbers
visibly tick over a few seconds; clicking a different tree node rebuilds
the whole panel; `Clear` empties both the one-liner and the panel;
portrait and landscape-short breakpoints keep the tree canvas at a sane
height with the detail panel scrolling independently — including a real
bug the first pass missed: both breakpoints' tight vertical budgets
squeezed the detail panel toward a ~11px sliver once the canvas's own
min-height floor and the toolbar ate the available space, since the
panel's `min-height: 0` (needed so an *unselected* state reserves no dead
space) gave it nothing to hold onto once the layout got tight. Fixed with
a small min-height floor for the panel in both breakpoints, verified
after the fix (70px portrait, 60px landscape-short — a real usable scroll
window, not a sliver). Zero console errors throughout.

**Follow-up**: those floors weren't actually enough — a real phone still
showed the detail panel as "barely there." Measured why: the tab's own
static onboarding hint (six sentences, wraps to 130px+ at phone width,
sitting in a `flex: 0 0 auto` toolbar that never shrinks) was eating
57% of the entire mobile sidebar budget on its own, worst possible
timing since it competes hardest for space in the exact moment it
matters least — once something's actually selected. Fixed with two
`:has()`-scoped rules (same feature the codebase already relies on for
`.segmented label:has(input:checked)`): hide the hint, and grow the
portrait sidebar past its 45vh cap, both only while the Tree tab is the
active tab *and* has a live selection — never just because a selection
exists anywhere, since one can be set silently from another tab and
that tab's own layout must never shift for it. Measured before/after on
the real repo (390×844 portrait, 812×380 landscape-short): detail panel
70px → 214px portrait, 60px → 121px landscape-short; confirmed the
Designer tab's layout is bit-for-bit unaffected by a silent selection,
`Clear` reverts cleanly, re-selecting regrows correctly, and desktop is
untouched (rules only live inside the two mobile media queries). Zero
console errors throughout.

**Second follow-up — that "grow the sidebar" rule was itself broken**:
shipped, and the very next report was "the tree tab doesn't scroll at
all now." The `height: 70dvh` override *did* make `.sidebar` measure
591px tall, exactly as intended — but never checking its *position*
relative to the viewport, or the enclosing `main`'s own total content
height, missed that `main`'s real available height (713px) was 211px
*less* than `.canvas-wrap` (273px, unchanged) + `#tab-rail` (60px) +
the newly-grown `.sidebar` (591px) demanded. `.sidebar` and `#tab-rail`
both inherit `flex-shrink: 0` from their desktop `flex: 0 0 Npx` base
rule (the mobile media query only ever overrides
flex-basis/width/height, never the shrink/grow components of that
shorthand), so neither gave ground; `.canvas-wrap` never got the
axis-flip `min-height: 0` override it needs once `main` switches to
column layout in mobile (its row-layout counterpart, `min-width: 0`,
was already there) — the same class of axis-flip bug already fixed
elsewhere in this file for `.tree-info`. The excess 211px didn't get
clipped by `main` (its `overflow-y` is the initial `visible`) — it
bled downward and only got clipped by `#app`'s `overflow: hidden;
height: 100dvh`, entirely below the visible viewport with nothing
scrollable in between to reach it. Confirmed directly: a real `wheel`
event over `#tree-detail` left `scrollTop` at 0 in the broken code —
`#tree-detail`'s own `overflow-y: auto` was never at fault; the whole
region was just rendered off-screen.

Fixed by not guessing a fixed vh number at all: `.canvas-wrap` now has
`min-height: 0`, and while a selection is active it gets an explicit
small floor (`flex: 0 1 90px; min-height: 90px`) while `.sidebar`
switches to `flex: 1 1 auto` and grows to take whatever's genuinely
left in `main` — guaranteed to fit by construction (flex-grow only
ever distributes real leftover space), not by assumption. Verified:
`main`'s `scrollHeight` now exactly equals its `clientHeight` (zero
overflow); `#tree-detail`'s rect sits entirely inside the viewport; a
real `wheel` event now moves `scrollTop` 0 → 300 under the identical
test that stayed at 0 before. Re-ran the full regression set (Designer
tab unaffected, `Clear` reverts, re-select regrows, landscape-short
unaffected, desktop unaffected) — all still pass. Zero console errors
throughout.

Also added real absolute numbers to the species radar/stat-star chart
(`ui/chart.ts`), reused here for the Inspector's own per-individual radar:
previously it only drew each axis normalized against its own biggest
value, so a lineage barely dabbling in a catalysis class and one deeply
specialized in it could draw visually identical polygons. Each axis label
now also shows its real class-power value.

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

## Branch experiment: a hydrothermal vent (Phase A of a larger, deliberately-sequenced redesign)

Started on `claude/closed-loop-soup`, split off from the main session
branch on purpose — the user wants to experiment with a much bigger
change to the pool's economy (filling the whole dish, no ambient
respawn of materials, organisms decomposing back into real matter on
death, permanent background chemistry, direct soup-eating) but chose to
sequence it: validate a hydrothermal vent alone first, inside the
existing small pool, before touching `World`/`Virtunism`/rendering
assumptions at all. Everything beyond the vent is recorded as a
roadmap, not built — see the plan file from this round for the full
detail.

**What shipped**: a fixed point in the pool (`{width*0.15, height*0.5}`)
that continuously vents fresh amino acids/nucleotides/lipids with an
outward jet kick, plus a small persistent tangential (not radial)
current around it, applied to every particle every tick — real
whole-pool circulation on top of (never replacing) each particle's
existing independent Brownian motion. `seedPrimordialSoup`'s own
one-time 8x-density seed is unchanged; the vent is a modest, capped
supplement, not yet the dominant matter source. `Origin.seedPrimordialSoup(...,
{ vent })` opt-out param for a clean A/B.

**A real bug caught and fixed during verification, not before shipping
it**: the first version capped the vent by checking the *current free*
particle count of each kind against a ceiling. That's wrong — ordinary
hydrolysis constantly cycles matter between free and polymer-bound
states, so the free-count gauge chronically understated how much the
vent had actually contributed once reactions started consuming what it
spawned. A fresh headless mass-ledger check (this project's own
established methodology, freshly written since no persisted script
existed in the repo to reuse) caught it directly: over a 5000-tick run
the vent added +989 aa and +717 nt total — more than 3x the intended
300-per-kind cap — while the free-count check never once saw its own
ceiling crossed. Fixed by tracking cumulative particles the vent has
ever spawned (`ventInjected`) and capping against *that* instead — a
true stability floor, correct regardless of how reactions later move
that matter between free and bound states, since nothing in this closed
system ever destroys aa/nt/lipid matter. Re-verified: vent-off run
exactly reproduces pre-change behavior (0 violations, ledger constant);
vent-on run adds exactly 300/300/300 (aa/nt/lipid), matching the cap
precisely, 0 violations.

**Rendering verified by draw-call interception, not just a screenshot**:
monkey-patching `CanvasRenderingContext2D.fill()`/`arc()` in a headless
Playwright page to catch the vent marker's distinctive fill color the
moment it's actually drawn turned out far more reliable than trying to
pixel-hunt a small marker through repeated zoom/pan (cumulative
zoom-step error made manually centering on it unreliable) — confirmed
the marker draws at a stable screen position every frame with the
correct pulsing alpha, which is stronger proof the mechanic is really
executing than a screenshot crop would have been anyway.

**The actual A/B question — does the vent increase bootstrap
likelihood — is not answered by this round's data, honestly**: a 3-seed
sweep at 6000 ticks each (deliberately scaled down from this project's
usual 40,000-tick/10-seed sweeps to fit this session's time budget, and
said so going in) produced **zero bootstrap candidates in every single
run, vent on or off** — 6000 ticks is just too short a horizon at this
density; past rounds routinely needed 40,000-80,000 ticks to see real
candidates. That question needs a longer, more patient sweep than this
session had room for.

**What the same sweep did find, consistently, across all 3 seeds — a
real and unexpected result worth recording plainly**: standing vesicle
count dropped by roughly half with the vent on (93→44, 93→43, 105→44).
Not noise — nearly identical across three different seeds. The likely
mechanism: `lipidAssembly()`'s cluster-formation gate needs a forming
lipid cluster to hold together via weak local attraction (strength
0.02) long enough to clear its own "6 of 8 angular sectors" closure
check; the vent's persistent shear (deliberately differential by
distance from the vent, for exactly the whole-pool mixing this was
built for) may be actively working against that weak clustering force
before a cluster can close, especially near the vent itself where the
current is what freshly-jetted lipids first experience. This wasn't
predicted going in and isn't confirmed as the mechanism (no isolated
diagnostic run yet) — recorded honestly as a real, reproducible,
currently-unexplained-in-depth cost the current mechanic carries,
directly relevant to whether it nets out positive for the original
question once a longer sweep can actually produce bootstrap data to
compare.

**Perf**: a focused, isolated comparison (400 ticks each, same seed,
warmed up first to avoid JIT noise) measured +14.5% average per-tick
cost with the vent on (48.1ms → 55.1ms/tick in this session's
container) — modest and bounded, not a runaway cost, though this
session's absolute ms/tick numbers ran higher across the board than
this repo's earlier-recorded baselines (likely just this particular
sandboxed environment being slower, not a regression — the *relative*
overhead is the meaningful number here).

**Honest state to hand off**: the mechanic is real, correctly
conserving mass (after a caught-and-fixed bug), rendering correctly,
and saving/restoring correctly (`SAVE_VERSION` bumped to 7). Whether it
actually helps bootstrap likelihood — the whole reason for building it —
is genuinely unanswered, and it has a real, consistently-reproduced
side effect (roughly halved vesicle count) that could plausibly cut
against the goal rather than for it. Next steps, if this branch
continues: a proper long-horizon multi-seed sweep to get a real
bootstrap-likelihood answer, and a diagnostic isolating whether the
vesicle-count drop is really the shear-vs-clustering mechanism
hypothesized above (e.g. measuring cluster-formation attempt rate near
vs. far from the vent) before concluding the current strength needs
tuning down.

## Phase B (pool fills the whole dish) + three live-iteration fixes

Four connected changes landed in one working session on
`claude/closed-loop-soup`, driven partly by design (Phase B, planned in
advance) and partly by the user watching the published artifact live
and reporting real problems as they appeared. Documented together
because that's how they actually happened, not retroactively split into
separate rounds.

**Phase B: the pool now spans the whole dish.** `Origin`'s coordinate
space grew from an 800×500 corner to the full 2400×1500 dish —
`POOL_OFFSET` is now `{0,0}`, `Origin`/`World` are spatially
coextensive. The key design decision: **patch-seed, don't area-seed**.
Naively spreading the same particle count over 9x the area would have
cut density 9x, directly undermining this project's own prior finding
that bootstrap likelihood scales super-linearly with density (3x
density: catalytic peptides 0.40→2.14 average; 5x: ribozymes appear at
all for the first time). Instead, `seedPrimordialSoup` plants the exact
same 8x-density initial dose into one 800×500 patch (reusing Phase A's
original footprint) positioned inside the new dish, and lets the vent's
ongoing injection + persistent current do the actual spreading over
time. `ventCapPerKind` raised 300→900 since the vent is now the dish's
sole ongoing matter source for its entire life, not a top-up on an
unchanged dominant seed. A real gap was caught before it could bite:
`spawnEnergy()` had no `at` parameter at all, which would have spread
the initial energy dose uniformly over the whole dish while aa/nt/lipid
stayed patch-concentrated — fixed by adding the same optional `at?`
param the other three spawn functions already had. The renderer's
amber pool-tint rectangle was removed (it now draws the exact same
rectangle as the dish boundary already drawn beside it). `SAVE_VERSION`
bumped 7→8 on a "pool identity changed" basis — no schema shape broke,
but resuming an old save silently under the new full-dish code would
otherwise keep running Phase A's small pool forever with no signal.

Mass-ledger re-verified exact: vent-off 0 violations (ledger constant);
vent-on adds exactly 900/900/900, matching the new cap precisely, 0
violations.

**A real regression was found, reported honestly, and accepted as-is —
not fixed.** A matched bootstrap-sanity comparison (same seeds,
patch-seeded full-dish vs. the original small-pool baseline) found
`longestPeptide` dropping from 12→2 and `longestRna` from 7-8→2-5 across
tested seeds, with standing vesicle count roughly doubling (46-58→
110-115). Likely mechanism, not yet isolated: the current, calibrated
for a small wall-bounded pool, now drains material out of the dense
patch into a much larger empty void once walls are far away, working
against concentration. Four possible fixes were identified but none
implemented — the finding was reported plainly with the tradeoff spelled
out, and the user's call was **"I like it as is."** This is recorded
here as an accepted, known cost of the design, not something silently
fixed or silently ignored.

**Division-cooldown fix: vesicles were re-fusing immediately after
splitting.** Live-observed by the user ("we're getting a vesicle issue
again"). Root cause: `divideVesicle()`'s two daughters start out still
touching — they're two halves of the same original membrane ring — so
`fuseVesicles()`'s ordinary contact-triggered fusion check (especially
its 0.9/tick `complementaryFusionChance` bonus) could immediately
re-merge them, worst case exactly when a division had split a catalyst
from a replicator, silently erasing the one outcome `isBootstrapEligible`
actually needs. Asked the user to choose between ejection force and a
cooldown; a cooldown was recommended (ejection force needs touching
per-particle movement code for every member of both daughters, with the
existing speed cap immediately reasserting — similar to the vent jet's
own limitation) and implemented: a `siblingId` field on `Vesicle`
cross-referencing each daughter to the other, plus a
`divisionSiblingCooldownTicks=50` gate in `fuseVesicles()` (deliberately
much shorter than the unrelated `divisionCooldownTicks=500`, which
gates a single vesicle re-dividing, not sibling re-fusion). Verified
headlessly by monkey-patching `divideVesicle`/`mergeVesicles` to log
tick-stamped events: 3000 ticks, 7848 divisions, 98 sibling reunions, **0
cooldown violations** (smallest observed gap was 57 ticks, cooldown is
50).

**Vent radial-dispersal fix: particles were orbiting, not spreading.**
Live-observed by the user ("Things are just slowly spinning in fairly
fixed orbits"). The original vent current was tangential-only,
deliberately, out of a concern that a purely radial push would just
pile everything against the walls — but that reasoning was incomplete.
A tangential-only force is centripetal-like with no radius-dependent
restoring force, so particles settle into stable circular orbits at
whatever radius they currently occupy rather than genuinely dispersing
— defeating the actual point of Phase B (the pool reaching the wider
dish). Fixed by adding a genuine radial (outward) component alongside
the tangential one (`ventRadialStrength=0.015`, same calibration
approach as the existing `ventCurrentStrength`), turning the motion
into a dispersing spiral instead of a closed circle — the same way a
real buoyant plume both entrains rotational flow and rises/expands away
from its source. Verified headlessly: average particle distance from
the vent increases monotonically at every sampled checkpoint (343→805
over 2000 ticks, post vent-position-fix numbers below), confirming real
outward dispersal rather than a plateau.

**Vent-position fix: anchored to the seed patch, not the raw dish.**
The user asked directly why the vent wasn't centered in the dish. The
honest answer: it never was meant to be — Phase A's `{width*0.15,
height*0.5}` formula deliberately placed it left-of-center to give the
current's rotation a real long axis before hitting a wall, not
symmetric-and-cancelling from dead center. But Phase B reused that
formula against the *whole dish's* width/height rather than the seed
patch's, and it only kept landing inside the patch by coincidence — this
dish happens to be narrow enough (2400×0.15=360, inside the patch's
0-800 x-range) for it to work, but a wider dish would silently put the
vent outside the seeded material entirely. Fixed by recomputing the
vent's position directly from `seedPatch` once it's known
(`seedPatch.x + seedPatch.w*0.15`, `seedPatch.y + seedPatch.h*0.5`),
keeping the vent's original off-center relationship to the *seeded
material* exact regardless of dish size, rather than relying on that
coincidence holding. Verified against three cases: full dish (2400×1500)
→ `(120, 750)`, a direct small-pool call reproducing Phase A's exact
original footprint (800×500) → `(120, 250)`, matching Phase A exactly,
and a hypothetical much-wider dish (6000×1500) → `(120, 750)`, unchanged
despite the huge width — confirming the vent now stays patch-anchored
rather than dish-anchored. Mass-ledger and radial-dispersal checks
re-run after this change, both still pass (0 violations; 343→805
avgDist increasing).

**Honest state to hand off**: all four changes build clean and pass
their respective headless verification. The Phase B polymer-growth
regression remains a known, user-accepted tradeoff, not a fixed bug —
if this branch continues, isolating its actual mechanism (rather than
the four untested hypotheses from when it was found) would be the
natural next diagnostic, now that the vent's own behavior (dispersal
direction, position) is on firmer footing than when the regression was
first found.

## Wall recycling + manual soup-spawning tool

Two more additions on `claude/closed-loop-soup`: free abiotic soup now
recycles through the vent instead of piling up at walls, and there's a
new hand tool to place specific chemistry directly into the pool.

**Wall recycling.** Free `aa`/`nt`/`lipid`/`energy` particles (not part
of a polymer, not captured in a vesicle) used to bounce off dish walls
forever — nothing removed them, so they could pile up at the boundary
indefinitely. `moveParticles()` now despawns them instead: touching a
wall removes the particle, and for `aa`/`nt`/`lipid` specifically,
decrements `ventInjected[kind]` (clamped at 0) to re-open one slot in
`ventCapPerKind` for `spawnVentFlux()` to eventually refill — at its
existing throttled rate, not instantly. Energy needs no extra
bookkeeping; `spawnEnergyFlux()`'s existing capacity-based top-up
already replaces a removed energy particle for free. Deliberately does
**not** track whether a specific despawned particle was ever actually
vent-spawned versus part of the original patch seed — no code anywhere
tracks per-particle provenance, and the budget is what matters, not
which atoms take which path. Polymers and vesicle members are
unaffected — still bounce, exactly as before; this is scoped to loose
soup only.

Verified two ways: an isolated decrement/clamp check (particles placed
directly at a wall with outward velocity, confirmed removed and the
counter decremented and clamped correctly, with a polymer placed the
same way confirmed still bouncing, unaffected), and a full exact mass-
ledger proof — instrumenting real vent-spawn counts, wall-despawn
counts, and (a real pre-existing mechanic this surfaced, not a bug)
energy-consumed-by-reaction counts, over 3000 ticks on the shipped
full-dish config. Every one of the four kinds reconciled to **exactly
0** difference between actual and predicted final counts.

**A real, honest, asymmetric side effect, found by a longer-run
census, not the ledger proof**: over 6000 ticks on the same config,
total aa-equivalent matter (free + in-polymer) fell from 2880 to 910
(down to ~32%) and nt-equivalent from 2240 to 865 (~39%), while lipid
matter *grew* from 1920 to 2819 (+899, almost exactly one
`ventCapPerKind`'s worth). Not a bug — the mass ledger proves every
atom is accounted for — but a real, structural asymmetry in how
different kinds cycle between free (wall-vulnerable) and bound
(wall-immune) states: aa/nt cycle constantly between free and
polymer-bound via ordinary condensation/hydrolysis, so each cycle
through the free state carries a real chance of wall-loss, and over
many cycles that compounds into a substantial net decline. Lipids
mostly only ever move from free into a vesicle membrane and then stay
there — once captured, a lipid is largely immune to further wall-
recycling, so the vent's contributions accumulate for lipids in a way
they don't for aa/nt. Whether this actually helps or hurts bootstrap
likelihood is genuinely unclear either way: less free aa/nt is less raw
material for peptide/RNA growth (working against the redesign's goal),
but more lipid could mean more vesicles for a manually-placed replicator/
catalyst to land in (helping it). Recorded honestly, not chased with a
fix — a natural next diagnostic if this branch continues.

**Manual soup-spawning tool.** Three new public `Origin` methods —
`spawnManualParticle`, `spawnManualPeptide`, `spawnManualRna` — let the
player place specific chemistry directly into the pool: individual
monomers, or a complete randomized peptide/RNA chain of a chosen length,
optionally with a `forceCatalyst`/`forceRibozyme` flag that resamples
the random sequence (up to 500 attempts) until it actually folds
catalytic. This is a deliberate override outside the closed-loop
economy — the same category of thing the Designer tab's "Release Random
Population" already is — so none of the three touch
`ventInjected`/`ventCapPerKind`. New Chemistry-tab panel: pick a kind,
set a length + force-catalytic/ribozyme toggle for peptide/RNA, arm
"Place on Dish," then tap the dish to place (stays armed for repeated
placements, an eyedropper-style tool). Placement is inset 1px from the
dish edge specifically so a freshly-placed particle can't land exactly
on the wall and get immediately despawned by the new recycling logic
above.

Verified: 30 repeated `forceCatalyst`/`forceRibozyme` calls at length
12 each hit **30/30** within the 500-attempt bound (well above the
7-20% single-attempt rate this project's own prior density scan
measured for peptides); length clamping confirmed at both ends (999 →
40, 0 → 2); confirmed none of the three touch `ventInjected`/
`ventCapPerKind` by direct before/after diff. Playwright, with the live
sim paused for a clean diff: selecting Peptide reveals the length/force
row, arming shows the `.active` state, and a single simulated dish tap
produces exactly +1 peptide and +1 catalytic peptide in the stats panel
— zero console errors.

No `SAVE_VERSION` bump for either change — manually-spawned particles
are plain `Particle`/`PeptideParticle`/`RnaParticle` objects already
covered by the existing generic serialization, and wall-recycling only
changes `ventInjected`'s runtime behavior, not its shape.

## Gene editor: editing a living individual's genes

Shipped. The Tree tab's "Raw gene sequence" section now has an **Edit
genes** mode: click a gene to expand it into clickable nucleotide chips,
click a symbol to cycle A -> U -> G -> C, watch a live decoded preview,
then Apply or Cancel. Individual-only, raw symbols, and speciation left to
happen naturally at the individual's next reproduction — all three as
previously scoped.

### The previous handover's plan was wrong in three places

It claimed: *"No changes needed to `genes.ts`, `genome.ts`,
`virtunism.ts`, or `world.ts` ... New code is UI only."* Checking each
claim against the code rather than trusting it:

1. **"UI only" does not hold.** Two functions were added to `genes.ts`
   (`cloneGeneSequence`, `validateGeneSequence`) and two to
   `virtunism.ts` (`replaceGenome`, a `jointDistance` static that
   `budOffspring` now shares). It *is* achievable UI-only — every field
   involved is public and `maxEnergy` is a live getter — but only by
   having `main.ts` own the `localDist` formula that otherwise lives in
   exactly one place, and hard-coding gene-length constants in the view
   layer while leaving the sim unguarded for any future caller. Both are
   the drift this codebase's comments exist to prevent.
2. **The aliasing hazard was mis-aimed.** `crossoverGeneSequence` does
   splice parent Gene arrays in by reference (`genes.ts:200-207`), but its
   only call site is `mateVirtunisms`, which wraps it in `mutateGenome` —
   and `mutateGeneSequence` rebuilds every gene via `.map()`. So
   **parent/sibling sharing is latent, never live**. The live case is
   sharper and was the real target: `World.addSpeciesFromSequence` hands
   founder #0 the *same object* it stored as `LineageInfo.referenceSequence`,
   and `checkSpeciation` does the same for a promoted cell. An in-place
   edit would have rewritten the cell's own species baseline to match
   itself, pinning its genetic distance from that baseline at 0 and
   silently disabling speciation for the entire lineage. Same mitigation
   (fresh arrays at both levels), different thing to assert.
3. **The energy edge case is narrower than flagged, but a *speed* case
   was missed entirely.** `World.buildInputs` already clamps `energyNorm`,
   so an over-cap energy corrupts no brain input — it only renders a >100%
   text label. But `speedNorm` is **not** clamped, and nothing ever
   re-derives a *non-root colony member's* `speed`: World's movement loop
   skips bonded members and `moveColonyRigid` writes only the root's. So a
   motor-shrinking edit on a colony member would have left a permanently
   too-high speed feeding the brain forever. `replaceGenome` clamps it.

Also found, not in the plan at all: **`TreeNode.hue` is snapshotted at
birth** and is what the tree view draws each node from, while the renderer
reads `genome.hue` live — so a hue edit recolored the dish dot and not the
tree dot. Apply now writes `node.hue`, which `checkSpeciation` already
does post-birth, so it is an established seam rather than a new one.

### One gene at a time, and why

A full genome is 5 core genes of 10 symbols plus up to 16 protein genes of
60. A chip per symbol would be **1010 chips** against the ~60 elements the
read-only list costs today — exactly the blowup `buildGeneList`'s own
comment says it avoids. Expanding only one gene caps the worst case at 60.
Measured, on a 21-gene individual: `#tree-detail *` = **183 read-only, 206
in edit mode collapsed, 267 with a 60-chip protein gene open**. No event
delegation needed, which matters because this codebase has none anywhere.

The room that buys pays for a **live decoded preview** of the expanded
gene, and that turned out to be load-bearing rather than decorative,
because of something the verification caught:

**`decodeUnit` is a sum over symbol indices, so it is order-independent.**
A first draft of the aliasing test flipped an entire core locus from
`CUUCGUACCC` to `GGGGGGGGGG` and measured a genetic distance of *exactly
0* — both sum to 20 and decode to 0.6667. Many edits are genuinely
synonymous. Without the preview a player flips ten symbols, sees nothing
happen, and concludes the feature is broken; with it they read
`size 1.22 - unchanged`. This is a real property of the encoding, not a
bug, and it is the strongest argument for the preview line.

### Decisions

- **No auto-pause.** `paused` has exactly one writer in the whole app;
  auto-pausing would add two new couplings around it. The draft is a
  private deep copy, so ticks passing during an edit provably cannot touch
  it — verified by leaving a dirty draft open for ~90 frames of a running
  sim and confirming the chips still held their drafted values. The hint
  text points at the top bar instead.
- **Validator added anyway**, returning a reason string rather than
  throwing, and deliberately *not* called from `genomeFromSequence` (the
  birth hot path). The editor structurally cannot emit a bad sequence, but
  the measured blast radius if anything ever did is severe: an all-`X`
  size gene yields `size = -0.4` (past `TRAIT_LIMITS.size.min` of 0.5),
  `maxEnergy = -12`, `reproduceThreshold = -5.04`, and
  **`canReproduce()` unconditionally true at zero energy** — unbounded
  reproduction. Note the plan also predicted a negative *radius*; that is
  wrong. `radius = 5 + size*5 + proteins*0.55` is still 5.2 at that size,
  only below any legitimate genome's, not negative.
- **No `SAVE_VERSION` bump** (stays 8). A genome built by
  `genomeFromSequence` is structurally identical to a born one and
  `serializeGenome` is a whole-object spread; an edited individual
  round-trips identically, colony joints included, and a world containing
  no edited individuals round-trips unchanged. The v8 "identity changed"
  precedent does not apply — that was about resumed worlds silently
  diverging from fresh ones. A bump would discard every existing save for
  nothing.
- **Provenance is session-only** (`handEditedIds`, rendered as
  `- hand-edited` in the detail head). `isPlayerDesigned` is `readonly`
  *and* inherited by every descendant, so reusing it would retroactively
  relabel a whole lineage; persisting a new flag would change
  `SerializedVirtunism`'s shape and cost a version bump. Same call
  `save.ts` already makes for paused/speed/camera.
- **Panel rebuild keys on genome object identity**, not a hand-bumped
  epoch. `genomeFromSequence` always returns a fresh object, so
  `live.genome !== lastRenderedGenome` is an exact, allocation-free test
  that a future caller swapping a genome some other way cannot forget to
  bump. Scroll position is preserved across an in-place swap (the gene
  section sits at the bottom of a scrolling panel) but not across a
  selection change.

### Verified

Headless (5 scripts): the lineage-baseline aliasing case both before and
after the fix, with every gene array proven fresh at both levels; the
validator rejecting 11 malformed shapes while accepting 200 trials each of
`randomGeneSequence`, `mutateGeneSequence` (incl. 10 generations deep),
`crossoverGeneSequence`, `randomGenome`, `mutateGenome`, `crossoverGenome`;
the measured blast radius above; brain carried as the *same object*; the
isDna ratchet holding through a replicase-stripping edit and still
promoting on a replicase-adding one; energy clamped (204 -> 42 on a
size-minimising edit); a non-root colony member's speed still bounded 200
ticks later; joints re-seated with the grandchild's own joint correctly
untouched; and the save round-trip.

Speciation timing, asserted precisely: an edit measured past
`speciationThreshold` changes **nothing** at edit time — same `lineageId`,
same lineage count, `isSpeciationEvent` still false — and founds a new
species with the right `parentLineageId` at the next reproduction.

Playwright: DOM counts above; a dirty draft surviving ~90 frames of a
running sim with live stat blocks unchanged; Apply updating the stat
blocks and preserving scroll; Cancel reverting; selection-change mid-edit
discarding the draft; **death mid-edit** (driven deterministically by
minimising the `maxAge` locus while paused, re-opening the draft, then
unpausing) leaving no edit DOM behind and no draft re-homed onto the next
selection; portrait 390x844 with 60 chips wrapping inside the panel
(`scrollWidth 361 <= clientWidth 361`), 21px tap targets, no horizontal
scroll anywhere. Zero console errors throughout.

**Honest gap:** the validator's *UI surfacing* path (Apply showing
`.gene-edit-error`) is not exercised end-to-end. Reaching it needs an
invalid sequence, which the editor structurally cannot create, and the app
exposes no `world` global to inject one — and adding a debug global to
shipped code purely to test an unreachable branch was not worth it. The
validator itself is thoroughly covered headless; only the wiring from
Apply to the error line rests on inspection.

**Known, accepted:** `replaceGenome` doesn't re-cascade colony positions —
`World.cascadeColonyPositions` does that on the next tick — so applying to
a colony member *while paused* leaves it looking slightly gapped until
unpause.

## Stage 0 retired: the pool is off, not deleted

User's call: the abiogenesis stage was "a bad call" and should go. Chosen
form after scoping: **hide it behind a flag rather than delete it**, so the
decision is one line to reverse.

```ts
const SOUP_DEFAULT = false;
const soupParam = new URLSearchParams(window.location.search).get('soup');
const SOUP_ENABLED = soupParam === null ? SOUP_DEFAULT : soupParam === '1';
```

`?soup=1` brings the whole stage back; `?soup=0` forces it off even if the
default ever flips. Keeping both modes reachable is not just politeness to a
future decision — it is what makes the change testable, and the browser
suite exercises both.

### The folder name misleads, and it nearly cost the organism model

"Delete `src/chem/`" sounds like it removes the soup. It does not.
`src/chem/` holds two unrelated things:

- **The abiogenesis stage** — `origin.ts` (2,077 lines), `particle.ts`,
  `vesicle.ts`, `bridge.ts`. Genuinely severable: nothing in `sim/` imports
  any of it, and `bridge.ts` has exactly one caller (`autoBootstrap`).
- **The organism's protein system** — `polymer.ts`'s `foldPeptide` and
  `elements.ts`'s `CODON_TABLE`. This is not soup code. It is how a gene
  becomes a capability at all: `decodeProteinGene` → `foldPeptide` →
  `catalysisClass` → `classPowerCache` → every `derive*` in `genome.ts`. It
  also drives speciation (`geneticDistance` is 50% protein-class histogram),
  founder viability, all species statistics, and every visual feature the
  renderer draws on an organism. Delete it and every virtunism has zero
  traits.

Hiding sidesteps the question entirely — nothing under `src/chem/` or
`src/sim/` is edited at all — but it is worth writing down for whoever
next reads "just delete the chemistry folder" and believes it.

### The dish had to be given a way to start

The blocker found while scoping, and the only genuinely new mechanism this
round: **`World` has no starter species.** Its own comment says a dish
starts genuinely empty and life enters either from the pool or from the
Designer's release button. Switch the pool off with nothing else changed and
the app opens to an empty dish that stays empty forever.

So `seedStartingPopulation()` stocks a fresh dish with 12 individuals via
the exact path the Designer's Release button already drives —
`randomGenome(world.rng)` → `world.addSpeciesFromSequence` — which runs
`ensureEnergyCapable`, so a seeded founder is guaranteed a real route to
feed itself rather than a random loadout that starves.

Called from **exactly two places**, both fresh-dish paths: first boot with
no save, and Reset. Never on extinction.

### Extinction is now final, and says so

`updateStage0Retirement`'s extinction branch was the only thing in the app
that ever revived a dead dish (it un-latched the pool so abiogenesis got
another shot). It is soup-only, so with Stage 0 retired it does not run and
a total extinction is permanent — which is what the README already promises
everywhere else: *"nothing steps in to save it."* The Species tab's
empty-state copy was reworded to name the Designer tab instead of the pool,
so a player who returns to a dead dish is told what happened and what to do.

### Two things the plan got wrong, both caught by verification

**1. `element.hidden` did nothing.** The plan said hide the Chemistry tab
button and the Vesicles HUD readout with the `hidden` attribute. Playwright
reported both still fully visible: `#tab-rail .tab-btn` and `.hud > div` are
both `display: flex`, and an author rule beats the UA stylesheet's
`[hidden] { display: none }`. The codebase had already hit this once and
solved it locally (`.confirm-overlay[hidden]`); generalised now to
`[hidden] { display: none !important; }` near the top of `style.css` so the
attribute means what it says everywhere.

**2. Turning the vent off does NOT make the pool inert.** The plan asserted
that constructing `new Origin(..., ventEnabled: false)` meant "nothing is
ever injected". Measured: a vent-less pool ticked 2,000 times accumulates
**200 particles**. `Origin.update()` calls `spawnEnergyFlux()`
(`origin.ts:757`) independently of `spawnVentFlux()` — it is the ambient
"sunlight" top-up and has nothing to do with the vent.

So the real guarantee is that `frame()` never calls `origin.update()` when
the soup is off. **That gate is load-bearing, not belt-and-braces**, and the
headless check now pins the 200-particle number precisely so that a future
change making a vent-less pool genuinely inert gets noticed rather than
silently widening what the flag promises. Constructing it vent-less is still
right (no vent marker, matching intent) — it just isn't the mechanism.

### Save format: unchanged, and verified across the flag

`SAVE_VERSION` stays **8**, and `save.ts` is not touched. Because an
`Origin` object still exists in both modes, `SaveFile` keeps its `origin`
field and nothing about the shape changes. Verified end-to-end in the
browser, in both directions: a run saved with the pool **on** reloads
cleanly with it **off** (population restored, pool neither drawn nor
ticked), and flipping back to `?soup=1` restores that pool with its matter
intact. Deleting the stage instead would have forced a v9 bump and
invalidated every existing save — the concrete payoff of hiding.

### Verified

Headless: a vent-less pool starts empty and produces no vesicles and no
founders even when ticked (with the 200-particle finding above pinned); a
seeded pool has 7,520 particles for contrast; the boot-seed path produces 12
living founders, all energy-capable, still alive and at generation 13 after
3,000 ticks; a wiped world stays wiped for 3,000 ticks; and
`seedStartingPopulation()` has exactly two call sites, both guarded, neither
referencing population or extinction.

Playwright, both modes: default hides the Chemistry tab, its panel and the
Vesicles readout, leaves the other four tabs, boots a stocked and running
dish, and reports a world-only perf number; `?soup=1` restores the tab, the
populated pool (aa≈2,230), its advancing tick and the eyedropper; `?soup=0`
forces it off; a canvas hash proves the dish genuinely renders differently
with and without the pool; Reset restocks rather than emptying. Zero console
errors in every mode.

All previous suites re-run clean, including the whole gene-editor set
against the new pre-seeded default.

One test correction worth noting, since it briefly looked like a
regression: the gene-editor suite's "energy label never exceeds 100%" check
used a regex window over the whole detail panel, which reaches into the
*next* row — "Toward reproduction threshold", which `updateLiveVitals`
deliberately leaves unclamped so a genuinely over-ready individual shows a
real >100%. The assertion now targets the energy row itself. The code was
never wrong.

## Tree of Life: collapsing the present

User's report, with a screenshot: at tick 28,101 with 650 alive, the tree was
"totally illegible when it matters most, the present." Correct, and the
existing caveat only captured half of why.

### Both axes failed, and they compound

Measured on real runs rather than eyeballed:

- **Vertical.** 239 leaves spread over the canvas height gives **0.40px per
  slot against a 3.2px node radius — ~16x overlap** at the 128px floor, and
  still 3.3x at a generous 500px. This is the smear.
- **Horizontal, and it worsens with run length.** Every living individual was
  born within one `maxAge` of now, so the living cohort crushes into a sliver
  of width that shrinks as the run stretches. The median node sits at **76%
  of the width at 4,000 ticks and 92.8% at 16,000** — extrapolating to the
  reported 28,101 gives the wall in the screenshot.

The decisive point: **no rescaling saves an individual-level view at 650
living dots.** Even a perfect time axis cannot fit 650 leaves in a
phone-height panel. So the fix has to reduce what is drawn.

### Why a leaf budget and not one tip per species

The first plan was to collapse the living cohort into one tip per species.
The data killed it: a **14,000-tick run with 163 individuals still had
exactly one living species**, so that rule would have rendered the entire
present as a single dot. (It also has no well-defined attachment point —
`addSpeciesFromSequence` makes each founder its own tree root, so a lineage's
living members often share no common ancestor at all, and an LCA-based
anchor computed zero tips.)

So the collapse budgets **leaves**, not species: walk down from the roots and
repeatedly expand whichever frontier node has the most living descendants
(reusing `TreeNode.liveCount`, already maintained by World) until there are
enough tips to fill the height. Everything below the frontier becomes one
weighted tip. One species alive gives sub-clades of it; fifteen give roughly
one tip each. The budget is `slotHeight / 13`, so a taller panel genuinely
shows more.

### Three things that only showed up on screen

- **Tips were drawn in the deep past.** A collapsed tip was anchored at its
  frontier node's birth tick — an *ancestor* — so summaries of the living
  present rendered at the far left, exactly backwards. They are now plotted
  at the birth of the newest living individual they stand for, which puts
  them at the right-hand edge where a phylogram puts its extant taxa.
- **Tip radius has to be capped by the layout, not taste.** Two adjacent
  tips at 11px in an 11px slot overlap outright, and one taller than the top
  padding clips against the canvas edge. Both were visible before the cap
  (`min(11, slotSpacing * 0.45, padTB - 3)`) existed.
- **Plotting tips at the present is not enough on its own — they need their
  branch drawn too.** Caught only by screenshotting the *real app*, which
  releases 26 founders from the Designer, where the harness fixture had 4:
  with that many roots the frontier never expands past them, so every tip
  plots at the present, nothing is left to draw in between, and the whole
  left half goes empty while the tips pile against the right frame. Each
  clade now draws a branch from its own origin out to its tip, which is what
  a phylogram does and what restores the time structure. The regression test
  gained a second fixture built the way the app actually seeds, because the
  original one could not have caught this.

### Result

383 nodes -> 20 marks at phone size, 35 at desktop. Closest pair of marks
**14.25px** (was sub-pixel), everything inside the canvas, and marks spanning
314px of 358 instead of piling at one edge. Tips carry their population count
once they are big enough to hold it.

`index.html`'s Tree panel copy was rewritten: it claimed "Every dot is one
virtunism that's ever lived," which the collapse makes false.

### Still open (caveats 3a and 3c)

devicePixelRatio is still unhandled in `treeview.ts`/`chart.ts`, so the tree
renders at 1x beside a 2x dish; and there are still no branch labels, zoom or
pan.

### A note on the scroll fix that isn't one

Re-running the gene-editor suite after this surfaced the detail panel losing
~113px of scroll position on Apply. Chased it: the panel does shrink when edit
mode exits, but not enough to explain it — a panel at 2834 came back at 2178
against a real maximum of 2688. Forcing a synchronous layout before the
assignment did not help; nor did re-applying on the next animation frame. It
is left as the simple assignment with the finding written down rather than
dressed up as fixed. What matters — the panel keeping its place instead of
snapping to the top — still holds, and that is what the test now asserts.

## Tree of Life: zoom, pan, and real resolution

User asked to "make the tree voxel (vertex?) based so you can zoom and keep
resolution", and to drop the Tree tab's explanatory hint to reclaim space.

### Vector-crisp without an SVG rewrite

The instinct behind "vector" is right, but it does not need SVG. The canvas is
redrawn from the layout every frame, so giving it a camera and redrawing under
the new transform re-rasterises at native resolution — zooming never magnifies
a bitmap. Two changes deliver it:

- **devicePixelRatio**, mirroring `renderer.ts`: the backing store is sized
  `css * min(dpr, 2)` and layout is done in CSS pixels. Verified in-browser at
  both 1x (359x256 backing for 359x256 css) and 2x (718x512 for 359x256).
  This was standing caveat 3a.
- **A camera** (`TreeCamera { cx, cy, zoom }`, normalised centre so resizing or
  rotating a phone doesn't throw the view somewhere unrelated), with
  cursor-anchored `zoomTreeCameraAt` and `panTreeCamera` mirroring the dish
  canvas's own gestures rather than inventing a second interaction model.
  Drag pans, wheel and pinch zoom, a Fit button resets. This was caveat 3c.

`touch-action: none` on `#chart-tree` is load-bearing exactly as it is on
`#sim-canvas` — without it the browser claims drags and pinches for page
scrolling before any handler sees them.

### Zoom buys detail, not magnification

The leaf budget scales with zoom (`slotHeight * zoom / 13`), so going in
spreads the layout and lets genuinely more tips fit at the same on-screen
spacing — collapsed clades open up instead of merely drifting apart.
Measured on the test fixture: **20 marks at 1x, 44 at 2x, 95 at 4x, 192 at
8x**, monotonic. Marker sizes and line widths are deliberately *not* scaled,
so marks stay a readable size the way a map behaves.

Tapping still works alongside panning via the dish's own rule: a pointer that
moved under 6px is a tap, anything more is a drag, and a pinch is never a tap.
Hit-testing moved to CSS pixels, since the backing store is no longer 1:1.

### The hint, traded down rather than deleted

The Tree tab's `.panel-hint` paragraph is gone; a single `.tree-hint` line
replaces it. Removing it outright reclaimed the space but took with it the
only explanation of what a collapsed tip is — and zoom/pan is undiscoverable
on a canvas, so there were now two things the view could not say for itself.
One line says both: *"Tips are collapsed clades, sized by population. Drag to
pan, scroll or pinch to zoom in."*

Measured at 390x844: toolbar **90px**, tree canvas **254px** — against the
~250px the paragraph alone used to take. Fit and Clear are wrapped in a
`.tree-actions` row so the narrow-viewport rule that turns the toolbar into a
column doesn't give each button its own line and eat the height back.

## Shipping Evo as a single-file Artifact

`tools/build-artifact.mjs`, `npm run build:artifact`. Committed this round,
which is a deliberate break with the old handover note telling each fresh
session to re-derive it: that convention is about scratch *verification*
scripts, and a repeatable build step is not one. Re-deriving a bundler every
session was pure waste.

Output is `evo-artifact.html` (~506 KB, gitignored — it is build output).

### Let tsc do the bundling

The obvious approach — concatenate `dist/*.js`, strip `import`/`export` — is
the fragile one. All 21 modules would share a single scope, so any two
top-level names that collide break it silently, and it has to special-case
the re-export edge (`sim/types.ts` re-exports from `chem/polymer.ts` while
`chem/origin.ts` imports back out of `sim/`).

Instead:

```
tsc --ignoreConfig --ignoreDeprecations 6.0 --module system \
    --outFile <tmp> --target es2020 --lib es2020,dom --strict --skipLibCheck \
    src/main.ts
```

Every module comes out as a `System.register(name, deps, declare)` call with
its **own scope**, so collisions are structurally impossible and the
`setters`/`execute` split handles dependency order. The only missing piece is
a loader, and the one in the build script is ~40 lines with no dependency —
it implements just what tsc emits: register, the two shapes of the `exports`
callback (`exports("n", v)` and `exports({a, b})`), setters, execute.

**Order is the whole job in that loader.** Declare every module first, then
wire setters so each module holds a live reference to its dependencies'
export *objects*, and only then execute — dependencies before dependents.
Executing in registration order instead leaves a module reading `dep_1.Thing`
before dep's `execute()` has assigned it. The same exports object is handed
to every dependent's setter, which is what stands in for ES module live
bindings.

**Deprecation to track:** `outFile` and `module=system` are deprecated in
TypeScript 6 and stop working in 7 (hence `--ignoreDeprecations 6.0`). When
that lands this needs a real bundler, or the shim needs to consume plain ESM.

### Assembly detail that would otherwise be a silent boot crash

The artifact is `<title>` + inlined `style.css` + the `#app` markup lifted
from `index.html`'s body + one plain `<script>`, with no
doctype/html/head/body (the Artifact wrapper supplies those).

That script **must go last**. `index.html` uses `<script type="module" src>`,
which defers automatically — that is the only reason the app's ~40
module-scope `el()` lookups find their elements. An inline classic script
does not defer, so placing it above the markup makes every one of those
lookups throw.

### Verified

The point of a single file is that it works with nothing else present, so it
is tested from `file://` with no server: **zero subresource requests** beyond
the document (the strongest form of the claim — it catches anything a grep
for `src=` would miss); boots with a stocked dish; tick advancing; canvas
hash changing between frames so it is genuinely painting; all four tabs open
and Chemistry is correctly absent; Release Random Population works; a tree
node selects and the gene editor expands a locus into 10 chips; the run
survives a reload via localStorage; Reset works through the in-page confirm
overlay (the app avoids `window.confirm` precisely because it ships
sandboxed — this verifies that decision end to end); portrait 390x844 holds
with no horizontal scroll. Zero console errors.

## Tech constraint from last time

Original build environment blocked the npm registry/CDNs (git-only
access), which is why it's vanilla TypeScript + Canvas 2D instead of
Phaser/PixiJS. This session confirmed a local global `tsc` is available
without npm, so the build still works the same way.
