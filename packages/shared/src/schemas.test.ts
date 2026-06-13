import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PREFERENCES,
  DEFAULT_SETTINGS,
  DEFAULT_SERIAL_PORT_CONFIG,
  SNAPSHOT_SAMPLE_FORMAT,
  decodeAppState,
  decodeSnapshotSamplesBlob,
} from ".";

describe("@vscope/shared", () => {
  test("decodes the initial app-state wire shape", () => {
    const state = decodeAppState({
      settings: {
        settings: DEFAULT_SETTINGS,
        recovery: {
          pending: false,
          message: null,
        },
      },
      preferences: {
        preferences: DEFAULT_PREFERENCES,
        recovery: {
          pending: false,
          message: null,
        },
      },
      serial: {
        _tag: "Disconnected",
      },
      ports: [],
      savedPorts: [],
      snapshots: [],
    });

    expect(state.serial._tag).toBe("Disconnected");
  });

  test("keeps snapshot samples as a binary wire payload", () => {
    const payload = decodeSnapshotSamplesBlob({
      snapshotId: 1,
      channelCount: 2,
      sampleCount: 2,
      format: SNAPSHOT_SAMPLE_FORMAT,
      byteLength: 16,
      data: new Uint8Array(16),
    });

    expect(payload.data.byteLength).toBe(16);
  });

  test("defines serial config independently of a selected port", () => {
    expect(DEFAULT_SERIAL_PORT_CONFIG).toMatchObject({
      baudRate: 115200,
      dataBits: 8,
    });
  });
});
