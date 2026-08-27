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
  OVERSIZE_DIVISION_MULTIPLIER,
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

/** The single vesicle currently closest to clearing isBootstrapEligible —
 * what the Chemistry tab's "closest to bootstrap" detail actually shows.
 * Real, currently-observable state, not a prediction. */
export interface BootstrapProgress {
  hasActiveCatalyst: boolean;
  hasReplicatorNow: boolean;
  replicationEvents: number;
  divisionsSoFar: number;
  lipidCount: number;
}

/** What a stabilized protocell hands off to the next stage — see bridge.ts. */
export interface BootstrapCandidate {
  vesicleId: number;
  tick: number;
  x: number; // local to this Origin's own coordinate space — the pool's position within the wider dish is main.ts's concern, not this engine's
  y: number;
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
  rng: Rng; // not readonly — deserialize() swaps in a state-restored instance

  particles = new Map<number, Particle>();
  vesicles = new Map<number, Vesicle>();
  tick = 0;
  history: OriginStatsSnapshot[] = [];
  perf = { lastTickMs: 0 };
  /** Every protocell that's ever crossed the bootstrap bar, most recent
   * last. main.ts drains this to offer a hand-off into the Virtunism dish. */
  bootstrapCandidates: BootstrapCandidate[] = [];
  /** Fixed point prebiotic matter vents from — see spawnVentFlux() (the
   * matter source) and the tangential current term in moveParticles()
   * (the agitation). null disables the whole mechanic — matter source
   * and current both — for a clean headless A/B against a vent-free run
   * with everything else held identical. Not readonly: deserialize() may
   * restore a different value than the constructor default, same reason
   * `rng` below isn't readonly either. */
  vent: { x: number; y: number } | null;
  /** Every completed templated-RNA-replication event, in or out of a
   * vesicle — this is the dish-wide total. `Vesicle.replicationEvents`
   * (see vesicle.ts) is a separate, narrower per-protocell count used
   * only for the bootstrap-eligibility bar, which specifically cares
   * whether heredity happened *inside* that vesicle. An earlier version
   * of this stat only summed the per-vesicle counts, so free-floating
   * replication (the overwhelming majority of it, since only a small
   * fraction of RNA ever ends up inside a vesicle) was invisible here —
   * worth flagging since it looked like replication "never completed" in
   * several verification runs when the real problem was this stat being
   * blind to it, not replication itself failing. */
  totalReplicationEvents = 0;

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
  // Raised from 0.05 as part of a modest, deliberate "make natural
  // abiogenesis actually reachable" calibration pass — see NOTES.md.
  // Left roughly 2x rather than pushed further so this stays a real
  // rare-event simulation, not a guaranteed-outcome one.
  readonly baseCondensationRate = 0.1;
  readonly baseHydrolysisRate = 0.0018;
  // Raised from 10 (up to ~16x now) as part of the same pass — a bigger
  // reward for a catalyst actually being present, without changing what
  // "present" means or how catalysts form in the first place.
  readonly catalystBoost = 15; // a strong nearby catalyst multiplies bonding odds up to ~16x
  readonly mutationRate = 0.03; // per-base chance a templated copy mispairs
  // Both raised together (not just the reaction rates above) — pushing
  // condensation/replication rates up without more energy throughput
  // would just shift the bottleneck onto energy availability instead of
  // actually removing it.
  readonly energyCapacity = 200;
  readonly energyFluxPerTick = 2.5; // expected new energy particles/tick (fractional, accumulated)
  // A hydrothermal vent — a real, physically-grounded source of both
  // fresh prebiotic matter and the current to move it. Everything else
  // in the pool only ever gets rearranged (see this file's header
  // comment on the closed-loop matter philosophy); the vent, like the
  // energy flux above, is a deliberate exception — new matter entering
  // from one real, localized point, the same way real geochemistry at
  // an alkaline hydrothermal vent (H2/CO2 reacting at mineral surfaces)
  // continuously synthesizes organics rather than a diffuse everywhere-
  // at-once seed. `seedPrimordialSoup`'s own one-time density dose is
  // unchanged by this — the vent is a modest ongoing supplement on top
  // of it, not yet the dominant source (that's a larger, separate
  // redesign, not this one).
  readonly ventFluxPerTick = 0.4; // expected new particles/tick per kind (aa/nt/lipid) — same fractional-debt-accumulator pattern as energyFluxPerTick
  // A performance/stability floor, not a claim a real vent would run
  // dry — same role energyCapacity plays for the energy flux. Bounds
  // how many particles of a kind the vent will ever spawn, cumulative
  // (see ventInjected below) — *not* a cap on the current free count of
  // that kind, which would silently let the vent keep injecting forever
  // as long as ordinary hydrolysis/condensation kept cycling matter
  // between free and polymer-bound states fast enough to keep the free
  // count under a ceiling (headless-caught: an earlier free-count-based
  // version of this cap let the vent add 3x+ its intended budget before
  // the free-count gauge ever actually reached the ceiling).
  // Raised from 300 to 900 for Phase B — the vent stopped being a modest
  // supplement on top of an otherwise-dish-wide dose the moment the pool
  // stopped ambiently reseeding the whole dish and started
  // patch-seeding instead (see seedPrimordialSoup); it's now the *sole*
  // ongoing matter source for the dish's entire life, so "a ~12%-of-
  // initial top-up" was the wrong bar. Still cheap in absolute terms —
  // 2,700 extra particles trickled in over ~2,250 ticks (ventFluxPerTick
  // unchanged), negligible next to the ~8,000-particle initial patch
  // that dominates per-tick cost — while meaningfully increasing the
  // matter actually available to spread outward with over a real run. A
  // starting hypothesis to confirm or adjust by measurement, not a final
  // number — see the Phase B density/perf sweep.
  readonly ventCapPerKind = 900;
  // Well above moveParticles()'s existing 0.6/1.1 speed caps — the very
  // next movement step clamps the *magnitude* back down to the cap but
  // preserves *direction* (moveParticles() already does this
  // unconditionally), so a freshly-vented particle gets a real outward
  // "running start" at max ambient speed in a random direction, then
  // decays into ordinary Brownian motion over the following ticks as
  // drag and noise wash the extra momentum out.
  readonly ventJetSpeed = 2.5;
  // The whole-pool "agitation" — a small, coherent, per-tick velocity
  // bias around the vent, applied to every particle every tick in
  // moveParticles(), on top of (never replacing) its existing
  // independent Brownian motion. Two components, tangential + radial:
  //
  // Tangential (rotational): constant magnitude (not divided by
  // distance), so angular velocity falls off with distance from the
  // vent — real differential rotation, which shears adjacent "rings" of
  // material past each other over time (actual mixing) rather than
  // carrying everyone around in the same rigid rotation (same molecules
  // stay same neighbors forever, no mixing).
  //
  // Radial (outward): originally left out on the reasoning that a purely
  // radial push would just pile everything against the walls — true in
  // isolation, but tangential-only turned out to have its own, worse
  // failure mode, caught by direct observation of a live run rather than
  // by the math: a tangential-only force continuously redirects a
  // particle's velocity to stay tangential *at whatever radius it
  // currently occupies*, which is a real centripetal-like effect with no
  // radius-dependent restoring force to fight it — particles settle into
  // stable, slowly-diffusing circular orbits around the vent instead of
  // actually escaping toward the wider dish, which was the entire point
  // once the pool stopped being a small enclosed pool (Phase B). Adding
  // a real outward term alongside the tangential one turns that circle
  // into a spiral — material still gets the shearing/mixing benefit
  // *and* genuinely disperses outward, the combination a real buoyant
  // plume actually produces (a plume both entrains rotational flow in
  // the surrounding water and, being buoyant, actually rises/expands
  // away from the vent — it doesn't just stir the pot in place).
  //
  // Calibrated, not guessed: same steady-state math
  // vesicleChemotaxisBiasStrength's own comment uses — a bias re-applied
  // every tick against drag=0.96 compounds to a steady-state
  // contribution of biasStrength/(1-drag) = 25x. At 0.015 each, that's
  // ~0.375/tick per component, comfortably under the 0.6/1.1 movement
  // speed caps even combined (~0.53/tick at 45°) — real, compounding
  // circulation *and* dispersal without permanently pegging every
  // particle at max speed in lockstep (which a much higher value would —
  // a rigid, cap-pegged whirl doesn't actually mix or disperse anything
  // either, for the same reason a non-differential rotation doesn't).
  readonly ventCurrentStrength = 0.015;
  readonly ventRadialStrength = 0.015;
  readonly lipidAssemblyRadius = 7;
  // Raised from 0.02 as part of the second abiogenesis-tuning pass (see
  // NOTES.md) — a vesicle's interior nucleotide/energy supply is
  // otherwise only whatever got trapped at formation plus whatever's
  // slowly diffused in since, so a working interior replicator can stall
  // on local depletion even with every reaction rate raised; a higher
  // exchange rate keeps it resupplied from the surrounding soup instead.
  readonly membranePermeability = 0.035; // per-tick chance a small molecule crosses a nearby membrane
  // A real, headless-diagnosed gap in what the model represented: being
  // inside a vesicle was previously *only* a constraint (a smaller,
  // same-vesicle-only reaction candidate pool), with none of the actual
  // real-world advantage compartmentalization is supposed to provide —
  // protection from the open dilute solution, and local concentration of
  // whatever reactants did get trapped together. A dedicated diagnostic
  // (see NOTES.md) found this was the real bottleneck behind the whole
  // first tuning pass: across an 80,000-tick sweep, replication completed
  // reasonably often free-floating in the open soup, but no vesicle ever
  // once accumulated 2 completions *inside* itself. This multiplier
  // stacks with (doesn't replace) the existing replicase-catalyst boost —
  // applied only in templatedReplication(), only when the template
  // currently has a vesicleId.
  readonly inVesicleReplicationBoost = 1.75;
  // Real fatty-acid protocells fuse on contact about as readily as they
  // divide (Zhu & Szostak 2009; Budin & Szostak 2011 growth/division
  // dynamics) — fission and fusion are both normal parts of real protocell
  // population dynamics, not just growth-then-split. Without this, two
  // protocells that each independently captured half of what a real
  // bootstrap needs (one a catalyst, one a replicator) had no way to ever
  // combine — a headless diagnostic (see NOTES.md) found a live catalyst
  // and a live replicator never once co-occurred inside the same vesicle
  // across a full run, which is the real bottleneck this targets. Kept
  // well under 1 (a real membrane-fusion event is stochastic even at
  // close range, not certain on first contact) so this stays a real rare-
  // event mechanism rather than an instant merge-on-touch shortcut.
  readonly vesicleFusionChance = 0.05; // per-tick chance two touching vesicles fuse
  // A *targeted* complement to vesicleFusionChance above, not a replacement
  // for it — see fuseVesicles()'s comment for the full mechanism. The
  // oversize-division escape valve (see OVERSIZE_DIVISION_MULTIPLIER,
  // vesicle.ts) closed a runaway where a vesicle could snowball through
  // dozens of uniform-random fusions and, by sheer brute-force absorption
  // of nearly the whole dish, eventually hold both a catalyst and a
  // replicator — headless-verified as the real mechanism behind this sim's
  // first natural-bootstrap successes (4/10 seeds), which vanished (0/10
  // on the same seeds) once that runaway was capped. Two vesicles that are
  // *specifically* complementary — one holds an active catalyst and no
  // replicator, the other holds a replicator and no active catalyst, so
  // fusing them is real structural progress toward isBootstrapEligible
  // rather than just membrane growth — are a categorically rarer and more
  // meaningful event than an arbitrary touch, so a much higher per-tick
  // chance here doesn't reopen the "instant merge-on-touch" shortcut
  // vesicleFusionChance's own comment guards against: the bonus only ever
  // applies to this one narrow case, and is self-limiting per vesicle —
  // once a vesicle picks up the piece it was missing it has both flags and
  // drops back to the ordinary baseline for every fusion after that, so
  // this can't compound into an unconditional runaway the way the
  // createdTick-reset bug did. Left under 1 rather than certain-on-contact
  // for the same reason vesicleFusionChance is: real membrane fusion is
  // stochastic even at close range, not guaranteed on first touch — but at
  // 0.9 a genuinely complementary pair fuses within ~1-2 ticks of first
  // contact on expectation, which is what actually matters here: restoring
  // reliable catalyst/replicator co-occurrence without depending on
  // unbounded vesicle size.
  readonly complementaryFusionChance = 0.9;
  // Real precedent: surfaces that concentrate prebiotic chemistry —
  // montmorillonite clay in particular (Hanczyc, Fujikawa & Szostak 2003)
  // — are documented to also nucleate vesicle formation around themselves,
  // and amphipathic peptides co-assemble with lipids rather than staying
  // chemically inert to membrane formation. Today's lipidAssembly() only
  // attracts free lipids to other free lipids, so *where* a vesicle closes
  // has zero correlation with where the dish's rare active chemistry
  // happens to be — a second, independent contributor to the same
  // co-occurrence bottleneck vesicleFusionChance targets. This is a soft
  // bias, not a guarantee: about half the strength of the lipid-lipid pull
  // it stacks with, so a vesicle can still close around empty soup most of
  // the time, same as reality.
  readonly nucleationSeedRadius = 14; // catalyst/RNA search radius during lipid clustering — 2x lipidAssemblyRadius, a "seed" pulls in lipids from further out than a same-species neighbor would
  readonly nucleationBiasStrength = 0.01;
  // A third, independent contributor to the same catalyst/replicator
  // co-occurrence problem vesicleFusionChance/complementaryFusionChance and
  // nucleationBiasStrength each target from a different angle:
  // nucleationBiasStrength biases where a *new* vesicle closes around
  // existing chemistry, but says nothing about two *already-closed*
  // vesicles that each independently ended up with only half of what a
  // bootstrap needs. Headless-verified as the real remaining gap:
  // instrumenting mergeVesicles() across two 40,000-tick runs (seeds 3 and
  // 10) found 0 complementary fusions in 4,400+ total fusion events,
  // because complementary vesicles never even touch — every particle
  // (including membrane lipids) moves by independent Brownian motion
  // (moveParticles()), so a vesicle's centroid is the average of N
  // independent random walks and its *net* displacement barely grows once
  // N is more than a handful; two specific rare vesicles out of a
  // ~90-107-strong population essentially never drift into contact by
  // chance within any practical horizon.
  //
  // This is not active chemotaxis — a protocell has no flagella or signal
  // transduction machinery to actively swim toward anything. It's modeled
  // the same way real fatty-acid vesicle chemistry already isn't inert to
  // its surroundings (surface/interfacial concentration gradients around
  // active chemistry are a real physical effect — the same
  // montmorillonite-nucleation precedent nucleationBiasStrength's comment
  // cites): a small, uniform, per-tick velocity nudge applied to every
  // membrane lipid of a catalyst-only or replicator-only vesicle, toward
  // the nearest vesicle holding the complementary piece. Applying the
  // *same* vector to every membrane lipid (not divided across them, unlike
  // nucleationBiasStrength's per-seed averaging) is what makes this work
  // despite the "sluggish blob" effect above: that effect is specific to
  // *uncorrelated* per-particle noise (which cancels across members), not
  // to a *coherent* applied bias (which translates the whole centroid
  // undiminished by member count).
  //
  // No radius cutoff — deliberately unbounded across the whole pool.
  // Catalyst-only/replicator-only vesicles are individually rare
  // (headless-typical: 1-3 of each at a time out of ~90-107 total), so
  // their *specific* mutual spacing is typically far larger than the
  // ~63-unit average spacing between all vesicles (sqrt(800*500/100)) — a
  // modest bounded radius would just reproduce a narrower version of the
  // exact zero-contact problem this exists to fix. The pool this models is
  // already framed elsewhere (seedPrimordialSoup's "fill the dish") as a
  // single small, well-mixed vessel, not an open ocean, so a soft gradient
  // bias spanning it is no less defensible than an arbitrary smaller
  // cutoff — and unlike a long-range-sensing claim, this stays bounded in
  // effect: it only ever nudges the two rarest vesicle types, only until
  // each resolves (see vesicleChemotaxis()).
  //
  // Strength calibrated, not guessed: with drag=0.96 (moveParticles()),
  // a nudge re-applied every tick has steady-state contribution
  // biasStrength/(1-drag) = 25*biasStrength per vesicle. At 0.002 that's
  // ~0.05 units/tick per vesicle, ~0.1/tick combined for a pair drifting
  // toward each other — closing the ~63-unit average spacing in ~600
  // ticks, or a worst-case ~400-unit separation in ~4,000 ticks, both far
  // inside the 40,000-tick sweep horizon and a matured catalyst/ribozyme's
  // thousands-of-ticks protected lifespan (see catalyticFoldProtection)
  // — real and reliable, but well under the 1.1/tick lipid speed cap, not
  // instant "swimming."
  readonly vesicleChemotaxisBiasStrength = 0.002;
  // A membrane that just crossed DIVISION_LIPID_COUNT — whether by
  // ordinary growth or by fusing with another vesicle — needs real time
  // to reorganize before it's structurally ready to fission again; real
  // fatty-acid vesicle growth/division cycles run on a physical timescale,
  // not an instantaneous threshold trigger. Set on the same order as this
  // file's other multi-hundred-tick process timescales (copyStallTicksPerBase,
  // copyStallTimeoutFloor) — long enough for a boosted in-vesicle
  // replication to plausibly complete before the membrane can split again.
  readonly divisionCooldownTicks = 500;
  // A different problem than divisionCooldownTicks above, which gates a
  // vesicle re-dividing — this gates two freshly-divided *siblings*
  // re-fusing with *each other*. The two daughters divideVesicle()
  // produces are just two halves of the same original membrane ring,
  // still touching (or close to it) the instant they're created, so
  // without this, fuseVesicles()'s ordinary contact check undoes the
  // division within a tick or two — worst case almost immediately when
  // the split happened to separate a catalyst from a replicator, since
  // that's exactly the pairing complementaryFusionChance (0.9/tick)
  // rewards, silently erasing the one division outcome that would
  // actually matter for isBootstrapEligible. Much shorter than
  // divisionCooldownTicks on purpose: this only needs to outlast the
  // instant of contact right at the split, not give the membrane real
  // reorganization time — long enough for ordinary drift/the vent
  // current to carry them apart, short enough that if they *do*
  // genuinely re-encounter each other later (a real, separate event,
  // not an artifact of the split), they're not blocked from fusing then.
  readonly divisionSiblingCooldownTicks = 50;
  // Headless-diagnosed (see NOTES.md): catalysts weren't being destroyed
  // outright — across 32 catalytic particles sampled over 5 seeds, 0 were
  // hydrolyzed to nothing, but 17 lost their catalytic classification from
  // a single ordinary hydrolysis event trimming one residue. The fold walk
  // has no memory of a previous fold — any sequence change re-derives the
  // whole structure from scratch — so losing even one residue is enough to
  // drop a molecule below CATALYTIC_STABILITY_THRESHOLD or MIN_STEM. The
  // existing stability-scaled resistance in hydrolyze() already reduces
  // this somewhat, but real biochemistry supports going further
  // specifically for a molecule that's *already* folded into something
  // functional: limited-proteolysis assays exploit exactly this (folded
  // domains resist protease cleavage; unstructured loops don't), and
  // RNase-protection assays rely on the RNA analog (paired/structured
  // regions resist single-strand-specific nucleases far better than
  // unstructured ones). This is an additional multiplier stacking with the
  // existing stability/stem-length term, not a replacement for it — a
  // real catalytic fold is measurably more protected than a merely
  // "stable" one at the same stability score, not just immune once it
  // clears the bar.
  readonly catalyticFoldProtection = 0.4;
  // A *per-base* allowance rather than one flat number — headless
  // verification found RNA strands growing past 30nt via ordinary
  // condensation (which has no completion requirement) while a fixed
  // absolute timeout gave a 6nt template and a 33nt template the exact
  // same window to finish copying in. That's not just unfair, it's a
  // structural dead end: replication can never even in principle keep
  // pace with unconstrained growth once a template gets long enough that
  // copying it exceeds the timeout on expectation alone, and 200,000+
  // ticks with zero completions across every seed traced back to exactly
  // this. Scaling per base keeps the odds comparable regardless of how
  // long a given template happens to be.
  readonly copyStallTicksPerBase = 220;
  readonly copyStallTimeoutFloor = 300;
  readonly substrateRadius = 42; // nucleotide search radius during templated copying — see templatedReplication's comment
  readonly statsSampleInterval = 20;
  readonly maxHistory = 500;

