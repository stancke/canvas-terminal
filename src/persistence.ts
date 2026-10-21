import type { TerminalState } from "./terminal-window";

const STORAGE_KEY = "canvas-terminal.layout.v1";

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
  geom?: SavedTerminal;
}

function cloneSavedTerminal(state: TerminalState): SavedTerminal {
  return {
    x: state.x,
    y: state.y,
    w: state.w,
    h: state.h,
    shell: state.shellId,
    cwd: state.cwd,
    title: state.title,
    maximized: state.maximized,
    geom: state.savedGeom ? cloneSavedTerminal(state.savedGeom) : undefined,
  };
}

export interface SavedLayout {
  view: SavedView;
  terminals: SavedTerminal[];
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

export function saveLayout(view: SavedView, terminals: TerminalState[]): void {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    const payload: SavedLayout = {
      view,
      terminals: terminals.map((t) => cloneSavedTerminal(t)),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignora erros de quota/escrita.
    }
  }, 500);
}

export function loadLayout(): SavedLayout | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SavedLayout;
  } catch {
    return null;
  }
}
