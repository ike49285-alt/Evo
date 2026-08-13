/** Draws a minimal sparkline (line + soft fill) of `values` into `canvas`. */
export function drawSparkline(canvas, values, colorHex) {
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return;
    const cssWidth = Math.max(1, Math.round(canvas.clientWidth));
    if (canvas.width !== cssWidth)
        canvas.width = cssWidth;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (values.length < 2)
        return;
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
        min -= 1;
        max += 1;
    }
    const pad = 4;
    const stepX = (w - pad * 2) / (values.length - 1);
    const yOf = (v) => h - pad - ((v - min) / (max - min)) * (h - pad * 2);
    ctx.beginPath();
    values.forEach((v, i) => {
        const x = pad + i * stepX;
        const y = yOf(v);
        if (i === 0)
            ctx.moveTo(x, y);
        else
            ctx.lineTo(x, y);
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
/**
 * Plots individual virtunisms as points, not an average — the only honest
 * way to show a population *splitting* into distinct morphs instead of
 * just drifting as one blob. A rolling average would hide a 50/50 split
 * into "big and armored" vs "small and fast" as one meaningless midpoint.
 */
export function drawScatter(canvas, points, opts) {
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return;
    const cssWidth = Math.max(1, Math.round(canvas.clientWidth));
    if (canvas.width !== cssWidth)
        canvas.width = cssWidth;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const pad = 14;
    if (points.length === 0)
        return;
    let minX = Math.min(...points.map((p) => p.x));
    let maxX = Math.max(...points.map((p) => p.x));
    let minY = Math.min(...points.map((p) => p.y));
    let maxY = Math.max(...points.map((p) => p.y));
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
    const xOf = (v) => pad + ((v - minX) / (maxX - minX)) * (w - pad * 2);
    const yOf = (v) => h - pad - ((v - minY) / (maxY - minY)) * (h - pad * 2);
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
