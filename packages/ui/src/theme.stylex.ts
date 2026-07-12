import * as stylex from "@stylexjs/stylex";

// Neutral light application surfaces with colour reserved for live signals and
// device state. Tokens compile to CSS variables so an alternate theme can be
// applied later with stylex.createTheme.
export const colors = stylex.defineVars({
  bg: "#f7f7f8",
  panel: "#ffffff",
  panelMuted: "#fafafa",
  panelRaised: "#f4f4f5",
  screen: "#ffffff",
  line: "#e4e4e7",
  lineStrong: "#d4d4d8",
  text: "#18181b",
  textRaised: "#27272a",
  textMuted: "#52525b",
  textSoft: "#71717a",
  accent: "#2563eb",
  accentStrong: "#1d4ed8",
  accentSoft: "#eff6ff",
  accentBorder: "#bfdbfe",
  focusRing: "#dbeafe",
  run: "#15803d",
  runSoft: "#f0fdf4",
  runSoftRaised: "#dcfce7",
  runBorder: "#bbf7d0",
  acquire: "#a16207",
  acquireSoft: "#fffbeb",
  acquireBorder: "#fde68a",
  halt: "#52525b",
  haltSoft: "#f4f4f5",
  danger: "#b91c1c",
  dangerSoft: "#fef2f2",
  dangerSoftRaised: "#fee2e2",
  dangerBorder: "#fecaca",
  overlay: "rgba(24, 24, 27, 0.24)",
  legendBg: "rgba(255, 255, 255, 0.92)",
});

export const shadows = stylex.defineVars({
  popover: "0 18px 48px rgba(24, 24, 27, 0.18), 0 2px 8px rgba(24, 24, 27, 0.08)",
  dialog: "0 24px 72px rgba(24, 24, 27, 0.24)",
});