  private readonly grid = new SpatialGrid<Particle>(14);
  private nextId = 1;
  private nextVesicleId = 1;
  private energyDebt = 0; // fractional accumulator for energyFluxPerTick
  private ventDebt = 0; // fractional accumulator for ventFluxPerTick, one shared debt spent on all three kinds together
  // Standing count of vent-attributable matter currently "checked out"
  // against ventCapPerKind, per kind. Deliberately *not* a check against
  // the current *free* count of that kind: hydrolysis constantly cycles
  // matter between free and polymer-bound states (see hydrolyze()), so
  // free count alone chronically understates how much the vent has
  // really contributed once reactions start consuming what it spawns —
  // a cap on free count would let the vent keep injecting indefinitely
  // as long as reactions kept pace, defeating the entire point of a
  // stability floor.
  //
  // Originally this only ever went up (nothing destroyed aa/nt/lipid
  // matter, so "cumulative ever spawned" and "current standing
  // contribution" were the same number, always). Wall recycling
  // (moveParticles()) broke that: a free aa/nt/lipid particle that
  // despawns at the dish wall decrements this, re-opening one slot for
  // spawnVentFlux() to eventually refill. That decrement does *not*
  // check whether the specific despawned particle was ever actually
  // vent-spawned versus part of the original patch seed — no code
  // anywhere tracks per-particle provenance, and the budget is what
  // matters here, not which atoms take which path. Net effect: this cap
  // now bounds "how much vent-sourced matter can be in circulation
  // concurrently," not "how much the vent may ever emit in the whole
  // run" — a deliberate loosening once matter can also leave.
  private ventInjected = { aa: 0, nt: 0, lipid: 0 };

