import { describe, expect, test } from "bun:test";
import { lerp } from "./math/lerp";
import { drawSpline } from "./math/spline";
import { niceTimeInterval, formatRelativeSeconds } from "./math/intervals";

describe("liveplot math", () => {
  test("lerp is stable across frame rates", () => {
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

  test("interval helpers return readable relative ticks", () => {
    expect(niceTimeInterval(10)).toBe(1);
    expect(niceTimeInterval(30)).toBe(5);
    expect(niceTimeInterval(120)).toBe(15);

    expect(formatRelativeSeconds(0)).toBe("0");
    expect(formatRelativeSeconds(5)).toBe("-5s");
    expect(formatRelativeSeconds(120)).toBe("-2m");
  });

  test("spline control points stay in segment x-bounds", () => {
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
