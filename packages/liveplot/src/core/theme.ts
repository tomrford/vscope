/**
 * Adapted from liveline (MIT): https://github.com/benjitaylor/liveline
 * Source commit: a913578832784bb6abdb148b6af9cf1739be2759
 * Local changes: simplified palette for multiseries rendering.
 */

import type { LiveChartPalette, LiveChartTheme } from "./types";

export const resolvePalette = (theme: LiveChartTheme): LiveChartPalette => {
  if (theme === "light") {
    return {
      axis: "rgba(0,0,0,0.45)",
      axisText: "rgba(0,0,0,0.55)",
      gridLine: "rgba(0,0,0,0.10)",
      crosshair: "rgba(0,0,0,0.45)",
      tooltipBg: "rgba(255,255,255,0.96)",
      tooltipBorder: "rgba(0,0,0,0.16)",
      tooltipText: "rgba(0,0,0,0.85)",
      loadingLine: "rgba(0,0,0,0.22)",
      noDataLine: "rgba(0,0,0,0.20)",
      font: "12px system-ui, -apple-system, sans-serif",
    };
  }

  return {
    axis: "rgba(255,255,255,0.35)",
    axisText: "rgba(255,255,255,0.55)",
    gridLine: "rgba(255,255,255,0.10)",
    crosshair: "rgba(255,255,255,0.45)",
    tooltipBg: "rgba(17,24,39,0.94)",
    tooltipBorder: "rgba(255,255,255,0.14)",
    tooltipText: "rgba(255,255,255,0.88)",
    loadingLine: "rgba(255,255,255,0.22)",
    noDataLine: "rgba(255,255,255,0.20)",
    font: "12px system-ui, -apple-system, sans-serif",
  };
};