  constructor(width: number, height: number, seed: number, ventEnabled = true) {
    this.width = width;
    this.height = height;
    this.rng = new Rng(seed);
    // Left-of-center, not dead-center — gives the current's rotation a
    // real long axis to fan material across before it reaches a wall,
    // instead of being symmetric-and-cancelling from the middle. This is
    // only a default: seedPrimordialSoup() recomputes it relative to the
    // seeded patch once the patch is known (see its own comment) — this
    // formula only still matters for a direct `new Origin(...)` call with
    // no seeding, or before that override runs.
    this.vent = ventEnabled ? { x: width * 0.15, y: height * 0.5 } : null;
  }

  static seedPrimordialSoup(width: number, height: number, seed: number, opts: { vent?: boolean } = {}): Origin {
    const o = new Origin(width, height, seed, opts.vent ?? true);
    // Every canonical amino acid and nucleotide gets a real shot at being
    // in the soup — no thumb on the scale toward whichever ones happen to
    // fold well. Base composition (~18 copies of each of the 20 real amino
    // acids, ~70 of each of the 4 real nucleotides, a matching lipid/energy
    // bath) times SOUP_DENSITY_MULTIPLIER — the same "concentration
    // problem" bondRadius's own comment documents, leaned into hard this
    // time rather than the earlier modest doublings.
    //
    // This is a deliberate scale-not-odds choice, not another rate/
    // threshold nudge: headless investigation this round (see NOTES.md)
    // found the actual catalytic-fold acceptance rates (~7-20% for
    // peptides, comparably rare for RNA at the lengths it realistically
    // reaches) are already *more generous* than real biology — spontaneous
    // catalytic folding from a random sequence is astronomically rare in
    // reality, not 1-in-10. Loosening those thresholds further to make
    // bootstrap more likely would trade away realism for reachability.
    // Instead, since real abiogenesis got there through sheer scale (an
    // entire ocean, hundreds of millions of years), this raises the number
    // of simultaneous independent "attempts" instead: a density scan found
    // a real, more-than-linear payoff (3x density: catalytic peptides
    // 0.40→2.14 average; 5x: ribozymes 0.00→0.96 average, appearing at all
    // for the first time) — denser soup means faster growth to
    // fold-eligible length too, not just more molecules, so the effect
    // compounds. 8x is a real "fill the dish" move, not a token increase;
    // the resulting heavier per-tick cost is accepted deliberately, since
    // Stage 0 deactivates once a population sustains (see main.ts's
    // retirement logic) rather than needing to run indefinitely at this
    // density.
    const SOUP_DENSITY_MULTIPLIER = 8;
    // Phase B: `width`/`height` now typically span the whole dish, not
    // just the pool's own small footprint — but density (particles per
    // unit area), not total particle count, is what past rounds' density
    // scan actually measured a payoff from (see above), and per-tick cost
    // is driven by particle count (Origin.tickOnce() scans every particle
    // every pass), not by how much empty space surrounds them. So the
    // initial dose still concentrates into one dense patch reusing the
    // pool's original 800x500 footprint — planting the same soup that
    // worked before, not diluting it across a much bigger area — flush
    // against the left wall, vertically centered, sized down safely via
    // Math.min if `width`/`height` are ever smaller than that (e.g. a
    // direct 800x500 call, which then reduces to exactly Phase A's own
    // behavior: the "patch" is the whole area).
    const seedPatch = {
      x: 0,
      y: (height - Math.min(500, height)) / 2,
      w: Math.min(800, width),
      h: Math.min(500, height),
    };
    // The constructor's vent formula ({width*0.15, height*0.5}) was
    // written back when the pool's own footprint *was* the whole
    // coordinate space (Phase A) — "left-of-center of the space" and
    // "left-of-center of the seeded material" were the same statement.
    // Patch-seeding broke that equivalence: at this dish's current size
    // (2400x1500) the dish-relative formula (x=360) still happens to land
    // inside the patch's 0-800 x-range, but only because this dish is
    // narrow enough for that to hold — a wider dish would put the vent
    // outside the seeded material entirely, silently. Recomputing directly
    // off seedPatch keeps the vent's original off-center relationship to
    // the *seeded material* exact regardless of how large the surrounding
    // dish gets, rather than relying on that coincidence.
    if (o.vent) o.vent = { x: seedPatch.x + seedPatch.w * 0.15, y: seedPatch.y + seedPatch.h * 0.5 };
    for (const code of AMINO_ACID_CODES) for (let i = 0; i < 18 * SOUP_DENSITY_MULTIPLIER; i++) o.spawnAminoAcid(code, o.randomPosInRect(seedPatch));
    for (const code of NUCLEOTIDE_CODES) for (let i = 0; i < 70 * SOUP_DENSITY_MULTIPLIER; i++) o.spawnNucleotide(code, o.randomPosInRect(seedPatch));
    for (let i = 0; i < 240 * SOUP_DENSITY_MULTIPLIER; i++) o.spawnLipid(o.randomPosInRect(seedPatch));
    for (let i = 0; i < 60 * SOUP_DENSITY_MULTIPLIER; i++) o.spawnEnergy(o.randomPosInRect(seedPatch));
    return o;
  }

