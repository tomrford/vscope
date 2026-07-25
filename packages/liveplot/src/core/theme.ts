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
      marker: "rgba(37,99,235,0.82)",
      tooltipBg: "rgba(255,255,255,0.96)",
      tooltipBorder: "rgba(0,0,0,0.16)",
      tooltipText: "rgba(0,0,0,0.85)",
      loadingLine: "rgba(0,0,0,0.22)",
      noDataLine: "rgba(0,0,0,0.20)",
      font: "12px system-ui, -apple-system, sans-serif",
    };
  }

  return {
    axis: "rgba(161,161,170,0.45)",
    axisText: "rgba(161,161,170,0.72)",
    gridLine: "rgba(63,63,70,0.52)",
    crosshair: "rgba(228,228,231,0.52)",
    marker: "rgba(96,165,250,0.90)",
    tooltipBg: "rgba(24,24,27,0.96)",
    tooltipBorder: "rgba(63,63,70,0.92)",
    tooltipText: "rgba(250,250,250,0.94)",
    loadingLine: "rgba(113,113,122,0.35)",
    noDataLine: "rgba(113,113,122,0.32)",
    font: "11px ui-monospace, SFMono-Regular, Menlo, monospace",
  };
};
