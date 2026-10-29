/**
 * Temas do aplicativo e paletas do terminal.
 *
 * A escolha vive em `localStorage`; sem escolha explícita o app segue a
 * preferência do sistema (`prefers-color-scheme`). O tema muda ao mesmo tempo
 * a interface (variáveis CSS em `data-theme`) e a paleta ANSI de cada terminal
 * xterm.js aberto.
 */

export type ThemeName =
  | "catppuccin-latte"
  | "catppuccin-frappe"
  | "catppuccin-macchiato"
  | "catppuccin-mocha"
  | "one-light"
  | "one-dark"
  | "apple-light"
  | "apple-dark"
  | "neon-retro"
  | "matrix";

export interface XtermPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface ThemePreview {
  background: string;
  surface: string;
  accent: string;
  text: string;
}

export interface ThemeDefinition {
  id: ThemeName;
  name: string;
  group: ThemeGroupName;
  mode: "light" | "dark";
  preview: ThemePreview;
  terminal: XtermPalette;
}

export type ThemeGroupName = "Catppuccin" | "One" | "Apple" | "Retro";

export const THEME_GROUPS: Array<{ label: ThemeGroupName; themes: ThemeName[] }> = [
  {
    label: "Catppuccin",
    themes: [
      "catppuccin-latte",
      "catppuccin-frappe",
      "catppuccin-macchiato",
      "catppuccin-mocha",
    ],
  },
  { label: "One", themes: ["one-light", "one-dark"] },
  { label: "Apple", themes: ["apple-light", "apple-dark"] },
  { label: "Retro", themes: ["neon-retro", "matrix"] },
];

