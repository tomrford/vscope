import { describe, expect, test } from "vitest";

import { SelectedPanel, ToggledRun, init, update } from "./model.ts";

describe("@vscope/ui model", () => {
  test("initializes the mock workbench", () => {
    const [model, commands] = init();

    expect(model.appName).toBe("vscope");
    expect(model.activePanel).toBe("Controls");
    expect(model.selectedSignals).toHaveLength(5);
    expect(commands).toHaveLength(0);
  });

  test("updates primary mock controls through the Foldkit update loop", () => {
    const [model] = init();
    const [stopped] = update(model, ToggledRun());
    const [snapshots] = update(stopped, SelectedPanel({ panel: "Snapshots" }));

    expect(stopped.isRunning).toBe(false);
    expect(snapshots.activePanel).toBe("Snapshots");
  });
});