  // --- spawning ----------------------------------------------------------
  private randomPos(): { x: number; y: number } {
    return { x: this.rng.range(0, this.width), y: this.rng.range(0, this.height) };
  }

  /** Same as randomPos() but bounded to a sub-rectangle — how
   * seedPrimordialSoup concentrates its initial dose into one dense
   * patch instead of spreading it over the whole (now much larger)
   * dish. See seedPrimordialSoup's own comment for why. */
  private randomPosInRect(rect: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
    return { x: this.rng.range(rect.x, rect.x + rect.w), y: this.rng.range(rect.y, rect.y + rect.h) };
  }

  /** A random-direction, fixed-magnitude kick well above moveParticles()'s
   * speed cap — see ventJetSpeed's own comment on why the direction
   * survives the cap even though the magnitude doesn't. */
  private jetVelocity(): { vx: number; vy: number } {
    const angle = this.rng.range(0, Math.PI * 2);
    return { vx: Math.cos(angle) * this.ventJetSpeed, vy: Math.sin(angle) * this.ventJetSpeed };
  }

  /** `jet` is only ever passed by spawnVentFlux() — a vented particle
   * gets the outward speed kick, everything else (including
   * seedPrimordialSoup's own patch-concentrated seeding, which does
   * pass `at` but never `jet`) keeps the original small ambient
   * velocity. */
  private spawnAminoAcid(code: AminoAcidCode, at?: { x: number; y: number }, jet = false): AminoAcidParticle {
    const p: AminoAcidParticle = {
      id: this.nextId++,
      kind: 'aa',
      code,
      ...(at ?? this.randomPos()),
      ...(jet ? this.jetVelocity() : { vx: this.rng.range(-0.3, 0.3), vy: this.rng.range(-0.3, 0.3) }),
      vesicleId: null,
    };
    this.particles.set(p.id, p);
    return p;
  }

  private spawnNucleotide(code: NucleotideCode, at?: { x: number; y: number }, jet = false): NucleotideParticle {
    const p: NucleotideParticle = {
      id: this.nextId++,
      kind: 'nt',
      code,
      ...(at ?? this.randomPos()),
      ...(jet ? this.jetVelocity() : { vx: this.rng.range(-0.3, 0.3), vy: this.rng.range(-0.3, 0.3) }),
      vesicleId: null,
    };
    this.particles.set(p.id, p);
    return p;
  }

  private spawnLipid(at?: { x: number; y: number }, jet = false): LipidParticle {
    const p: LipidParticle = {
      id: this.nextId++,
      kind: 'lipid',
      tailLength: this.rng.bool(0.5) ? 1 : 2,
      ...(at ?? this.randomPos()),
      ...(jet ? this.jetVelocity() : { vx: this.rng.range(-0.2, 0.2), vy: this.rng.range(-0.2, 0.2) }),
      vesicleId: null,
    };
    this.particles.set(p.id, p);
    return p;
  }

  /** `at` is only ever passed by seedPrimordialSoup's own initial dose
   * (see its comment on why the dose patch-concentrates) — the ongoing
   * per-tick spawnEnergyFlux() top-up deliberately stays dish-wide and
   * uniform, the pre-existing "ambient sunlight" design, genuinely
   * unrelated to where matter is concentrated. */
  private spawnEnergy(at?: { x: number; y: number }): EnergyParticle {
    const p: EnergyParticle = {
      id: this.nextId++,
      kind: 'energy',
      ...(at ?? this.randomPos()),
      vx: this.rng.range(-0.5, 0.5),
      vy: this.rng.range(-0.5, 0.5),
      vesicleId: null,
    };
    this.particles.set(p.id, p);
    return p;
  }

  // --- manual spawn tool (player-directed, not part of the closed-loop
  // economy) ---------------------------------------------------------------
  // Everything above this point is chemistry the *simulation* decides to
  // create — the vent's throttled trickle, or an organic reaction. These
  // three are different: a deliberate, explicit player action, the same
  // category of override the Designer tab's "Release Random Population"
  // already is. None of them touch ventInjected/ventCapPerKind — that
  // budget exists to bound what the *vent* emits over time, and has
  // nothing to do with a player directly placing a specific molecule to
  // test or nudge a specific vesicle.

  /** Places one free aa/nt/lipid/energy particle at `at`, with a random
   * code where relevant. Thin public wrapper over the private spawn
   * primitives above — reuses them rather than duplicating their
   * velocity/field logic. */
  spawnManualParticle(kind: 'aa' | 'nt' | 'lipid' | 'energy', at: { x: number; y: number }): Particle {
    switch (kind) {
      case 'aa':
        return this.spawnAminoAcid(this.rng.pick(AMINO_ACID_CODES), at);
      case 'nt':
        return this.spawnNucleotide(this.rng.pick(NUCLEOTIDE_CODES), at);
      case 'lipid':
        return this.spawnLipid(at);
      case 'energy':
        return this.spawnEnergy(at);
    }
  }

  /** Builds a complete random peptide of `length` residues directly,
   * rather than waiting for extendPolymer() to grow one a residue at a
   * time over many ticks. If `forceCatalyst`, resamples the sequence up
   * to 500 times (NOTES.md's own prior measurement put catalytic-fold
   * acceptance at roughly 7-20% per attempt for peptides, so 500 makes
   * failure negligible without risking a real hang) looking for a fold
   * with `isCatalyst`; on the rare chance none of the 500 attempts hit,
   * spawns whatever the last attempt produced anyway rather than
   * failing outright — the caller can just try again. */
  spawnManualPeptide(at: { x: number; y: number }, length: number, forceCatalyst: boolean): PeptideParticle {
    const len = clamp(Math.round(length), 2, MAX_POLYMER_LENGTH);
    let sequence: AminoAcidCode[] = [];
    let fold = null as ReturnType<typeof foldPeptide> | null;
    const attempts = forceCatalyst ? 500 : 1;
    for (let i = 0; i < attempts; i++) {
      sequence = Array.from({ length: len }, () => this.rng.pick(AMINO_ACID_CODES));
      fold = foldPeptide(sequence);
      if (!forceCatalyst || fold.isCatalyst) break;
    }
    const p: PeptideParticle = {
      id: this.nextId++,
      kind: 'peptide',
      sequence,
      fold: fold!,
      ...at,
      vx: 0,
      vy: 0,
      vesicleId: null,
    };
    this.particles.set(p.id, p);
    return p;
  }

