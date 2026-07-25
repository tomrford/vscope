import * as stylex from "@stylexjs/stylex";

// Neutral application surfaces with colour reserved for live signals and
// device state. Alternate values stay on the same tokens so every StyleX
// consumer switches as one root theme.
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

export const darkColors = stylex.createTheme(colors, {
  bg: "#09090b",
  panel: "#18181b",
  panelMuted: "#1c1c20",
  panelRaised: "#27272a",
  screen: "#111113",
  line: "#27272a",
  lineStrong: "#3f3f46",
  text: "#fafafa",
  textRaised: "#e4e4e7",
  textMuted: "#d4d4d8",
  textSoft: "#a1a1aa",
  accent: "#60a5fa",
  accentStrong: "#93c5fd",
  accentSoft: "#172554",
  accentBorder: "#1e40af",
  focusRing: "#1e3a8a",
  run: "#4ade80",
  runSoft: "#14261b",
  runSoftRaised: "#183820",
  runBorder: "#166534",
  acquire: "#fbbf24",
  acquireSoft: "#2b2111",
  acquireBorder: "#854d0e",
  halt: "#d4d4d8",
  danger: "#f87171",
  dangerSoft: "#321818",
  dangerSoftRaised: "#451a1a",
  dangerBorder: "#7f1d1d",
  overlay: "rgba(0, 0, 0, 0.58)",
  legendBg: "rgba(24, 24, 27, 0.92)",
});

export const darkShadows = stylex.createTheme(shadows, {
  popover: "0 18px 48px rgba(0, 0, 0, 0.42), 0 2px 8px rgba(0, 0, 0, 0.28)",
  dialog: "0 24px 72px rgba(0, 0, 0, 0.56)",
});
