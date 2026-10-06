/** 64x64 inline SVG icons as data URIs, one per tool (contracts §3.1). */
export interface Icon {
  src: string;
  mimeType: "image/svg+xml";
  sizes: string[];
}

const GLYPHS: Record<string, string> = {
  // plan: checklist
  handle_situation:
    '<path d="M18 20h6M18 32h6M18 44h6" stroke="#fff" stroke-width="4" stroke-linecap="round"/><path d="M30 20h18M30 32h18M30 44h12" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".8"/>',
  // progress ring + tick
  get_status:
    '<circle cx="32" cy="32" r="14" fill="none" stroke="#fff" stroke-width="4" opacity=".4"/><path d="M24 33l6 6 11-13" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>',
  answer_decision:
    '<path d="M16 34l10 10 22-26" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>',
  // receipt
  list_actions:
    '<path d="M20 14h24v38l-4-3-4 3-4-3-4 3-4-3-4 3z" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round"/><path d="M26 24h12M26 32h12" stroke="#fff" stroke-width="4" stroke-linecap="round"/>',
  explain_action:
    '<circle cx="32" cy="32" r="16" fill="none" stroke="#fff" stroke-width="4"/><path d="M32 30v10" stroke="#fff" stroke-width="5" stroke-linecap="round"/><circle cx="32" cy="23.5" r="2.8" fill="#fff"/>',
  object_to_action:
    '<path d="M32 14v22" stroke="#fff" stroke-width="6" stroke-linecap="round"/><circle cx="32" cy="46" r="3.6" fill="#fff"/>',
  // shield
  list_rules:
    '<path d="M32 12l16 6v12c0 10-7 18-16 22-9-4-16-12-16-22V18z" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round"/><path d="M25 32l5 5 9-10" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  // sliders
  change_rule:
    '<path d="M16 22h32M16 42h32" stroke="#fff" stroke-width="4" stroke-linecap="round"/><circle cx="26" cy="22" r="5" fill="#fff"/><circle cx="40" cy="42" r="5" fill="#fff"/>',
  // undo arrow
  undo_action:
    '<path d="M24 20l-9 9 9 9" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 29h20a12 12 0 0 1 0 24h-8" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>',
  get_ledger_page:
    '<path d="M16 20h32M16 32h32M16 44h32" stroke="#fff" stroke-width="4" stroke-linecap="round"/><path d="M26 16v32" stroke="#fff" stroke-width="3" opacity=".6"/>',
  get_plan:
    '<path d="M18 22h28M18 32h28M18 42h18" stroke="#fff" stroke-width="4" stroke-linecap="round"/>',
};

const COLORS: Record<string, string> = {
  handle_situation: "#2563eb",
  get_status: "#0891b2",
  answer_decision: "#16a34a",
  list_actions: "#7c3aed",
  explain_action: "#0284c7",
  object_to_action: "#d97706",
  list_rules: "#475569",
  change_rule: "#be185d",
  undo_action: "#dc2626",
  get_ledger_page: "#7c3aed",
  get_plan: "#2563eb",
};

export function svgFor(tool: string): string {
  const color = COLORS[tool] ?? "#334155";
  const glyph = GLYPHS[tool] ?? "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" rx="14" fill="${color}"/>${glyph}</svg>`;
}

export function iconFor(tool: string): Icon {
  return {
    src: `data:image/svg+xml;base64,${Buffer.from(svgFor(tool)).toString("base64")}`,
    mimeType: "image/svg+xml",
    sizes: ["64x64"],
  };
}

export function serverIcon(): Icon {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" rx="14" fill="#0f172a"/><path d="M20 46V18h13a8 8 0 0 1 0 16H20m13 0a8 8 0 0 1 0 16H20" fill="none" stroke="#f8fafc" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return { src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, mimeType: "image/svg+xml", sizes: ["64x64"] };
}
