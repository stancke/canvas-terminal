import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import {
  killTerminal,
  onPtyData,
  offPtyData,
  resizeTerminal,
  spawnTerminal,
  writeTerminal,
  type PtyEvent,
} from "./pty";
import { Canvas } from "./canvas";
import { onThemeChange, terminalPalette } from "./theme";

export interface TerminalState {
  id: number;
  shellId: string;
  cwd: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  maximized: boolean;
  savedGeom?: TerminalState;
}

const MIN_W = 240;
const MIN_H = 140;

/** Exibe um aviso temporário na barra de status do app. */
function warnClipboard(message: string): void {
  const hint = document.getElementById("hint");
  if (!hint) return;
  const original = hint.textContent || "";
  hint.textContent = `Clipboard: ${message}`;
  setTimeout(() => {
    if (hint.textContent === `Clipboard: ${message}`) {
      hint.textContent = original;
    }
  }, 3000);
}

export class TerminalWindow {
  readonly element: HTMLDivElement;
  readonly id: number;
  readonly shellId: string;
  readonly cwd: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  maximized = false;
  savedGeom?: TerminalState;

  private term: Terminal;
  private fitAddon: FitAddon;
  private termBody: HTMLDivElement;
  private titleEl!: HTMLSpanElement;
  private overlay!: HTMLDivElement;
  private canvas: Canvas;
  private disposed = false;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private fitThrottle: ReturnType<typeof setTimeout> | null = null;
  private lastCols = 0;
  private lastRows = 0;
  /** Remove os listeners de janela (drag/resize) quando a janela morre. */
  private listeners = new AbortController();
  /** Cancela a inscrição nas mudanças de tema (xterm). */
  private unsubscribeTheme?: () => void;

  onFocus?: (id: number) => void;
  onClose?: (id: number) => void;
  onRestart?: (state: TerminalState) => void;
  onChange?: () => void;

