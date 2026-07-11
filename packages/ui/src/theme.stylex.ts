// Neutral light application surfaces with colour reserved for live signals and
// device state.
export const colors = {
  bg: "#f7f7f8",
  panel: "#ffffff",
  panelMuted: "#fafafa",
  panelRaised: "#f4f4f5",
  screen: "#ffffff",
  screenAxis: "#e4e4e7",
  line: "#e4e4e7",
  lineStrong: "#d4d4d8",
  text: "#18181b",
  textMuted: "#52525b",
  textSoft: "#71717a",
  accent: "#2563eb",
  accentStrong: "#1d4ed8",
  accentSoft: "#eff6ff",
  run: "#15803d",
  runSoft: "#f0fdf4",
  acquire: "#a16207",
  acquireSoft: "#fffbeb",
  halt: "#52525b",
  haltSoft: "#f4f4f5",
  danger: "#b91c1c",
  dangerSoft: "#fef2f2",
} as const;

// Per-channel trace colours, indexed by scope channel.
export const chartColors = ["#2563eb", "#c026d3", "#059669", "#d97706", "#7c3aed"] as const;