  /** Same idea as spawnManualPeptide() for RNA — see its comment. */
  spawnManualRna(at: { x: number; y: number }, length: number, forceRibozyme: boolean): RnaParticle {
    const len = clamp(Math.round(length), 2, MAX_POLYMER_LENGTH);
    let sequence: NucleotideCode[] = [];
    let fold = null as ReturnType<typeof foldRna> | null;
    const attempts = forceRibozyme ? 500 : 1;
    for (let i = 0; i < attempts; i++) {
      sequence = Array.from({ length: len }, () => this.rng.pick(NUCLEOTIDE_CODES));
      fold = foldRna(sequence);
      if (!forceRibozyme || fold.isRibozyme) break;
    }
    const p: RnaParticle = {
      id: this.nextId++,
      kind: 'rna',
      sequence,
      fold: fold!,
      copying: null,
      ...at,
      vx: 0,
      vy: 0,
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

  // tickOnce() is a flat, ordered list of small, independently-tunable,
  // commented private methods, each running against a freshly rebuilt grid.
  // That's the deliberate "bolt-on" shape for this file: a new mechanism —
  // another environmental or chemical dimension — is just one more method
  // in this list plus its own named constants above, grounded the same way
  // every existing one is (a real citation or a headless-verified reason,
  // not an arbitrary knob). Candidates that fit this pattern without any
  // further design change: wet-dry/concentration cycling (the Damer &
  // Deamer hot-spring hypothesis — periodic evaporation pulses that
  // concentrate reactants and reorganize vesicles), mineral-surface
  // catalysis, UV-driven mutagenesis.
  private tickOnce(): void {
    this.tick++;
    this.grid.rebuild([...this.particles.values()]);
    this.moveParticles();
    this.spawnEnergyFlux();
    this.spawnVentFlux();

    // Each of these passes removes and creates particles, so the grid
    // built above goes stale the moment the first one runs — rebuilding
    // between every pass, not just once per tick, is what this fixes.
    // Left stale (as an earlier version did), a later pass can still
    // "find" a particle an earlier pass already deleted this same tick:
    // the grid's bucket arrays hold object references, not live lookups,
    // so the detached zombie object still passes every kind/length/
    // vesicleId check. Extending or bonding into that zombie mutates an
    // object nothing else references — a silent no-op for the sim state
    // — while the *real* monomer that was "merged into it" still gets
    // deleted for real. That's genuine mass destruction, not just a
    // double-count: headless verification traced it directly (a hydrolysis
    // event's freshly spawned replacement nucleotide vanishing in the same
    // tick, consumed by an extend call whose target was an rna already
    // deleted moments earlier by hydrolyze()) and confirmed it as the
    // reason the free nucleotide pool was slowly starving out from under
    // replication regardless of how generous the reaction rates were.
    this.hydrolyze();
    this.grid.rebuild([...this.particles.values()]);
    this.condensePolymers('aa');
    this.grid.rebuild([...this.particles.values()]);
    this.condensePolymers('nt');
    this.grid.rebuild([...this.particles.values()]);
    this.templatedReplication();
    this.grid.rebuild([...this.particles.values()]);
    this.lipidAssembly();
    this.grid.rebuild([...this.particles.values()]);
    this.recruitAndDivideVesicles();
    this.grid.rebuild([...this.particles.values()]);
    this.vesicleChemotaxis();
    this.grid.rebuild([...this.particles.values()]);
    this.fuseVesicles();
    this.grid.rebuild([...this.particles.values()]);
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
      // The vent's persistent current — a coherent tangential + radial
      // bias on top of (never replacing) the independent Brownian term
      // just above. See ventCurrentStrength's own comment for the full
      // reasoning on both components, why constant-magnitude, and how
      // the strengths were calibrated.
      if (this.vent) {
        const dx = p.x - this.vent.x;
        const dy = p.y - this.vent.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.01) {
          p.vx += (-dy / dist) * this.ventCurrentStrength + (dx / dist) * this.ventRadialStrength;
          p.vy += (dx / dist) * this.ventCurrentStrength + (dy / dist) * this.ventRadialStrength;
        }
      }
      const speedCap = p.kind === 'peptide' || p.kind === 'rna' ? 0.6 : 1.1;
      const speed = Math.hypot(p.vx, p.vy);
      if (speed > speedCap) {
        p.vx = (p.vx / speed) * speedCap;
        p.vy = (p.vy / speed) * speedCap;
      }
      p.x += p.vx;
      p.y += p.vy;
      // Free abiotic soup (aa/nt/lipid/energy, not yet part of a polymer
      // or captured in a vesicle) despawns at a wall instead of bouncing
      // — otherwise it just piles up against the boundary forever, since
      // nothing else in this closed system ever removes it. This is the
      // vent's other half: matter exits here and re-enters through
      // spawnVentFlux()'s existing throttled trickle (see the
      // ventInjected decrement below), not instantly — a real recycling
      // loop, not a teleport. Polymers and anything inside a vesicle
      // still bounce, unchanged — this is scoped to loose soup, not
      // accumulated chemistry that represents real progress.
      const outOfBounds = p.x < 0 || p.x > this.width || p.y < 0 || p.y > this.height;
      const isFreeAbiotic =
        p.vesicleId === null && (p.kind === 'aa' || p.kind === 'nt' || p.kind === 'lipid' || p.kind === 'energy');
      if (outOfBounds && isFreeAbiotic) {
        this.removeParticle(p.id);
        // Re-opens one ventCapPerKind slot so spawnVentFlux() can
        // eventually replace what just left. Deliberately not tracking
        // whether *this specific particle* was ever vent-spawned versus
        // part of the original patch seed — no code anywhere tracks
        // per-particle provenance, and the budget is what matters here,
        // not which atoms take which path. energy has no cap to
        // reopen — spawnEnergyFlux()'s existing capacity-based top-up
        // already replaces a removed energy particle for free.
        if (p.kind !== 'energy') this.ventInjected[p.kind] = Math.max(0, this.ventInjected[p.kind] - 1);
        continue;
      }
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

  /** The matter half of the vent — see ventFluxPerTick's own comment for
   * why this is a deliberate exception to the closed-loop matter
   * philosophy, and ventInjected's for why the cap tracks cumulative
   * spawns rather than the current free count. One shared debt spent on
   * all three kinds together (not three independent debts) — simpler,
   * and there's no real reason a vent's aa/nt/lipid output should drift
   * out of lockstep with each other. */
  private spawnVentFlux(): void {
    if (!this.vent) return;
    this.ventDebt += this.ventFluxPerTick;
    while (this.ventDebt >= 1) {
      this.ventDebt -= 1;
      if (this.ventInjected.aa < this.ventCapPerKind) {
        this.spawnAminoAcid(this.rng.pick(AMINO_ACID_CODES), this.vent, true);
        this.ventInjected.aa++;
      }
      if (this.ventInjected.nt < this.ventCapPerKind) {
        this.spawnNucleotide(this.rng.pick(NUCLEOTIDE_CODES), this.vent, true);
        this.ventInjected.nt++;
      }
      if (this.ventInjected.lipid < this.ventCapPerKind) {
        this.spawnLipid(this.vent, true);
        this.ventInjected.lipid++;
      }
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
        const foldedProtection = p.fold.isCatalyst ? this.catalyticFoldProtection : 1;
        if (this.rng.bool(this.baseHydrolysisRate * resistance * foldedProtection)) this.shrinkPeptide(p);
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
        const foldedProtection = p.fold.isRibozyme ? this.catalyticFoldProtection : 1;
        if (this.rng.bool(this.baseHydrolysisRate * resistance * foldedProtection)) this.shrinkRna(p);
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
    // Guards against two different templates picking the *same* free
    // nucleotide (or the same energy particle) within this one pass —
    // mirrors condensePolymers()'s own `consumed` Set, which this
    // function was missing. The grid snapshot this pass reads from isn't
    // rebuilt between templates (only between whole passes — see
    // tickOnce()'s comment on why), so without this, a later template in
    // the same tick can still "find" a nucleotide/energy particle an
    // earlier template already removed a few iterations ago: removing an
    // already-gone id is a harmless no-op, but `p.copying.built.push(...)`
    // still runs regardless, silently minting a nucleotide-equivalent
    // that was never actually backed by a real free particle. A real
    // headless mass-conservation run caught this directly — a modest
    // rate increase (see NOTES.md) was enough to make the within-pass
    // collision non-negligible, where at the old, lower rates it had
    // apparently never fired often enough to show up.
    const consumed = new Set<number>();
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
        // Raised from 0.0015 as part of the "make natural abiogenesis
        // actually reachable" calibration pass (see NOTES.md) — this was
        // the single rarest roll in the whole pipeline (an eligible RNA
        // only had a 0.15%/tick shot at ever starting to copy at all,
        // before any of the downstream per-base extension odds even come
        // into play), so it's the one constant in this pass raised a
        // full 2x rather than a fraction of that.
        const vesicleBoost = p.vesicleId !== null ? this.inVesicleReplicationBoost : 1;
        const startRate = 0.003 * Math.max(selfBoost, transBoost) * vesicleBoost;
        if (this.rng.bool(startRate)) p.copying = { built: [], startedTick: this.tick };
        continue;
      }

      // A stalled complex eventually falls apart rather than freezing the
      // template at a fixed length forever (see particle.ts's doc comment
      // on RnaParticle.copying) — headless-verified as necessary: without
      // it, RNA length plateaued hard the instant the first copy attempt
      // got stuck, for the entire rest of a 150,000-tick run.
      const stallTimeout = this.copyStallTimeoutFloor + p.sequence.length * this.copyStallTicksPerBase;
      if (this.tick - p.copying.startedTick > stallTimeout) {
        // The bases already built don't just vanish with the complex —
        // headless-verified as a real, previously-silent mass-destruction
        // bug: every abandoned copy was quietly deleting however many
        // nucleotides it had successfully assembled before giving up,
        // which (since most attempts don't complete) was steadily
        // starving the free nucleotide pool out from under every other
        // attempt still in progress.
        for (const code of p.copying.built) {
          const mono = this.spawnNucleotide(code);
          mono.x = p.x + this.rng.range(-4, 4);
          mono.y = p.y + this.rng.range(-4, 4);
          mono.vesicleId = p.vesicleId;
          if (p.vesicleId !== null) this.vesicles.get(p.vesicleId)?.memberIds.add(mono.id);
        }
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
        .filter((o): o is NucleotideParticle => o.kind === 'nt' && o.vesicleId === p.vesicleId && !consumed.has(o.id));
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
        .find((o) => o.kind === 'energy' && o.vesicleId === p.vesicleId && !consumed.has(o.id));
      if (!energyNearby) continue;

      // Calibrated up from an initial 0.04, then again from 0.12 as part
      // of the "make natural abiogenesis actually reachable" pass (see
      // NOTES.md): headless verification showed copies routinely
      // stalling at ~15-20% of their template length before hitting the
      // stall timeout even with an active ribozyme nearby — the base
      // rate, not just catalysis, was too low to realistically finish a
      // 6-9-base copy inside a ~1000-tick window.
      const vesicleBoost = p.vesicleId !== null ? this.inVesicleReplicationBoost : 1;
      const boost = this.nearbyCatalystBoost(p.x, p.y, 'replicase') * (p.fold.isRibozyme ? 1 + p.fold.catalysisStrength * 4 : 1) * vesicleBoost;
      if (!this.rng.bool(Math.min(0.9, 0.2 * boost))) continue;

      consumed.add(energyNearby.id);
      consumed.add(chosen.id);
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
        this.totalReplicationEvents++;
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

      // A second, independent attractor: catalytically active peptides and
      // long-enough RNA also draw nearby free lipids in — real membrane
      // nucleation isn't blind to what's already there (see
      // nucleationBiasStrength's comment above for the citations). This is
      // what lets a *newly forming* vesicle land on top of active
      // chemistry instead of a uniformly random patch of empty soup.
      const seeds = this.grid
        .queryRadius(l.x, l.y, this.nucleationSeedRadius)
        .filter(
          (o): o is PeptideParticle | RnaParticle =>
            (o.kind === 'peptide' && o.fold.isCatalyst) ||
            (o.kind === 'rna' && (o.fold.isRibozyme || o.sequence.length >= MIN_TEMPLATE_LENGTH)),
        );
      if (seeds.length > 0) {
        let sx = 0;
        let sy = 0;
        for (const s of seeds) {
          sx += s.x - l.x;
          sy += s.y - l.y;
        }
        l.vx += (sx / seeds.length) * this.nucleationBiasStrength;
        l.vy += (sy / seeds.length) * this.nucleationBiasStrength;
      }
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
      siblingId: null,
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
      if (nearbyFree.length > 0) {
        v.radius = radiusForLipidCount(v.lipidIds.length);

        // Capture-on-growth: a membrane that just expanded to enclose new
        // lipids also encloses whatever peptides/RNA now happen to be
        // geometrically inside its larger radius — the same real,
        // unconditional "whatever's nearby gets trapped, for better or
        // worse" mechanism formVesicle() already uses at initial closure
        // (see its own comment above), extended here from a one-time
        // closure event to every later growth event across a vesicle's
        // life: real ongoing bilayer growth is physically the same
        // membrane-closing-around-contents process repeated, not a
        // categorically different one. Unlike the lipid recruitment
        // immediately above — lipids are the membrane's actual building
        // material, driven inward as new wall, hence the generous `+3`
        // reach — a captured peptide or RNA is incidental, passive
        // enclosure, so this uses a real geometric containment test
        // (dist <= v.radius, exactly formVesicle()'s own check) rather
        // than a reach-out-and-grab radius or any driven-recruitment
        // framing.
        //
        // Deliberately unconditional/blind to catalytic or replicator
        // status, same as formVesicle(): a real membrane closing around
        // space has no way to know in advance which macromolecule inside
        // happens to be functional, any more than the original closure
        // event does. Scoped to peptide/rna only — lipid is already fully
        // covered by the unconditional recruitment just above (the
        // nearbyFree query already captures every unclaimed free lipid
        // within this same radius), and nt/aa/energy already have their
        // own ongoing post-formation entry/exit pathway (membraneDiffusion(),
        // permeability-gated) — this fills specifically the gap
        // membraneDiffusion()'s own comment carves out ("too big to
        // cross"): peptide/rna were the only two kinds with no route into
        // an existing vesicle at all before this.
        //
        // No new probability knob: capture frequency is already bounded
        // by how often a vesicle actually recruits new lipids
        // (nearbyFree.length > 0, itself an existing, already-tuned,
        // naturally-limited rate) — piggybacking on an already-calibrated
        // cadence instead of inventing a new number to guess, the same
        // "more independent attempts, not higher per-attempt odds"
        // philosophy seedPrimordialSoup's SOUP_DENSITY_MULTIPLIER comment
        // already uses elsewhere in this file. Headless-verified: closes
        // the confirmed 0.00%-of-ticks in-vesicle-catalyst gap (see
        // NOTES.md) without pushing it into universal/instant territory.
        const newlyEnclosed = this.grid
          .queryRadius(v.x, v.y, v.radius + 3)
          .filter(
            (p): p is PeptideParticle | RnaParticle =>
              (p.kind === 'peptide' || p.kind === 'rna') && p.vesicleId === null,
          );
        for (const p of newlyEnclosed) {
          if (Math.hypot(p.x - v.x, p.y - v.y) > v.radius) continue;
          p.vesicleId = v.id;
          v.memberIds.add(p.id);
        }
      }

      // Real vesicle fission isn't instant the moment a size threshold is
      // crossed — a membrane needs real time to reorganize before it's
      // structurally ready to split again (see divisionCooldownTicks'
      // comment above). Without this, a freshly fused vesicle — already
      // at or past DIVISION_LIPID_COUNT the instant two ~equal-sized
      // vesicles combine — was re-dividing on literally the very next
      // tick, undoing the merge (and re-separating whatever it had just
      // brought together) before any chemistry had a chance to happen: a
      // headless diagnostic found 86 real fusion events in one 30,000-tick
      // seed and still zero ticks of catalyst+replicator co-occurrence,
      // with division counts exploding 30-50x versus the pre-fusion
      // baseline — the smoking gun for fuse-then-instantly-re-split churn.
      const settled = this.tick - v.createdTick >= this.divisionCooldownTicks;
      // A separate, size-based escape valve for the opposite failure mode:
      // mergeVesicles() resets createdTick on every fusion, so a vesicle
      // absorbing new small vesicles faster than the cooldown clears can
      // never divide at all — headless-verified as a real runaway at 8x
      // soup density (a large vesicle's radius scales directly with its
      // lipid count, keeping it in near-constant contact with freshly-
      // forming small ones, so successful fusions arrive faster than 500
      // ticks apart and the cooldown never lapses): 6 of 8 seeds in a
      // 15,000-tick sweep collapsed to a single vesicle holding
      // 1,700-1,900+ of ~1,920 total pool lipids, some still collapsed
      // tens of thousands of ticks later. See OVERSIZE_DIVISION_MULTIPLIER
      // (vesicle.ts) for why 3x specifically and why this doesn't
      // reintroduce the fuse-then-instant-resplit churn above for
      // ordinary-sized vesicles.
      const grosslyOversized = v.lipidIds.length >= DIVISION_LIPID_COUNT * OVERSIZE_DIVISION_MULTIPLIER;
      if (v.lipidIds.length >= DIVISION_LIPID_COUNT && (settled || grosslyOversized)) {
        this.divideVesicle(v);
      }
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

    // Both daughters inherit the parent's full replicationEvents count,
    // not split or reset — a lineage's replicative track record belongs
    // to both branches of a division equally, the same way a real
    // daughter cell inherits its parent's actual working molecular
    // machinery (ribosomes, enzymes, genetic material) rather than
    // re-earning replication capability from a cold start. This doesn't
    // weaken isBootstrapEligible's real gate: hasActiveCatalyst/
    // hasReplicatorNow are still checked live, fresh from whatever's
    // physically inside each specific vesicle at the moment it's
    // evaluated — a daughter that ends up with the catalyst separated
    // from the replicator (division partitions purely by spatial
    // proximity to each new centroid; real protocells at this stage have
    // no active segregation machinery, so this stays passive on purpose)
    // still fails that check immediately either way. What this removes
    // is the previous, structural requirement that a vesicle complete
    // *two more* full replication events specifically timed after its
    // first division before it could ever qualify — on top of already
    // having proven it could replicate before splitting at all. That
    // compounding of two independently-rare events in a specific order
    // is the likely reason a natural bootstrap was never once observed
    // in 200,000+ verification ticks despite every individual mechanism
    // (folding, catalysis, replication, division) working on its own.
    // ids assigned up front, not inline, so each daughter can record the
    // other's real id as its sibling (see Vesicle.siblingId's own
    // comment) — divisionSiblingCooldownTicks below is what actually
    // uses this, in fuseVesicles().
    const idA = this.nextVesicleId++;
    const idB = this.nextVesicleId++;
    const daughterA: Vesicle = {
      id: idA,
      x: ca.x,
      y: ca.y,
      radius: radiusForLipidCount(groupA.length),
      lipidIds: groupA.map((l) => l.id),
      memberIds: new Set(groupA.map((l) => l.id)),
      createdTick: this.tick,
      divisions: v.divisions + 1,
      replicationEvents: v.replicationEvents,
      siblingId: idB,
    };
    const daughterB: Vesicle = {
      id: idB,
      x: cb.x,
      y: cb.y,
      radius: radiusForLipidCount(groupB.length),
      lipidIds: groupB.map((l) => l.id),
      memberIds: new Set(groupB.map((l) => l.id)),
      createdTick: this.tick,
      divisions: v.divisions + 1,
      replicationEvents: v.replicationEvents,
      siblingId: idA,
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

  // --- vesicle chemotaxis ---------------------------------------------------
  // See vesicleChemotaxisBiasStrength's comment above for the full
  // rationale. Runs once per tick, right after recruitAndDivideVesicles()
  // has refreshed every vesicle's centroid/membership and before
  // fuseVesicles() checks for contact — nudges vx/vy the same one-tick-
  // behind way lipidAssembly()'s nucleation bias already does (the actual
  // position integration happens in the *next* tick's moveParticles()).
  private vesicleChemotaxis(): void {
    const list = [...this.vesicles.values()];
    if (list.length < 2) return;
    // One content scan per vesicle up front — same reasoning as
    // fuseVesicles()'s own `contents` prescan (see its comment): up to
    // O(vesicles^2) in the worst case below, trivial at the ~90-107-
    // vesicle scale this sim runs at.
    const contents = new Map<number, { hasActiveCatalyst: boolean; hasReplicator: boolean }>();
    for (const v of list) {
      const { hasActiveCatalyst, hasReplicator } = this.scanVesicleContents(v);
      contents.set(v.id, { hasActiveCatalyst, hasReplicator });
    }
    for (const v of list) {
      const c = contents.get(v.id)!;
      const catalystOnly = c.hasActiveCatalyst && !c.hasReplicator;
      const replicatorOnly = c.hasReplicator && !c.hasActiveCatalyst;
      // Only the two "half-formed" cases drift — a vesicle with neither
      // (or already both) has nothing complementary to look for, same
      // gating fuseVesicles() already uses for complementaryFusionChance.
      if (!catalystOnly && !replicatorOnly) continue;

      let nearest: Vesicle | null = null;
      let nearestDist = Infinity;
      for (const other of list) {
        if (other.id === v.id) continue;
        const oc = contents.get(other.id)!;
        const isComplement = catalystOnly
          ? oc.hasReplicator && !oc.hasActiveCatalyst
          : oc.hasActiveCatalyst && !oc.hasReplicator;
        if (!isComplement) continue;
        const d = Math.hypot(other.x - v.x, other.y - v.y);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = other;
        }
      }
      if (!nearest || nearestDist === 0) continue;

      // Only the membrane lipids get nudged, not the fuller memberIds —
      // v.x/v.y (what fuseVesicles() actually checks) is the centroid of
      // v.lipidIds only (see recruitAndDivideVesicles()), and interior
      // contents already get pulled along by moveParticles()'s existing
      // containment clamp as the membrane translates, with no extra code
      // needed for that part.
      const dx = (nearest.x - v.x) / nearestDist;
      const dy = (nearest.y - v.y) / nearestDist;
      for (const id of v.lipidIds) {
        const p = this.particles.get(id);
        if (!p) continue;
        p.vx += dx * this.vesicleChemotaxisBiasStrength;
        p.vy += dy * this.vesicleChemotaxisBiasStrength;
      }
    }
  }

  // --- vesicle fusion ------------------------------------------------------
  // See vesicleFusionChance's comment (with this.tunables above) for the
  // real precedent and why this exists: without it, a protocell holding a
  // catalyst and one holding a replicator can drift side by side forever
  // and never combine into a single bootstrap-eligible unit. On top of that
  // flat baseline, a specifically complementary pair — one missing only a
  // replicator, the other missing only a catalyst — fuses at
  // complementaryFusionChance instead: a deliberate, targeted bias toward
  // exactly the co-occurrence isBootstrapEligible needs, in place of what
  // this sim's first natural bootstraps actually ran on (an unbounded
  // vesicle brute-force-absorbing the whole dish — see
  // OVERSIZE_DIVISION_MULTIPLIER, vesicle.ts) with a mechanism that doesn't
  // depend on runaway size at all.
  private fuseVesicles(): void {
    const list = [...this.vesicles.values()];
    // One content scan per vesicle up front, not one per pair compared —
    // this pass has up to ~90-107 vesicles (~5,000-11,000 pairs before the
    // radius check below short-circuits most of them), and re-scanning
    // full membership per pair would be wasteful. A fusion doesn't remove
    // anything from either side (mergeVesicles is a pure union of
    // contents), so this snapshot is kept accurate for the rest of the
    // pass by updating the surviving vesicle's entry in place after each
    // merge below, instead of re-scanning it.
    const contents = new Map<number, { hasActiveCatalyst: boolean; hasReplicator: boolean }>();
    for (const v of list) {
      const { hasActiveCatalyst, hasReplicator } = this.scanVesicleContents(v);
      contents.set(v.id, { hasActiveCatalyst, hasReplicator });
    }
    const consumed = new Set<number>();
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (consumed.has(a.id) || !this.vesicles.has(a.id)) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (consumed.has(b.id) || !this.vesicles.has(b.id)) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) > a.radius + b.radius) continue; // membranes not touching
        // Fresh division siblings, still on cooldown — see
        // divisionSiblingCooldownTicks's own comment for why this check
        // exists. createdTick is the same for both (both daughters get
        // it set at the moment of division), so either side's is fine.
        if (
          (a.siblingId === b.id || b.siblingId === a.id) &&
          this.tick - a.createdTick < this.divisionSiblingCooldownTicks
        ) {
          continue;
        }
        const ca = contents.get(a.id)!;
        const cb = contents.get(b.id)!;
        // Complementary: each side is missing exactly what the other
        // holds — fusing them is real structural progress toward
        // isBootstrapEligible, not just membrane growth. See
        // complementaryFusionChance's comment above.
        const aCatalystOnly = ca.hasActiveCatalyst && !ca.hasReplicator;
        const aReplicatorOnly = ca.hasReplicator && !ca.hasActiveCatalyst;
        const bCatalystOnly = cb.hasActiveCatalyst && !cb.hasReplicator;
        const bReplicatorOnly = cb.hasReplicator && !cb.hasActiveCatalyst;
        const complementary = (aCatalystOnly && bReplicatorOnly) || (bCatalystOnly && aReplicatorOnly);
        const chance = complementary ? this.complementaryFusionChance : this.vesicleFusionChance;
        if (!this.rng.bool(chance)) continue; // contact alone isn't instant fusion
        const [big, small] = a.lipidIds.length >= b.lipidIds.length ? [a, b] : [b, a];
        this.mergeVesicles(big, small);
        consumed.add(small.id);
        // The merge is a pure union — keep the survivor's cached flags
        // accurate for any further pairing this same pass without a full
        // re-scan (see the comment on `contents` above).
        contents.set(big.id, {
          hasActiveCatalyst: ca.hasActiveCatalyst || cb.hasActiveCatalyst,
          hasReplicator: ca.hasReplicator || cb.hasReplicator,
        });
        if (small.id === a.id) break; // a was absorbed — nothing left to pair it with this tick
      }
    }
  }

