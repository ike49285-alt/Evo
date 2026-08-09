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
