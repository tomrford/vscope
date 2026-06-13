/**
 * Adapted from liveline (MIT): https://github.com/benjitaylor/liveline
 * Source commit: a913578832784bb6abdb148b6af9cf1739be2759
 */

export const LOADING_AMPLITUDE_RATIO = 0.07;
export const LOADING_SCROLL_SPEED = 0.001;

export const loadingY = (t: number, centerY: number, amplitude: number, scroll: number): number => {
  return (
    centerY +
    amplitude *
      (Math.sin(t * 9.4 + scroll) * 0.55 +
        Math.sin(t * 15.7 + scroll * 1.3) * 0.3 +
        Math.sin(t * 4.2 + scroll * 0.7) * 0.15)
  );
};

export const loadingBreath = (nowMs: number): number => {
  return 0.22 + 0.08 * Math.sin((nowMs / 1200) * Math.PI);
};
