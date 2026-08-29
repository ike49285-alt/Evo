#!/usr/bin/env node
/**
 * Bundles Evo into ONE self-contained HTML file, for publishing as a Claude
 * Artifact (which is a single document with no way to fetch sibling files —
 * no network, and blob/data-URL module tricks are blocked by its CSP).
 *
 * Previous sessions did this with throwaway scripts kept in a scratchpad and
 * never committed, which meant re-deriving the whole thing every time. This
 * lives in the repo instead.
 *
 * Approach: let `tsc` do the module bundling rather than hand-rolling it.
 * Concatenating dist/*.js and stripping import/export is the fragile route —
 * 21 modules share one scope, so any two top-level names that collide break
 * it silently, and it has to special-case re-export edges (sim/types.ts
 * re-exports from chem/polymer.ts while chem/origin.ts imports back out of
 * sim/). `--module system --outFile` emits every module as a
 * System.register() call with its OWN scope, so collisions are structurally
 * impossible and the setters/execute split handles dependency order.
 *
 * All that is missing is a loader, and it is ~40 lines with no dependency
 * (see SYSTEM_SHIM below).
 *
 * Caveat worth tracking: `outFile` and `module=system` are deprecated in
 * TypeScript 6 and stop working in 7, hence --ignoreDeprecations. When that
 * lands this needs a real bundler, or the shim needs to consume plain ESM.
 *
 *   node tools/build-artifact.mjs [outfile]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] ?? join(ROOT, 'evo-artifact.html'));

/** A minimal SystemJS-format loader.
 *
 * Deliberately not the real SystemJS (external script, blocked by the
 * Artifact CSP). It implements only what tsc's output actually uses:
 * register / setters / execute, plus the two shapes of the `exports`
 * callback tsc emits — exports("name", value) and exports({a, b}).
 *
 * Order matters and is the whole job. Every module is declared first, then
 * setters are wired so each module holds a live reference to its
 * dependencies' export objects, and only then is anything executed —
 * dependencies before dependents. Executing in registration order instead
 * would leave a module reading `dep_1.Thing` before dep's execute() had
 * assigned it. */
const SYSTEM_SHIM = `
(function () {
  var registry = Object.create(null);
  var instances = Object.create(null);

  window.System = {
    register: function (name, deps, declare) {
      registry[name] = { deps: deps, declare: declare };
    },
  };

  function instantiate(name) {
    if (instances[name]) return instances[name];
    var entry = registry[name];
    if (!entry) throw new Error('Evo bundle: module not found: ' + name);
    var inst = (instances[name] = {
      exports: {},
      deps: entry.deps,
      setters: [],
      execute: null,
      executed: false,
    });
    // The same exports object is handed to every dependent's setter, so
    // assignments made later (inside execute) are visible through it --
    // that is what stands in for ES module live bindings here.
    var declared = entry.declare(function (nameOrObj, value) {
      if (typeof nameOrObj === 'object' && nameOrObj !== null) {
        for (var k in nameOrObj) inst.exports[k] = nameOrObj[k];
        return nameOrObj;
      }
      inst.exports[nameOrObj] = value;
      return value;
    }, { id: name });
    inst.setters = declared.setters || [];
    inst.execute = declared.execute || null;
    return inst;
  }

  var executing = Object.create(null);
  function execute(name) {
    var inst = instances[name];
    if (inst.executed || executing[name]) return;  // executing[] guards cycles
    executing[name] = true;
    for (var i = 0; i < inst.deps.length; i++) execute(inst.deps[i]);
    inst.executed = true;
    if (inst.execute) inst.execute();
  }

  window.__evoBoot = function () {
    var names = Object.keys(registry);
    names.forEach(instantiate);
    names.forEach(function (name) {
      var inst = instances[name];
      for (var i = 0; i < inst.deps.length; i++) {
        if (inst.setters[i]) inst.setters[i](instantiate(inst.deps[i]).exports);
      }
    });
    names.forEach(execute);
  };
})();
`.trim();

// --- 1. bundle every module into one SystemJS file ------------------------
const tmp = mkdtempSync(join(tmpdir(), 'evo-artifact-'));
const bundlePath = join(tmp, 'evo.system.js');
let bundle;
try {
  execFileSync(
    'tsc',
    [
      '--ignoreConfig',
      '--ignoreDeprecations', '6.0',
      '--module', 'system',
      '--outFile', bundlePath,
      '--target', 'es2020',
      '--lib', 'es2020,dom',
      '--strict',
      '--skipLibCheck',
      join(ROOT, 'src/main.ts'),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  bundle = readFileSync(bundlePath, 'utf8');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const moduleCount = (bundle.match(/^System\.register\(/gm) || []).length;
if (moduleCount < 20) {
  throw new Error(`Evo build: expected ~21 registered modules, got ${moduleCount}`);
}

// --- 2. the page's own CSS and markup -------------------------------------
const css = readFileSync(join(ROOT, 'style.css'), 'utf8');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
if (!bodyMatch) throw new Error('Evo build: could not find <body> in index.html');

// Drop the module script tag; its code is inlined below instead.
const markup = bodyMatch[1].replace(/\s*<script\b[^>]*><\/script>/g, '').trim();
if (/<script/i.test(markup)) throw new Error('Evo build: an unexpected script tag survived');

// A literal </script> anywhere in the JS would end the inline block early.
const safeBundle = bundle.replace(/<\/script/gi, '<\\/script');

// --- 3. assemble ----------------------------------------------------------
// No doctype/html/head/body: the Artifact wrapper supplies those.
//
// The script goes LAST and is a plain classic script. index.html could use
// <script type="module" src>, which defers automatically -- that is why the
// app's ~40 module-scope el() lookups find their elements. An inline classic
// script does not defer, so placing it anywhere above the markup would throw
// on the first lookup.
const out = `<title>Evo</title>
<style>
${css.trim()}
</style>

${markup}

<script>
${SYSTEM_SHIM}
${safeBundle.trim()}
window.__evoBoot();
</script>
`;

writeFileSync(OUT, out, 'utf8');
console.log(
  `Evo artifact -> ${OUT}\n` +
  `  ${moduleCount} modules bundled\n` +
  `  ${(Buffer.byteLength(out) / 1024).toFixed(1)} KB total`,
);
