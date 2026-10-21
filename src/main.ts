import "@xterm/xterm/css/xterm.css";
import { Canvas } from "./canvas";
import {
  createTerminal,
  TerminalWindow,
} from "./terminal-window";
import {
  defaultCwd,
  initPtyListener,
  killAllTerminals,
  listShells,
  type ShellInfo,
} from "./pty";
import { loadLayout, saveLayout } from "./persistence";
import { initTheme, onThemeChange, themeLabel, toggleTheme } from "./theme";

const DEFAULT_W = 720;
const DEFAULT_H = 420;

let canvas: Canvas;
let shells: ShellInfo[] = [];
let focusedTerminal: TerminalWindow | null = null;
let zCounter = 10;

const toolbar = {
  newBtn: document.querySelector<HTMLButtonElement>("#btn-new-terminal")!,
  shellSelect: document.querySelector<HTMLSelectElement>("#shell-select")!,
  organizeBtn: document.querySelector<HTMLButtonElement>("#btn-organize")!,
  centerBtn: document.querySelector<HTMLButtonElement>("#btn-center")!,
  resetZoomBtn: document.querySelector<HTMLButtonElement>("#btn-reset-zoom")!,
  themeBtn: document.querySelector<HTMLButtonElement>("#btn-theme")!,
  zoom: document.querySelector<HTMLSpanElement>("#zoom-indicator")!,
  count: document.querySelector<HTMLSpanElement>("#terminal-count")!,
  coords: document.querySelector<HTMLSpanElement>("#coords")!,
};

const contextMenu = document.querySelector<HTMLDivElement>("#context-menu")!;

async function main(): Promise<void> {
  initTheme();
  syncThemeButton();
  onThemeChange(() => syncThemeButton());

  await initPtyListener();
  // Uma recarga do webview deixaria os PTYs antigos órfãos: limpa antes de restaurar.
  await killAllTerminals().catch(() => 0);
  window.addEventListener("beforeunload", () => {
    void killAllTerminals().catch(() => 0);
  });

  canvas = new Canvas("#viewport", "#world");
  canvas.onEmptyContextMenu = showEmptyContextMenu;
  canvas.onViewChange = () => updateStatus();

  shells = await listShells();
  populateShellSelect();

  bindToolbar();
  bindGlobalShortcuts();
  bindContextMenu();
  bindTitlebarContext();

  await restoreLayout();
  updateStatus();
  trackMouseCoordinates();

  if (canvas.getAllTerminals().length === 0) {
    await addTerminalAtCenter();
  }
}

function populateShellSelect(): void {
  toolbar.shellSelect.innerHTML = "";
  for (const shell of shells) {
    const opt = document.createElement("option");
    opt.value = shell.id;
    opt.textContent = shell.name;
    toolbar.shellSelect.appendChild(opt);
  }
}

function selectedShell(): string {
  return toolbar.shellSelect.value || shells[0]?.id || "";
}

async function addTerminalAtCenter(): Promise<void> {
  const center = canvas.centerWorldPoint();
  const x = center.x - DEFAULT_W / 2;
  const y = center.y - DEFAULT_H / 2;
  await addTerminal(selectedShell(), x, y, DEFAULT_W, DEFAULT_H);
}

async function addTerminal(
  shellId: string,
  x: number,
  y: number,
  w: number,
  h: number,
  cwd?: string,
  title?: string,
): Promise<TerminalWindow> {
  const cwdPath = cwd || (await defaultCwd());
  const shell = shells.find((s) => s.id === shellId) || shells[0];
  const terminalTitle = title || `${shell.name} #${canvas.getAllTerminals().length + 1}`;

  const terminal = await createTerminal(
    canvas,
    shellId,
    cwdPath,
    terminalTitle,
    x,
    y,
    w,
    h,
  );

  terminal.element.style.zIndex = String(++zCounter);
  terminal.onFocus = (id) => {
    focusedTerminal = canvas.getTerminal(id) || null;
  };
  terminal.onClose = () => {
    if (focusedTerminal === terminal) focusedTerminal = null;
    canvas.removeTerminal(terminal.id);
    persist();
    updateStatus();
  };
  terminal.onRestart = async (state) => {
    await addTerminal(state.shellId, state.x, state.y, state.w, state.h, state.cwd, state.title);
  };
  terminal.onChange = () => {
    persist();
    updateStatus();
  };

  canvas.addTerminal(terminal.id, terminal);
  focusedTerminal = terminal;
  persist();
  updateStatus();
  return terminal;
}