  /** Merges `absorbed` into `keep` — both membranes' full contents end up
   * in one combined vesicle. `keep` happens to be whichever one had more
   * lipids at the moment of contact (arbitrary as a matter of bookkeeping;
   * physically the two membranes contribute equally). */
  private mergeVesicles(keep: Vesicle, absorbed: Vesicle): void {
    for (const id of absorbed.memberIds) {
      const p = this.particles.get(id);
      if (p) p.vesicleId = keep.id;
      keep.memberIds.add(id);
    }
    keep.lipidIds.push(...absorbed.lipidIds);
    // The more evolved lineage's track record carries forward — same
    // inheritance principle already used for division (see divideVesicle's
    // comment above): a merged protocell's real molecular machinery is
    // whichever parent actually had it, not reset to zero because it
    // arrived by fusion instead of by growth.
    keep.replicationEvents = Math.max(keep.replicationEvents, absorbed.replicationEvents);
    keep.divisions = Math.max(keep.divisions, absorbed.divisions);
    // Reset the merge clock — see divisionCooldownTicks — so the newly
    // combined membrane gets its own settling period before it's eligible
    // to divide again, same as a freshly formed or freshly divided one.
    keep.createdTick = this.tick;
    // Recompute the merged membrane's centroid/radius now rather than
    // waiting for the next recruitAndDivideVesicles pass, so
    // detectBootstrap() sees accurate state in the same tick fusion happens.
    let cx = 0;
    let cy = 0;
    let n = 0;
    for (const id of keep.lipidIds) {
      const p = this.particles.get(id);
      if (!p) continue;
      cx += p.x;
      cy += p.y;
      n++;
    }
    if (n > 0) {
      keep.x = cx / n;
      keep.y = cy / n;
    }
    keep.radius = radiusForLipidCount(keep.lipidIds.length);
    this.vesicles.delete(absorbed.id);
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
  /** One real scan of a vesicle's current contents, shared by
   * detectBootstrap() and getBootstrapProgress() so "what does this
   * vesicle actually, currently hold" is computed one way in one place. */
  private scanVesicleContents(v: Vesicle): {
    hasActiveCatalyst: boolean;
    hasReplicator: boolean;
    peptides: PeptideParticle[];
    rnas: RnaParticle[];
  } {
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
    return { hasActiveCatalyst, hasReplicator, peptides, rnas };
  }

  private detectBootstrap(): void {
    for (const v of this.vesicles.values()) {
      const { hasActiveCatalyst, hasReplicator, peptides, rnas } = this.scanVesicleContents(v);
      if (isBootstrapEligible(v, hasActiveCatalyst, hasReplicator)) {
        const already = this.bootstrapCandidates.some((c) => c.vesicleId === v.id);
        if (!already) {
          this.bootstrapCandidates.push({
            vesicleId: v.id,
            tick: this.tick,
            x: v.x,
            y: v.y,
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
      totalReplicationEvents: this.totalReplicationEvents,
      bootstrapReady: this.bootstrapCandidates.length,
    };
  }

  /** The single vesicle currently ranked closest to bootstrap eligibility
   * — ranked first by whether it *currently* has a live catalyst +
   * replicator (what actually matters right now), then by real
   * historical replicationEvents, then divisions. Shared by
   * getBootstrapProgress() and estimateBootstrapChance() so both read
   * off the exact same notion of "leading". */
  private findLeadingVesicle(): { v: Vesicle; hasActiveCatalyst: boolean; hasReplicator: boolean } | null {
    let leading: { v: Vesicle; hasActiveCatalyst: boolean; hasReplicator: boolean } | null = null;
    let leadingScore = -Infinity;
    for (const v of this.vesicles.values()) {
      const { hasActiveCatalyst, hasReplicator } = this.scanVesicleContents(v);
      const score = (hasActiveCatalyst && hasReplicator ? 1_000_000 : 0) + v.replicationEvents * 1000 + v.divisions;
      if (score > leadingScore) {
        leadingScore = score;
        leading = { v, hasActiveCatalyst, hasReplicator };
      }
    }
    return leading;
  }

  /** Real, currently-observable progress toward a natural bootstrap — not
   * a prediction, just what's actually true about the dish right now.
   * The Chemistry tab's "closest to bootstrap" detail block reads this
   * directly. */
  getBootstrapProgress(): { vesicleCount: number; bootstrapReady: number; leading: BootstrapProgress | null } {
    const leading = this.findLeadingVesicle();
    return {
      vesicleCount: this.vesicles.size,
      bootstrapReady: this.bootstrapCandidates.length,
      leading: leading
        ? {
            hasActiveCatalyst: leading.hasActiveCatalyst,
            hasReplicatorNow: leading.hasReplicator,
            replicationEvents: leading.v.replicationEvents,
            divisionsSoFar: leading.v.divisions,
            lipidCount: leading.v.lipidIds.length,
          }
        : null,
    };
  }

  /** A cheap, always-live *heuristic* estimate of the odds this dish
   * produces a natural bootstrap within the next `horizonTicks` — this is
   * deliberately NOT a simulated probability. A real one would mean
   * actually cloning the dish and fast-forwarding many independent
   * trials (Monte Carlo), and headless timing this session put a single
   * 10,000-tick trial at ~10-15s — far too slow to recompute live every
   * tick, or even every few seconds. This instead reuses the exact real
   * formulas templatedReplication() itself rolls against (start-rate,
   * extension-rate, the same catalyst/ribozyme/in-vesicle boosts),
   * evaluated for whatever the actual leading vesicle's actual current
   * fold/catalyst state is, and projects forward with a Poisson
   * approximation for "at least K more completions in the next
   * `horizonTicks` ticks." Grounded in real numbers, but still a rough
   * approximation, not a validated probability — it ignores the
   * stall-timeout mechanic, assumes local substrate stays available, and
   * (see divisionReadiness below) treats "enough replication" and
   * "enough lipid growth" as independent when they aren't really. The
   * UI labels this as an estimate for exactly this reason — don't
   * present it as more precise than it is. */
  estimateBootstrapChance(horizonTicks = 10000): number {
    const leading = this.findLeadingVesicle();
    if (!leading || !leading.hasActiveCatalyst || !leading.hasReplicator) return 0;

    // The representative template: whichever RNA is actively mid-copy
    // (the most concrete evidence of live progress), else the longest
    // real replicator candidate currently inside.
    let template: RnaParticle | null = null;
    for (const id of leading.v.memberIds) {
      const p = this.particles.get(id);
      if (!p || p.kind !== 'rna' || p.sequence.length < MIN_TEMPLATE_LENGTH) continue;
      if (p.copying) {
        template = p;
        break;
      }
      if (!template || p.sequence.length > template.sequence.length) template = p;
    }
    if (!template) return 0;

    // Same formulas as templatedReplication()'s two real rolls (see
    // there for what each factor means) — not reinvented here.
    const selfBoost = template.fold.isRibozyme ? 1 + template.fold.catalysisStrength * this.catalystBoost : 1;
    const transBoost = this.nearbyCatalystBoost(template.x, template.y, 'replicase');
    const startRate = 0.003 * Math.max(selfBoost, transBoost) * this.inVesicleReplicationBoost;
    const extBoost =
      this.nearbyCatalystBoost(template.x, template.y, 'replicase') *
      (template.fold.isRibozyme ? 1 + template.fold.catalysisStrength * 4 : 1) *
      this.inVesicleReplicationBoost;
    const extensionRate = Math.min(0.9, 0.2 * extBoost);

    const basesRemaining = template.copying ? template.sequence.length - template.copying.built.length : template.sequence.length;
    const ticksToExtend = extensionRate > 0 ? basesRemaining / extensionRate : Infinity;
    const ticksToStart = template.copying ? 0 : startRate > 0 ? 1 / startRate : Infinity;
    const expectedTicksPerCompletion = ticksToStart + ticksToExtend;
    if (!Number.isFinite(expectedTicksPerCompletion) || expectedTicksPerCompletion <= 0) return 0;

    // Treat full-copy completions as a Poisson process at this rate —
    // P(>= K events in `horizonTicks`) = 1 - e^-lambda * sum_{i=0}^{K-1} lambda^i/i!
    const completionsPerTick = 1 / expectedTicksPerCompletion;
    const neededCompletions = Math.max(1, 2 - leading.v.replicationEvents);
    const lambda = completionsPerTick * horizonTicks;
    let cdf = 0;
    let term = Math.exp(-lambda);
    for (let i = 0; i < neededCompletions; i++) {
      cdf += term;
      term *= lambda / (i + 1);
    }
    const replicationChance = clamp(1 - cdf, 0, 1);

    // Division readiness: a coarse current-progress proxy (lipid count
    // vs. the real DIVISION_LIPID_COUNT bar), not a real rate-based
    // time-to-event projection — this engine doesn't track a specific
    // vesicle's lipid count history over time, so there's no real trend
    // to extrapolate from. Documented simplification, not hidden.
    const divisionReadiness = leading.v.divisions >= 1 ? 1 : clamp(leading.v.lipidIds.length / DIVISION_LIPID_COUNT, 0, 1);

    return clamp(replicationChance * divisionReadiness, 0, 1);
  }

  // --- save/restore ----------------------------------------------------
  // Particles are already plain, JSON-safe data (even the union's peptide/
  // rna variants — `fold`/`copying` are plain objects, no class instances,
  // no circular refs) — only the Maps and each Vesicle's `memberIds` Set
  // need flattening to arrays.
  serialize(): SerializedOrigin {
    return {
      width: this.width,
      height: this.height,
      tick: this.tick,
      rngState: this.rng.getState(),
      nextId: this.nextId,
      nextVesicleId: this.nextVesicleId,
      energyDebt: this.energyDebt,
      totalReplicationEvents: this.totalReplicationEvents,
      particles: [...this.particles.values()],
      vesicles: [...this.vesicles.values()].map((v) => ({ ...v, memberIds: [...v.memberIds] })),
      history: this.history,
      bootstrapCandidates: this.bootstrapCandidates,
      vent: this.vent,
      ventDebt: this.ventDebt,
      ventInjected: this.ventInjected,
    };
  }

  static deserialize(data: SerializedOrigin): Origin {
    const o = new Origin(data.width, data.height, 0);
    o.rng = Rng.fromState(data.rngState);
    o.tick = data.tick;
    o.nextId = data.nextId;
    o.nextVesicleId = data.nextVesicleId;
    o.energyDebt = data.energyDebt;
    o.totalReplicationEvents = data.totalReplicationEvents;
    for (const p of data.particles) o.particles.set(p.id, p);
    for (const v of data.vesicles) o.vesicles.set(v.id, { ...v, memberIds: new Set(v.memberIds) });
    o.history = data.history;
    o.bootstrapCandidates = data.bootstrapCandidates;
    // Overrides the constructor's own default vent — same reason rng
    // gets swapped in above rather than trusted from the constructor.
    o.vent = data.vent;
    o.ventDebt = data.ventDebt;
    o.ventInjected = data.ventInjected;
    return o;
  }
}

export interface SerializedOrigin {
  width: number;
  height: number;
  tick: number;
  rngState: number;
  nextId: number;
  nextVesicleId: number;
  energyDebt: number;
  totalReplicationEvents: number;
  particles: Particle[];
  vesicles: Array<Omit<Vesicle, 'memberIds'> & { memberIds: number[] }>;
  history: OriginStatsSnapshot[];
  bootstrapCandidates: BootstrapCandidate[];
  vent: { x: number; y: number } | null;
  ventDebt: number;
  ventInjected: { aa: number; nt: number; lipid: number };
}

export type { Lipid };
