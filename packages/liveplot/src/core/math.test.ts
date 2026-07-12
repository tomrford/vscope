import { describe, expect, it } from "@effect/vitest";
import { clampDomain, panDomain, zoomDomain } from "./math/domain";
import { lerp } from "./math/lerp";
import { drawSpline } from "./math/spline";
import { formatDomainSeconds, niceTimeInterval, formatRelativeSeconds } from "./math/intervals";

describe("liveplot math", () => {
  it("lerp is stable across frame rates", () => {
    const at60 = lerp(0, 100, 0.1, 16.67);
    const at30 = lerp(0, 100, 0.1, 33.33);

    expect(at60).toBeGreaterThan(0);
    expect(at30).toBeGreaterThan(at60);

    let value = 0;
    for (let i = 0; i < 240; i += 1) {
      value = lerp(value, 100, 0.08, 16.67);
    }

    expect(value).toBeCloseTo(100, 2);
  });

  it("interval helpers return readable relative ticks", () => {
    expect(niceTimeInterval(10)).toBe(1);
    expect(niceTimeInterval(30)).toBe(5);
    expect(niceTimeInterval(120)).toBe(15);

    expect(formatRelativeSeconds(0)).toBe("0");
    expect(formatRelativeSeconds(5)).toBe("-5s");
    expect(formatRelativeSeconds(120)).toBe("-2m");
  });

  it("interval helpers scale to sub-second domain windows", () => {
    expect(niceTimeInterval(0.04)).toBeCloseTo(0.01, 9);
    expect(niceTimeInterval(1)).toBeCloseTo(0.2, 9);

    expect(formatDomainSeconds(0.02, 0.01)).toBe("0.02s");
    expect(formatDomainSeconds(3, 1)).toBe("3s");
  });

  it("domain gestures zoom around the anchor, pan within bounds, and reset at full span", () => {
    const bounds = { start: 0, end: 0.04 };

    const zoomed = zoomDomain(bounds, bounds, 0.5, 1 / 2);
    expect(zoomed).toEqual({ start: 0.01, end: 0.03 });

    // The anchor time stays put: zooming at the left edge keeps the left edge.
    const edge = zoomDomain(bounds, bounds, 0, 1 / 2);
    expect(edge).toEqual({ start: 0, end: 0.02 });

    // Panning past the end clamps to the bounds.
    const panned = panDomain({ start: 0.01, end: 0.03 }, bounds, -2);
    expect(panned?.start).toBeCloseTo(0.02, 9);
    expect(panned?.end).toBeCloseTo(0.04, 9);

    // Zooming out to (or beyond) the full extent resets to "show everything".
    expect(zoomDomain({ start: 0.01, end: 0.03 }, bounds, 0.5, 4)).toBeNull();
    expect(clampDomain(0, 1, bounds)).toBeNull();

    // Zooming in never collapses below the minimum span.
    let domain = { start: 0.01, end: 0.03 };
    for (let i = 0; i < 200; i += 1) {
      domain = zoomDomain(domain, bounds, 0.5, 1 / 2) ?? bounds;
    }
    expect(domain.end - domain.start).toBeGreaterThanOrEqual(0.04 * 1e-4 * 0.999);
  });

  it("spline control points stay in segment x-bounds", () => {
    const calls: number[][] = [];
    const ctx = {
      lineTo: () => {},
      bezierCurveTo: (...args: number[]) => {
        calls.push(args);
      },
    } as unknown as CanvasRenderingContext2D;

    const pts: Array<[number, number]> = [
      [0, 0],
      [1, 1],
      [2, 0.5],
      [3, 1.5],
    ];

    drawSpline(ctx, pts);

    expect(calls.length).toBe(pts.length - 1);

    for (let i = 0; i < calls.length; i += 1) {
      const [cp1x, , cp2x] = calls[i];
      expect(cp1x).toBeGreaterThanOrEqual(pts[i][0]);
      expect(cp1x).toBeLessThanOrEqual(pts[i + 1][0]);
      expect(cp2x).toBeGreaterThanOrEqual(pts[i][0]);
      expect(cp2x).toBeLessThanOrEqual(pts[i + 1][0]);
    }
  });
});
