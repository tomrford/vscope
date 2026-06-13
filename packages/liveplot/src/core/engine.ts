/**
 * Adapted from liveline (MIT): https://github.com/benjitaylor/liveline
 * Source commit: a913578832784bb6abdb148b6af9cf1739be2759
 * Local changes: framework-agnostic engine, multiseries rendering,
 * no badge/pulse/momentum/current-line features.
 */

import { drawCrosshair } from "./draw/crosshair";
import { drawEmpty } from "./draw/empty";
import { drawGrid } from "./draw/grid";
import { drawLoading } from "./draw/loading";
import { drawMultiSeries, type VisibleSeries } from "./draw/line-multiseries";
import { interpolateAtTime } from "./math/interpolate";
import { lerp } from "./math/lerp";
import { computeMultiRange } from "./math/range";
import { resolvePalette } from "./theme";
import type {
  ChartLayout,
  ChartPadding,
  LiveChartConfig,
  LiveHoverPayload,
  LiveSeries,
} from "./types";
const MAX_DT_MS = 50;
const WINDOW_LERP = 0.16;
const RANGE_LERP = 0.14;
const REVEAL_LERP = 0.14;
const LOADING_LERP = 0.14;
const CATCHUP_LERP = 0.15;
const MIN_VISIBLE_POINTS = 2;

const DEFAULT_PADDING: ChartPadding = {
  top: 12,
  right: 64,
  bottom: 28,
  left: 12,
};

const getDpr = (): number => Math.min(window.devicePixelRatio || 1, 3);

const applyDpr = (
  ctx: CanvasRenderingContext2D,
  dpr: number,
  width: number,
  height: number,
): void => {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
};

type InternalState = {
  width: number;
  height: number;
  raf: number;
  lastFrameMs: number;
  displayWindowSecs: number;
  displayNowSec: number;
  displayMin: number;
  displayMax: number;
  rangeInit: boolean;
  chartReveal: number;
  loadingAlpha: number;
  localScrubX: number | null;
  scrubOverrideTime: number | null;
  hoverActive: boolean;
};
const toVisibleSeries = (
  seriesList: LiveSeries[],
  leftEdge: number,
  rightEdge: number,
  smoothValueMap: Map<string, number>,
  dtMs: number,
): VisibleSeries[] => {
  const visible: VisibleSeries[] = [];
  for (const series of seriesList) {
    const points = series.points.filter(
      (point) => point.time >= leftEdge - 1 && point.time <= rightEdge,
    );

    if (points.length === 0) {
      smoothValueMap.delete(series.id);
      continue;
    }

    const last = points[points.length - 1];
    const prevSmooth = smoothValueMap.get(series.id);
    const nextSmooth =
      prevSmooth === undefined ? last.value : lerp(prevSmooth, last.value, 0.18, dtMs);
    smoothValueMap.set(series.id, nextSmooth);

    const copy = [...points];
    copy[copy.length - 1] = { ...last, value: nextSmooth };

    visible.push({
      id: series.id,
      color: series.color,
      points: copy,
    });
  }

  return visible;
};

const toLayout = (
  width: number,
  height: number,
  padding: ChartPadding,
  nowSec: number,
  windowSecs: number,
  minVal: number,
  maxVal: number,
): ChartLayout => {
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const range = Math.max(maxVal - minVal, 1e-3);
  const leftEdge = nowSec - windowSecs;
  const rightEdge = nowSec;

  return {
    width,
    height,
    padding,
    chartWidth,
    chartHeight,
    minVal,
    maxVal,
    valRange: range,
    toX: (time: number) => {
      const ratio = (time - leftEdge) / (rightEdge - leftEdge);
      return padding.left + ratio * chartWidth;
    },
    toY: (value: number) => {
      const ratio = (value - minVal) / range;
      return padding.top + (1 - ratio) * chartHeight;
    },
  };
};

export type LivePlotEngine = {
  setConfig: (next: LiveChartConfig) => void;
  setScrubTime: (time: number | null) => void;
  resize: () => void;
  destroy: () => void;
};

