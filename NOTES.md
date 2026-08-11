# Evo — working notes for whoever picks this up next

This supersedes the previous version of this file (a pre-rebuild wish list).
Everything below reflects what's actually built and verified as of branch
`claude/genome-driven-rebuild`, not aspiration. Where something is still
aspirational, it's labeled as such.

## What this is

A browser-based virtual ecosystem where every organism's **genome** drives
both its body plan (a chassis with mounted organelles) and its behavior (a
small neural net). Nothing about what an organism can do is hard-coded
outside what its genome encodes. The dish now starts as **primordial soup**
with zero seeded life — every organism has to spontaneously condense out of
chemistry, or the dish stays empty. That's a deliberate, load-bearing design
choice, not a placeholder.

Tech stack: vanilla TypeScript + Canvas2D, zero runtime dependencies.
**The npm registry is blocked in this build environment** (git-only
network access) — `tsc` is preinstalled and that's the whole toolchain.
Check whether that constraint still holds before reaching for a package.

## Repo / branch state

- Working branch: `claude/genome-driven-rebuild`, branched off the repo's
  actual default branch (`claude/cell-lab-evolution-simulator-nu6bbe` — not
  `main`; check `git remote show origin` if unsure). Pushed, not yet
  merged or PR'd.
- Everything described below is committed. `git log --oneline` tells the
  story in order: wipe → genome rebuild → plants-only → vacuole rename →
  carnivory back on → abiogenesis → colonies/separation → save/resume.

## Architecture (`src/`)

```
sim/
  types.ts       Vec2 + math helpers (dist, directionTo, clamp, wrapAngle)
  rng.ts         Rng — seeded PRNG (mulberry32), used everywhere for
                 reproducibility; nothing uses Math.random() except one
                 cosmetic initial-heading fallback in Organism's constructor
  nn.ts          The brain: fixed-topology feedforward net, 13 sensor
                 inputs -> 10 hidden -> 2 outputs (turn, thrust). forward(),
                 randomWeights(), mutateWeights(), crossoverWeights()
  genome.ts      THE CENTER OF THE SIM. OrganelleType = vacuole |
                 chloroplast | flagellum | eye | armor | bud.
                 ACTIVE_ORGANELLE_TYPES gates which types can currently be
                 expressed (currently = all of them; this is the "animals
                 on/off" toggle — see below). randomGenome/mutateGenome/
                 crossoverGenome (crossover exists but nothing calls it yet
                 — no sexual reproduction implemented). deriveStats() reads
                 a genome into every physical number (mass, upkeep, thrust,
                 vision, vacuoleRadius, budCapable, reproCost, ...).
                 genomeFromComposition() is the abiogenesis entry point —
                 builds a genome directly from a condensed protein cluster.
                 serializeGenome/deserializeGenome for save/resume (handles
                 the Float32Array-doesn't-survive-JSON problem).
  chemistry.ts   Abiogenesis particle sim: AminoAcid (7 flavors: structural,
                 regulatory, + whichever organelle types are active) drift,
                 bond into Protein (composition, not sequence), decay if
                 unconsumed, and condense into a genome when a local
                 cluster clears a mass threshold + has real structural
                 mass + wins a per-tick nucleation roll. No viability
                 check — a cluster with no income organelle just starves.
  grid.ts        SpatialGrid<T> — the one spatial-hash perf primitive
                 everything (organisms, carrion, amino acids, proteins)
                 uses for neighbor queries. Grid rebuilt fresh every tick.
  food.ts        Carrion — decays after ~500s (see units gotcha below),
                 hard-capped.
  organism.ts    Organism class: sense/think/act/metabolize, plus the
                 colony bond tree (parent/children, propagateColonyTransform,
                 bondChild, dissolveBonds) and the pendingPush* scratch
                 fields World's separation pass uses.
  world.ts       The tick loop. Owns: sunlight budget, chemistry tick,
                 sense/think/act (roots only — see colonies below),
                 separation, bond energy diffusion, ingestion, reproduction
                 (asexual, with budding as an alternate path), deaths,
                 carrion decay, stats, and serialize()/deserialize() for
                 save/resume.
render/
  renderer.ts    Canvas2D, reads World state, draws it, touches nothing.
                 Organelle colors, amino-acid/protein colors (same palette,
                 by dominant function), bond membrane lines, vision cones.
main.ts          DOM wiring, pan/zoom, the time-budgeted (~18ms/frame) game
                 loop, save/resume localStorage plumbing, HUD text.
scripts/serve.js Dependency-free static file server (needed because the
                 page loads ES modules, which file:// won't serve).
```

## The big design decisions, and why

