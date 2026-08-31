/** Range of a numeric series, by iteration rather than `Math.min(...arr)`.
 *
 * The spread form is not a style preference here, it is a crash: spreading an
 * array into a call passes one argument per element, and past a few tens of
 * thousands of them the engine throws RangeError. drawScatter is handed one
 * point per living organism every frame, and the population cap now accepts
 * 20,000 — with no try/catch around the frame loop, that throw would kill
 * requestAnimationFrame outright and freeze the whole app, dish included. */
function extent<T>(items: readonly T[], pick: (item: T) => number): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const item of items) {
    const v = pick(item);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/** Draws a minimal sparkline (line + soft fill) of `values` into `canvas`. */
export function drawSparkline(canvas: HTMLCanvasElement, values: readonly number[], colorHex: string): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const cssWidth = Math.max(1, Math.round(canvas.clientWidth));
  if (canvas.width !== cssWidth) canvas.width = cssWidth;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (values.length < 2) return;

  let { min, max } = extent(values, (v) => v);
  if (min === max) {
    min -= 1;
    max += 1;
  }

  const pad = 4;
  const stepX = (w - pad * 2) / (values.length - 1);
  const yOf = (v: number): number => h - pad - ((v - min) / (max - min)) * (h - pad * 2);

  ctx.beginPath();
  values.forEach((v, i) => {
    const x = pad + i * stepX;
    const y = yOf(v);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = colorHex;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.lineTo(pad + (values.length - 1) * stepX, h - pad);
  ctx.lineTo(pad, h - pad);
  ctx.closePath();
  ctx.fillStyle = `${colorHex}22`;
  ctx.fill();
}

export interface ScatterPoint {
  x: number;
  y: number;
  colorHsl: string; // e.g. "hsl(120, 65%, 50%)"
  ring?: boolean; // draw a highlight ring (player-designed individuals)
}

/**
 * Plots individual virtunisms as points, not an average — the only honest
 * way to show a population *splitting* into distinct morphs instead of
 * just drifting as one blob. A rolling average would hide a 50/50 split
 * into "big and armored" vs "small and fast" as one meaningless midpoint.
 */
export function drawScatter(
  canvas: HTMLCanvasElement,
  points: readonly ScatterPoint[],
  opts: { xLabel: string; yLabel: string; xZeroLine?: boolean; yZeroLine?: boolean },
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const cssWidth = Math.max(1, Math.round(canvas.clientWidth));
  if (canvas.width !== cssWidth) canvas.width = cssWidth;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const pad = 14;
  if (points.length === 0) return;

  const xs = extent(points, (p) => p.x);
  const ys = extent(points, (p) => p.y);
  let minX = xs.min;
  let maxX = xs.max;
  let minY = ys.min;
  let maxY = ys.max;
  // Always include zero in range for axes that have a meaningful zero
  // (e.g. a diet axis where 0 = no mouth/chloroplast lean either way).
  minX = Math.min(minX, 0);
  maxX = Math.max(maxX, 0.001);
  minY = Math.min(minY, 0);
  maxY = Math.max(maxY, 0.001);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const marginX = spanX * 0.1;
  const marginY = spanY * 0.1;
  minX -= marginX;
  maxX += marginX;
  minY -= marginY;
  maxY += marginY;

  const xOf = (v: number): number => pad + ((v - minX) / (maxX - minX)) * (w - pad * 2);
  const yOf = (v: number): number => h - pad - ((v - minY) / (maxY - minY)) * (h - pad * 2);

  // zero-lines — green-grey to match style.css's --text-dim token (canvas
  // can't read CSS custom properties, so it's mirrored here as a literal).
  ctx.strokeStyle = 'rgba(138, 154, 142, 0.25)';
  ctx.lineWidth = 1;
  if (opts.xZeroLine !== false) {
    ctx.beginPath();
    ctx.moveTo(xOf(0), pad);
    ctx.lineTo(xOf(0), h - pad);
    ctx.stroke();
  }
  if (opts.yZeroLine !== false) {
    ctx.beginPath();
    ctx.moveTo(pad, yOf(0));
    ctx.lineTo(w - pad, yOf(0));
    ctx.stroke();
  }

  for (const p of points) {
    const px = xOf(p.x);
    const py = yOf(p.y);
    ctx.beginPath();
    ctx.arc(px, py, p.ring ? 3 : 2.2, 0, Math.PI * 2);
    ctx.fillStyle = p.colorHsl;
    ctx.globalAlpha = 0.75;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (p.ring) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // axis labels
  ctx.fillStyle = 'rgba(138, 154, 142, 0.8)';
  ctx.font = '10px sans-serif';
  ctx.fillText(opts.xLabel, pad, h - 3);
  ctx.save();
  ctx.translate(10, h - pad);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(opts.yLabel, 0, 0);
  ctx.restore();
}

export interface RadarAxis {
  label: string;
  value: number; // real, unscaled — the chart normalizes against the largest value present
}

/**
 * A "stat star" — one axis per entry, plotted as a closed polygon from the
 * center. Built for a species' six real catalysis-class powers
 * (Genome.classPowerCache, averaged across its living members — see
 * World.getLivingSpecies), so the shape itself is a real capability
 * profile read off actual folded proteins (a predator-heavy lineage
 * genuinely spikes toward protease/motor), not an illustrative fake.
 * `hue` is a raw 0-360 value (species already carry one, see
 * SpeciesSummary.hue) rather than a pre-built color string, so the fill/
 * stroke/vertex colors can share one real number instead of three
 * string-parsing round trips.
 */
export function drawRadarChart(canvas: HTMLCanvasElement, axes: readonly RadarAxis[], hue: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const cssWidth = Math.max(1, Math.round(canvas.clientWidth));
  const cssHeight = Math.max(1, Math.round(canvas.clientHeight));
  if (canvas.width !== cssWidth) canvas.width = cssWidth;
  if (canvas.height !== cssHeight) canvas.height = cssHeight;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (axes.length < 3) return; // not a meaningful polygon below a triangle

  const cx = w / 2;
  const cy = h / 2;
  const labelPad = 40; // room for axis labels + their real value line around the rim
  const radius = Math.max(8, Math.min(w, h) / 2 - labelPad);
  const n = axes.length;
  const angleFor = (i: number): number => -Math.PI / 2 + (i / n) * Math.PI * 2; // start at top, clockwise
  // A real value of 0 across every axis (a lineage with no functional
  // proteins at all yet) shouldn't divide-by-zero into a degenerate
  // full-size star — floor the normalizer so an all-zero profile draws as
  // a real point at the center instead.
  const maxValue = Math.max(0.05, ...axes.map((a) => a.value));

  // Concentric rings, same neutral axis-line color the other charts here use.
  ctx.strokeStyle = 'rgba(138, 154, 142, 0.16)';
  ctx.lineWidth = 1;
  const rings = 4;
  for (let ring = 1; ring <= rings; ring++) {
    const rr = (radius * ring) / rings;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = angleFor(i % n);
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Spokes + axis labels.
  ctx.strokeStyle = 'rgba(138, 154, 142, 0.22)';
  ctx.fillStyle = 'rgba(138, 154, 142, 0.85)';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  axes.forEach((axis, i) => {
    const a = angleFor(i);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    ctx.stroke();
    const lx = cx + Math.cos(a) * (radius + 14);
    const ly = cy + Math.sin(a) * (radius + 14);
    ctx.fillStyle = 'rgba(138, 154, 142, 0.85)';
    ctx.font = '10px sans-serif';
    ctx.fillText(axis.label, lx, ly);
    // The real absolute number, not just the normalized shape — without
    // this, a lineage with a 0.1-power dabble in a class and one with a
    // 3.0-power specialization can draw the exact same-looking polygon
    // (each chart normalizes to its own biggest axis) and read as
    // identical at a glance. A plain 0 is real, useful information too —
    // "no gene folds into this at all" is a legitimate answer worth
    // showing, not hidden as an empty axis.
    ctx.fillStyle = 'rgba(138, 154, 142, 0.55)';
    ctx.font = '9px sans-serif';
    ctx.fillText(axis.value.toFixed(2), lx, ly + 11);
  });

  // The real data polygon.
  ctx.beginPath();
  axes.forEach((axis, i) => {
    const a = angleFor(i);
    const rr = (Math.min(axis.value, maxValue) / maxValue) * radius;
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = `hsla(${hue}, 65%, 55%, 0.28)`;
  ctx.fill();
  ctx.strokeStyle = `hsl(${hue}, 70%, 60%)`;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Vertex dots make each axis's real value legible even where the
  // polygon edge alone would be ambiguous (a value near zero is easy to
  // miss without one).
  axes.forEach((axis, i) => {
    const a = angleFor(i);
    const rr = (Math.min(axis.value, maxValue) / maxValue) * radius;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${hue}, 70%, 65%)`;
    ctx.fill();
  });
}
