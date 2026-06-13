/**
 * Adapted from liveline (MIT): https://github.com/benjitaylor/liveline
 * Source commit: a913578832784bb6abdb148b6af9cf1739be2759
 * Local changes: relative-time x axis and simplified y-grid.
 */

import { formatRelativeSeconds, niceTimeInterval } from "../math/intervals";
import type { ChartLayout, LiveChartPalette, XTick } from "../types";

const GRID_ROWS = 4;

export const buildXTicks = (
  windowSecs: number,
  nowSec: number,
  toX: (time: number) => number,
): XTick[] => {
  const interval = niceTimeInterval(windowSecs);
  const ticks: XTick[] = [];

  for (let secondsAgo = windowSecs; secondsAgo >= 0; secondsAgo -= interval) {
    const rounded = Math.max(0, Math.round(secondsAgo));
    const x = toX(nowSec - rounded);
    ticks.push({ secondsAgo: rounded, x });
  }

  if (ticks.length === 0 || ticks[ticks.length - 1].secondsAgo !== 0) {
    ticks.push({ secondsAgo: 0, x: toX(nowSec) });
  }

  return ticks;
};

export const drawGrid = (
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  palette: LiveChartPalette,
  nowSec: number,
  windowSecs: number,
): XTick[] => {
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

  const ticks = buildXTicks(windowSecs, nowSec, layout.toX);

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = palette.axis;

  for (const tick of ticks) {
    ctx.beginPath();
    ctx.moveTo(tick.x, height - padding.bottom);
    ctx.lineTo(tick.x, height - padding.bottom + 5);
    ctx.strokeStyle = palette.axis;
    ctx.stroke();

    const label = formatRelativeSeconds(tick.secondsAgo);
    ctx.fillText(label, tick.x, height - padding.bottom + 7);
  }

  ctx.restore();
  return ticks;
};