**Genome drives everything, always.** Body plan (organelles) and brain
(NN weights) are one heritable unit. This was the very first requirement
and hasn't been compromised anywhere — even abiogenesis produces a real
genome via `genomeFromComposition`, not a special-cased "starter" object.

**Vacuole, not mouth.** Originally called "mouth"; renamed because eating
was always continuous rate-based energy transfer over contact time, not a
bite/kill — "vacuole" (engulf-and-digest) matches the actual mechanic
instead of implying combat that was never modeled. Purely a rename +
reflavor; `ABSORB_RATE`/`ABSORB_EFFICIENCY` in world.ts, same math as
before.

**Plants-only / carnivory toggle = one array.** `ACTIVE_ORGANELLE_TYPES`
in genome.ts is the single source of truth for which organelle types can
be expressed. Filtering `'vacuole'` out disables predation *and* stops the
primordial soup from ever synthesizing vacuole-flavored amino acids (the
gate cascades all the way down to chemistry.ts's `AMINO_FLAVORS`, which
derives from this same array). Currently the full set is active. Toggling
animals off again is a one-line `.filter()`.

**No seeded life — abiogenesis is the only origin path.** `World.seed()`
doesn't exist anymore. The dish opens as pure soup (amino acids drifting,
zero organisms). A run can go a long time — or forever — without a single
spark. That's the point, not a bug. `spawnFounder(genome, x?, y?)` is the
only way an organism comes to exist, called either by the condensation
pass or (with random position) by test/debug code. The old "+ Species"
button (direct genome injection) is gone — "+ Soup" only adds raw amino
acids, which still have to condense on their own.

**Colonies are a real bond, not an accident.** Earlier builds had
organisms clumping near their spawn point with no actual relationship
between them — that was recognized as *not* multicellularity (just
nothing pushing them apart) and fixed properly: any two organisms that
aren't in the same colony physically separate on overlap
(`World.resolveSeparation`), and a `bud` organelle makes an offspring bond
into a real colony instead — fixed relative position, energy diffusing
across every bond (`resolveBondDiffusion`), capped at `MAX_COLONY_SIZE`
(16). Only a colony's root actually runs sense/think/act; bonded members
still metabolize/photosynthesize/eat individually, they just don't drive.
This was also, unexpectedly, the fix for a real performance problem (see
Verified Facts below).

**Save/resume via localStorage, not a cookie.** User's first instinct was
"maybe a cookie" — wrong tool (4KB cap, sent with every request). Full
dish snapshots run up to ~1.25MB at population cap, need zero network
involvement. Autosaves every 5s + on tab-hide + on beforeunload; loads
automatically on startup if a save exists; Reset Dish clears it. Does
*not* preserve RNG internal state (resumed run's random sequence diverges
from the original) — traded off deliberately, not an oversight.

## Tunables cheat-sheet (all in world.ts unless noted)

- `MAX_POPULATION = 500`, `MAX_COLONY_SIZE = 16`
- `LIGHT_BUDGET_PER_AREA`, `REPRO_ENERGY_MULT`, `CHILD_ENERGY_SHARE` —
  energy economy
- `SEPARATION_STRENGTH`, `MAX_SEPARATION_PUSH`, `SEPARATION_QUERY_PAD` —
  colony/organism physical separation
- `BOND_DIFFUSION_RATE` — how fast energy equalizes across a bond
- chemistry.ts: `MAX_AMINO_ACIDS` (900), `MAX_PROTEINS` (260),
  `MIN_CONDENSATION_MASS` (40), `MIN_STRUCTURAL_MASS` (9),
  `CONDENSATION_CHANCE_PER_SEC` (0.045) — this last one is *the* knob for
  how often life sparks; current tuning puts first spark around ~100s sim
  time, verified across multiple seeds
- genome.ts: `MIN/MAX_CHASSIS_RADIUS`, `MIN/MAX_ORGANELLE_SIZE`,
  `DEFAULT_MUTATION_RATES`

## Verified facts (measured, not assumed — re-verify if you change the
## systems these numbers depend on)

- 25,000-tick headless run at full population: **2.57ms/tick average**,
  zero NaN positions/energy, zero negative energy, zero dangling bond
  references. (Pre-colonies this was ~9-12ms/tick — restricting
  sense/think/act to colony roots cut real cost, it wasn't just a
  side effect.)
- First abiogenesis spark: consistently ~100-103s sim time across
  independent seeds after tuning (started at "every ~0.5s," which was
  indistinguishable from direct seeding — had to be fixed).
- avgGeneration/highestGeneration climb noticeably faster with colonies
  than without (4.14/9 vs ~2/6 in comparable-length runs) — energy
  diffusion keeps more individuals alive long enough to reproduce.
- Save-file size: ~1.25MB JSON at population cap. Well inside
  localStorage's typical 5-10MB/origin limit.
