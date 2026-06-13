/**
 * Adapted from liveline (MIT): https://github.com/benjitaylor/liveline
 * Source commit: a913578832784bb6abdb148b6af9cf1739be2759
 * Local changes: palette wiring for VScope.
 */

import { drawSpline } from "../math/spline";
import type { ChartPadding, LiveChartPalette } from "../types";
import {
  LOADING_AMPLITUDE_RATIO,
  LOADING_SCROLL_SPEED,
  loadingBreath,
  loadingY,
} from "./loading-shape";

export const drawLoading = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  padding: ChartPadding,
  palette: LiveChartPalette,
  nowMs: number,
  alpha: number,
): void => {
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const centerY = padding.top + chartHeight / 2;
  const leftX = padding.left;
  const amplitude = chartHeight * LOADING_AMPLITUDE_RATIO;
  const scroll = nowMs * LOADING_SCROLL_SPEED;
  const breath = loadingBreath(nowMs);

  const pointCount = 32;
  const pts: Array<[number, number]> = [];

  for (let i = 0; i <= pointCount; i += 1) {
    const t = i / pointCount;
    const x = leftX + t * chartWidth;
    const y = loadingY(t, centerY, amplitude, scroll);
    pts.push([x, y]);
  }

  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  drawSpline(ctx, pts);
  ctx.strokeStyle = palette.loadingLine;
  ctx.lineWidth = 2;
  ctx.globalAlpha = breath * alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.globalAlpha = 1;
};
