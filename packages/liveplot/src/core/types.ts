/**
 * Adapted from liveline (MIT): https://github.com/benjitaylor/liveline
 * Source commit: a913578832784bb6abdb148b6af9cf1739be2759
 * Local changes: Svelte-native engine interface, multiseries model,
 * removed badge/pulse/momentum features.
 */

export type LivePoint = {
  time: number;
  value: number;
};

export type LiveSeries = {
  id: string;
  label: string;
  color: string;
  points: LivePoint[];
};

export type LiveHoverSeriesValue = {
  id: string;
  label: string;
  color: string;
  value: number | null;
};

export type LiveHoverPayload = {
  time: number;
  values: LiveHoverSeriesValue[];
};

export type LiveChartInput = {
  series: LiveSeries[];
  windowSecs: number;
  paused: boolean;
  loading: boolean;
  emptyText?: string;
  scrubTime?: number | null;
};

export type LiveChartTheme = "light" | "dark";

export type LiveChartConfig = LiveChartInput & {
  theme: LiveChartTheme;
  scrubEnabled: boolean;
  showGrid: boolean;
  showFill: boolean;
  onHover?: (payload: LiveHoverPayload | null) => void;
};

export type ChartPadding = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type ChartLayout = {
  width: number;
  height: number;
  padding: ChartPadding;
  chartWidth: number;
  chartHeight: number;
  minVal: number;
  maxVal: number;
  valRange: number;
  toX: (time: number) => number;
  toY: (value: number) => number;
};

export type LiveChartPalette = {
  axis: string;
  axisText: string;
  gridLine: string;
  crosshair: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  loadingLine: string;
  noDataLine: string;
  font: string;
};

export type XTick = {
  secondsAgo: number;
  x: number;
};
