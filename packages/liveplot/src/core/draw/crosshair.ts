/**
 * Adapted from liveline (MIT): https://github.com/benjitaylor/liveline
 * Source commit: a913578832784bb6abdb148b6af9cf1739be2759
 * Local changes: multiseries tooltip content.
 */

import type { ChartLayout, LiveChartPalette, LiveHoverSeriesValue } from "../types";

const formatTimeLabel = (secondsAgo: number): string => {
  const rounded = Math.max(0, Math.round(secondsAgo));
  return rounded === 0 ? "now" : `-${rounded}s`;
};

const formatValue = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return "--";
  return value.toFixed(3);
};

export const drawCrosshair = (
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  palette: LiveChartPalette,
  x: number,
  secondsAgo: number,
  values: LiveHoverSeriesValue[],
): void => {
  const { padding, width, height } = layout;

  ctx.save();
  ctx.strokeStyle = palette.crosshair;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, padding.top);
  ctx.lineTo(x, height - padding.bottom);
  ctx.stroke();

  ctx.font = palette.font;
  ctx.textBaseline = "middle";

  const header = formatTimeLabel(secondsAgo);
  const rows = [header, ...values.map((v) => `${v.label}: ${formatValue(v.value)}`)];

  let boxWidth = 0;
  for (const row of rows) {
    const w = ctx.measureText(row).width;
    if (w > boxWidth) boxWidth = w;
  }

  const lineHeight = 16;
  const padX = 8;
  const padY = 8;
  const totalHeight = rows.length * lineHeight + padY * 2;
  const totalWidth = boxWidth + padX * 2;

  let boxLeft = x + 10;
  const boxTop = padding.top + 8;
  if (boxLeft + totalWidth > width - 4) {
    boxLeft = x - totalWidth - 10;
  }
  boxLeft = Math.max(4, boxLeft);

  const radius = 6;
  ctx.fillStyle = palette.tooltipBg;
  ctx.strokeStyle = palette.tooltipBorder;
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(boxLeft + radius, boxTop);
  ctx.lineTo(boxLeft + totalWidth - radius, boxTop);
  ctx.quadraticCurveTo(boxLeft + totalWidth, boxTop, boxLeft + totalWidth, boxTop + radius);
  ctx.lineTo(boxLeft + totalWidth, boxTop + totalHeight - radius);
  ctx.quadraticCurveTo(
    boxLeft + totalWidth,
    boxTop + totalHeight,
    boxLeft + totalWidth - radius,
    boxTop + totalHeight,
  );
  ctx.lineTo(boxLeft + radius, boxTop + totalHeight);
  ctx.quadraticCurveTo(boxLeft, boxTop + totalHeight, boxLeft, boxTop + totalHeight - radius);
  ctx.lineTo(boxLeft, boxTop + radius);
  ctx.quadraticCurveTo(boxLeft, boxTop, boxLeft + radius, boxTop);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = palette.tooltipText;
  for (let i = 0; i < rows.length; i += 1) {
    const y = boxTop + padY + lineHeight * (i + 0.5);

    if (i > 0) {
      const swatch = values[i - 1];
      ctx.fillStyle = swatch.color;
      ctx.fillRect(boxLeft + padX, y - 4, 8, 8);
      ctx.fillStyle = palette.tooltipText;
      ctx.fillText(rows[i], boxLeft + padX + 12, y);
    } else {
      ctx.fillText(rows[i], boxLeft + padX, y);
    }
  }

  ctx.restore();
};
