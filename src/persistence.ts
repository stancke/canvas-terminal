import type { TerminalState } from "./terminal-window";

/**
 * Layout com múltiplas áreas de trabalho (abas). Cada área guarda sua própria
 * view (pan/zoom) e seus terminais.
 *
 * A chave antiga (`layout.v1`) é migrada automaticamente para uma única área.
 */

const STORAGE_KEY = "canvas-terminal.workspaces.v1";
const LEGACY_KEY = "canvas-terminal.layout.v1";

export interface SavedView {
  panX: number;
  panY: number;
  zoom: number;
}

export interface SavedTerminal {
  x: number;
  y: number;
  w: number;
  h: number;
  shell: string;
  cwd: string;
  title: string;
  maximized: boolean;
  minimized: boolean;
  geom?: SavedTerminal;
}

export interface SavedWorkspace {
  id: string;
  name: string;
  view: SavedView;
  terminals: SavedTerminal[];
  /** Índice do terminal que estava em foco ao sair (para reabrir no mesmo). */
  focusedIndex?: number;
}

export interface SavedWorkspaceLayout {
  activeId: string;
  workspaces: SavedWorkspace[];
}

interface LegacyLayout {
  view: SavedView;
  terminals: SavedTerminal[];
}

export function toSavedTerminal(state: TerminalState): SavedTerminal {
  return {
    x: state.x,
    y: state.y,
    w: state.w,
    h: state.h,
    shell: state.shellId,
    cwd: state.cwd,
    title: state.title,
    maximized: state.maximized,
    minimized: state.minimized,
    geom: state.savedGeom ? toSavedTerminal(state.savedGeom) : undefined,
  };
}

function makeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
}

function isSavedView(value: unknown): value is SavedView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.panX === "number" &&
    Number.isFinite(v.panX) &&
    typeof v.panY === "number" &&
    Number.isFinite(v.panY) &&
    typeof v.zoom === "number" &&
    Number.isFinite(v.zoom)
  );
}

function parseTerminals(value: unknown): SavedTerminal[] {
  if (!Array.isArray(value)) return [];
  const terminals: SavedTerminal[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const t = entry as Record<string, unknown>;
    if (
      typeof t.x !== "number" ||
      typeof t.y !== "number" ||
      typeof t.w !== "number" ||
      typeof t.h !== "number"
    ) {
      continue;
    }
    terminals.push({
      x: t.x,
      y: t.y,
      w: t.w,
      h: t.h,
      shell: typeof t.shell === "string" ? t.shell : "",
      cwd: typeof t.cwd === "string" ? t.cwd : "",
      title: typeof t.title === "string" ? t.title : "",
      maximized: t.maximized === true,
      minimized: t.minimized === true,
      geom:
        typeof t.geom === "object" && t.geom !== null
          ? parseTerminals([t.geom])[0]
          : undefined,
    });
  }
  return terminals;
}

function parseWorkspace(value: unknown, index: number): SavedWorkspace | null {
  if (typeof value !== "object" || value === null) return null;
  const w = value as Record<string, unknown>;
  if (!isSavedView(w.view)) return null;
  const focusedIndex =
    typeof w.focusedIndex === "number" &&
    Number.isInteger(w.focusedIndex) &&
    w.focusedIndex >= 0
      ? w.focusedIndex
      : undefined;
  return {
    id: typeof w.id === "string" && w.id ? w.id : makeId(),
    name:
      typeof w.name === "string" && w.name.trim()
        ? w.name.trim()
        : `Área ${index + 1}`,
    view: w.view,
    focusedIndex,
    terminals: parseTerminals(w.terminals),
  };
}

function parseWorkspaceLayout(value: unknown): SavedWorkspaceLayout | null {
  if (typeof value !== "object" || value === null) return null;
  const layout = value as Record<string, unknown>;
  if (!Array.isArray(layout.workspaces)) return null;

  const workspaces: SavedWorkspace[] = [];
  layout.workspaces.forEach((entry, index) => {
    const parsed = parseWorkspace(entry, index);
    if (parsed) workspaces.push(parsed);
  });
  if (workspaces.length === 0) return null;

  const activeId =
    typeof layout.activeId === "string" &&
    workspaces.some((w) => w.id === layout.activeId)
      ? layout.activeId
      : workspaces[0].id;

  return { activeId, workspaces };
}

function migrateLegacy(): SavedWorkspaceLayout | null {
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return null;
  const legacy = JSON.parse(raw) as LegacyLayout;
  if (!legacy || !isSavedView(legacy.view)) return null;
  const id = makeId();
  return {
    activeId: id,
    workspaces: [
      {
        id,
        name: "Área 1",
        view: legacy.view,
        terminals: parseTerminals(legacy.terminals),
      },
    ],
  };
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let pendingPayload: SavedWorkspaceLayout | null = null;

function writePending(): void {
  if (!pendingPayload) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pendingPayload));
  } catch {
    // Ignora erros de quota/escrita.
  }
  pendingPayload = null;
}

export function saveWorkspaces(layout: SavedWorkspaceLayout): void {
  pendingPayload = layout;
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    writePending();
  }, 500);
}

/** Grava imediatamente o último layout pendente (antes de fechar o app). */
export function flushSave(): void {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  writePending();
}

export function loadWorkspaces(): SavedWorkspaceLayout | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = parseWorkspaceLayout(JSON.parse(raw));
      if (parsed) return parsed;
    }
    return migrateLegacy();
  } catch {
    return null;
  }
}
