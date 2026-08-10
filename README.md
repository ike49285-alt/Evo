# Evo — a stable virtual ecosystem

A browser-based petri dish where **virtunisms** — virtual organisms, not a
simulation of any specific real biology — grow and adapt. You design a
virtunism's body from real organelles, release it into a shared dish, and
its descendants' bodies *and* brains evolve by mutation and natural
selection over generations. The design priority for this build is **runtime
stability**: the simulation is built on a spatial grid specifically so tick
cost stays consistent regardless of population size or how long the dish
has been running, not just a demo that happens to work for a few minutes.

## Why "virtunism"

Not "organism," not "cell" — a virtunism is its own thing: a virtual life
form that lives entirely in this dish, under these rules. The name is a
deliberate small distinction from the literal biology it's inspired by.

## How it works

- **Organelles (physical evolution):** a virtunism's body is a sized
  chassis with organelles mounted around the rim — **flagella** (speed &
  agility), **mouths** (eat plant matter, carrion, or smaller virtunisms),
  **chloroplasts** (passive energy from ambient light — the "plant" path),
  **eyes** (each one its own vision cone), and **armor** (harder to catch
  and eat). There's no "diet" label: what a virtunism eats falls out of
  what it's physically carrying. Every organelle has a real upkeep cost, so
  a loadout is a bet, not a free upgrade — mutation adds, removes, resizes,
  and repositions organelles generation over generation, and natural
  selection prunes what doesn't pay for itself.
- **Multicellularity:** give a species a **bud gland** and its offspring
  stay physically attached instead of drifting off, growing into a simple
  colony — a tree of bonded virtunisms that moves as one rigid body (every
  member's brain "votes" on thrust and turning, weighted by its own
  flagella) and shares energy across bonds by diffusion. Losing a member to
  a predator splits the colony rather than deleting it. The default "Wild
  Grazers" are bud-capable, so colonies form on their own from the moment
  you open the dish.
- **Brain (behavioral evolution):** every virtunism has a small neural
  network (15 sensor inputs → 10 hidden neurons → 2 outputs: turn, thrust)
  that decides how it moves in response to nearby food, threats, potential
  mates, its own energy, and dish walls. New virtunisms start with random
  weights; each offspring's weights are a mutated copy of its parent's (or,
  for sexual reproduction, a shuffled mix of both parents'). There's no
  training step — bad brains just fail to find food and die out, while
  brains that happen to steer toward food (or mates) reproduce more.
- **Reproduction — asexual, sexual, or budded:** asexual virtunisms
  reproduce solo once they cross an energy threshold; the child is a
  mutated clone. Sexual virtunisms need to find another mating-ready
  virtunism of the same lineage — the child's traits, organelles, and brain
  weights are each independently drawn from one parent or the other
  (crossover), then mutated. A virtunism with a bud gland buds an attached
  child instead — how colonies grow.
- **Ecosystem:** food regrows over time; carrion decays and is capped so it
  can't accumulate without bound over a long run. Energy drives movement,
  aging, and reproduction.
- **Ecosystem tab:** live counts of colonies vs. solo virtunisms, average
  colony size, reproduction-mode split, food levels, highest generation
  reached, and rolling charts of population and average traits.

The dish is pre-seeded with a colonial, photosynthetic "Wild Grazers"
population and a solitary, mobile "Wild Hunters" predator population.

## Performance architecture

This build exists specifically to make **consistent performance** — not
population survival, not feature count — the primary constraint, after an
earlier iteration of this project got fragile under long runs. Two things
make that a guarantee rather than a hope:

1. **Spatial grid (`src/sim/grid.ts`).** Every neighbor-style query in the
   sim — nearest food, nearest threat, nearest mate, eating/predation
   contact, sexual-mating pairing — used to be a linear scan over *every*
   other entity: O(n) per entity, O(n²) per tick. Entities are now bucketed
   by position in a uniform grid, rebuilt fresh every tick, so a query only
   touches the handful of buckets actually nearby. Tick cost tracks local
   density, not total population — verified to scale sub-quadratically well
   past the population cap (see `scaling.mjs`-style tests: ~6ms/tick at the
   320-virtunism cap, ~16ms at 640, not the ~24ms a quadratic system would
   show).
2. **Per-frame time budget (`src/main.ts`).** The game loop never spends
   more than ~18ms/frame running ticks, regardless of the chosen speed
   multiplier. If a frame's simulation work hits that budget partway
   through, it just stops early and picks up next frame — a busy tick
   degrades to a lower effective speed instead of freezing the tab. The
   live "Sim time/tick" HUD readout shows the actual cost so this isn't
   just a claim.

A secondary fix in the same spirit: carrion (dead-virtunism / predation
leftovers) used to have no cap and no decay, so a long-running dish would
quietly accumulate more and more of it, slowly growing every downstream
cost. It now decays after ~500 ticks and is hard-capped as a backstop.

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
- **Play/Pause**, **1×/2×/4×/8×** speed, **+ Food**, **Fit View**, **👁
  Vision** (toggle every virtunism's per-eye vision cones), **Reset Dish**.
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
    food.ts         plant/meat food items
    world.ts        the tick loop — grid-backed sensing, colony movement,
                    eating, predation, reproduction/budding, stats
  render/
    renderer.ts     Canvas2D — organelles, bond membranes, vision cones
  ui/
    chart.ts        sparkline helper
  main.ts           DOM wiring + the time-budgeted game loop
```

`sim/` has no DOM dependency, so it can be driven headlessly — useful for
both balance tuning and perf verification (see the constants at the top of
`world.ts` and `virtunism.metabolize()` for the energy economy).

## A note on tech choices

This was originally scoped for Phaser/PixiJS, but this build environment's
network policy blocks the npm registry and CDNs entirely (only git access
to this repo is allowed), so installing any package — including a game
engine — wasn't possible. Everything here is written against the browser's
native Canvas 2D API and vanilla TypeScript, compiled with the
`typescript` compiler preinstalled in this environment.