const THEMES: Record<ThemeName, ThemeDefinition> = {
  "catppuccin-latte": {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    group: "Catppuccin",
    mode: "light",
    preview: { background: "#eff1f5", surface: "#e6e9ef", accent: "#1e66f5", text: "#4c4f69" },
    terminal: {
      background: "#eff1f5",
      foreground: "#4c4f69",
      cursor: "#1e66f5",
      cursorAccent: "#eff1f5",
      selectionBackground: "#bcc0cc",
      black: "#5c5f77",
      red: "#d20f39",
      green: "#40a02b",
      yellow: "#df8e1d",
      blue: "#1e66f5",
      magenta: "#8839ef",
      cyan: "#179299",
      white: "#acb0be",
      brightBlack: "#6c6f85",
      brightRed: "#d20f39",
      brightGreen: "#40a02b",
      brightYellow: "#df8e1d",
      brightBlue: "#1e66f5",
      brightMagenta: "#8839ef",
      brightCyan: "#179299",
      brightWhite: "#bcc0cc",
    },
  },
  "catppuccin-frappe": {
    id: "catppuccin-frappe",
    name: "Catppuccin Frappé",
    group: "Catppuccin",
    mode: "dark",
    preview: { background: "#303446", surface: "#292c3c", accent: "#8caaee", text: "#c6d0f5" },
    terminal: {
      background: "#303446",
      foreground: "#c6d0f5",
      cursor: "#f4b8e4",
      cursorAccent: "#303446",
      selectionBackground: "#51576d",
      black: "#51576d",
      red: "#e78284",
      green: "#a6d189",
      yellow: "#e5c890",
      blue: "#8caaee",
      magenta: "#f4b8e4",
      cyan: "#81c8be",
      white: "#b5bfe2",
      brightBlack: "#626880",
      brightRed: "#e78284",
      brightGreen: "#a6d189",
      brightYellow: "#e5c890",
      brightBlue: "#8caaee",
      brightMagenta: "#f4b8e4",
      brightCyan: "#81c8be",
      brightWhite: "#a5adce",
    },
  },
  "catppuccin-macchiato": {
    id: "catppuccin-macchiato",
    name: "Catppuccin Macchiato",
    group: "Catppuccin",
    mode: "dark",
    preview: { background: "#24273a", surface: "#1e2030", accent: "#8aadf4", text: "#cad3f5" },
    terminal: {
      background: "#24273a",
      foreground: "#cad3f5",
      cursor: "#f5bde6",
      cursorAccent: "#24273a",
      selectionBackground: "#494d64",
      black: "#494d64",
      red: "#ed8796",
      green: "#a6da95",
      yellow: "#eed49f",
      blue: "#8aadf4",
      magenta: "#f5bde6",
      cyan: "#8bd5ca",
      white: "#b8c0e0",
      brightBlack: "#5b6078",
      brightRed: "#ed8796",
      brightGreen: "#a6da95",
      brightYellow: "#eed49f",
      brightBlue: "#8aadf4",
      brightMagenta: "#f5bde6",
      brightCyan: "#8bd5ca",
      brightWhite: "#a5adcb",
    },
  },
  "catppuccin-mocha": {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    group: "Catppuccin",
    mode: "dark",
    preview: { background: "#1e1e2e", surface: "#181825", accent: "#89b4fa", text: "#cdd6f4" },
    terminal: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5c2e7",
      cursorAccent: "#1e1e2e",
      selectionBackground: "#45475a",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
  },
  "one-light": {
    id: "one-light",
    name: "One Light",
    group: "One",
    mode: "light",
    preview: { background: "#fafafa", surface: "#f0f0f0", accent: "#4078f2", text: "#383a42" },
    terminal: {
      background: "#fafafa",
      foreground: "#383a42",
      cursor: "#4078f2",
      cursorAccent: "#ffffff",
      selectionBackground: "#d0d0d0",
      black: "#383a42",
      red: "#e45649",
      green: "#50a14f",
      yellow: "#c18401",
      blue: "#4078f2",
      magenta: "#a626a4",
      cyan: "#0184bc",
      white: "#a0a1a7",
      brightBlack: "#4f525e",
      brightRed: "#e45649",
      brightGreen: "#50a14f",
      brightYellow: "#c18401",
      brightBlue: "#4078f2",
      brightMagenta: "#a626a4",
      brightCyan: "#0184bc",
      brightWhite: "#ffffff",
    },
  },
  "one-dark": {
    id: "one-dark",
    name: "One Dark",
    group: "One",
    mode: "dark",
    preview: { background: "#282c34", surface: "#21252b", accent: "#61afef", text: "#abb2bf" },
    terminal: {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#528bff",
      cursorAccent: "#282c34",
      selectionBackground: "#3e4451",
      black: "#3f4451",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
      brightBlack: "#4f5666",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    },
  },
  "apple-light": {
    id: "apple-light",
    name: "Apple Light",
    group: "Apple",
    mode: "light",
    preview: { background: "#f5f5f7", surface: "#ffffff", accent: "#0071e3", text: "#1d1d1f" },
    terminal: {
      background: "#ffffff",
      foreground: "#1d1d1f",
      cursor: "#0071e3",
      cursorAccent: "#ffffff",
      selectionBackground: "#b3d7ff",
      black: "#1d1d1f",
      red: "#d70015",
      green: "#1a7f37",
      yellow: "#9a6700",
      blue: "#0071e3",
      magenta: "#8944ab",
      cyan: "#007c89",
      white: "#6e6e73",
      brightBlack: "#86868b",
      brightRed: "#ff3b30",
      brightGreen: "#34c759",
      brightYellow: "#ffcc00",
      brightBlue: "#0a84ff",
      brightMagenta: "#bf5af2",
      brightCyan: "#64d2ff",
      brightWhite: "#1d1d1f",
    },
  },
  "apple-dark": {
    id: "apple-dark",
    name: "Apple Dark",
    group: "Apple",
    mode: "dark",
    preview: { background: "#1c1c1e", surface: "#161617", accent: "#0a84ff", text: "#f5f5f7" },
    terminal: {
      background: "#1c1c1e",
      foreground: "#f5f5f7",
      cursor: "#0a84ff",
      cursorAccent: "#1c1c1e",
      selectionBackground: "#3a3a3c",
      black: "#48484a",
      red: "#ff453a",
      green: "#30d158",
      yellow: "#ffd60a",
      blue: "#0a84ff",
      magenta: "#bf5af2",
      cyan: "#64d2ff",
      white: "#d1d1d6",
      brightBlack: "#636366",
      brightRed: "#ff6961",
      brightGreen: "#32d74b",
      brightYellow: "#ffe066",
      brightBlue: "#409cff",
      brightMagenta: "#da8fff",
      brightCyan: "#70d7ff",
      brightWhite: "#ffffff",
    },
  },
  "neon-retro": {
    id: "neon-retro",
    name: "Neon Retro",
    group: "Retro",
    mode: "dark",
    preview: { background: "#0a0a12", surface: "#111122", accent: "#00f0ff", text: "#e0f7ff" },
    terminal: {
      background: "#0a0a12",
      foreground: "#e0f7ff",
      cursor: "#00f0ff",
      cursorAccent: "#0a0a12",
      selectionBackground: "#1f1f35",
      black: "#1a1a2e",
      red: "#ff2a6d",
      green: "#05ffa1",
      yellow: "#ffee00",
      blue: "#00f0ff",
      magenta: "#ff00ff",
      cyan: "#00f0ff",
      white: "#c8e6ff",
      brightBlack: "#3a3a5c",
      brightRed: "#ff5c8a",
      brightGreen: "#5cffc3",
      brightYellow: "#fff566",
      brightBlue: "#5cffff",
      brightMagenta: "#ff5cff",
      brightCyan: "#5cffff",
      brightWhite: "#ffffff",
    },
  },
  matrix: {
    id: "matrix",
    name: "Matrix",
    group: "Retro",
    mode: "dark",
    preview: { background: "#000000", surface: "#051005", accent: "#00ff41", text: "#e8ffe8" },
    terminal: {
      background: "#000000",
      foreground: "#00ff41",
      cursor: "#00ff41",
      cursorAccent: "#000000",
      selectionBackground: "#0a280a",
      black: "#001a00",
      red: "#ff3333",
      green: "#00ff41",
      yellow: "#ccff00",
      blue: "#008f11",
      magenta: "#00ff41",
      cyan: "#00ff41",
      white: "#e8ffe8",
      brightBlack: "#003b00",
      brightRed: "#ff6666",
      brightGreen: "#33ff66",
      brightYellow: "#dfff33",
      brightBlue: "#00b815",
      brightMagenta: "#33ff66",
      brightCyan: "#33ff66",
      brightWhite: "#ffffff",
    },
  },
};

