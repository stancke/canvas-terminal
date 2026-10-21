/**
 * Tema do app: escuro (padrão) e claro.
 *
 * A escolha vive em `localStorage`; sem escolha explícita o app segue a
 * preferência do sistema (`prefers-color-scheme`). O tema do xterm.js é uma
 * paleta separada (ANSI de 16 cores) e precisa ser reaplicado em cada terminal
 * aberto quando o tema muda.
 */

export type ThemeName = "dark" | "light";

const STORAGE_KEY = "canvas-terminal.theme.v1";

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

/** Paleta escura (base GitHub Dark), alinhada ao tema escuro do CSS. */
const DARK_TERMINAL: XtermPalette = {
  background: "#12171e",
  foreground: "#c9d1d9",
  cursor: "#4ea1ff",
  cursorAccent: "#12171e",
  selectionBackground: "#264f78",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

/** Paleta clara (base GitHub Light), com contraste suficiente em fundo branco. */
const LIGHT_TERMINAL: XtermPalette = {
  background: "#ffffff",
  foreground: "#1f2328",
  cursor: "#0969da",
  cursorAccent: "#ffffff",
  selectionBackground: "#b6dcfe",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#4d2d00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

let current: ThemeName = "dark";
const listeners = new Set<(theme: ThemeName) => void>();

/** Tema salvo pelo usuário, ou `null` se ele nunca escolheu. */
export function storedTheme(): ThemeName | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function systemTheme(): ThemeName {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function currentTheme(): ThemeName {
  return current;
}

export function terminalPalette(): XtermPalette {
  return current === "light" ? LIGHT_TERMINAL : DARK_TERMINAL;
}

export function themeLabel(theme: ThemeName = current): string {
  return theme === "light" ? "Tema claro" : "Tema escuro";
}

/**
 * Aplica o tema na raiz do documento. `persist = false` serve para o tema
 * herdado do sistema, que não deve virar escolha do usuário.
 */
export function applyTheme(theme: ThemeName, persist = true): void {
  current = theme;
  const root = document.documentElement;
  root.dataset.theme = theme;
  // Deixa barras de rolagem e campos nativos coerentes com o tema.
  root.style.colorScheme = theme;

  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Ignora quota/escrita bloqueada.
    }
  }

  for (const listener of listeners) listener(theme);
}

export function toggleTheme(): ThemeName {
  const next: ThemeName = current === "light" ? "dark" : "light";
  applyTheme(next);
  return next;
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
