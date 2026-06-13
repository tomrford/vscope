/**
 * Adapted from liveline (MIT): https://github.com/benjitaylor/liveline
 * Source commit: a913578832784bb6abdb148b6af9cf1739be2759
 */

import type { LivePoint } from "../types";

export const interpolateAtTime = (points: LivePoint[], time: number): number | null => {
  if (points.length === 0) return null;
  if (time <= points[0].time) return points[0].value;
  if (time >= points[points.length - 1].time) return points[points.length - 1].value;

  let lo = 0;
  let hi = points.length - 1;

  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].time <= time) lo = mid;
    else hi = mid;
  }

  const p1 = points[lo];
  const p2 = points[hi];
  const dt = p2.time - p1.time;
  if (dt <= 0) return p2.value;
  const t = (time - p1.time) / dt;
  return p1.value + (p2.value - p1.value) * t;
};