export function getTheme(id: ThemeName): ThemeDefinition {
  return THEMES[id];
}

const STORAGE_KEY = "canvas-terminal.theme.v1";

/** Temas antigos ("dark"/"light") continuam válidos e são migrados. */
const LEGACY: Record<string, ThemeName> = {
  dark: "one-dark",
  light: "one-light",
};

function isThemeName(value: string): value is ThemeName {
  return Object.prototype.hasOwnProperty.call(THEMES, value);
}

let current: ThemeName = "one-dark";
const listeners = new Set<(theme: ThemeName) => void>();

/** Tema salvo pelo usuário, ou `null` se ele nunca escolheu. */
export function storedTheme(): ThemeName | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (!value) return null;
    const migrated = LEGACY[value] ?? value;
    return isThemeName(migrated) ? migrated : null;
  } catch {
    return null;
  }
}

export function systemTheme(): ThemeName {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "one-light"
    : "one-dark";
}

export function currentTheme(): ThemeName {
  return current;
}

export function terminalPalette(): XtermPalette {
  return THEMES[current].terminal;
}

/**
 * Aplica o tema na raiz do documento. `persist = false` serve para o tema
 * herdado do sistema, que não deve virar escolha do usuário.
 */
export function applyTheme(theme: ThemeName, persist = true): void {
  current = theme;
  const definition = THEMES[theme];
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themeMode = definition.mode;
  // Deixa barras de rolagem e campos nativos coerentes com o tema.
  root.style.colorScheme = definition.mode;

  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Ignora quota/escrita bloqueada.
    }
  }

  for (const listener of listeners) listener(theme);
}

/** Notifica sempre que o tema muda (os terminais reaplicam a paleta do xterm). */
export function onThemeChange(listener: (theme: ThemeName) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initTheme(): ThemeName {
  const initial = storedTheme() ?? systemTheme();
  applyTheme(initial, false);

  // Enquanto o usuário não escolher explicitamente, segue o sistema.
  window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", () => {
    if (!storedTheme()) applyTheme(systemTheme(), false);
  });

  return initial;
}
