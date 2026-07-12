/**
 * Adapted from liveline (MIT): https://github.com/benjitaylor/liveline
 * Source commit: a913578832784bb6abdb148b6af9cf1739be2759
 * Local changes: relative- and domain-time x axes and simplified y-grid.
 */

import { formatDomainSeconds, formatRelativeSeconds, niceTimeInterval } from "../math/intervals";
import type { AxisTick, ChartLayout, LiveChartPalette } from "../types";

const GRID_ROWS = 4;

// Live mode: ticks labelled as seconds before "now".
export const buildRelativeTicks = (
  windowSecs: number,
  nowSec: number,
  toX: (time: number) => number,
): AxisTick[] => {
  const interval = niceTimeInterval(windowSecs);
  const ticks: AxisTick[] = [];

  for (let secondsAgo = windowSecs; secondsAgo >= 0; secondsAgo -= interval) {
    const rounded = Math.max(0, Math.round(secondsAgo));
    ticks.push({ x: toX(nowSec - rounded), label: formatRelativeSeconds(rounded) });
  }

  if (ticks.length === 0 || ticks[ticks.length - 1].label !== "0") {
    ticks.push({ x: toX(nowSec), label: formatRelativeSeconds(0) });
  }

  return ticks;
};

// Static mode: ticks at nice absolute capture times within [start, end].
export const buildDomainTicks = (
  start: number,
  end: number,
  toX: (time: number) => number,
): AxisTick[] => {
  const span = Math.max(end - start, 1e-9);
  const interval = niceTimeInterval(span);
  const first = Math.ceil(start / interval - 1e-6);
  const last = Math.floor(end / interval + 1e-6);
  const ticks: AxisTick[] = [];

  for (let step = first; step <= last; step += 1) {
    const time = step * interval;
    ticks.push({ x: toX(time), label: formatDomainSeconds(time, interval) });
  }

  return ticks;
};

export const drawGrid = (
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  palette: LiveChartPalette,
  ticks: AxisTick[],
): void => {
  const { width, height, padding, minVal, maxVal, toY } = layout;

  ctx.save();
  ctx.font = palette.font;
  ctx.strokeStyle = palette.gridLine;
  ctx.fillStyle = palette.axisText;
  ctx.lineWidth = 1;

  for (let i = 0; i <= GRID_ROWS; i += 1) {
    const t = i / GRID_ROWS;
    const value = maxVal - (maxVal - minVal) * t;
    const y = toY(value);

    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    if (i !== GRID_ROWS) {
      const label = value.toFixed(2);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(label, width - padding.right + 48, y);
    }
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = palette.axis;

  for (const tick of ticks) {
    ctx.beginPath();
    ctx.moveTo(tick.x, height - padding.bottom);
    ctx.lineTo(tick.x, height - padding.bottom + 5);
    ctx.strokeStyle = palette.axis;
    ctx.stroke();

    ctx.fillText(tick.label, tick.x, height - padding.bottom + 7);
  }

  ctx.restore();
};
