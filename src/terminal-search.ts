import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";

/** Converte qualquer cor CSS (hex, rgba...) para #rrggbb, que o xterm exige. */
function colorToHex(value: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return "#888888";
  ctx.fillStyle = "#000000";
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function cssColor(name: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return colorToHex(value || "gray");
}

/** Barra de busca (Ctrl+Shift+F) flutuante sobre um terminal. */
export class TerminalSearch {
  readonly element: HTMLDivElement;
  private readonly addon = new SearchAddon({ highlightLimit: 2000 });
  private readonly input: HTMLInputElement;
  private readonly counter: HTMLSpanElement;
  private caseSensitive = false;
  private regex = false;

  constructor(
    private readonly term: Terminal,
    private readonly onClose: () => void,
  ) {
    term.loadAddon(this.addon);

    this.element = document.createElement("div");
    this.element.className = "term-search hidden";
    this.element.setAttribute("role", "search");

    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "term-search-input";
    this.input.placeholder = "Buscar no terminal";
    this.input.setAttribute("aria-label", "Buscar no terminal");
    this.input.spellcheck = false;

    this.counter = document.createElement("span");
    this.counter.className = "term-search-count";

    this.element.append(
      this.input,
      this.counter,
      this.button("Aa", "Diferenciar maiúsculas e minúsculas", "toggle", (btn) => {
        this.caseSensitive = !this.caseSensitive;
        btn.classList.toggle("on", this.caseSensitive);
        this.find(true);
      }),
      this.button(".*", "Expressão regular", "toggle", (btn) => {
        this.regex = !this.regex;
        btn.classList.toggle("on", this.regex);
        this.find(true);
      }),
      this.button("↑", "Anterior (Shift+Enter)", "", () => this.find(false, true)),
      this.button("↓", "Próximo (Enter)", "", () => this.find(false)),
      this.button("×", "Fechar (Esc)", "", () => this.close()),
    );

    // Sem isso o mousedown chegaria à janela, que devolve o foco ao xterm.
    for (const type of ["mousedown", "wheel", "dblclick", "contextmenu"]) {
      this.element.addEventListener(type, (event) => event.stopPropagation());
    }

    this.input.addEventListener("input", () => this.find(true));
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.find(false, event.shiftKey);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
    });

    this.addon.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (!this.input.value) {
        this.counter.textContent = "";
      } else if (resultCount === 0) {
        this.counter.textContent = "0";
      } else if (resultIndex < 0) {
        this.counter.textContent = `${resultCount}+`;
      } else {
        this.counter.textContent = `${resultIndex + 1}/${resultCount}`;
      }
      this.input.classList.toggle("no-match", !!this.input.value && resultCount === 0);
    });
  }

  get isOpen(): boolean {
    return !this.element.classList.contains("hidden");
  }

  open(): void {
    this.element.classList.remove("hidden");
    // Seleção atual vira o termo inicial, como em editores de código.
    const selection = this.term.getSelection();
    if (selection && !selection.includes("\n")) this.input.value = selection;
    this.input.focus();
    this.input.select();
    if (this.input.value) this.find(true);
  }

  close(): void {
    if (!this.isOpen) return;
    this.element.classList.add("hidden");
    this.addon.clearDecorations();
    this.counter.textContent = "";
    this.onClose();
  }

  private button(
    label: string,
    title: string,
    kind: string,
    action: (button: HTMLButtonElement) => void,
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = kind ? `term-search-btn ${kind}` : "term-search-btn";
    btn.textContent = label;
    btn.title = title;
    btn.setAttribute("aria-label", title);
    // Mantém o foco no campo de busca ao clicar nos botões.
    btn.addEventListener("mousedown", (event) => event.preventDefault());
    btn.addEventListener("click", () => action(btn));
    return btn;
  }

  private options(incremental: boolean): ISearchOptions {
    return {
      caseSensitive: this.caseSensitive,
      regex: this.regex,
      incremental,
      decorations: {
        matchBackground: cssColor("--hover"),
        matchBorder: cssColor("--accent-dim"),
        matchOverviewRuler: cssColor("--accent-dim"),
        activeMatchBackground: cssColor("--accent"),
        activeMatchBorder: cssColor("--accent-hover"),
        activeMatchColorOverviewRuler: cssColor("--accent"),
      },
    };
  }

  private find(incremental: boolean, backwards = false): void {
    const query = this.input.value;
    if (!query) {
      this.addon.clearDecorations();
      this.counter.textContent = "";
      this.input.classList.remove("no-match");
      return;
    }
    try {
      if (backwards) this.addon.findPrevious(query, this.options(false));
      else this.addon.findNext(query, this.options(incremental));
    } catch {
      // Regex inválida enquanto o usuário ainda digita.
      this.input.classList.add("no-match");
      this.counter.textContent = "";
    }
  }
}