- Pure-hunter (mouth/vacuole-only, no chloroplast) founders reliably lose
  out to chloroplast+vacuole omnivores over a few thousand ticks — matches
  the old project's "pure predators are the fragile strategy" finding.

## Gotchas discovered the hard way (don't re-discover these)

- **`Float32Array` does not survive `JSON.stringify` as an array** — it
  serializes as `{"0":1,"1":2,...}`. Always `Array.from()` it first (see
  `serializeGenome`).
- **`age` fields (Carrion, Protein) accumulate `dt` in seconds, not literal
  tick counts**, despite constant names like `CARRION_DECAY_TICKS` /
  `PROTEIN_DECAY_TICKS` implying otherwise. This is a pre-existing naming
  quirk in `CARRION_DECAY_TICKS` (500 *seconds*, ~8 min, left as-is —
  out of scope to rename everywhere) and was a real bug in the first
  abiogenesis pass (`PROTEIN_DECAY_TICKS` was set to 1100 *seconds* ≈ 18
  minutes — proteins effectively never decayed, which is why the first
  tuning pass sparked constantly). Fixed to 60. If you touch decay timing
  anywhere, check what unit `dt` actually is at that call site.
- **Nested-comment bug in generated bundles**: a JS block comment like
  `/* ...src/**/*.ts... */` self-closes early because `**/` contains `*/`.
  Bit the artifact-preview bundling step once. Watch for glob patterns
  inside `/* */` comments.
- **`tsconfig.json` needs `moduleResolution: "bundler"`**, not `"node"`
  (that's `node10`, deprecated and warns under current `tsc`).
- **Condensation must respect `MAX_POPULATION`** — the first abiogenesis
  implementation didn't check this and population grew past the cap
  (1348+ organisms observed) before it was caught and fixed.
- Module-level id counters (`nextOrganismId` in organism.ts,
  `nextFoodId` in food.ts, `nextParticleId` in chemistry.ts) all needed
  `setNextXId()` escape hatches for save/resume — a naive page reload
  would otherwise restart every counter at 1 and immediately collide with
  ids a resumed save is still using.

## Explicitly NOT built yet

- **Sexual reproduction.** `crossoverGenome()` exists in genome.ts and is
  fully functional but nothing in world.ts calls it — reproduction is
  100% asexual (mutated copy) right now, whether ejected or budded.
- **Tree of Life genealogy view.** Was in the pre-rebuild project, not
  reimplemented.
- **Ecosystem stats tab / charts.** Same — HUD is a single text line, no
  scatter plot or rolling charts yet.
- **Carrion recycling back into amino acids.** Would close the abiogenesis
  material loop (dead organisms → carrion → decays → back into soup
  instead of just vanishing). Discussed as a natural follow-on, not built.
- **Per-lineage population-share cap** (~65% ceiling from the old design,
  preventing one lineage from crowding out all others). Not reimplemented;
  only the global `MAX_POPULATION` cap exists.
- **A real body-plan Designer UI.** "+ Soup" just adds raw material now;
  there's no manual organelle-placement editor.
- **Exact RNG-state save/resume.** Resumed runs diverge from the original
  timeline (see save/resume section above) — deliberate scope cut, not
  forgotten.

## Workflow notes for whoever's continuing this

- **npm is blocked.** `npx tsc` works (preinstalled); anything requiring
  `npm install` won't. Re-verify this constraint before assuming it still
  holds — it was environment-specific, not a law of nature.
- **Local dev**: `npx tsc && node scripts/serve.js`, then hit
  `localhost:8080`. Playwright + headless Chromium are preinstalled at
  `/opt/pw-browsers/chromium`; the system-global Playwright package lives
  at `/opt/node22/lib/node_modules/playwright` — import via that absolute
  path (`node_modules/playwright` isn't in this repo).
- **Live preview artifact**: there's a standing published artifact at
  `https://claude.ai/code/artifact/debbf318-25f1-4584-b2c7-3ffb06c7d82e`
  that mirrors the current build. To update it: `npx tsc`, then
  concatenate `dist/**/*.js` in dependency order (types → rng → nn →
  genome → grid → food → chemistry → organism → world → renderer → main),
  stripping `import`/`export` keywords and `sourceMappingURL` comments,
  and inject the result into the existing preview HTML's second
  `<script>` block (see any earlier commit's process — it's been done
  ~5 times this way). Test locally via a headless-Chromium script
  (`file://` load, check zero console errors, check HUD text) before
  republishing. Always republish to the *same* file path so the URL
  stays stable.
- **Headless verification is the standard**, not optional: every
  significant change in this project's history was checked with a
  multi-thousand-tick headless run before being called done — crashes,
  NaN, population-cap violations, and pacing regressions all surfaced
  that way, not from eyeballing the canvas.