  constructor(
    canvas: Canvas,
    id: number,
    shellId: string,
    cwd: string,
    title: string,
    x: number,
    y: number,
    w: number,
    h: number,
  ) {
    this.canvas = canvas;
    this.id = id;
    this.shellId = shellId;
    this.cwd = cwd;
    this.title = title;
    this.x = x;
    this.y = y;
    this.w = Math.max(w, MIN_W);
    this.h = Math.max(h, MIN_H);

    this.element = document.createElement("div");
    this.element.className = "term-window";
    this.element.style.left = "0";
    this.element.style.top = "0";
    this.element.style.width = "0";
    this.element.style.height = "0";

    this.element.appendChild(this.buildTitlebar());
    this.termBody = document.createElement("div");
    this.termBody.className = "term-body";
    this.element.appendChild(this.termBody);
    this.element.appendChild(this.buildOverlay());
    this.element.appendChild(this.buildResizeHandles());

    this.term = new Terminal({
      fontFamily: '"Cascadia Mono", "JetBrains Mono", "DejaVu Sans Mono", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: terminalPalette(),
    });

    // O xterm guarda a paleta numa opção própria: trocar o tema do CSS não a
    // atualiza sozinho, então cada terminal vivo se inscreve aqui.
    this.unsubscribeTheme = onThemeChange(() => {
      if (!this.disposed) this.term.options.theme = terminalPalette();
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new WebLinksAddon());

    this.term.open(this.termBody);
    this.bindTerminalInput();
    this.bindWindowEvents();
    this.bindKeyboard();

    onPtyData(id, (event) => this.onPtyEvent(event));
    this.focus();
    this.render(canvas.zoom);
  }

  private buildTitlebar(): HTMLDivElement {
    const bar = document.createElement("div");
    bar.className = "term-titlebar";

    const dot = document.createElement("span");
    dot.className = `term-dot ${this.shellId}`;
    bar.appendChild(dot);

    this.titleEl = document.createElement("span");
    this.titleEl.className = "term-name";
    this.titleEl.textContent = this.title;
    bar.appendChild(this.titleEl);

    const controls = document.createElement("div");
    controls.className = "term-controls";

    const btnMin = document.createElement("button");
    btnMin.textContent = "−";
    btnMin.title = "Minimizar";
    btnMin.addEventListener("click", () => this.toggleMinimize());
    controls.appendChild(btnMin);

    const btnMax = document.createElement("button");
    btnMax.textContent = "□";
    btnMax.title = "Maximizar / Restaurar";
    btnMax.addEventListener("click", () => this.toggleMaximize());
    controls.appendChild(btnMax);

    const btnRestart = document.createElement("button");
    btnRestart.textContent = "↻";
    btnRestart.title = "Reiniciar terminal";
    btnRestart.addEventListener("click", () => this.restart());
    controls.appendChild(btnRestart);

    const btnClose = document.createElement("button");
    btnClose.className = "term-close";
    btnClose.textContent = "×";
    btnClose.title = "Fechar terminal (Ctrl+Shift+W)";
    btnClose.addEventListener("click", () => this.close());
    controls.appendChild(btnClose);

    bar.appendChild(controls);
    return bar;
  }

  private buildOverlay(): HTMLDivElement {
    this.overlay = document.createElement("div");
    this.overlay.className = "term-overlay hidden";

    const msg = document.createElement("span");
    msg.textContent = "Processo finalizado";
    this.overlay.appendChild(msg);

    const codeEl = document.createElement("span");
    codeEl.className = "exit-code";
    this.overlay.appendChild(codeEl);

    const restartBtn = document.createElement("button");
    restartBtn.textContent = "Reiniciar";
    restartBtn.addEventListener("click", () => this.restart());
    this.overlay.appendChild(restartBtn);

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Fechar";
    closeBtn.addEventListener("click", () => this.close());
    this.overlay.appendChild(closeBtn);

    return this.overlay;
  }

  private buildResizeHandles(): DocumentFragment {
    const frag = document.createDocumentFragment();
    const positions: Array<"n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"> = [
      "n",
      "s",
      "e",
      "w",
      "ne",
      "nw",
      "se",
      "sw",
    ];
    for (const pos of positions) {
      const h = document.createElement("div");
      h.className = `resize-handle ${pos}`;
      h.dataset.handle = pos;
      frag.appendChild(h);
    }
    return frag;
  }

  private bindTerminalInput(): void {
    this.term.onData(async (data) => {
      if (this.disposed) return;
      const encoder = new TextEncoder();
      await writeTerminal(this.id, encoder.encode(data));
    });
  }

  private bindWindowEvents(): void {
    this.element.addEventListener("mousedown", () => this.focus());

    this.element.addEventListener("wheel", (e) => {
      e.stopPropagation();
    });

    this.element.addEventListener("contextmenu", (e) => {
      if ((e.target as HTMLElement).closest(".term-titlebar")) {
        e.preventDefault();
        this.showTitlebarContextMenu(e.clientX, e.clientY);
      }
    });

    this.setupDrag();
    this.setupResize();

    this.element.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".term-titlebar")) {
        this.toggleMaximize();
      }
    });
  }

  private bindKeyboard(): void {
    this.term.onKey(async ({ domEvent }) => {
      const ev = domEvent as KeyboardEvent;
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.shiftKey && ev.key.toLowerCase() === "v") {
        ev.preventDefault();
        await this.paste();
        return;
      }
      if (mod && ev.key.toLowerCase() === "v") {
        ev.preventDefault();
        await this.paste();
        return;
      }
      if (mod && ev.key.toLowerCase() === "c") {
        if (this.term.hasSelection()) {
          ev.preventDefault();
          await this.copy();
          return;
        }
      }
    });
  }

  private async paste(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        const encoder = new TextEncoder();
        await writeTerminal(this.id, encoder.encode(text));
      }
    } catch (err) {
      warnClipboard(`não foi possível colar: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.term.getSelection());
      this.term.clearSelection();
    } catch (err) {
      warnClipboard(`não foi possível copiar: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private onPtyEvent(event: PtyEvent): void {
    if (event.kind === "data" && event.data) {
      const decoded = atob(event.data);
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) {
        bytes[i] = decoded.charCodeAt(i);
      }
      const text = new TextDecoder().decode(bytes);
      this.term.write(text);
    } else if (event.kind === "exit") {
      this.showExitOverlay(event.code ?? undefined);
    }
  }

  private showExitOverlay(code?: number): void {
    const codeEl = this.overlay.querySelector(".exit-code");
    if (codeEl) codeEl.textContent = code !== undefined ? `código ${code}` : "";
    this.overlay.classList.remove("hidden");
  }

  private hideExitOverlay(): void {
    this.overlay.classList.add("hidden");
  }

  render(zoom: number): void {
    if (this.maximized) return;
    this.element.style.left = `${this.x * zoom}px`;
    this.element.style.top = `${this.y * zoom}px`;
    this.element.style.width = `${this.w * zoom}px`;
    this.element.style.height = `${this.h * zoom}px`;
  }

  focus(): void {
    if (this.disposed) return;
    this.term.focus();
    this.element.classList.add("active");
    this.bringToFront();
    this.onFocus?.(this.id);
  }

  blur(): void {
    this.element.classList.remove("active");
    this.term.blur();
  }

  private bringToFront(): void {
    const all = document.querySelectorAll(".term-window");
    let max = 10;
    all.forEach((el) => {
      const z = parseInt((el as HTMLElement).style.zIndex || "10", 10);
      if (z > max) max = z;
    });
    this.element.style.zIndex = String(max + 1);
  }

  toggleMinimize(): void {
    this.element.classList.toggle("minimized");
  }

  toggleMaximize(): void {
    if (this.maximized) {
      this.restoreGeom();
    } else {
      this.saveGeom();
      const rect = this.canvas.worldRectVisible();
      this.x = rect.x;
      this.y = rect.y;
      this.w = rect.w;
      this.h = rect.h;
      this.maximized = true;
    }
    this.render(this.canvas.zoom);
    this.scheduleFit();
    this.onChange?.();
  }

  private saveGeom(): void {
    this.savedGeom = {
      id: this.id,
      shellId: this.shellId,
      cwd: this.cwd,
      title: this.title,
      x: this.x,
      y: this.y,
      w: this.w,
      h: this.h,
      maximized: false,
    };
  }

  private restoreGeom(): void {
    if (this.savedGeom) {
      this.x = this.savedGeom.x;
      this.y = this.savedGeom.y;
      this.w = this.savedGeom.w;
      this.h = this.savedGeom.h;
      this.maximized = false;
      this.savedGeom = undefined;
    }
  }

  /** Renomeia inline na barra de título (sem diálogo nativo do webview). */
  rename(): void {
    if (this.titleEl.isContentEditable) return;
    this.titleEl.contentEditable = "true";
    this.titleEl.classList.add("editing");
    this.titleEl.focus();

    const range = document.createRange();
    range.selectNodeContents(this.titleEl);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const finish = (commit: boolean) => {
      this.titleEl.removeEventListener("keydown", onKey, true);
      this.titleEl.removeEventListener("blur", onBlur, true);
      const value = (this.titleEl.textContent || "").trim();
      this.titleEl.contentEditable = "false";
      this.titleEl.classList.remove("editing");
      if (commit && value) {
        this.title = value;
        this.onChange?.();
      }
      this.titleEl.textContent = this.title;
      this.focus();
    };
    const onKey = (ev: KeyboardEvent) => {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        finish(false);
      }
    };
    const onBlur = () => finish(true);

    this.titleEl.addEventListener("keydown", onKey, true);
    this.titleEl.addEventListener("blur", onBlur, true);
  }

  async restart(): Promise<void> {
    this.hideExitOverlay();
    await killTerminal(this.id);
    this.onRestart?.(this.getState());
    this.close();
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    offPtyData(this.id);
    killTerminal(this.id);
    this.term.dispose();
    this.unsubscribeTheme?.();
    this.listeners.abort();
    this.onClose?.(this.id);
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      offPtyData(this.id);
      this.term.dispose();
      this.unsubscribeTheme?.();
    }
    this.listeners.abort();
    if (this.element.parentElement) {
      this.element.parentElement.removeChild(this.element);
    }
  }

  getState(): TerminalState {
    return {
      id: this.id,
      shellId: this.shellId,
      cwd: this.cwd,
      title: this.title,
      x: this.x,
      y: this.y,
      w: this.w,
      h: this.h,
      maximized: this.maximized,
      savedGeom: this.savedGeom,
    };
  }

  private setupDrag(): void {
    const titlebar = this.element.querySelector(".term-titlebar") as HTMLElement;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origX = 0;
    let origY = 0;

    titlebar.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest(".term-controls")) return;
      if ((e.target as HTMLElement).isContentEditable) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      origX = this.x;
      origY = this.y;
      this.focus();
      e.preventDefault();
    });

    window.addEventListener(
      "mousemove",
      (e) => {
        if (!dragging || this.disposed) return;
        const dx = (e.clientX - startX) / this.canvas.zoom;
        const dy = (e.clientY - startY) / this.canvas.zoom;
        this.x = origX + dx;
        this.y = origY + dy;
        this.render(this.canvas.zoom);
        this.onChange?.();
      },
      { signal: this.listeners.signal },
    );

    window.addEventListener(
      "mouseup",
      () => {
        dragging = false;
      },
      { signal: this.listeners.signal },
    );
  }

  private setupResize(): void {
    let resizing = false;
    let handle = "";
    let startX = 0;
    let startY = 0;
    let origX = 0;
    let origY = 0;
    let origW = 0;
    let origH = 0;

    this.element.addEventListener("mousedown", (e) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains("resize-handle")) return;
      resizing = true;
      handle = target.dataset.handle || "";
      startX = e.clientX;
      startY = e.clientY;
      origX = this.x;
      origY = this.y;
      origW = this.w;
      origH = this.h;
      e.preventDefault();
      e.stopPropagation();
    });

    window.addEventListener(
      "mousemove",
      (e) => {
        if (!resizing || this.disposed) return;
        const dx = (e.clientX - startX) / this.canvas.zoom;
        const dy = (e.clientY - startY) / this.canvas.zoom;

        let newX = origX;
        let newY = origY;
        let newW = origW;
        let newH = origH;

        if (handle.includes("e")) newW = origW + dx;
        if (handle.includes("s")) newH = origH + dy;
        if (handle.includes("w")) {
          newW = origW - dx;
          newX = origX + dx;
        }
        if (handle.includes("n")) {
          newH = origH - dy;
          newY = origY + dy;
        }

        newW = Math.max(newW, MIN_W);
        newH = Math.max(newH, MIN_H);
        if (handle.includes("w")) newX = origX + (origW - newW);
        if (handle.includes("n")) newY = origY + (origH - newH);

        this.x = newX;
        this.y = newY;
        this.w = newW;
        this.h = newH;
        this.render(this.canvas.zoom);
        this.throttledFit();
        this.onChange?.();
      },
      { signal: this.listeners.signal },
    );

    window.addEventListener(
      "mouseup",
      () => {
        resizing = false;
        handle = "";
        this.scheduleFit();
      },
      { signal: this.listeners.signal },
    );
  }

  private throttledFit(): void {
    if (this.fitThrottle) return;
    this.fitThrottle = setTimeout(() => {
      this.fitThrottle = null;
      this.fit();
    }, 50);
  }

  private scheduleFit(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => this.fit(), 120);
  }

  private fit(): void {
    if (this.disposed || this.element.classList.contains("minimized")) return;
    try {
      this.fitAddon.fit();
    } catch {
      return;
    }
    const dims = this.fitAddon.proposeDimensions();
    if (!dims) return;
    const cols = Math.floor(dims.cols);
    const rows = Math.floor(dims.rows);
    if (cols !== this.lastCols || rows !== this.lastRows) {
      this.lastCols = cols;
      this.lastRows = rows;
      resizeTerminal(this.id, cols, rows);
    }
  }

  private showTitlebarContextMenu(x: number, y: number): void {
    // Implementação via menu global do app.
    const event = new CustomEvent("term-titlebar-context", {
      detail: { x, y, terminal: this },
    });
    document.dispatchEvent(event);
  }
}

export async function createTerminal(
  canvas: Canvas,
  shellId: string,
  cwd: string,
  title: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<TerminalWindow> {
  const id = await spawnTerminal(shellId, cwd, 80, 24);
  const terminal = new TerminalWindow(canvas, id, shellId, cwd, title, x, y, w, h);
  return terminal;
}
