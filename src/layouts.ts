/**
 * Layouts de terminais: arranjos reutilizáveis (posição relativa, shell, pasta
 * e comando de inicialização de cada janela) que podem ser aplicados a
 * qualquer área de trabalho.
 */

import type { TerminalState } from "./terminal-window";

const STORAGE_KEY = "canvas-terminal.layouts.v1";

/** Posição/tamanho como fração (0..1) da área onde o layout é aplicado. */
export interface LayoutSlot {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Vazio = shell padrão. */
  shell: string;
  /** Vazio = pasta da área de trabalho. */
  cwd: string;
  /** Vazio = título automático. */
  title: string;
  startupCommand: string;
  /** Falso = comando manual, disparado pelo botão Executar do terminal. */
  startupAuto?: boolean;
}

export interface SavedLayout {
  id: string;
  name: string;
  slots: LayoutSlot[];
  builtin?: boolean;
}

export interface WorldRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Espaço entre janelas e nas bordas, em unidades do canvas. */
export const LAYOUT_GAP = 8;

function slot(x: number, y: number, w: number, h: number): LayoutSlot {
  return { x, y, w, h, shell: "", cwd: "", title: "", startupCommand: "" };
}

export const BUILTIN_LAYOUTS: SavedLayout[] = [
  {
    id: "builtin-side-by-side",
    name: "Lado a lado",
    builtin: true,
    slots: [slot(0, 0, 0.5, 1), slot(0.5, 0, 0.5, 1)],
  },
  {
    id: "builtin-stacked",
    name: "Empilhado",
    builtin: true,
    slots: [slot(0, 0, 1, 0.5), slot(0, 0.5, 1, 0.5)],
  },
  {
    id: "builtin-columns-3",
    name: "Três colunas",
    builtin: true,
    slots: [slot(0, 0, 1 / 3, 1), slot(1 / 3, 0, 1 / 3, 1), slot(2 / 3, 0, 1 / 3, 1)],
  },
  {
    id: "builtin-main-2",
    name: "Principal + 2",
    builtin: true,
    slots: [slot(0, 0, 0.6, 1), slot(0.6, 0, 0.4, 0.5), slot(0.6, 0.5, 0.4, 0.5)],
  },
  {
    id: "builtin-grid-2x2",
    name: "Grade 2×2",
    builtin: true,
    slots: [slot(0, 0, 0.5, 0.5), slot(0.5, 0, 0.5, 0.5), slot(0, 0.5, 0.5, 0.5), slot(0.5, 0.5, 0.5, 0.5)],
  },
];

function makeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseSlot(value: unknown): LayoutSlot | null {
  if (typeof value !== "object" || value === null) return null;
  const s = value as Record<string, unknown>;
  const x = num(s.x);
  const y = num(s.y);
  const w = num(s.w);
  const h = num(s.h);
  if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) {
    return null;
  }
  const text = (field: unknown) => (typeof field === "string" ? field : "");
  return {
    x,
    y,
    w,
    h,
    shell: text(s.shell),
    cwd: text(s.cwd),
    title: text(s.title),
    startupCommand: text(s.startupCommand),
    startupAuto: s.startupAuto !== false,
  };
}

export function loadLayouts(): SavedLayout[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const layouts: SavedLayout[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const l = entry as Record<string, unknown>;
      const slots = Array.isArray(l.slots)
        ? l.slots.map(parseSlot).filter((s): s is LayoutSlot => s !== null)
        : [];
      if (slots.length === 0) continue;
      layouts.push({
        id: typeof l.id === "string" && l.id ? l.id : makeId(),
        name:
          typeof l.name === "string" && l.name.trim()
            ? l.name.trim()
            : `Layout ${layouts.length + 1}`,
        slots,
      });
    }
    return layouts;
  } catch {
    return [];
  }
}

export function saveLayouts(layouts: SavedLayout[]): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(layouts.filter((layout) => !layout.builtin)),
    );
  } catch {
    // Ignora quota/escrita bloqueada.
  }
}

/** Geometria real de uma janela (a restaurada, quando está maximizada). */
function geometryOf(state: TerminalState): WorldRect {
  const g = state.maximized && state.savedGeom ? state.savedGeom : state;
  return { x: g.x, y: g.y, w: g.w, h: g.h };
}

/**
 * Registra o arranjo atual como layout: as posições viram frações do retângulo
 * que envolve todas as janelas. `details` inclui shell, pasta e comando.
 */
export function captureLayout(
  name: string,
  terminals: TerminalState[],
  details: boolean,
): SavedLayout | null {
  if (terminals.length === 0) return null;
  const rects = terminals.map(geometryOf);
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  const width = Math.max(right - left, 1);
  const height = Math.max(bottom - top, 1);

  return {
    id: makeId(),
    name: name.trim() || "Layout",
    slots: terminals.map((terminal, index) => ({
      x: (rects[index].x - left) / width,
      y: (rects[index].y - top) / height,
      w: rects[index].w / width,
      h: rects[index].h / height,
      shell: details ? terminal.shellId : "",
      cwd: details ? terminal.cwd : "",
      title: details ? terminal.title : "",
      startupCommand: details ? terminal.startupCommand : "",
      startupAuto: details ? terminal.startupAuto : true,
    })),
  };
}

/** Converte um slot em retângulo do canvas dentro de `area`, com folga entre janelas. */
export function slotRect(layoutSlot: LayoutSlot, area: WorldRect): WorldRect {
  const half = LAYOUT_GAP / 2;
  return {
    x: area.x + layoutSlot.x * area.w + half,
    y: area.y + layoutSlot.y * area.h + half,
    w: Math.max(layoutSlot.w * area.w - LAYOUT_GAP, 1),
    h: Math.max(layoutSlot.h * area.h - LAYOUT_GAP, 1),
  };
}
