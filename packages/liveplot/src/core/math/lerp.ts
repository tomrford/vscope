/**
 * Adapted from liveline (MIT): https://github.com/benjitaylor/liveline
 * Source commit: a913578832784bb6abdb148b6af9cf1739be2759
 */

/**
 * Frame-rate-independent exponential lerp.
 */
export const lerp = (
  current: number,
  target: number,
  speed: number,
  dtMs: number = 16.67,
): number => {
  if (speed <= 0) return current;
  if (speed >= 1) return target;
  const t = 1 - Math.pow(1 - speed, dtMs / 16.67);
  return current + (target - current) * t;
};
