import type { ChartLayout, LiveChartPalette } from "../types";

export const drawMarker = (
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  palette: LiveChartPalette,
  time: number,
  label: string,
): void => {
  const { width, height, padding, toX } = layout;
  const x = toX(time);
  if (x < padding.left || x > width - padding.right) return;

  ctx.save();
  ctx.strokeStyle = palette.marker;
  ctx.fillStyle = palette.marker;
  ctx.font = palette.font;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(x, padding.top);
  ctx.lineTo(x, height - padding.bottom);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(label, x + 5, padding.top + 2);
  ctx.restore();
};
