/**
 * Adapted from liveline (MIT): https://github.com/benjitaylor/liveline
 * Source commit: a913578832784bb6abdb148b6af9cf1739be2759
 * Local changes: multiseries range aggregation.
 */

import type { LivePoint, LiveSeries } from "../types";

const MIN_RANGE = 1e-3;

export const computeSeriesRange = (points: LivePoint[]): { min: number; max: number } => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const p of points) {
    if (!Number.isFinite(p.value)) continue;
    if (p.value < min) min = p.value;
    if (p.value > max) max = p.value;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: -1, max: 1 };
  }

  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.03, 0.5);
    return { min: min - pad, max: max + pad };
  }

  const pad = (max - min) * 0.12;
  return { min: min - pad, max: max + pad };
};

export const computeMultiRange = (
  visibleSeries: Array<{ series: LiveSeries; points: LivePoint[] }>,
): { min: number; max: number; range: number } => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const entry of visibleSeries) {
    const local = computeSeriesRange(entry.points);
    if (local.min < min) min = local.min;
    if (local.max > max) max = local.max;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = -1;
    max = 1;
  }

  const range = Math.max(max - min, MIN_RANGE);
  return { min, max, range };
};
