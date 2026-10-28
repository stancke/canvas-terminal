import { Terminal } from "@xterm/xterm";
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
import { snapMovingRect, snapResizingRect, type SnapRect } from "./snapping";

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
  minimized: boolean;
  /** Comando executado automaticamente quando o terminal abrir. */
  startupCommand: string;
  savedGeom?: TerminalState;
}

/** Referência a um terminal exibido nas abas do cabeçalho maximizado. */
export interface TerminalTabRef {
  workspaceId: string;
  terminalId?: number;
  /** Índice no layout salvo quando a área ainda não foi instanciada. */
  pendingIndex?: number;
  label: string;
}

/** Grupo de terminais de uma área de trabalho. */
export interface TerminalTabGroup {
  workspaceId: string;
  workspaceName: string;
  activeWorkspace: boolean;
  terminals: TerminalTabRef[];
}

export interface TerminalTabReorderDetail {
  from: TerminalTabRef;
  to: TerminalTabRef;
  after: boolean;
}

export interface TerminalGroupReorderDetail {
  fromId: string;
  toId: string;
  after: boolean;
}

/** Evita que um clique seja disparado ao final de um arrasto de aba. */
let suppressTabClick = false;

const MIN_W = 240;
const MIN_H = 140;
/** Tamanho da fonte do terminal em zoom 100%. */
const BASE_FONT_SIZE = 13;

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
  /** Comando a executar automaticamente quando o terminal for aberto. */
  startupCommand = "";

  private term: Terminal;
  private termBody: HTMLDivElement;
  private titleEl!: HTMLSpanElement;
  private tabsEl!: HTMLDivElement;
  private menuBtn!: HTMLButtonElement;
  private overlay!: HTMLDivElement;
  private canvas: Canvas;
  private disposed = false;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private fitThrottle: ReturnType<typeof setTimeout> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCols = 0;
  private lastRows = 0;
  private currentFontSize = BASE_FONT_SIZE;
  private currentZoom = 1;
  /** Remove os listeners de janela (drag/resize) quando a janela morre. */
  private listeners = new AbortController();
  /** Cancela a inscrição nas mudanças de tema (xterm). */
  private unsubscribeTheme?: () => void;

  onFocus?: (id: number) => void;
  onClose?: (id: number) => void;
  onRestart?: (state: TerminalState) => void;
  onChange?: () => void;
  /** Fornece os grupos (áreas de trabalho) para as abas do modo maximizado. */
  onRequestTerminalTabs?: () => TerminalTabGroup[];
  /** Chamado ao clicar em uma aba de qualquer área de trabalho. */
  onSelectTerminalTab?: (ref: TerminalTabRef) => void;
  /** Abre/fecha o menu do app pelo botão exibido no modo maximizado. */
  onToggleAppMenu?: () => void;

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

    this.term.loadAddon(new WebLinksAddon());

    this.term.open(this.termBody);
    this.bindTerminalInput();
    this.bindWindowEvents();
    this.bindKeyboard();

    onPtyData(id, (event) => this.onPtyEvent(event));
    // O canvas avisa quando terminais são criados/removidos/trocados de área:
    // a barra de abas do terminal maximizado se mantém atualizada.
    document.addEventListener(
      "canvas-terminals-changed",
      () => this.renderHeaderTabs(),
      { signal: this.listeners.signal },
    );
    this.render(canvas.zoom);
    // O PTY nasce com 80x24; sincroniza com o tamanho real da janela assim
    // que ela entra no DOM.
    this.scheduleFit();
  }

  private buildTitlebar(): HTMLDivElement {
    const bar = document.createElement("div");
    bar.className = "term-titlebar";

    const dot = document.createElement("span");
    dot.className = `term-dot ${this.shellId}`;
    bar.appendChild(dot);

    // Primeiro item antes das abas no modo maximizado: abre o menu do app.
    this.menuBtn = document.createElement("button");
    this.menuBtn.type = "button";
    this.menuBtn.className = "term-menu-btn";
    this.menuBtn.title = "Abrir/fechar menu";
    this.menuBtn.setAttribute("aria-label", "Abrir ou fechar menu");
    this.menuBtn.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true">' +
      '<path d="M3 4h10M3 8h10M3 12h10" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round"/></svg>';
    this.menuBtn.addEventListener("mousedown", (event) => event.stopPropagation());
    this.menuBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.onToggleAppMenu?.();
    });
    bar.appendChild(this.menuBtn);

    this.titleEl = document.createElement("span");
    this.titleEl.className = "term-name";
    this.titleEl.textContent = this.title;
    bar.appendChild(this.titleEl);

    // Abas com os terminais da área: visíveis só quando a janela é maximizada.
    this.tabsEl = document.createElement("div");
    this.tabsEl.className = "term-tabs";
    this.tabsEl.addEventListener(
      "wheel",
      (event) => {
        if (event.ctrlKey || !this.maximized) return;
        this.tabsEl.scrollLeft += event.deltaY || event.deltaX;
        event.preventDefault();
        event.stopPropagation();
      },
      { passive: false },
    );
    bar.appendChild(this.tabsEl);

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
      // Ctrl+roda continua chegando ao canvas: zoom no cursor mesmo com o
      // mouse sobre um terminal.
      if (!e.ctrlKey) e.stopPropagation();
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
      const target = e.target as HTMLElement;
      if (target.closest(".term-tabs")) return;
      if (target.closest(".term-menu-btn")) return;
      if (target.closest(".term-titlebar")) {
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

  /**
   * Cola um comando no shell. Com `execute`, envia o Enter no mesmo evento de
   * entrada (garante que o Enter chegue depois do comando). Sem `execute`, o
   * usuário confirma manualmente.
   */
  pasteCommand(command: string, execute = false): void {
    if (this.disposed) return;
    if (execute) {
      this.term.input(`${command}\r`);
    } else {
      this.term.paste(command);
    }
    this.focus();
  }

  /**
   * Define o comando de inicialização. Não executa agora: ele roda na próxima
   * vez que o terminal for aberto (início do app ou reinício do terminal).
   */
  setStartupCommand(command: string): void {
    this.startupCommand = command.trim();
    this.onChange?.();
  }

  /** Agenda o comando de inicialização após o shell terminar de subir. */
  scheduleStartupCommand(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    const command = this.startupCommand.trim();
    if (!command || this.disposed) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      if (this.disposed) return;
      // Envia direto ao PTY: não mexe no foco/seleção de uma janela em segundo
      // plano e executa o comando com Enter.
      const bytes = new TextEncoder().encode(`${command}\r`);
      void writeTerminal(this.id, bytes).catch(() => {});
    }, 500);
  }

  private cancelStartupCommand(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
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
    this.currentZoom = zoom;
    this.element.classList.toggle("maximized", this.maximized);
    // Uma janela maximizada acompanha o viewport também quando o zoom muda.
    if (this.maximized) {
      const rect = this.canvas.worldRectVisible();
      this.x = rect.x;
      this.y = rect.y;
      this.w = rect.w;
      this.h = Math.max(80, rect.h);
    }
    this.element.style.left = `${this.x * zoom}px`;
    this.element.style.top = `${this.y * zoom}px`;
    this.element.style.width = `${this.w * zoom}px`;
    this.element.style.height = `${this.h * zoom}px`;
    // Todo o cromo da janela (barra de título, controles, paddings) escala
    // junto com a fonte do xterm: o zoom é uniforme, sem reflow do terminal.
    this.element.style.setProperty("--z", String(zoom));
    this.applyFontSize(zoom);
  }

  /**
   * O xterm não aceita ser reduzido via `transform: scale()` sem quebrar as
   * coordenadas de mouse/seleção. Em vez disso, a fonte acompanha o zoom e o
   * terminal é redimensionado em colunas/linhas — como largura e fonte escalam
   * na mesma proporção, o layout do terminal permanece idêntico (sem reflow).
   */
  private applyFontSize(zoom: number): void {
    const size = Math.max(3, Math.min(48, Math.round(BASE_FONT_SIZE * zoom * 100) / 100));
    if (size === this.currentFontSize) return;
    this.currentFontSize = size;
    this.term.options.fontSize = size;
    this.throttledFit();
  }

  focus(): void {
    if (this.disposed) return;
    // Ao focar um terminal, o canvas deixa o modo de navegação por teclado.
    this.canvas.setCanvasActive(false);
    this.term.focus();
    this.element.classList.add("active");
    this.bringToFront();
    this.onFocus?.(this.id);
  }

  /** Recalcula colunas/linhas após uma mudança de geometria externa. */
  refit(): void {
    if (this.disposed) return;
    // Garante que o xterm meça a célula agora que a janela está no DOM: uma
    // área restaurada pode ter sido criada fora do documento.
    this.term.refresh(0, Math.max(0, this.term.rows - 1));
    // Faz o ajuste imediato (sem esperar o throttle) para a janela maximizada
    // já aparecer no tamanho final, sem o “pulo” de layout.
    this.fit();
    this.scheduleFit();
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
    const nowMinimized = this.element.classList.toggle("minimized");
    if (nowMinimized && this.maximized) {
      // Minimizar uma janela maximizada devolve a geometria normal.
      this.toggleMaximize();
    }
    if (!nowMinimized) this.scheduleFit();
  }

  toggleMaximize(): void {
    if (this.maximized) {
      this.restoreGeom();
    } else {
      // Uma janela minimizada não pode ser maximizada enquanto o corpo está
      // escondido.
      this.element.classList.remove("minimized");
      // Apenas um terminal maximizado por área de trabalho: restaura os demais
      // para que as abas do cabeçalho funcionem como navegação.
      for (const other of this.canvas.getAllTerminals()) {
        if (other !== this && other.maximized) other.toggleMaximize();
      }
      this.saveGeom();
      const rect = this.canvas.worldRectVisible();
      this.x = rect.x;
      this.y = rect.y;
      this.w = rect.w;
      this.h = rect.h;
      this.maximized = true;
    }
    this.render(this.canvas.zoom);
    this.renderHeaderTabs();
    // Aplica o novo tamanho ao xterm imediatamente; o scheduleFit fica como
    // redundância para medições de fonte.
    this.fit();
    this.scheduleFit();
    this.onChange?.();
  }

  /** Monta as abas agrupadas por área no cabeçalho da janela maximizada. */
  private renderHeaderTabs(): void {
    if (!this.tabsEl) return;
    this.tabsEl.innerHTML = "";
    if (!this.maximized || !this.element.isConnected) return;

    const groups = this.onRequestTerminalTabs?.() ?? [];
    for (const group of groups) {
      if (group.terminals.length === 0) continue;

      const groupEl = document.createElement("div");
      groupEl.className =
        "term-tab-group" + (group.activeWorkspace ? " active-workspace" : "");

      const groupName = document.createElement("span");
      groupName.className = "term-tab-group-name";
      groupName.textContent = group.workspaceName;
      groupName.title = `${group.workspaceName} — arraste para reordenar o grupo`;
      groupName.dataset.workspaceId = group.workspaceId;
      this.setupTabDrag(groupName, "group", { workspaceId: group.workspaceId });
      groupEl.appendChild(groupName);

      for (const ref of group.terminals) {
        const tab = document.createElement("div");
        tab.className =
          "term-tab" +
          (ref.terminalId !== undefined && ref.terminalId === this.id ? " active" : "");
        tab.setAttribute("role", "tab");
        tab.setAttribute(
          "aria-selected",
          String(ref.terminalId !== undefined && ref.terminalId === this.id),
        );
        tab.tabIndex = 0;
        tab.title = `${ref.label} — arraste para reordenar`;
        tab.dataset.workspaceId = ref.workspaceId;
        tab.dataset.label = ref.label;
        if (ref.terminalId !== undefined) {
          tab.dataset.terminalId = String(ref.terminalId);
        }
        if (ref.pendingIndex !== undefined) {
          tab.dataset.pendingIndex = String(ref.pendingIndex);
        }

        const label = document.createElement("span");
        label.className = "term-tab-name";
        label.textContent = ref.label;
        tab.appendChild(label);
        this.setupTabDrag(tab, "terminal", ref);

        tab.addEventListener("mousedown", (event) => event.stopPropagation());
        tab.addEventListener("click", (event) => {
          event.stopPropagation();
          if (suppressTabClick) {
            suppressTabClick = false;
            return;
          }
          this.onSelectTerminalTab?.(ref);
        });
        tab.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.onSelectTerminalTab?.(ref);
          }
        });
        groupEl.appendChild(tab);
      }

      this.tabsEl.appendChild(groupEl);
    }

    this.tabsEl
      .querySelector<HTMLElement>(".term-tab.active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /** Arrasto horizontal para reordenar abas de terminal ou grupos de área. */
  private setupTabDrag(
    handle: HTMLElement,
    kind: "terminal" | "group",
    payload: TerminalTabRef | { workspaceId: string },
  ): void {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).isContentEditable) return;

      const startX = event.clientX;
      const startY = event.clientY;
      let dragging = false;
      let dropTarget: HTMLElement | null = null;
      const selector = kind === "terminal" ? ".term-tab" : ".term-tab-group-name";

      const clearDropTarget = () => {
        dropTarget?.classList.remove("drop-before", "drop-after");
        dropTarget = null;
      };

      const finish = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("blur", onCancel);
        handle.classList.remove("dragging");
        clearDropTarget();
      };

      const onCancel = () => {
        dragging = false;
        finish();
      };

      const onMove = (move: PointerEvent) => {
        if (!dragging) {
          if (
            Math.abs(move.clientX - startX) + Math.abs(move.clientY - startY) <
            6
          ) {
            return;
          }
          dragging = true;
          handle.classList.add("dragging");
        }
        move.preventDefault();

        const el = document.elementFromPoint(
          move.clientX,
          move.clientY,
        ) as HTMLElement | null;
        const candidate = el?.closest<HTMLElement>(selector) ?? null;
        if (candidate !== dropTarget) {
          clearDropTarget();
          dropTarget = candidate;
        }
        if (dropTarget) {
          const rect = dropTarget.getBoundingClientRect();
          const after = move.clientX > rect.left + rect.width / 2;
          dropTarget.classList.toggle("drop-after", after);
          dropTarget.classList.toggle("drop-before", !after);
        }
      };

      const onUp = (up: PointerEvent) => {
        const wasDragging = dragging;
        finish();
        if (!wasDragging) return;

        suppressTabClick = true;
        setTimeout(() => {
          suppressTabClick = false;
        }, 250);

        const el = document.elementFromPoint(
          up.clientX,
          up.clientY,
        ) as HTMLElement | null;
        const target = el?.closest<HTMLElement>(selector) ?? null;
        if (!target || target === handle) return;

        const rect = target.getBoundingClientRect();
        const after = up.clientX > rect.left + rect.width / 2;

        if (kind === "terminal") {
          const to = this.tabRefFromElement(target);
          const from = payload as TerminalTabRef;
          if (to && to.workspaceId === from.workspaceId) {
            document.dispatchEvent(
              new CustomEvent<TerminalTabReorderDetail>("terminal-tab-reorder", {
                detail: { from, to, after },
              }),
            );
          }
        } else {
          const toId = target.dataset.workspaceId;
          const fromId = (payload as { workspaceId: string }).workspaceId;
          if (toId && toId !== fromId) {
            document.dispatchEvent(
              new CustomEvent<TerminalGroupReorderDetail>("terminal-group-reorder", {
                detail: { fromId, toId, after },
              }),
            );
          }
        }
      };

      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("blur", onCancel);
    });
  }

  private tabRefFromElement(element: HTMLElement): TerminalTabRef | null {
    const workspaceId = element.dataset.workspaceId;
    if (!workspaceId) return null;
    const terminalId = element.dataset.terminalId
      ? Number(element.dataset.terminalId)
      : undefined;
    const pendingIndex = element.dataset.pendingIndex
      ? Number(element.dataset.pendingIndex)
      : undefined;
    return {
      workspaceId,
      terminalId,
      pendingIndex,
      label: element.dataset.label ?? "",
    };
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
      minimized: false,
      startupCommand: this.startupCommand,
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
    // Maximizado, o nome fica na aba ativa do cabeçalho; fora disso, no título.
    const activeTabName = this.maximized
      ? this.tabsEl.querySelector<HTMLElement>(".term-tab.active .term-tab-name")
      : null;
    const target = activeTabName ?? this.titleEl;
    if (target.isContentEditable) return;

    target.contentEditable = "true";
    target.classList.add("editing");
    target.focus();

    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const finish = (commit: boolean) => {
      target.removeEventListener("keydown", onKey, true);
      target.removeEventListener("blur", onBlur, true);
      const value = (target.textContent || "").trim();
      target.contentEditable = "false";
      target.classList.remove("editing");
      if (commit && value) {
        this.title = value;
        this.onChange?.();
      }
      this.titleEl.textContent = this.title;
      this.renderHeaderTabs();
      if (commit && value) {
        document.dispatchEvent(new CustomEvent("canvas-terminals-changed"));
      }
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

    target.addEventListener("keydown", onKey, true);
    target.addEventListener("blur", onBlur, true);
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
    this.cancelStartupCommand();
    offPtyData(this.id);
    killTerminal(this.id);
    this.term.dispose();
    this.unsubscribeTheme?.();
    this.listeners.abort();
    this.onClose?.(this.id);
  }

  dispose(): void {
    this.cancelStartupCommand();
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

  /**
   * Encerra o PTY e descarta a janela sem disparar `onClose` (usado ao fechar
   * uma área de trabalho inteira).
   */
  destroy(): void {
    this.cancelStartupCommand();
    if (!this.disposed) {
      this.disposed = true;
      offPtyData(this.id);
      void killTerminal(this.id).catch(() => {});
      this.term.dispose();
      this.unsubscribeTheme?.();
    }
    this.listeners.abort();
    this.element.remove();
    this.onClose = undefined;
    this.onFocus = undefined;
    this.onChange = undefined;
    this.onRestart = undefined;
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
      minimized: this.element.classList.contains("minimized"),
      startupCommand: this.startupCommand,
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
      if ((e.target as HTMLElement).closest(".term-tabs")) return;
      if ((e.target as HTMLElement).closest(".term-menu-btn")) return;
      if ((e.target as HTMLElement).isContentEditable) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      origX = this.x;
      origY = this.y;
      this.focus();
      this.canvas.snapGuides.clear();
      e.preventDefault();
    });

    window.addEventListener(
      "mousemove",
      (e) => {
        if (!dragging || this.disposed) return;
        const dx = (e.clientX - startX) / this.canvas.zoom;
        const dy = (e.clientY - startY) / this.canvas.zoom;
        const snapped = snapMovingRect(
          { x: origX + dx, y: origY + dy, w: this.w, h: this.h },
          this.snapTargets(),
          this.canvas.zoom,
        );
        this.x = snapped.x;
        this.y = snapped.y;
        this.render(this.canvas.zoom);
        this.canvas.snapGuides.show(
          snapped.vertical,
          snapped.horizontal,
          this.canvas.zoom,
          this.canvas.panX,
          this.canvas.panY,
        );
        this.onChange?.();
      },
      { signal: this.listeners.signal },
    );

    window.addEventListener(
      "mouseup",
      () => {
        if (!dragging) return;
        dragging = false;
        this.canvas.snapGuides.clear();
      },
      { signal: this.listeners.signal },
    );
  }

  /** Retângulos dos outros terminais visíveis usados como guias de encaixe. */
  private snapTargets(): SnapRect[] {
    return this.canvas
      .getAllTerminals()
      .filter(
        (terminal) =>
          terminal !== this &&
          !terminal.maximized &&
          !terminal.element.classList.contains("minimized"),
      )
      .map((terminal) => ({
        x: terminal.x,
        y: terminal.y,
        w: terminal.w,
        h: terminal.h,
      }));
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
      this.canvas.snapGuides.clear();
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

        const snapped = snapResizingRect(
          { x: newX, y: newY, w: newW, h: newH },
          this.snapTargets(),
          this.canvas.zoom,
          handle,
          MIN_W,
          MIN_H,
        );

        this.x = snapped.x;
        this.y = snapped.y;
        this.w = snapped.w;
        this.h = snapped.h;
        this.render(this.canvas.zoom);
        this.canvas.snapGuides.show(
          snapped.vertical,
          snapped.horizontal,
          this.canvas.zoom,
          this.canvas.panX,
          this.canvas.panY,
        );
        this.throttledFit();
        this.onChange?.();
      },
      { signal: this.listeners.signal },
    );

    window.addEventListener(
      "mouseup",
      () => {
        if (!resizing) return;
        resizing = false;
        handle = "";
        this.canvas.snapGuides.clear();
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

    // O FitAddon reserva 14px fixos para a barra de rolagem sempre que há
    // scrollback. Como todo o resto escala com o zoom, essa constante faria o
    // terminal refluir a cada nível. Calculamos as dimensões aqui usando a
    // mesma célula do xterm, reservando a barra proporcionalmente.
    const root = this.term.element;
    const screen = root?.querySelector<HTMLElement>(".xterm-screen");
    if (!root || !screen || this.term.cols <= 0 || this.term.rows <= 0) return;

    const screenW = parseFloat(screen.style.width);
    const screenH = parseFloat(screen.style.height);
    if (!(screenW > 0) || !(screenH > 0)) return;

    const cellW = screenW / this.term.cols;
    const cellH = screenH / this.term.rows;
    const availW = root.clientWidth;
    const availH = root.clientHeight;
    if (availW <= 0 || availH <= 0 || cellW <= 0 || cellH <= 0) return;

    const scrollback = this.term.options.scrollback ?? 0;
    const scrollbar = scrollback > 0 ? 14 * this.currentZoom : 0;
    const cols = Math.max(2, Math.floor((availW - scrollbar) / cellW));
    const rows = Math.max(1, Math.floor(availH / cellH));

    if (cols !== this.term.cols || rows !== this.term.rows) {
      this.term.resize(cols, rows);
    }
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
