import * as stylex from "@stylexjs/stylex";
import type { Attribute } from "foldkit/html";
import type { html } from "foldkit/html";

export { chartColors, colors } from "./theme.stylex.ts";
import { colors } from "./theme.stylex.ts";

type StyleInput = stylex.StyleXStyles | false | null | undefined;
type HtmlFactory<Message> = ReturnType<typeof html<Message>>;

const toStyleRecord = (
  style: Readonly<{ readonly [key: string]: string | number }> | undefined,
): Record<string, string> => {
  const record: Record<string, string> = {};
  if (!style) return record;

  for (const [key, value] of Object.entries(style)) {
    record[key] = String(value);
  }

  return record;
};

export const sx = <Message>(
  h: HtmlFactory<Message>,
  ...styles: ReadonlyArray<StyleInput>
): ReadonlyArray<Attribute<Message>> => {
  const props = stylex.props(...styles);
  const attributes: Array<Attribute<Message>> = [];

  if (props.className) {
    attributes.push(h.Class(props.className));
  }

  if (props.style) {
    attributes.push(h.Style(toStyleRecord(props.style)));
  }

  return attributes;
};

const pulse = stylex.keyframes({
  "0%, 100%": { opacity: 1, transform: "scale(1)" },
  "50%": { opacity: 0.35, transform: "scale(0.82)" },
});

// Faint graticule grid + brighter centre axes, baked as literal hex so the
// StyleX compiler can statically resolve the gradient.
const graticule =
  "linear-gradient(#13202b 1px, transparent 1px), linear-gradient(90deg, #13202b 1px, transparent 1px)";