export const createLivePlotEngine = (
  canvas: HTMLCanvasElement,
  container: HTMLElement,
  initialConfig: LiveChartConfig,
): LivePlotEngine => {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D context unavailable");
  }
  let config = initialConfig;
  let destroyed = false;
  const smoothValueMap = new Map<string, number>();

  const state: InternalState = {
    width: 0,
    height: 0,
    raf: 0,
    lastFrameMs: 0,
    displayWindowSecs: Math.max(1, initialConfig.windowSecs),
    displayNowSec: Date.now() / 1000,
    displayMin: -1,
    displayMax: 1,
    rangeInit: false,
    chartReveal: 0,
    loadingAlpha: initialConfig.loading ? 1 : 0,
    localScrubX: null,
    scrubOverrideTime: initialConfig.scrubTime ?? null,
    hoverActive: false,
  };

  const emitHover = (payload: LiveHoverPayload | null): void => {
    config.onHover?.(payload);
  };

  const clearHover = (): void => {
    if (!state.hoverActive) return;
    state.hoverActive = false;
    emitHover(null);
  };

  const resizeFromContainer = (): void => {
    const rect = container.getBoundingClientRect();
    state.width = Math.max(0, rect.width);
    state.height = Math.max(0, rect.height);
  };

  const ro = new ResizeObserver(() => resizeFromContainer());
  ro.observe(container);
  resizeFromContainer();

  const onMove = (x: number): void => {
    if (!config.scrubEnabled) return;
    state.localScrubX = x;
  };

  const mouseMove = (event: MouseEvent): void => {
    const rect = container.getBoundingClientRect();
    onMove(event.clientX - rect.left);
  };

  const mouseLeave = (): void => {
    state.localScrubX = null;
    clearHover();
  };

  const touchMove = (event: TouchEvent): void => {
    if (!config.scrubEnabled) return;
    if (event.touches.length !== 1) return;
    event.preventDefault();
    const rect = container.getBoundingClientRect();
    onMove(event.touches[0].clientX - rect.left);
  };

  const touchStart = (event: TouchEvent): void => {
    if (!config.scrubEnabled) return;
    if (event.touches.length !== 1) return;
    const rect = container.getBoundingClientRect();
    onMove(event.touches[0].clientX - rect.left);
  };

  const touchEnd = (): void => {
    state.localScrubX = null;
    clearHover();
  };

  container.addEventListener("mousemove", mouseMove);
  container.addEventListener("mouseleave", mouseLeave);
  container.addEventListener("touchstart", touchStart, { passive: true });
  container.addEventListener("touchmove", touchMove, { passive: false });
  container.addEventListener("touchend", touchEnd);
  container.addEventListener("touchcancel", touchEnd);

  const draw = (): void => {
    if (destroyed) return;

    if (document.hidden) {
      state.raf = 0;
      return;
    }

    if (state.width <= 0 || state.height <= 0) {
      state.raf = requestAnimationFrame(draw);
      return;
    }

    const nowMs = performance.now();
    const dtMs = state.lastFrameMs ? Math.min(nowMs - state.lastFrameMs, MAX_DT_MS) : 16.67;
    state.lastFrameMs = nowMs;

    const dpr = getDpr();
    const targetWidth = Math.round(state.width * dpr);
    const targetHeight = Math.round(state.height * dpr);

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      canvas.style.width = `${state.width}px`;
      canvas.style.height = `${state.height}px`;
    }

    applyDpr(ctx, dpr, state.width, state.height);

    const realNowSec = Date.now() / 1000;

    if (config.paused) {
      state.displayNowSec = state.displayNowSec || realNowSec;
    } else {
      state.displayNowSec = lerp(state.displayNowSec, realNowSec, CATCHUP_LERP, dtMs);
      if (Math.abs(state.displayNowSec - realNowSec) < 0.01) {
        state.displayNowSec = realNowSec;
      }
    }

    state.displayWindowSecs = lerp(
      state.displayWindowSecs,
      Math.max(1, config.windowSecs),
      WINDOW_LERP,
      dtMs,
    );

    const leftEdge = state.displayNowSec - state.displayWindowSecs;
    const visibleSeries = toVisibleSeries(
      config.series,
      leftEdge,
      state.displayNowSec,
      smoothValueMap,
      dtMs,
    );

    const hasData = visibleSeries.some((entry) => entry.points.length >= MIN_VISIBLE_POINTS);

    state.loadingAlpha = lerp(state.loadingAlpha, config.loading ? 1 : 0, LOADING_LERP, dtMs);

    const revealTarget = !config.loading && hasData ? 1 : 0;
    state.chartReveal = lerp(state.chartReveal, revealTarget, REVEAL_LERP, dtMs);

    const palette = resolvePalette(config.theme);

    if (!hasData && state.chartReveal < 0.02) {
      if (state.loadingAlpha > 0.01) {
        drawLoading(
          ctx,
          state.width,
          state.height,
          DEFAULT_PADDING,
          palette,
          nowMs,
          state.loadingAlpha,
        );
      }

      const emptyAlpha = 1 - state.loadingAlpha;
      if (emptyAlpha > 0.01) {
        drawEmpty(
          ctx,
          state.width,
          state.height,
          DEFAULT_PADDING,
          palette,
          emptyAlpha,
          nowMs,
          false,
          config.emptyText,
        );
      }

      clearHover();
      state.raf = requestAnimationFrame(draw);
      return;
    }

    const dataForRange = visibleSeries
      .filter((entry) => entry.points.length >= MIN_VISIBLE_POINTS)
      .map((entry) => ({
        series: {
          id: entry.id,
          label: entry.id,
          color: entry.color,
          points: entry.points,
        },
        points: entry.points,
      }));

    const computed = computeMultiRange(dataForRange);

    if (!state.rangeInit) {
      state.displayMin = computed.min;
      state.displayMax = computed.max;
      state.rangeInit = true;
    } else {
      state.displayMin = lerp(state.displayMin, computed.min, RANGE_LERP, dtMs);
      state.displayMax = lerp(state.displayMax, computed.max, RANGE_LERP, dtMs);
    }

    const layout = toLayout(
      state.width,
      state.height,
      DEFAULT_PADDING,
      state.displayNowSec,
      state.displayWindowSecs,
      state.displayMin,
      state.displayMax,
    );

    if (config.showGrid) {
      drawGrid(ctx, layout, palette, state.displayNowSec, state.displayWindowSecs);
    }

    drawMultiSeries(ctx, layout, visibleSeries, config.showFill, state.chartReveal, nowMs);

    if (state.chartReveal < 0.99 && !config.loading) {
      drawEmpty(
        ctx,
        state.width,
        state.height,
        DEFAULT_PADDING,
        palette,
        1 - state.chartReveal,
        nowMs,
        true,
        config.emptyText,
      );
    }

    const localScrubX = state.localScrubX;
    const usingLocalScrub = config.scrubEnabled && localScrubX !== null;
    const scrubTime = usingLocalScrub
      ? (() => {
          const clamped = Math.max(
            DEFAULT_PADDING.left,
            Math.min(state.width - DEFAULT_PADDING.right, localScrubX),
          );
          const ratio =
            (clamped - DEFAULT_PADDING.left) /
            Math.max(1, state.width - DEFAULT_PADDING.left - DEFAULT_PADDING.right);
          return leftEdge + ratio * state.displayWindowSecs;
        })()
      : state.scrubOverrideTime;

    if (scrubTime === null) {
      clearHover();
      state.raf = requestAnimationFrame(draw);
      return;
    }

    const clampedTime = Math.max(leftEdge, Math.min(state.displayNowSec, scrubTime));
    const crosshairX = layout.toX(clampedTime);

    const hoverValues = visibleSeries.map((entry) => ({
      id: entry.id,
      label: config.series.find((series) => series.id === entry.id)?.label ?? entry.id,
      color: entry.color,
      value: interpolateAtTime(entry.points, clampedTime),
    }));

    drawCrosshair(ctx, layout, palette, crosshairX, state.displayNowSec - clampedTime, hoverValues);

    if (usingLocalScrub) {
      state.hoverActive = true;
      emitHover({ time: clampedTime, values: hoverValues });
    }

    state.raf = requestAnimationFrame(draw);
  };

  const onVisibility = (): void => {
    if (!document.hidden && !state.raf) {
      state.raf = requestAnimationFrame(draw);
    }
  };

  document.addEventListener("visibilitychange", onVisibility);
  state.raf = requestAnimationFrame(draw);

  return {
    setConfig(next) {
      config = next;
      state.scrubOverrideTime = next.scrubTime ?? state.scrubOverrideTime;
      if (!next.scrubEnabled) {
        state.localScrubX = null;
        state.scrubOverrideTime = null;
      }
    },
    setScrubTime(time) {
      state.scrubOverrideTime = time;
      if (time === null && state.localScrubX === null) {
        clearHover();
      }
    },
    resize() {
      resizeFromContainer();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(state.raf);
      ro.disconnect();
      container.removeEventListener("mousemove", mouseMove);
      container.removeEventListener("mouseleave", mouseLeave);
      container.removeEventListener("touchstart", touchStart);
      container.removeEventListener("touchmove", touchMove);
      container.removeEventListener("touchend", touchEnd);
      container.removeEventListener("touchcancel", touchEnd);
      document.removeEventListener("visibilitychange", onVisibility);
      clearHover();
    },
  };
};
