/**
 * Atalhos globais configuráveis do aplicativo.
 *
 * Apenas os atalhos do aplicativo (novo terminal, salvar, etc.) são
 * editáveis. Navegação no canvas (WASD, Q/E, roda do mouse) permanece fixa.
 */

const STORAGE_KEY = "canvas-terminal.shortcuts.v1";

export type ShortcutAction =
  | "new-terminal"
  | "save"
  | "new-workspace"
  | "close-terminal"
  | "quit"
  | "cycle-focus-forward"
  | "cycle-focus-backward"
  | "rename-terminal"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "toggle-fullscreen"
  | "toggle-theme-menu"
  | "open-settings";

export interface ShortcutBinding {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

const DEFAULTS: Record<ShortcutAction, ShortcutBinding> = {
  "new-terminal": { key: "t", ctrl: true, shift: false, alt: false },
  save: { key: "s", ctrl: true, shift: false, alt: false },
  "new-workspace": { key: "t", ctrl: true, shift: true, alt: false },
  "close-terminal": { key: "w", ctrl: true, shift: true, alt: false },
  quit: { key: "q", ctrl: true, shift: false, alt: false },
  "cycle-focus-forward": { key: "pagedown", ctrl: true, shift: false, alt: false },
  "cycle-focus-backward": { key: "pageup", ctrl: true, shift: false, alt: false },
  "rename-terminal": { key: "f2", ctrl: false, shift: false, alt: false },
  "zoom-in": { key: "=", ctrl: true, shift: false, alt: false },
  "zoom-out": { key: "-", ctrl: true, shift: false, alt: false },
  "zoom-reset": { key: "0", ctrl: true, shift: false, alt: false },
  "toggle-fullscreen": { key: "f11", ctrl: false, shift: false, alt: false },
  "toggle-theme-menu": { key: "l", ctrl: true, shift: true, alt: false },
  "open-settings": { key: ",", ctrl: true, shift: false, alt: false },
};

const LABELS: Record<ShortcutAction, string> = {
  "new-terminal": "Novo terminal",
  save: "Salvar estado do canvas",
  "new-workspace": "Nova área de trabalho",
  "close-terminal": "Fechar terminal",
  quit: "Sair do aplicativo",
  "cycle-focus-forward": "Próximo terminal",
  "cycle-focus-backward": "Terminal anterior",
  "rename-terminal": "Renomear terminal",
  "zoom-in": "Aumentar zoom",
  "zoom-out": "Diminuir zoom",
  "zoom-reset": "Resetar zoom",
  "toggle-fullscreen": "Tela cheia",
  "toggle-theme-menu": "Escolher tema",
  "open-settings": "Configurações",
};

let bindings: Record<ShortcutAction, ShortcutBinding> = load();

function load(): Record<ShortcutAction, ShortcutBinding> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULTS };
    const merged = { ...DEFAULTS };
    for (const action of Object.keys(DEFAULTS) as ShortcutAction[]) {
      const candidate = (parsed as Record<string, unknown>)[action];
      if (isBinding(candidate)) merged[action] = candidate;
    }
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

function isBinding(value: unknown): value is ShortcutBinding {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Record<string, unknown>;
  return (
    typeof b.key === "string" &&
    typeof b.ctrl === "boolean" &&
    typeof b.shift === "boolean" &&
    typeof b.alt === "boolean"
  );
}

export function saveBindings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    // Ignora quota/escrita bloqueada.
  }
}

export function resetBindings(): void {
  bindings = { ...DEFAULTS };
  saveBindings();
}

export function setBinding(action: ShortcutAction, binding: ShortcutBinding): void {
  bindings[action] = binding;
  saveBindings();
}

export function getBinding(action: ShortcutAction): ShortcutBinding {
  return { ...bindings[action] };
}

export function getLabel(action: ShortcutAction): string {
  return LABELS[action];
}

export function allActions(): ShortcutAction[] {
  return Object.keys(DEFAULTS) as ShortcutAction[];
}

/** Verifica se um evento de teclado corresponde a uma ação. */
export function matches(event: KeyboardEvent, action: ShortcutAction): boolean {
  const binding = bindings[action];
  if (!binding) return false;
  return (
    normalizeKey(event.key) === normalizeKey(binding.key) &&
    event.ctrlKey === binding.ctrl &&
    event.shiftKey === binding.shift &&
    event.altKey === binding.alt
  );
}

function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
}

/** Converte uma combinação em texto legível. */
export function format(binding: ShortcutBinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push("Ctrl");
  if (binding.alt) parts.push("Alt");
  if (binding.shift) parts.push("Shift");
  parts.push(capitalize(binding.key));
  return parts.join("+");
}

function capitalize(key: string): string {
  if (key === ",") return ",";
  if (key === "=") return "=";
  if (key === "-") return "-";
  if (key.length === 1) return key.toUpperCase();
  const map: Record<string, string> = {
    pagedown: "PageDown",
    pageup: "PageUp",
    f2: "F2",
    f11: "F11",
  };
  return map[key] ?? key;
}

/** Extrai uma combinação a partir de um evento de teclado. */
export function capture(event: KeyboardEvent): ShortcutBinding | null {
  const key = normalizeKey(event.key);
  if (["control", "shift", "alt", "meta", "capslock", "tab", "escape"].includes(key)) {
    return null;
  }
  return {
    key: event.key.length === 1 ? event.key.toLowerCase() : event.key,
    ctrl: event.ctrlKey || event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
  };
}
