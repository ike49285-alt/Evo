# Evo — a stable virtual ecosystem

A browser-based digital terrarium where **virtunisms** — virtual organisms,
not a simulation of any specific real biology — grow and adapt. You design
a virtunism's body from real organelles, release it into a shared dish, and
its descendants' bodies *and* brains evolve by mutation and natural
selection over generations.

**This is a closed loop.** There is no food dispenser. The only energy this
dish generates from nothing is sunlight, and the only thing that reaches it
from outside is you dropping in a new species. Everything else — every
calorie a mouthed virtunism ever spends — has to come from the dish itself:
hunting something photosynthetic or smaller, or scavenging what's already
dead. If a lineage can't make that work, it starves, same as it would in a
real terrarium. Nothing steps in to save it.

## Why "virtunism"

Not "organism," not "cell" — a virtunism is its own thing: a virtual life
form that lives entirely in this dish, under these rules. The name is a
deliberate small distinction from the literal biology it's inspired by.

## How it works

- **Sunlight is the only external input.** Chloroplast organelles draw
  energy directly from ambient light — no pellets, no puck-dropping. But
  sunlight is a *shared, finite budget* for the whole dish (see
  "Carrying capacity" below), not a per-virtunism freebie: it's what gives
  photosynthesizers an actual population ceiling instead of growing to
  fill every open slot in the dish.
- **Organelles (physical evolution):** a virtunism's body is a sized
  chassis with organelles mounted around the rim — **flagella** (speed &
  agility), **mouths** (eat carrion or smaller/weaker virtunisms —
  including photosynthesizers), **chloroplasts** (the sunlight path),
  **eyes** (each one its own vision cone), and **armor** (harder to catch).
  Every organelle has a real upkeep cost, so a loadout is a bet, not a free
  upgrade — mutation adds, removes, resizes, and repositions organelles
  generation over generation, and natural selection prunes what doesn't pay
  for itself.
- **Multicellularity:** a **bud gland** makes a lineage's offspring stay
  physically attached instead of drifting off, growing into a simple colony
  — a tree of bonded virtunisms that moves as one rigid body and shares
  energy across bonds by diffusion. The default "Wild Grazers" are
  bud-capable, so colonies form on their own from the moment you open the
  dish.
- **Brain (behavioral evolution):** every virtunism has a small neural
  network (15 sensor inputs → 10 hidden neurons → 2 outputs: turn, thrust).
  New virtunisms start with random weights; each offspring's weights are a
  mutated copy of its parent's (or a shuffled mix of both parents', for
  sexual reproduction). Bad brains just fail to find food and die out.
- **Reproduction — asexual, sexual, or budded:** asexual virtunisms
  reproduce solo past an energy threshold; sexual ones need to find another
  mating-ready virtunism of the same lineage and cross over; budding grows
  an attached colony instead of ejecting a child.
- **Carrying capacity, twice over:**
  1. *Sunlight budget.* Total photosynthetic demand across the whole dish
     competes for one shared light budget — over budget, everyone's income
     scales down together. This is what gives a pure-sunlight species an
     actual population ceiling well short of "every slot in the dish,"
     the same way real plants compete for light and nutrients.
  2. *Per-lineage population share.* No single lineage — however
     successful — can occupy more than ~65% of the total population cap.
     Without this, a fast-growing photosynthesizer population would
     structurally starve a slower-growing predator population of the room
     to ever reproduce, even when the predator is perfectly capable of
     feeding itself.
- **Ecosystem tab:** live counts of colonies vs. solo virtunisms, average
  colony size, reproduction-mode split, carrion levels, highest generation
  reached, a live **morph scatter plot** (every virtunism plotted as one
  dot — size vs. chloroplast/mouth diet lean, colored by hue), and rolling
  charts of population and average traits.
- **Tree of Life drawer** (bottom of the screen): every virtunism that's
  ever lived, drawn as a genealogy — dots are individuals, lines trace
  parent → child, time runs left to right. Click a dot to trace its full
  ancestry back to a founder and, if it's still alive, find it highlighted
  in the dish. This isn't a full history log: a branch is only kept around
  as long as something alive still traces back through it, so the view
  stays bounded by current population + branch points, not by how long
  the dish has been running (verified flat over 60,000+ ticks — see
  "Performance architecture" below).

## What actually happens

The dish is pre-seeded with a small starting population — 16
"Dandelions" (pure photosynthesizers, no mouth at all — sunlight is their
*only* possible income) and 12 "Rabbits" (a mouth, no chloroplasts — every
calorie has to come from hunting Dandelions or scavenging carrion). Those
are just starting names, not hard-coded species: there is no separate
"predator" or "scavenger" or "tree" template anywhere in the code. Diet,
size, speed, and defense are all just organelle counts and sizes, and
organelle loadouts mutate freely and without limit every generation — so
whatever shows up ten thousand generations later, whether that's a
photosynthesizer that's grown into something tree-like and armored, or a
Rabbit-descendant that's grown into something wolf-like or vulture-like, is
a genuine evolutionary outcome, not a switch I flipped.

