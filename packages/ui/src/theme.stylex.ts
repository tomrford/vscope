// Instrument console palette. Dark, high-contrast, oscilloscope-inspired:
// a near-black chassis, a darker phosphor screen, and saturated signal accents
// that double as device-state semantics (run/acquire/halt/fault).
export const colors = {
  // chassis surfaces, back-to-front
  bg: "#0a0d13",
  panel: "#10141c",
  panelMuted: "#161b25",
  panelRaised: "#1d2430",
  // the scope display itself
  screen: "#070a0f",
  screenGrid: "#13202b",
  screenAxis: "#1d3340",
  // structure
  line: "#222a36",
  lineStrong: "#323c4c",
  // text, brightest-to-dimmest
  text: "#e8ecf3",
  textMuted: "#97a2b2",
  textSoft: "#616b7a",
  // actions
  accent: "#38bdf8",
  accentStrong: "#0ea5e9",
  accentSoft: "#0c2c3d",
  // device-state semantics
  run: "#4ade80",
  runSoft: "#0f2c1d",
  acquire: "#fbbf24",
  acquireSoft: "#2c2410",
  halt: "#8b95a5",
  haltSoft: "#1a212c",
  danger: "#f87171",
  dangerSoft: "#2c1416",
} as const;

// Per-channel trace colours, indexed by scope channel.
export const chartColors = ["#38bdf8", "#f472b6", "#4ade80", "#fbbf24", "#a78bfa"] as const;
