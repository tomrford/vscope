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

/** Fixed time window in capture seconds. When set, the chart renders a
 *  static domain (snapshot mode) instead of a marching live window. */
export type TimeDomain = {
  start: number;
  end: number;
};

export type LiveChartInput = {
  series: LiveSeries[];
  windowSecs: number;
  paused: boolean;
  loading: boolean;
  emptyText?: string;
  scrubTime?: number | null;
  domain?: TimeDomain | null;
  /** Full data extent. Together with `onDomainChange` this enables the
   *  engine's pan/zoom gestures (wheel, drag, double-click reset). */
  domainBounds?: TimeDomain | null;
};

export type LiveChartTheme = "light" | "dark";

export type LiveChartConfig = LiveChartInput & {
  theme: LiveChartTheme;
  scrubEnabled: boolean;
  showGrid: boolean;
  showFill: boolean;
  onHover?: (payload: LiveHoverPayload | null) => void;
  /** Receives the window proposed by a pan/zoom gesture; `null` asks for the
   *  full extent. The engine never moves its own window — the owner applies
   *  the change via `setConfig`, which is what keeps sibling plots in sync. */
  onDomainChange?: (domain: TimeDomain | null) => void;
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

export type AxisTick = {
  x: number;
  label: string;
};
