import type { TimeDomain } from "../types";

// Pan/zoom never yields a window narrower than this fraction of the bounds.
const MIN_SPAN_RATIO = 1e-4;

/** Clamps a proposed window into bounds; `null` means "show everything". */
export const clampDomain = (start: number, span: number, bounds: TimeDomain): TimeDomain | null => {
  const fullSpan = bounds.end - bounds.start;
  if (span >= fullSpan) return null;
  const clampedSpan = Math.max(span, fullSpan * MIN_SPAN_RATIO);
  const clampedStart = Math.min(Math.max(start, bounds.start), bounds.end - clampedSpan);
  return { start: clampedStart, end: clampedStart + clampedSpan };
};

/** Scales the window by `factor` around the time at `anchorRatio` (0..1 across the window). */
export const zoomDomain = (
  domain: TimeDomain,
  bounds: TimeDomain,
  anchorRatio: number,
  factor: number,
): TimeDomain | null => {
  const span = domain.end - domain.start;
  const anchor = domain.start + anchorRatio * span;
  const nextSpan = span * factor;
  return clampDomain(anchor - anchorRatio * nextSpan, nextSpan, bounds);
};

/** Shifts the window by `deltaRatio` window-widths (positive drags content rightward). */
export const panDomain = (
  domain: TimeDomain,
  bounds: TimeDomain,
  deltaRatio: number,
): TimeDomain | null => {
  const span = domain.end - domain.start;
  return clampDomain(domain.start - deltaRatio * span, span, bounds);
};
