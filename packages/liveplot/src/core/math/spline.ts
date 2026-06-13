/**
 * Adapted from liveline (MIT): https://github.com/benjitaylor/liveline
 * Source commit: a913578832784bb6abdb148b6af9cf1739be2759
 */

/**
 * Draw monotone cubic spline through points using Fritsch-Carlson tangents.
 */
export const drawSpline = (ctx: CanvasRenderingContext2D, pts: Array<[number, number]>): void => {
  if (pts.length < 2) return;
  if (pts.length === 2) {
    ctx.lineTo(pts[1][0], pts[1][1]);
    return;
  }

  const n = pts.length;
  const dx = Array.from({ length: n - 1 }, () => 0);
  const dy = Array.from({ length: n - 1 }, () => 0);
  const slopes = Array.from({ length: n - 1 }, () => 0);

  for (let i = 0; i < n - 1; i += 1) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    dy[i] = pts[i + 1][1] - pts[i][1];
    slopes[i] = dx[i] === 0 ? 0 : dy[i] / dx[i];
  }

  const tangents = Array.from({ length: n }, () => 0);
  tangents[0] = slopes[0];
  tangents[n - 1] = slopes[n - 2];

  for (let i = 1; i < n - 1; i += 1) {
    if (slopes[i - 1] * slopes[i] <= 0) {
      tangents[i] = 0;
      continue;
    }
    const w1 = 2 * dx[i] + dx[i - 1];
    const w2 = dx[i] + 2 * dx[i - 1];
    tangents[i] = (w1 + w2) / (w1 / slopes[i - 1] + w2 / slopes[i]);
  }

  for (let i = 0; i < n - 1; i += 1) {
    const x0 = pts[i][0];
    const y0 = pts[i][1];
    const x1 = pts[i + 1][0];
    const y1 = pts[i + 1][1];
    const h = x1 - x0;
    const m0 = tangents[i];
    const m1 = tangents[i + 1];

    const cp1x = x0 + h / 3;
    const cp1y = y0 + (m0 * h) / 3;
    const cp2x = x1 - h / 3;
    const cp2y = y1 - (m1 * h) / 3;

    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x1, y1);
  }
};
