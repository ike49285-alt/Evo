# Evo — Cell Evolution Sandbox

A browser-based sandbox inspired by *Cell Lab: Evolution Simulator*, built to
focus specifically on **watching evolution happen**: you design a cell's body
plan, release it into a shared petri dish, and its descendants' *brains*
evolve by mutation and natural selection over generations — no hand-tuning
required.

## How it works

- **Body plan (you design this):** diet (herbivore / omnivore / carnivore),
  reproduction mode (asexual or sexual), size, max speed, sense radius,
  vision angle ("eyes"), mouth size, lifespan, and color. Set in the
  *Designer* tab and locked in when you hit "Release into Dish".
- **Brain (evolution shapes this):** every cell has a small neural network
  (15 sensor inputs → 10 hidden neurons → 2 outputs: turn, thrust) that
  decides how it moves in response to nearby food, threats, potential mates,
  its own energy, and dish walls. New cells start with random weights; each
  offspring's weights are a mutated copy of its parent's (or, for sexual
  reproduction, a shuffled mix of both parents'). There's no training step —
  bad brains just fail to find food, starve before reproducing, and their
  lineage dies out, while brains that happen to steer toward food (or mates)
  reproduce more. That selection pressure, repeated over hundreds of
  generations, is the entire "AI."
- **Reproduction — asexual or sexual:** asexual cells reproduce solo once
  they cross an energy threshold; the child is a mutated clone. Sexual cells
  need to find another mating-ready cell of the same lineage — once they do,
  the child's traits and brain weights are each independently drawn from one
  parent or the other (crossover), then mutated on top. Sexual reproduction
  is slower and needs a healthier founding population (mates have to
  actually meet), but mixes two lineages' genes together rather than just
  drifting one lineage's — a real trade-off, not strictly better or worse.
- **Eyes and mouth:** `visionAngle` is a genuine field-of-view cone, not
  omnidirectional radar — a cell only senses food/threats/mates inside that
  cone, so narrow-eyed cells have to actually turn to look. Wider vision
  costs more upkeep. `mouthSize` scales how much energy a bite yields, how
  far a cell's effective reach is, and how large a prey item it can tackle
  relative to its own body — also at an upkeep cost. Turn on the **👁
  Vision** toggle in the top bar to see every cell's vision cone live.
- **Ecosystem:** herbivores eat plant food that regrows over time; carnivores
  and omnivores can also eat smaller cells (and the carrion left behind by
  any death). Energy drives movement, aging, and reproduction. Diet itself
  can rarely mutate too, so you may see a herbivore lineage spontaneously go
  omnivore.
- **Ecosystem tab:** live counts by diet and reproduction mode, food levels,
  highest generation reached, and rolling charts of population and average
  traits (size, speed, sense radius, vision angle, mouth size) so you can
  actually see the population's genome drifting over time.

The dish is pre-seeded with a wild (asexual) herbivore and carnivore
population so there's already an ecosystem before you add your own design —
your species competes, gets hunted, or hunts alongside them.

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
  cell's vision cone on/off), **Reset Dish** (clear everything and reseed
  the base ecosystem).
- Cells you personally release get a thin white outline so you can pick your
  lineage out of the crowd. Sexual-mode cells also get a small pale "nucleus"
  marker at their center; every cell has a small notch at its front — its
  mouth — sized by `mouthSize`.

## Project layout

```
src/
  sim/          engine-agnostic simulation: rng, neural net, genome/mutation,
                cell, food, world (the tick loop, sensing, eating,
                predation, reproduction, stats)
  render/       Canvas2D renderer + camera (pan/zoom)
  ui/           sparkline chart helper
  main.ts       wires DOM controls to the World + Renderer and runs the loop
```

`sim/` has no DOM dependency, so it can be driven headlessly (handy for
tuning balance — see the constants at the top of `world.ts` and
`cell.metabolize()` for the energy economy).

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
