# Evo — notes from the last attempt

Etch-a-sketch shake: the code's gone, but the idea was close enough to worth
keeping. Distilled from the old README so the next attempt doesn't start
from zero.

## The core idea

A browser-based digital terrarium of **virtunisms** — virtual organisms
(not a simulation of specific real biology) that grow and adapt. You design
a virtunism's body from organelles, release it into a shared dish, and its
descendants' bodies *and* brains evolve by mutation and natural selection
over generations.

**Closed loop, no food dispenser.** The only energy entering the dish from
outside is sunlight (plus you dropping in a new species). Everything a
mouthed virtunism eats has to trace back to something in the dish already —
hunting or scavenging. If a lineage can't make that work, it starves.
Nothing steps in to save it.

## Mechanics worth keeping

- **Sunlight as the only external input**, drawn via chloroplast organelles,
  but shared across a finite dish-wide budget — this is what gives
  photosynthesizers a real population ceiling instead of unbounded growth.
- **Organelle-based physical evolution:** a sized chassis with mounted
  organelles — flagella (speed/agility), mouths (eat carrion or
  smaller/weaker virtunisms), chloroplasts (sunlight), eyes (vision cones),
  armor (defense). Each has upkeep cost; mutation adds/removes/resizes/
  repositions organelles each generation.
- **Multicellularity via a bud gland:** offspring stay attached instead of
  drifting off, forming a colony that moves as one rigid body and shares
  energy across bonds by diffusion.
- **Brain as a small neural net:** ~15 sensor inputs → 10 hidden neurons →
  2 outputs (turn, thrust). Offspring inherit a mutated copy of parent
  weights (or a crossover mix for sexual reproduction). Bad brains just
  fail to find food and die out.
- **Three reproduction modes:** asexual (solo past an energy threshold),
  sexual (find a same-lineage mate, crossover), budded (grows an attached
  colony instead of ejecting a child).
- **Carrying capacity, twice over:** (1) shared sunlight budget scales
  everyone's income down together when oversubscribed; (2) no single
  lineage can occupy more than ~65% of the population cap, so a
  fast-growing photosynthesizer population can't structurally starve a
  slower predator population of room to reproduce.
- **No hard-coded species tiers.** Diet, size, speed, defense are all just
  organelle counts/sizes. Starting population was 16 pure-photosynthesizer
  "Dandelions" and 12 mouth-only "Rabbits" — just starting names, not
  templates. Whatever emerges generations later (tree-like armored
  photosynthesizers, wolf-like or vulture-like predator descendants) is
  meant to be a genuine evolutionary outcome, not a scripted switch.
- **Tree of Life view:** genealogy of every virtunism that's ever lived —
  dots as individuals, lines as parent→child, click to trace ancestry.
  Pruned so it stays bounded by current population + branch points, not by
  total ticks run (dead individuals with no living descendants get
  forgotten; unbranched dead waypoints get spliced out).
- **Ecosystem tab:** live counts (colonies vs. solo, avg colony size,
  reproduction-mode split, carrion levels, highest generation), a morph
  scatter plot (size vs. chloroplast/mouth diet lean), rolling charts of
  population and average traits.

## What was actually verified last time (be honest about this again)

- Trait divergence was real and observed in 30,000+ tick headless runs —
  Dandelion size range widened ~3×, and a subset spontaneously grew mouth
  organelles through pure mutation with no environmental push.
- The predator lineage established in most but not all runs (~67% across
  15 seeds) — the rest collapsed to extinction. That failure rate is a
  feature of the design (real starvation), not a bug to tune away.
- A full multi-tier food web (distinct scavenger tier, several coexisting
  body plans) was never directly witnessed end-to-end — mechanically
  plausible but unconfirmed. Don't claim it as done until it's actually
  seen.

## Performance lessons to reapply

- Spatial hash grid for every neighbor query (nearest food/threat/mate,
  eating/predation contact, mating pairing) — rebuilt every tick, keeps
  tick cost tracking local density instead of total population.
- Hard per-frame time budget (~18ms/tick) in the game loop so a busy tick
  degrades speed instead of freezing the tab.
- Carrion decay (~500 ticks) and a hard cap, so dead-body cleanup can't
  quietly grow into an unbounded cost over a long run.
- Prune ancestry/tree data the same way real coalescent trees collapse —
  don't let "log every birth forever" grow linearly with total ticks.

## Tech constraint from last time

Original build environment blocked the npm registry/CDNs (git-only
access), which is why it ended up as vanilla TypeScript + Canvas 2D instead
of Phaser/PixiJS. Worth checking whether that constraint still applies
before re-choosing the stack.
