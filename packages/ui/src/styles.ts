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

export const appStyles = stylex.create({
  root: {
    minHeight: "100vh",
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    WebkitFontSmoothing: "antialiased",
  },
  layout: {
    display: "grid",
    gridTemplateColumns: "minmax(300px, 360px) minmax(0, 1fr)",
    minHeight: "100vh",
  },
  leftPanel: {
    minHeight: 0,
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: colors.line,
    backgroundColor: colors.panel,
    display: "flex",
    flexDirection: "column",
  },
  brandBar: {
    padding: "18px 18px 14px",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.line,
  },
  brandRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  brandTitle: {
    margin: 0,
    fontSize: 18,
    lineHeight: "24px",
    fontWeight: 650,
    letterSpacing: 0,
    textWrap: "balance",
  },
  brandMeta: {
    margin: "4px 0 0",
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: "18px",
  },
  tabs: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: 4,
    marginTop: 16,
    padding: 4,
    backgroundColor: colors.panelMuted,
    borderRadius: 8,
  },
  tabButton: {
    minHeight: 36,
    borderWidth: 0,
    borderRadius: 6,
    backgroundColor: "transparent",
    color: colors.textMuted,
    font: "inherit",
    fontSize: 12,
    fontWeight: 620,
    cursor: "pointer",
    transitionProperty: "background-color, color, scale",
    transitionDuration: "140ms",
    ":hover": {
      color: colors.text,
    },
    ":active": {
      scale: 0.96,
    },
  },
  tabButtonActive: {
    backgroundColor: colors.panel,
    color: colors.text,
    boxShadow: "0 1px 2px rgba(17, 19, 24, 0.08)",
  },
  panelBody: {
    minHeight: 0,
    flex: 1,
    overflow: "auto",
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  sectionHeader: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 12,
  },
  sectionTitle: {
    margin: 0,
    fontSize: 12,
    lineHeight: "16px",
    fontWeight: 700,
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0,
  },
  helperText: {
    margin: 0,
    color: colors.textSoft,
    fontSize: 12,
    lineHeight: "18px",
    textWrap: "wrap",
  },
  fieldGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 10,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 5,
  },
  label: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: "14px",
    fontWeight: 640,
  },
  input: {
    width: "100%",
    minHeight: 36,
    boxSizing: "border-box",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.lineStrong,
    borderRadius: 6,
    backgroundColor: colors.panel,
    color: colors.text,
    padding: "0 10px",
    font: "inherit",
    fontSize: 13,
    fontVariantNumeric: "tabular-nums",
  },
  select: {
    width: "100%",
    minHeight: 32,
    boxSizing: "border-box",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.lineStrong,
    borderRadius: 6,
    backgroundColor: colors.panel,
    color: colors.text,
    padding: "0 10px",
    font: "inherit",
    fontSize: 13,
  },
  buttonRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
  },
  button: {
    minHeight: 40,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.lineStrong,
    borderRadius: 7,
    backgroundColor: colors.panel,
    color: colors.text,
    padding: "0 12px",
    font: "inherit",
    fontSize: 13,
    fontWeight: 650,
    cursor: "pointer",
    transitionProperty: "background-color, border-color, color, scale",
    transitionDuration: "140ms",
    ":hover": {
      backgroundColor: colors.panelMuted,
    },
    ":active": {
      scale: 0.96,
    },
  },
  primaryButton: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
    color: "#ffffff",
    ":hover": {
      backgroundColor: "#0f5dc9",
    },
  },
  dangerButton: {
    borderColor: "#efcbc8",
    color: colors.red,
    backgroundColor: "#fff7f6",
  },
  statusPill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    minHeight: 28,
    borderRadius: 999,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
    padding: "0 10px",
    fontSize: 12,
    lineHeight: "16px",
    fontWeight: 680,
    fontVariantNumeric: "tabular-nums",
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 999,
    backgroundColor: colors.green,
  },
  snapshotRow: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: 8,
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.line,
    padding: "10px 0",
  },
  rowTitle: {
    fontSize: 13,
    lineHeight: "18px",
    fontWeight: 650,
  },
  rowMeta: {
    color: colors.textSoft,
    fontSize: 11,
    lineHeight: "16px",
    fontVariantNumeric: "tabular-nums",
  },
  graphPane: {
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    padding: 16,
    gap: 12,
  },
  commandBar: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: 12,
    alignItems: "center",
  },
  commandGroup: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
  },
  graphStack: {
    minHeight: 0,
    flex: 1,
    display: "grid",
    gridTemplateRows: "repeat(5, minmax(0, 1fr))",
    gap: 10,
  },
  plotLane: {
    minHeight: 0,
    borderRadius: 8,
    backgroundColor: colors.plotBg,
    boxShadow: "inset 0 0 0 1px rgba(17, 19, 24, 0.10)",
    overflow: "hidden",
    display: "grid",
    gridTemplateColumns: "minmax(128px, 170px) minmax(0, 1fr)",
  },
  plotControl: {
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: colors.line,
    padding: 10,
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    gap: 10,
    backgroundColor: "#ffffff",
  },
  signalName: {
    margin: 0,
    fontSize: 13,
    lineHeight: "18px",
    fontWeight: 700,
  },
  signalMeta: {
    margin: "4px 0 0",
    color: colors.textSoft,
    fontSize: 11,
    lineHeight: "15px",
    fontVariantNumeric: "tabular-nums",
  },
  plotArea: {
    position: "relative",
    minWidth: 0,
    minHeight: 0,
  },
  svg: {
    display: "block",
    width: "100%",
    height: "100%",
  },
});