function bindToolbar(): void {
  toolbar.newBtn.addEventListener("click", () => addTerminalAtCenter());
  toolbar.organizeBtn.addEventListener("click", () => organizeTerminals());
  toolbar.centerBtn.addEventListener("click", () => centerView());
  toolbar.resetZoomBtn.addEventListener("click", () => resetZoom());
  toolbar.themeBtn.addEventListener("click", () => toggleTheme());
}

/** O rótulo mostra o tema em uso; o clique alterna. */
function syncThemeButton(): void {
  toolbar.themeBtn.textContent = themeLabel();
}

function bindGlobalShortcuts(): void {
  // Fase de captura: o xterm.js interrompe a propagação das teclas que ele
  // resolve (F1-F12, Ctrl+letra) quando o terminal está focado — um listener em
  // fase de bolha nunca recebe esses atalhos, e o terminal é justamente o
  // estado normal de foco aqui.
  document.addEventListener(
    "keydown",
    async (e) => {
      if (isTyping(e)) return;

      const mod = e.ctrlKey || e.metaKey;
      // Atalhos que pertencem ao app: também barram o envio da tecla ao shell.
      const own = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (mod && e.key.toLowerCase() === "t") {
        own();
        await addTerminalAtCenter();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "w") {
        // Fecha mesmo com o foco dentro do terminal.
        own();
        focusedTerminal?.close();
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "w") {
        // Com o terminal focado, Ctrl+W pertence ao shell (apaga a palavra anterior).
        const target = e.target as HTMLElement | null;
        if (target && isInsideTerminal(target)) return;
        own();
        focusedTerminal?.close();
        return;
      }
      if (mod && e.key === "PageDown") {
        own();
        cycleFocus(1);
        return;
      }
      if (mod && e.key === "PageUp") {
        own();
        cycleFocus(-1);
        return;
      }
      if (mod && e.key === "0") {
        own();
        resetZoom();
        return;
      }
      if (e.key === "F2" && focusedTerminal) {
        own();
        focusedTerminal.rename();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        own();
        organizeTerminals();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "l") {
        own();
        toggleTheme();
        return;
      }
    },
    true,
  );
}

