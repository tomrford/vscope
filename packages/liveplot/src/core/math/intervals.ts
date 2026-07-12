/**
 * Adapted from liveline (MIT): https://github.com/benjitaylor/liveline
 * Source commit: a913578832784bb6abdb148b6af9cf1739be2759
 * Local changes: relative-seconds axis labels.
 */

export const niceTimeInterval = (windowSecs: number): number => {
  if (windowSecs < 2) {
    // Zoomed snapshot spans go well below one second: aim for ~4 ticks,
    // snapped to a 1/2/5 decade step.
    const target = Math.max(windowSecs / 4, 1e-9);
    const pow = 10 ** Math.floor(Math.log10(target));
    const unit = target / pow;
    return (unit >= 5 ? 5 : unit >= 2 ? 2 : 1) * pow;
  }
  if (windowSecs <= 10) return 1;
  if (windowSecs <= 20) return 2;
  if (windowSecs <= 30) return 5;
  if (windowSecs <= 60) return 10;
  if (windowSecs <= 120) return 15;
  if (windowSecs <= 300) return 30;
  if (windowSecs <= 600) return 60;
  if (windowSecs <= 1800) return 300;
  if (windowSecs <= 3600) return 600;
  return 1800;
};

export const formatRelativeSeconds = (secondsAgo: number): string => {
  const value = Math.max(0, Math.round(secondsAgo));
  if (value === 0) return "0";
  if (value < 60) return `-${value}s`;
  if (value % 60 === 0) return `-${Math.round(value / 60)}m`;
  return `-${value}s`;
};

// Absolute capture-time label ("0.25s") with precision derived from the tick
// interval so labels stay distinct at any zoom level.
export const formatDomainSeconds = (time: number, interval: number): string => {
  const decimals = interval >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(interval)));
  return `${time.toFixed(decimals)}s`;
};
