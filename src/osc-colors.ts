/**
 * Respostas às consultas de cor do terminal (OSC 4 e 10–19) e aviso de
 * mudança de esquema de cores (modo 2031).
 *
 * O xterm.js entende essas sequências, mas não responde: ele apenas emite
 * eventos internos. Programas como o OpenCode usam essas consultas para
 * descobrir a paleta do terminal (tema `system`) e, sem resposta, caem no
 * fallback e ficam com cores próprias — foi o que acontecia com o tema do app.
 *
 * Aqui registramos handlers de OSC/CSI que respondem com a paleta atual do
 * canvas-terminal, então qualquer TUI que siga a paleta do terminal acompanha
 * o tema escolhido no cabeçalho.
 */

import type { Terminal } from "@xterm/xterm";
import { currentTheme, getTheme, terminalPalette, type XtermPalette } from "./theme";

/** Handlers instalados em um terminal para responder/avisar sobre cores. */
export interface ColorReporting {
  /** Avisa programas que habilitaram o modo 2031 que o tema mudou. */
  notifyThemeChange(mode: "light" | "dark"): void;
  /** Remove todos os handlers registrados. */
  dispose(): void;
}

function currentThemeMode(): "light" | "dark" {
  return getTheme(currentTheme()).mode;
}

/** Cores especiais que podem ser consultadas por OSC 10–19. */
const SPECIAL_COLORS: Array<[number, (palette: XtermPalette) => string]> = [
  [10, (palette) => palette.foreground],
  [11, (palette) => palette.background],
  [12, (palette) => palette.cursor],
  [13, (palette) => palette.foreground],
  [14, (palette) => palette.background],
  [15, (palette) => palette.foreground],
  [16, (palette) => palette.background],
  [17, (palette) => palette.selectionBackground],
  [19, (palette) => palette.foreground],
];

/** Cores ANSI 0–15 na ordem usada pela paleta do xterm.js. */
const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const satisfies ReadonlyArray<keyof XtermPalette>;

/** Níveis do cubo 6×6×6 usado pelos índices 16–231. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function hex2(value: number): string {
  return value.toString(16).padStart(2, "0");
}

/**
 * Converte `#rrggbb` para o formato de resposta do xterm
 * (`rgb:rrrr/gggg/bbbb`, 16 bits por canal).
 */
function toRgbSpec(hex: string): string {
  let value = hex.trim().replace(/^#/, "");
  if (value.length === 3) {
    value = value
      .split("")
      .map((char) => char + char)
      .join("");
  }
  if (value.length !== 6) return "rgb:0000/0000/0000";
  const red = value.slice(0, 2);
  const green = value.slice(2, 4);
  const blue = value.slice(4, 6);
  return `rgb:${red}${red}/${green}${green}/${blue}${blue}`;
}

/** Cor de um índice da paleta de 256 cores. */
function indexedColor(palette: XtermPalette, index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null;
  if (index < 16) return toRgbSpec(palette[ANSI_KEYS[index]]);

  if (index < 232) {
    const offset = index - 16;
    const red = CUBE_LEVELS[Math.floor(offset / 36)];
    const green = CUBE_LEVELS[Math.floor(offset / 6) % 6];
    const blue = CUBE_LEVELS[offset % 6];
    return toRgbSpec(`#${hex2(red)}${hex2(green)}${hex2(blue)}`);
  }

  const gray = hex2(8 + (index - 232) * 10);
  return toRgbSpec(`#${gray}${gray}${gray}`);
}

/** Responde uma consulta simples (`OSC 10;?`) com a cor pedida. */
function specialColorHandler(
  code: number,
  color: (palette: XtermPalette) => string,
  write: (data: string) => void,
): (data: string) => boolean {
  return (data) => {
    const parts = data.split(";");
    // Só tratamos consultas; comandos de definir cor seguem para o xterm.
    if (!parts.every((part) => part === "?")) return false;
    const spec = toRgbSpec(color(terminalPalette()));
    write(`\x1b]${code};${parts.map(() => spec).join(";")}\x1b\\`);
    return true;
  };
}

/**
 * Registra os handlers de consulta de cor em um terminal.
 */
export function installColorReporting(
  term: Terminal,
  write: (data: string) => void,
): ColorReporting {
  /**
   * Se o programa habilitou o modo 2031 (`CSI ? 2031 h`), ele quer receber
   * `CSI ? 997 ; 1 n` (escuro) / `2 n` (claro) quando o esquema mudar. É o que
   * permite o OpenCode repintar na hora ao trocar o tema no cabeçalho.
   */
  let reportsColorScheme = false;
  const notifyColorScheme = (mode: "light" | "dark"): void => {
    if (!reportsColorScheme) return;
    write(`\x1b[?997;${mode === "light" ? 2 : 1}n`);
  };

  const disposables = [
    // OSC 4: paleta indexada. Vem como pares "índice;?".
    term.parser.registerOscHandler(4, (data) => {
      const parts = data.split(";");
      const replies: string[] = [];
      let allQueries = parts.length % 2 === 0;

      for (let i = 0; i + 1 < parts.length; i += 2) {
        if (parts[i + 1] !== "?") {
          allQueries = false;
          continue;
        }
        const index = Number(parts[i]);
        const color = indexedColor(terminalPalette(), index);
        if (!color) {
          allQueries = false;
          continue;
        }
        replies.push(`\x1b]4;${index};${color}\x1b\\`);
      }

      if (!replies.length) return false;
      write(replies.join(""));
      // Mistura de consulta e definição: o xterm ainda precisa ver a definição.
      return allQueries;
    }),
    ...SPECIAL_COLORS.map(([code, color]) =>
      term.parser.registerOscHandler(code, specialColorHandler(code, color, write)),
    ),
    // Modo 2031: o programa pede para ser avisado de mudanças de esquema.
    term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (!params.some((param) => param === 2031)) return false;
      reportsColorScheme = true;
      notifyColorScheme(currentThemeMode());
      return false;
    }),
    term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (!params.some((param) => param === 2031)) return false;
      reportsColorScheme = false;
      return false;
    }),
    // DECRQM: sem isso o xterm responde "não reconhecido" e alguns programas
    // nem habilitam as notificações de esquema de cores.
    term.parser.registerCsiHandler(
      { prefix: "?", intermediates: "$", final: "p" },
      (params) => {
        if (!params.some((param) => param === 2031)) return false;
        write(`\x1b[?2031;${reportsColorScheme ? 1 : 2}$y`);
        return true;
      },
    ),
  ];

  return {
    notifyThemeChange(mode) {
      notifyColorScheme(mode);
    },
    dispose() {
      for (const disposable of disposables) disposable.dispose();
    },
  };
}