/** True quando o foco está num campo de digitação do próprio app (não num terminal). */
function isTyping(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null;
  if (!target) return false;
  if (isInsideTerminal(target)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}

/** O xterm.js captura a digitação num <textarea> oculto: atalhos globais seguem valendo. */
function isInsideTerminal(el: HTMLElement): boolean {
  return el.classList.contains("xterm-helper-textarea") || !!el.closest(".term-body");
}

function cycleFocus(direction: number): void {
  const terms = canvas.getAllTerminals();
  if (terms.length === 0) return;
  const idx = focusedTerminal ? terms.indexOf(focusedTerminal) : -1;
  const next = (idx + direction + terms.length) % terms.length;
  terms[next].focus();
}

function organizeTerminals(): void {
  const terms = canvas.getAllTerminals();
  if (terms.length === 0) return;
  const visible = canvas.worldRectVisible();
  const cols = Math.ceil(Math.sqrt(terms.length));
  const rows = Math.ceil(terms.length / cols);
  const cellW = visible.w / cols;
  const cellH = visible.h / rows;

  terms.forEach((term, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    term.x = visible.x + col * cellW + 16;
    term.y = visible.y + row * cellH + 16;
    term.w = cellW - 32;
    term.h = cellH - 32;
    term.maximized = false;
    term.savedGeom = undefined;
    term.render(canvas.zoom);
    term.focus();
  });
  persist();
}

function centerView(): void {
  const terms = canvas.getAllTerminals();
  if (terms.length === 0) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const term of terms) {
    minX = Math.min(minX, term.x);
    minY = Math.min(minY, term.y);
    maxX = Math.max(maxX, term.x + term.w);
    maxY = Math.max(maxY, term.y + term.h);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const vpW = canvas.viewport.clientWidth;
  const vpH = canvas.viewport.clientHeight;
  canvas.setView(vpW / 2 - cx * canvas.zoom, vpH / 2 - cy * canvas.zoom, canvas.zoom);
}

function resetZoom(): void {
  canvas.setView(canvas.panX, canvas.panY, 1);
}

function updateStatus(): void {
  toolbar.zoom.textContent = `${Math.round(canvas.zoom * 100)}%`;
  toolbar.count.textContent = String(canvas.getAllTerminals().length);
}

function trackMouseCoordinates(): void {
  canvas.viewport.addEventListener("mousemove", (e) => {
    const p = canvas.screenToWorld(e.clientX, e.clientY);
    toolbar.coords.textContent = `${Math.round(p.x)}, ${Math.round(p.y)}`;
  });
}

function persist(): void {
  saveLayout(
    { panX: canvas.panX, panY: canvas.panY, zoom: canvas.zoom },
    canvas.getAllTerminals().map((t) => t.getState()),
  );
}

async function restoreLayout(): Promise<void> {
  const layout = loadLayout();
  if (!layout) return;

  canvas.setView(layout.view.panX, layout.view.panY, layout.view.zoom);

  for (const saved of layout.terminals) {
    try {
      await addTerminal(
        saved.shell,
        saved.x,
        saved.y,
        saved.w,
        saved.h,
        saved.cwd,
        saved.title,
      );
    } catch {
      // Continua restaurando os demais terminais.
    }
  }
}

function bindContextMenu(): void {
  document.addEventListener("click", (e) => {
    if (!contextMenu.contains(e.target as Node)) {
      hideContextMenu();
    }
  });
}

function bindTitlebarContext(): void {
  document.addEventListener("term-titlebar-context", ((e: CustomEvent) => {
    const { x, y, terminal } = e.detail as { x: number; y: number; terminal: TerminalWindow };
    showTitlebarContextMenu(x, y, terminal);
  }) as EventListener);
}

async function showEmptyContextMenu(point: { x: number; y: number }): Promise<void> {
  hideContextMenu();
  let hasClipboard = false;
  try {
    hasClipboard = !!(await navigator.clipboard.readText());
  } catch {
    hasClipboard = false;
  }

  const items = [
    { label: "Novo terminal aqui", action: () => addTerminal(selectedShell(), point.x, point.y, DEFAULT_W, DEFAULT_H) },
    { label: "Organizar em cascata", action: () => organizeTerminals() },
    { label: "Centralizar vista", action: () => centerView() },
    { label: "Colar terminal", action: () => addTerminal(selectedShell(), point.x, point.y, DEFAULT_W, DEFAULT_H), disabled: !hasClipboard },
  ];

  renderContextMenu(items, point.x * canvas.zoom + canvas.panX, point.y * canvas.zoom + canvas.panY);
}

function showTitlebarContextMenu(x: number, y: number, terminal: TerminalWindow): void {
  const items = [
    { label: "Renomear", action: () => terminal.rename() },
    { label: "Reiniciar", action: () => terminal.restart() },
    { label: terminal.maximized ? "Restaurar" : "Maximizar", action: () => terminal.toggleMaximize() },
    { label: "Fechar", action: () => terminal.close() },
  ];
  renderContextMenu(items, x, y);
}

function renderContextMenu(items: Array<{ label: string; action: () => void; disabled?: boolean }>, x: number, y: number): void {
  contextMenu.innerHTML = "";
  for (const item of items) {
    const el = document.createElement("div");
    el.className = "context-item" + (item.disabled ? " disabled" : "");
    el.textContent = item.label;
    if (!item.disabled) {
      el.addEventListener("click", () => {
        item.action();
        hideContextMenu();
      });
    }
    contextMenu.appendChild(el);
  }
  contextMenu.style.left = `${Math.min(x, window.innerWidth - 160)}px`;
  contextMenu.style.top = `${Math.min(y, window.innerHeight - 120)}px`;
  contextMenu.classList.remove("hidden");
}

function hideContextMenu(): void {
  contextMenu.classList.add("hidden");
}

main().catch((err) => {
  document.body.innerHTML = `<pre>MAIN ERROR: ${err}</pre>`;
});
