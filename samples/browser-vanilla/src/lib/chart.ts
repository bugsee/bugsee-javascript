// A hand-rolled <canvas> price-history sparkline. Deliberately plain 2D canvas drawing (no chart
// library) — it is the S11 canvas-replay target (@bugsee/replay-canvas records this element's pixels
// at a fixed fps or 'all', and S8/S11 blockAllCanvas / .bugsee-show are exercised against it too).

export function drawSparkline(canvas: HTMLCanvasElement, values: number[], color = '#7ee2b8'): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);

  if (values.length === 0) return;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const padding = 8;
  const stepX = (width - padding * 2) / Math.max(1, values.length - 1);

  ctx.beginPath();
  values.forEach((v, i) => {
    const x = padding + i * stepX;
    const y = height - padding - ((v - min) / span) * (height - padding * 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Fill under the line for a "sparkline area chart" look.
  ctx.lineTo(width - padding, height - padding);
  ctx.lineTo(padding, height - padding);
  ctx.closePath();
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;

  // Latest-point dot.
  const lastX = padding + (values.length - 1) * stepX;
  const lastY = height - padding - ((values[values.length - 1] - min) / span) * (height - padding * 2);
  ctx.beginPath();
  ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}
