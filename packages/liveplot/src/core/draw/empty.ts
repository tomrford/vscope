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

export const drawEmpty = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  padding: ChartPadding,
  palette: LiveChartPalette,
  alpha: number,
  nowMs: number,
  skipLine: boolean,
  text?: string,
): void => {
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const centerY = padding.top + chartHeight / 2;
  const centerX = padding.left + chartWidth / 2;

  const emptyText = text ?? "No data to display";
  ctx.font = palette.font;

  const amplitude = chartHeight * LOADING_AMPLITUDE_RATIO;
  const textWidth = ctx.measureText(emptyText).width;
  const gapHalf = textWidth / 2 + 18;
  const fadeWidth = 26;

  if (!skipLine) {
    const scroll = nowMs * LOADING_SCROLL_SPEED;
    const breath = loadingBreath(nowMs);
    const pts: Array<[number, number]> = [];
    const pointCount = 32;

    for (let i = 0; i <= pointCount; i += 1) {
      const t = i / pointCount;
      const x = padding.left + t * chartWidth;
      const y = loadingY(t, centerY, amplitude, scroll);
      pts.push([x, y]);
    }

    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    drawSpline(ctx, pts);
    ctx.strokeStyle = palette.noDataLine;
    ctx.lineWidth = 2;
    ctx.globalAlpha = breath * alpha;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  const gapLeft = centerX - gapHalf - fadeWidth;
  const gapRight = centerX + gapHalf + fadeWidth;

  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  const eraseGradient = ctx.createLinearGradient(gapLeft, 0, gapRight, 0);
  eraseGradient.addColorStop(0, "rgba(0,0,0,0)");
  eraseGradient.addColorStop(fadeWidth / (gapRight - gapLeft), "rgba(0,0,0,1)");
  eraseGradient.addColorStop(1 - fadeWidth / (gapRight - gapLeft), "rgba(0,0,0,1)");
  eraseGradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = eraseGradient;
  ctx.globalAlpha = alpha;
  const eraseHeight = amplitude * 2 + 10;
  ctx.fillRect(gapLeft, centerY - eraseHeight / 2, gapRight - gapLeft, eraseHeight);
  ctx.restore();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = alpha * 0.55;
  ctx.fillStyle = palette.axisText;
  ctx.fillText(emptyText, centerX, centerY);
  ctx.globalAlpha = 1;
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
};