export const appStyles = stylex.create({
  root: {
    height: "100vh",
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    WebkitFontSmoothing: "antialiased",
  },
  shell: {
    height: "100vh",
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr)",
  },

  // ---- header ------------------------------------------------------------
  header: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    padding: "10px 16px",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.line,
    backgroundColor: colors.panel,
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  brandMark: {
    width: 12,
    height: 12,
    borderRadius: 3,
    backgroundColor: colors.accent,
    boxShadow: "0 0 10px rgba(56, 189, 248, 0.55)",
  },
  brandName: {
    margin: 0,
    fontSize: 15,
    lineHeight: "18px",
    fontWeight: 700,
    letterSpacing: 0.4,
  },
  brandSub: {
    margin: 0,
    color: colors.textSoft,
    fontSize: 11,
    lineHeight: "14px",
    fontVariantNumeric: "tabular-nums",
  },
  spacer: {
    flex: 1,
    minWidth: 0,
  },
  cluster: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },

  // ---- body --------------------------------------------------------------
  body: {
    minHeight: 0,
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 336px",
  },
  displayCol: {
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },

  // ---- scope display -----------------------------------------------------
  screen: {
    position: "relative",
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    margin: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.lineStrong,
    backgroundColor: colors.screen,
    backgroundImage: graticule,
    backgroundSize: "40px 40px",
    backgroundPosition: "center center",
    boxShadow: "inset 0 0 70px rgba(0, 0, 0, 0.6)",
    "::before": {
      content: "",
      position: "absolute",
      left: 0,
      right: 0,
      top: "50%",
      height: 1,
      backgroundColor: colors.screenAxis,
    },
    "::after": {
      content: "",
      position: "absolute",
      top: 0,
      bottom: 0,
      left: "50%",
      width: 1,
      backgroundColor: colors.screenAxis,
    },
  },
  osd: {
    position: "absolute",
    display: "flex",
    flexDirection: "column",
    gap: 3,
    zIndex: 1,
  },
  osdTopLeft: { top: 12, left: 14 },
  osdTopRight: { top: 12, right: 14, alignItems: "flex-end" },
  osdBottom: { bottom: 12, left: 14, right: 14 },
  osdLine: {
    color: colors.textMuted,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 11,
    lineHeight: "15px",
    fontVariantNumeric: "tabular-nums",
  },
  osdScale: {
    display: "flex",
    justifyContent: "space-between",
    color: colors.textSoft,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 10,
    lineHeight: "14px",
    fontVariantNumeric: "tabular-nums",
  },
  screenCenter: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    textAlign: "center",
    pointerEvents: "none",
  },
  centerTitle: {
    margin: 0,
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: 0.3,
  },
  centerHint: {
    margin: 0,
    maxWidth: 320,
    color: colors.textSoft,
    fontSize: 11,
    lineHeight: "16px",
  },

  // ---- command dock ------------------------------------------------------
  dock: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
    padding: "12px 16px",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.line,
    backgroundColor: colors.panel,
  },
  dockGroup: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  dockDivider: {
    width: 1,
    alignSelf: "stretch",
    backgroundColor: colors.line,
  },

  // ---- instrument rail ---------------------------------------------------
  rail: {
    minHeight: 0,
    overflow: "auto",
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 14,
    borderLeftWidth: 1,
    borderLeftStyle: "solid",
    borderLeftColor: colors.line,
    backgroundColor: colors.panel,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: 12,
    borderRadius: 9,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.line,
    backgroundColor: colors.panelMuted,
  },
  cardHeader: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 10,
  },
  cardTitle: {
    margin: 0,
    fontSize: 11,
    lineHeight: "14px",
    fontWeight: 700,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: colors.textMuted,
  },
  cardMeta: {
    color: colors.textSoft,
    fontSize: 11,
    lineHeight: "14px",
    fontVariantNumeric: "tabular-nums",
  },
  helperText: {
    margin: 0,
    color: colors.textSoft,
    fontSize: 11,
    lineHeight: "16px",
  },

  // ---- channels ----------------------------------------------------------
  channelRow: {
    display: "grid",
    gridTemplateColumns: "auto auto minmax(0, 1fr)",
    alignItems: "center",
    gap: 8,
  },
  swatch: {
    width: 10,
    height: 10,
    borderRadius: 3,
  },
  channelTag: {
    color: colors.textMuted,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 11,
    fontWeight: 600,
    fontVariantNumeric: "tabular-nums",
  },
  channelVar: {
    color: colors.text,
    fontSize: 12,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  // ---- key/value grids (RT + device info) --------------------------------
  kvGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 8,
  },
  kv: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0,
  },
  kvLabel: {
    color: colors.textSoft,
    fontSize: 10,
    lineHeight: "13px",
    fontWeight: 600,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  kvValue: {
    color: colors.text,
    fontSize: 13,
    lineHeight: "16px",
    fontVariantNumeric: "tabular-nums",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  // ---- snapshots ---------------------------------------------------------
  snapRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: 8,
    alignItems: "center",
    paddingTop: 8,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.line,
  },
  snapTitle: {
    fontSize: 12,
    lineHeight: "16px",
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  snapMeta: {
    color: colors.textSoft,
    fontSize: 10,
    lineHeight: "14px",
    fontVariantNumeric: "tabular-nums",
  },

  // ---- state badge -------------------------------------------------------
  stateBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    minHeight: 28,
    padding: "0 12px",
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.lineStrong,
    backgroundColor: colors.haltSoft,
    color: colors.halt,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    fontVariantNumeric: "tabular-nums",
  },
  stateRun: { backgroundColor: colors.runSoft, color: colors.run, borderColor: "#1c5236" },
  stateAcquire: {
    backgroundColor: colors.acquireSoft,
    color: colors.acquire,
    borderColor: "#5a4710",
  },
  stateHalt: {
    backgroundColor: colors.haltSoft,
    color: colors.halt,
    borderColor: colors.lineStrong,
  },
  stateFault: { backgroundColor: colors.dangerSoft, color: colors.danger, borderColor: "#5a2424" },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: "currentColor",
  },
  dotPulse: {
    animationName: pulse,
    animationDuration: "1.4s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  },

  // small inline status (app readiness)
  miniStatus: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    color: colors.textSoft,
    fontSize: 11,
    fontVariantNumeric: "tabular-nums",
  },
  // ---- buttons -----------------------------------------------------------
  btn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    minHeight: 36,
    padding: "0 14px",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.lineStrong,
    borderRadius: 7,
    backgroundColor: colors.panelRaised,
    color: colors.text,
    font: "inherit",
    fontSize: 13,
    fontWeight: 650,
    cursor: "pointer",
    transitionProperty: "background-color, border-color, color, scale",
    transitionDuration: "130ms",
    ":hover": { backgroundColor: "#252d3a" },
    ":active": { scale: 0.97 },
    ":disabled": { opacity: 0.4, cursor: "not-allowed", scale: 1 },
  },
  btnSmall: {
    minHeight: 30,
    padding: "0 10px",
    fontSize: 12,
    fontWeight: 600,
  },
  btnPrimary: {
    borderColor: colors.accentStrong,
    backgroundColor: colors.accentStrong,
    color: "#04121c",
    ":hover": { backgroundColor: colors.accent },
  },
  btnRun: {
    borderColor: "#2f7d52",
    backgroundColor: "#1a4f33",
    color: colors.run,
    ":hover": { backgroundColor: "#225f3e" },
  },
  btnStop: {
    borderColor: "#7d3a36",
    backgroundColor: "#4a201e",
    color: colors.danger,
    ":hover": { backgroundColor: "#5c2825" },
  },
  btnActive: {
    borderColor: colors.accent,
    color: colors.accent,
    backgroundColor: colors.accentSoft,
  },

  // ---- fields ------------------------------------------------------------
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 5,
    minWidth: 0,
  },
  fieldLabel: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: "14px",
    fontWeight: 600,
  },
  input: {
    width: "100%",
    minHeight: 34,
    boxSizing: "border-box",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.lineStrong,
    borderRadius: 6,
    backgroundColor: colors.screen,
    color: colors.text,
    padding: "0 10px",
    font: "inherit",
    fontSize: 13,
    fontVariantNumeric: "tabular-nums",
    "::placeholder": { color: colors.textSoft },
    ":focus": { borderColor: colors.accent, outlineStyle: "none" },
  },
  select: {
    minHeight: 34,
    boxSizing: "border-box",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.lineStrong,
    borderRadius: 6,
    backgroundColor: colors.panelRaised,
    color: colors.text,
    padding: "0 10px",
    font: "inherit",
    fontSize: 13,
    cursor: "pointer",
    ":focus": { borderColor: colors.accent, outlineStyle: "none" },
  },
  portSelect: {
    maxWidth: 230,
  },

  // ---- popover -----------------------------------------------------------
  popoverAnchor: {
    position: "relative",
    display: "inline-flex",
  },
  popoverPanel: {
    position: "absolute",
    bottom: "calc(100% + 10px)",
    left: 0,
    zIndex: 50,
    width: 280,
    display: "flex",
    flexDirection: "column",
    gap: 12,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.lineStrong,
    backgroundColor: colors.panelRaised,
    boxShadow: "0 18px 40px rgba(0, 0, 0, 0.55)",
  },
  popoverHeader: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 8,
  },
  popoverRow: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 10,
  },
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 40,
    borderWidth: 0,
    padding: 0,
    cursor: "default",
    backgroundColor: "rgba(5, 7, 11, 0.45)",
  },

  // ---- error -------------------------------------------------------------
  errorWrap: {
    padding: "0 16px 8px",
  },
  errorBanner: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 12px",
    borderRadius: 7,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#5a2424",
    backgroundColor: colors.dangerSoft,
    color: colors.danger,
    fontSize: 12,
    lineHeight: "16px",
  },
});
