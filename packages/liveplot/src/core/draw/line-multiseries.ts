/**
 * Adapted from liveline (MIT): https://github.com/benjitaylor/liveline
 * Source commit: a913578832784bb6abdb148b6af9cf1739be2759
 * Local changes: multiseries rendering, no pulse/momentum/badge line.
 */

import { drawSpline } from "../math/spline";
import type { ChartLayout, LivePoint } from "../types";
import {
  LOADING_AMPLITUDE_RATIO,
  LOADING_SCROLL_SPEED,
  loadingBreath,
  loadingY,
} from "./loading-shape";

export type VisibleSeries = {
  id: string;
  color: string;
  points: LivePoint[];
};

const hexToRgba = (hex: string, alpha: number): string => {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return hex;
  const r = parseInt(match[1], 16);
  const g = parseInt(match[2], 16);
  const b = parseInt(match[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const clampY = (y: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, y));
};

const drawSeriesCurve = (
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  points: Array<[number, number]>,
  color: string,
  alpha: number,
  showFill: boolean,
): void => {
  const { padding, height } = layout;

  if (showFill) {
    ctx.beginPath();
    ctx.moveTo(points[0][0], height - padding.bottom);
    ctx.lineTo(points[0][0], points[0][1]);
    drawSpline(ctx, points);
    ctx.lineTo(points[points.length - 1][0], height - padding.bottom);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
    grad.addColorStop(0, hexToRgba(color, 0.18 * alpha));
    grad.addColorStop(1, hexToRgba(color, 0.03 * alpha));
    ctx.fillStyle = grad;
    ctx.fill();
  }

  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  drawSpline(ctx, points);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.globalAlpha = 1;
};

export const drawMultiSeries = (
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  visibleSeries: VisibleSeries[],
  showFill: boolean,
  chartReveal: number,
  nowMs: number,
): void => {
  const { padding, chartHeight, chartWidth } = layout;
  const yMin = padding.top;
  const yMax = layout.height - padding.bottom;

  const centerY = padding.top + chartHeight / 2;
  const amplitude = chartHeight * LOADING_AMPLITUDE_RATIO;
  const scroll = nowMs * LOADING_SCROLL_SPEED;

  const morphY =
    chartReveal < 1
      ? (rawY: number, x: number): number => {
          const t = Math.max(0, Math.min(1, (x - padding.left) / chartWidth));
          const baseY = loadingY(t, centerY, amplitude, scroll);
          return baseY + (rawY - baseY) * chartReveal;
        }
      : (rawY: number): number => rawY;

  const revealLineAlpha =
    chartReveal < 1 ? loadingBreath(nowMs) + (1 - loadingBreath(nowMs)) * chartReveal : 1;

  ctx.save();
  ctx.beginPath();
  ctx.rect(padding.left - 1, padding.top, chartWidth + 2, chartHeight);
  ctx.clip();

  const shouldFill = showFill && visibleSeries.length === 1;

  for (const entry of visibleSeries) {
    if (entry.points.length < 2) continue;

    const pts: Array<[number, number]> = entry.points.map((point) => {
      const x = layout.toX(point.time);
      const y = morphY(clampY(layout.toY(point.value), yMin, yMax), x);
      return [x, y];
    });

    drawSeriesCurve(ctx, layout, pts, entry.color, revealLineAlpha, shouldFill);
  }

  ctx.restore();
};
