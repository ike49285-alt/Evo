# Evo — Cell Evolution Sandbox

A browser-based sandbox inspired by *Cell Lab: Evolution Simulator*, built to
focus specifically on **watching evolution happen** — physically and
behaviorally. You design a cell's body from real organelles, release it into
a shared petri dish, and its descendants' bodies *and* brains evolve by
mutation and natural selection over generations. No hand-tuning required.

## How it works

- **Organelles (physical evolution):** a cell's body is a sized chassis with
  organelles mounted around the rim — **flagella** (speed & agility),
  **mouths** (eat plant matter, carrion, or smaller cells), **chloroplasts**
  (passive energy from ambient light — the "plant" path), **eyes** (each one
  its own vision cone), and **armor** (harder to catch and eat). There's no
  "diet" label: what a cell eats falls out of what it's physically carrying.
  A cell can be pure photosynthesizer, pure predator, both, or neither (and
  starve). Every organelle has a real upkeep cost, so a loadout is a bet, not
  a free upgrade — mutation adds, removes, resizes, and repositions
  organelles generation over generation, and natural selection prunes what
  doesn't pay for itself.
- **Multicellularity:** give a species a **bud gland** and its offspring stay
  physically attached instead of drifting off, growing into a simple colony
  — a tree of bonded cells that moves as one rigid body (every member's brain
  "votes" on thrust and turning, weighted by its own flagella) and shares
  energy across bonds by diffusion, so a flagella-heavy propulsion cell can
  survive on income harvested by a photosynthetic neighbor. Losing a member
  to a predator splits the colony rather than deleting it — the rest carries
  on as one or more independent colonies. The default "Wild Grazers" are
  bud-capable, so colonies form on their own from the moment you open the
  dish.
- **Brain (behavioral evolution):** every cell has a small neural network
  (15 sensor inputs → 10 hidden neurons → 2 outputs: turn, thrust) that
  decides how it moves in response to nearby food, threats, potential mates,
  its own energy, and dish walls. New cells start with random weights; each
  offspring's weights are a mutated copy of its parent's (or, for sexual
  reproduction, a shuffled mix of both parents'). There's no training step —
  bad brains just fail to find food, starve before reproducing, and their
  lineage dies out, while brains that happen to steer toward food (or mates)
  reproduce more.
- **Reproduction — asexual, sexual, or budded:** asexual cells reproduce solo
  once they cross an energy threshold; the child is a mutated clone. Sexual
  cells need to find another mating-ready cell of the same lineage — once
  they do, the child's traits, organelles, and brain weights are each
  independently drawn from one parent or the other (crossover), then
  mutated. A cell with a bud gland buds an attached child instead of ejecting
  one — how colonies grow. Sexual and budded reproduction are both slower
  than solo asexual and need a healthier founding population, but each buys
  something asexual cloning can't: sexual mixes two lineages' genes;
  budding builds a cooperating multicellular body.
- **Ecosystem:** food regrows over time; any cell with a mouth can eat plant
  matter, carrion, or a smaller cell (including armor and mouth-investment
  trade-offs on both sides of a predation attempt). Energy drives movement,
  aging, and reproduction.
- **Ecosystem tab:** live counts of colonies vs. solo cells, average colony
  size, reproduction mode split, food levels, highest generation reached, and
  rolling charts of population and average traits (chassis size, derived max
  speed, sense radius, flagella, chloroplasts) so you can watch the
  population's physical genome drifting over time.

The dish is pre-seeded with a colonial, photosynthetic "Wild Grazers"
population and a solitary, mobile "Wild Hunters" predator population, so
there's already an ecosystem — plant-like colonies being hunted by mobile
animal-like cells — before you add your own design.

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
- **Play/Pause**, **1×/2×/4×/8×** speed, **+ Food** (sprinkle a burst of
  plant food), **Fit View** (recenter camera), **👁 Vision** (toggle every
  cell's per-eye vision cones on/off), **Reset Dish** (clear everything and
  reseed the base ecosystem).
- Cells you personally release get a thin white outline so you can pick your
  lineage out of the crowd. Sexual-mode cells get a small pale "nucleus"
  marker; thin lines between cells are bond membranes — that's a colony.

## Project layout

```
src/
  sim/          engine-agnostic simulation: rng, neural net, genome/mutation
                (organelles + traits), cell (incl. bond-tree state), food,
                world (the tick loop — sensing, colony movement, eating,
                predation, reproduction/budding, colony energy diffusion,
                stats)
  render/       Canvas2D renderer — draws organelles, bond membranes,
                vision cones + camera (pan/zoom)
  ui/           sparkline chart helper
  main.ts       wires DOM controls (incl. the organelle loadout builder) to
                the World + Renderer and runs the loop
```

`sim/` has no DOM dependency, so it can be driven headlessly (handy for
tuning balance — see the constants at the top of `world.ts` and
`cell.metabolize()` for the energy economy, and `genome.ts` for organelle
costs/limits).

## A note on tech choices

This was originally scoped for Phaser/PixiJS, but this build environment's
network policy blocks the npm registry and CDNs entirely (only git access to
this repo is allowed), so installing any package — including a game engine —
wasn't possible. Everything here is written against the browser's native
Canvas 2D API and vanilla TypeScript instead, compiled with the `typescript`
compiler that's preinstalled in this environment. Functionally this gets you
the same result for a top-down 2D sandbox like this; if you later want
Phaser/Pixi for sprite animation or bigger population counts, the renderer
is isolated in `src/render/renderer.ts` and `World` doesn't know it exists,
so swapping it out shouldn't touch the simulation code.
