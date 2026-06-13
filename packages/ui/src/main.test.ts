import { describe, expect, test } from "bun:test";

const loadMain = async () => {
  Object.assign(globalThis, {
    window: {
      requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    },
  });

  return await import("./main");
};

describe("@vscope/ui", () => {
  test("initializes without a server connection", async () => {
    const { init } = await loadMain();
    const [model, commands] = init();

    expect(model).toMatchObject({
      appName: "vscope",
      status: "Waiting for runtime",
    });
    expect(commands).toEqual([]);
  });

  test("updates runtime status through the Foldkit update loop", async () => {
    const { init, update } = await loadMain();
    const [model] = init();
    const [next] = update(model, {
      _tag: "RuntimeStateLoaded",
      status: "Connected",
    });

    expect(next.status).toBe("Connected");
  });

  test("renders the current shell title", async () => {
    const { init, view } = await loadMain();
    const [model] = init();

    expect(view(model).title).toBe("vscope");
  });
});