Here's what's actually been verified, honestly, not just hoped for:
- **Trait divergence is real and observed**, not theoretical. In 30,000+
  tick headless runs, the Dandelion population's size range visibly widens
  — roughly 3× over the run — and a subset of that "plant" lineage
  spontaneously acquires mouth organelles through pure mutation, with no
  environmental pressure pushing it there. That's the mechanism the
  trees/wolves/vultures idea depends on, and it's genuinely firing.
- **The predator lineage establishes in most, not all, runs.** Across a
  batch of 15 random seeds, Rabbits survived long enough to hold a stable
  population in 10 (~67%). The other 5 collapsed to extinction — sometimes
  quickly, sometimes (as with any predator-prey system) after a real boom
  that later busts. That failure rate is reported here rather than tuned
  away, because "if animals starve, they starve" was an explicit design
  choice, not a bug to chase out.
- **A full multi-tier food web — a distinct scavenger tier specializing on
  carrion, several visibly different body plans coexisting at once — was
  not directly witnessed end-to-end in this session's testing window.**
  The mechanics support it (nothing caps how far a lineage can diverge, and
  carrion-scavenging is already a fully viable strategy for any mouthed
  virtunism), but confirming it needs longer runs and more seeds than this
  session had time for. Consider this an open, honestly-unresolved
  question rather than a promised outcome.

If a run collapses further than you'd like, **Reset Dish** reseeds it, and
the Designer is always there to drop in something new.

## Performance architecture

Consistent runtime performance — not population survival, not feature
count — is this build's primary constraint, after an earlier iteration of
this project got fragile under long runs. Two things make that a guarantee
rather than a hope:

1. **Spatial grid (`src/sim/grid.ts`).** Every neighbor-style query in the
   sim — nearest food, nearest threat, nearest mate, eating/predation
   contact, sexual-mating pairing — is bucketed by position and rebuilt
   fresh every tick, so a query only touches nearby buckets instead of
   scanning the whole population. Tick cost tracks local density, not total
   population — verified to scale sub-quadratically well past the
   population cap.
2. **Per-frame time budget (`src/main.ts`).** The game loop never spends
   more than ~18ms/frame running ticks, regardless of the chosen speed
   multiplier. A busy tick degrades to a lower effective speed instead of
   freezing the tab. The live "Sim time/tick" HUD readout shows the actual
   cost.

Carrion (dead-virtunism / predation leftovers) decays after ~500 ticks and
is hard-capped, so a long-running dish can't quietly accumulate an
unbounded amount of it and slow every downstream cost.

The Tree of Life's ancestry data (`World.treeNodes`) gets the same
treatment for the same reason: a naive "log every birth forever" design
would grow linearly with total ticks run, not population — a slow leak
that wouldn't show up in a short test. Instead a dead individual is
forgotten the instant nothing alive still traces through it, *and*
unbranched dead "waypoints" (a dead individual with exactly one surviving
line of descent) get spliced out of the tree rather than kept forever —
the same collapsing a real coalescent/pedigree tree does. Verified against
a 60,000-tick run at a stable population: node count climbs briefly as the
population's first generations spread out, then plateaus and stays flat
for the rest of the run instead of climbing with tick count.

## Running it locally

No install step is required — there are no runtime dependencies.

```sh
npm run build   # compiles src/**/*.ts -> dist/**/*.js with tsc
npm run serve   # serves the folder at http://localhost:8080 (needs a real
                 # HTTP server because the page loads ES modules)
```

Then open `http://localhost:8080`. `npm run watch` recompiles on save while
you iterate.

## Controls

- **Drag** the dish to pan, **scroll** to zoom.
- **Play/Pause**, **1×/2×/4×/8×** speed, **Fit View**, **👁 Vision** (toggle
  every virtunism's per-eye vision cones), **Reset Dish**.
- Virtunisms you personally release get a thin white outline. Sexual-mode
  virtunisms get a small pale "nucleus" marker; thin lines between
  virtunisms are bond membranes — that's a colony.

## Project layout

```
src/
  sim/
    grid.ts        spatial hash grid — the core perf primitive
    rng.ts          seeded PRNG
    nn.ts           the brain (tiny feedforward net, evolves by mutation)
    genome.ts       organelle model, mutation, crossover, derived stats
    virtunism.ts    the entity: movement, metabolism, reproduction, bonds
    food.ts         carrion — the only discrete food item
    world.ts        the tick loop — sunlight budget, grid-backed sensing,
                    colony movement, eating, predation, reproduction,
                    per-lineage population share, stats
  render/
    renderer.ts     Canvas2D — organelles, bond membranes, vision cones
  ui/
    chart.ts        sparkline + per-virtunism morph scatter plot
  main.ts           DOM wiring + the time-budgeted game loop
```

`sim/` has no DOM dependency, so it can be driven headlessly — useful for
both balance tuning and perf verification (see the constants at the top of
`world.ts` and `virtunism.metabolize()`/`photosynthesize()` for the energy
economy).

## A note on tech choices

This was originally scoped for Phaser/PixiJS, but this build environment's
network policy blocks the npm registry and CDNs entirely (only git access
to this repo is allowed), so installing any package — including a game
engine — wasn't possible. Everything here is written against the browser's
native Canvas 2D API and vanilla TypeScript, compiled with the
`typescript` compiler preinstalled in this environment.
