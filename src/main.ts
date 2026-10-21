import "@xterm/xterm/css/xterm.css";
import { isTauri } from "@tauri-apps/api/core";
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
import {
  createQuickCommand,
  loadQuickCommands,
  saveQuickCommands,
  type QuickCommand,
} from "./snippets";
import { initTheme, onThemeChange, themeLabel, toggleTheme } from "./theme";

const DEFAULT_W = 720;
const DEFAULT_H = 420;

let canvas: Canvas;
let shells: ShellInfo[] = [];
let focusedTerminal: TerminalWindow | null = null;
let zCounter = 10;
let quickCommands: QuickCommand[] = [];
let hintTimer: ReturnType<typeof setTimeout> | null = null;

const toolbar = {
  shellSelect: document.querySelector<HTMLSelectElement>("#shell-select")!,
  fullscreenBtn: document.querySelector<HTMLButtonElement>("#btn-fullscreen")!,
  zoom: document.querySelector<HTMLSpanElement>("#zoom-indicator")!,
  count: document.querySelector<HTMLSpanElement>("#terminal-count")!,
  coords: document.querySelector<HTMLSpanElement>("#coords")!,
};

const menuEls = Array.from(document.querySelectorAll<HTMLElement>("#menubar .menu"));

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
  bindQuickPanel();
  bindGlobalShortcuts();
  bindAutoHideToolbar();
  bindFullscreenWatcher();
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

/** O rótulo mostra o tema em uso; o clique alterna. */
function syncThemeButton(): void {
  const label = document.querySelector<HTMLElement>("#menu-theme .menu-label");
  if (label) label.textContent = themeLabel();
}

function bindToolbar(): void {
  bindMenubar();
  bindMenuActions();
  bindDialog();
  toolbar.fullscreenBtn.addEventListener("click", () => void toggleFullscreen());
}

/* ---- Menus do cabeçalho ---- */

function openMenu(menu: HTMLElement): void {
  for (const other of menuEls) {
    const open = other === menu;
    other.classList.toggle("open", open);
    other
      .querySelector(".menu-button")
      ?.setAttribute("aria-expanded", open ? "true" : "false");
  }
}

/** Fecha todos os menus; devolve `true` se havia algum aberto. */
function closeAllMenus(): boolean {
  let any = false;
  for (const menu of menuEls) {
    if (menu.classList.contains("open")) any = true;
    menu.classList.remove("open");
    menu.querySelector(".menu-button")?.setAttribute("aria-expanded", "false");
  }
  return any;
}

function bindMenubar(): void {
  const menubar = document.getElementById("menubar")!;

  for (const menu of menuEls) {
    const button = menu.querySelector<HTMLButtonElement>(".menu-button")!;
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      if (menu.classList.contains("open")) closeAllMenus();
      else openMenu(menu);
    });
    // Com um menu aberto, passar o mouse por outra categoria troca de menu.
    button.addEventListener("mouseenter", () => {
      if (menuEls.some((m) => m.classList.contains("open"))) openMenu(menu);
    });
  }

  document.addEventListener("click", (e) => {
    if (!menubar.contains(e.target as Node)) closeAllMenus();
  });
}

function bindMenuActions(): void {
  const on = (id: string, action: () => void) => {
    document.getElementById(id)?.addEventListener("click", () => {
      closeAllMenus();
      action();
    });
  };

  on("menu-new", () => void addTerminalAtCenter());
  on("menu-close-terminal", () => focusedTerminal?.close());
  on("menu-quit", () => void quitApp());

  on("menu-theme", () => toggleTheme());
  on("menu-reset-zoom", () => resetZoom());
  on("menu-center", () => centerView());
  on("menu-fullscreen", () => void toggleFullscreen());

  on("menu-organize", () => organizeTerminals());
  on("menu-cycle", () => cycleFocus(1));
  on("menu-maximize", () => focusedTerminal?.toggleMaximize());
  on("menu-minimize", () => focusedTerminal?.toggleMinimize());

  on("menu-shortcuts", () => showShortcutsDialog());
  on("menu-about", () => showAboutDialog());
}

/* ---- Diálogos ---- */

function bindDialog(): void {
  const dialog = document.getElementById("app-dialog")!;
  document.getElementById("dialog-close")?.addEventListener("click", () => closeDialog());
  dialog.addEventListener("mousedown", (e) => {
    if (e.target === dialog) closeDialog();
  });
}

function showDialog(title: string, html: string): void {
  document.getElementById("dialog-title")!.textContent = title;
  document.getElementById("dialog-body")!.innerHTML = html;
  document.getElementById("app-dialog")!.classList.remove("hidden");
}

function closeDialog(): boolean {
  const dialog = document.getElementById("app-dialog")!;
  if (dialog.classList.contains("hidden")) return false;
  dialog.classList.add("hidden");
  return true;
}

function showShortcutsDialog(): void {
  const shortcuts: Array<[string, string]> = [
    ["Novo terminal", "Ctrl+T"],
    ["Fechar terminal", "Ctrl+Shift+W"],
    ["Sair do aplicativo", "Ctrl+Q"],
    ["Ciclar foco entre terminais", "Ctrl+PageDown / Ctrl+PageUp"],
    ["Renomear terminal", "F2"],
    ["Zoom no cursor", "Ctrl + roda do mouse"],
    ["Aumentar / diminuir zoom", "Ctrl+= / Ctrl+-"],
    ["Resetar zoom", "Ctrl+0"],
    ["Pan do canvas", "Espaço + arrastar · botão do meio"],
    ["Navegar no canvas (clique antes em área vazia)", "WASD / setas"],
    ["Pan horizontal", "Shift + roda do mouse"],
    ["Tela cheia", "F11 / Ctrl+Shift+F"],
    ["Alternar tema", "Ctrl+Shift+L"],
  ];
  const rows = shortcuts
    .map(([label, key]) => `<tr><td>${label}</td><td>${key}</td></tr>`)
    .join("");
  showDialog("Atalhos de teclado", `<table>${rows}</table>`);
}

function showAboutDialog(): void {
  showDialog(
    "Sobre",
    `<h3>Canvas Terminal 0.1.0</h3>
     <p>Canvas infinito com terminais reais, construído com Tauri 2,
     TypeScript e xterm.js.</p>
     <p>Terminais, zoom e posição são salvos automaticamente.</p>`,
  );
}

async function quitApp(): Promise<void> {
  if (isTauri()) {
    await killAllTerminals().catch(() => 0);
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
    return;
  }
  window.close();
}

/* ---- Comandos rápidos ---- */

const QUICK_COLLAPSED_KEY = "canvas-terminal.quick-panel-collapsed.v1";
let editingQuickId: string | null = null;

function persistQuickCollapsed(value: boolean): void {
  try {
    localStorage.setItem(QUICK_COLLAPSED_KEY, value ? "1" : "0");
  } catch {
    // Ignora quota/escrita bloqueada.
  }
}

/** Abre o formulário para adicionar (sem `item`) ou editar um comando. */
function openQuickForm(item?: QuickCommand): void {
  const panel = document.getElementById("quick-panel")!;
  const form = document.getElementById("quick-form") as HTMLFormElement;
  const labelInput = document.getElementById("quick-label") as HTMLInputElement;
  const commandInput = document.getElementById("quick-command") as HTMLInputElement;
  const executeInput = document.getElementById("quick-execute") as HTMLInputElement;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');

  editingQuickId = item?.id ?? null;
  panel.classList.remove("collapsed");
  persistQuickCollapsed(false);
  form.classList.remove("hidden");
  labelInput.value = item?.label ?? "";
  commandInput.value = item?.command ?? "";
  executeInput.checked = item?.execute ?? false;
  if (submit) submit.textContent = item ? "Atualizar" : "Salvar";
  commandInput.focus();
  if (item) commandInput.select();
}

function closeQuickForm(): void {
  const form = document.getElementById("quick-form") as HTMLFormElement;
  form.classList.add("hidden");
  form.reset();
  editingQuickId = null;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.textContent = "Salvar";
}

function bindQuickPanel(): void {
  const panel = document.getElementById("quick-panel")!;
  const form = document.getElementById("quick-form") as HTMLFormElement;
  const labelInput = document.getElementById("quick-label") as HTMLInputElement;
  const commandInput = document.getElementById("quick-command") as HTMLInputElement;
  const executeInput = document.getElementById("quick-execute") as HTMLInputElement;
  const addButton = document.getElementById("quick-add")!;
  const cancelButton = document.getElementById("quick-cancel")!;
  const toggleButton = document.getElementById("quick-toggle")!;

  quickCommands = loadQuickCommands();
  renderQuickCommands();

  let collapsed = false;
  try {
    collapsed = localStorage.getItem(QUICK_COLLAPSED_KEY) === "1";
  } catch {
    collapsed = false;
  }
  panel.classList.toggle("collapsed", collapsed);

  addButton.addEventListener("click", () => openQuickForm());
  cancelButton.addEventListener("click", closeQuickForm);
  toggleButton.addEventListener("click", () => {
    const nowCollapsed = panel.classList.toggle("collapsed");
    persistQuickCollapsed(nowCollapsed);
    if (nowCollapsed) closeQuickForm();
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const command = commandInput.value.trim();
    if (!command) {
      commandInput.focus();
      return;
    }

    const label = labelInput.value.trim() || command;
    const execute = executeInput.checked;
    let savedId = editingQuickId;

    const existing = editingQuickId
      ? quickCommands.find((entry) => entry.id === editingQuickId)
      : undefined;
    if (existing) {
      existing.label = label;
      existing.command = command;
      existing.execute = execute;
    } else {
      const created = createQuickCommand(label, command, execute);
      quickCommands.push(created);
      savedId = created.id;
    }

    saveQuickCommands(quickCommands);
    renderQuickCommands();
    closeQuickForm();

    if (savedId) {
      const list = document.getElementById("quick-list");
      const row = Array.from(list?.children ?? []).find(
        (el) => (el as HTMLElement).dataset.id === savedId,
      ) as HTMLElement | undefined;
      row?.scrollIntoView({ block: "nearest" });
    }
  });

  // O handler global ignora eventos vindos de inputs; Esc fecha o formulário.
  form.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeQuickForm();
    }
  });
}

function renderQuickCommands(): void {
  const list = document.getElementById("quick-list")!;
  const empty = document.getElementById("quick-empty")!;
  list.innerHTML = "";

  for (const item of quickCommands) {
    const row = document.createElement("div");
    row.className = "quick-item";
    row.dataset.id = item.id;

    const run = document.createElement("button");
    run.type = "button";
    run.className = "quick-run";
    run.title = item.execute
      ? `${item.command}\n(clique para colar e executar)`
      : `${item.command}\n(clique para colar no terminal em foco)`;
    run.textContent = item.label;
    run.addEventListener("click", () => runQuickCommand(item));

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "quick-edit";
    edit.title = "Editar comando";
    edit.textContent = "✎";
    edit.addEventListener("click", () => openQuickForm(item));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "quick-remove";
    remove.title = "Remover comando";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      if (editingQuickId === item.id) closeQuickForm();
      quickCommands = quickCommands.filter((entry) => entry.id !== item.id);
      saveQuickCommands(quickCommands);
      renderQuickCommands();
    });

    row.append(run);
    if (item.execute) {
      const execBadge = document.createElement("span");
      execBadge.className = "quick-exec";
      execBadge.title = "Executa ao colar";
      execBadge.textContent = "↵";
      row.append(execBadge);
    }
    row.append(edit, remove);
    list.appendChild(row);
  }

  empty.classList.toggle("hidden", quickCommands.length > 0);
}

function runQuickCommand(item: QuickCommand): void {
  if (!focusedTerminal) {
    flashHint("Clique em um terminal antes de usar um comando rápido.");
    return;
  }
  focusedTerminal.pasteCommand(item.command, item.execute);
}

/** Mostra uma mensagem temporária na barra de status. */
function flashHint(message: string): void {
  const hint = document.getElementById("hint");
  if (!hint) return;
  if (hintTimer) clearTimeout(hintTimer);
  const original = hint.dataset.original ?? hint.textContent ?? "";
  hint.dataset.original = original;
  hint.textContent = message;
  hintTimer = setTimeout(() => {
    hintTimer = null;
    hint.textContent = hint.dataset.original || original;
  }, 3000);
}

/** O cabeçalho fica escondido e desce quando o mouse encosta no topo da tela. */
function bindAutoHideToolbar(): void {
  const bar = document.getElementById("toolbar")!;
  const hotzone = document.getElementById("toolbar-hotzone")!;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  const show = () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    bar.classList.add("visible");
  };

  const scheduleHide = (delay = 350) => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      // Não esconde enquanto o usuário interage com a barra (select, foco)
      // ou enquanto um submenu estiver aberto.
      if (bar.contains(document.activeElement)) return;
      if (bar.querySelector(".menu.open")) return;
      if (bar.matches(":hover")) return;
      bar.classList.remove("visible");
    }, delay);
  };

  hotzone.addEventListener("mouseenter", show);
  hotzone.addEventListener("click", show);
  bar.addEventListener("mouseenter", show);
  bar.addEventListener("mouseleave", () => scheduleHide());
  bar.addEventListener("focusin", show);
  bar.addEventListener("focusout", () => scheduleHide());

  // Abre visível por alguns segundos: dá tempo de descobrir os menus antes de
  // a barra se esconder sozinha.
  show();
  scheduleHide(2500);
}

function bindFullscreenWatcher(): void {
  if (isTauri()) {
    // Fullscreen também pode ser acionado pelo WM/atalho do sistema: mantém o
    // CSS do app sincronizado com o estado real da janela.
    let timer: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener("resize", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        timer = null;
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const on = await getCurrentWindow().isFullscreen();
          if (on !== document.body.classList.contains("fullscreen-mode")) {
            setFullscreenUi(on);
          }
        } catch {
          // Sem permissão/indisponível: ignora.
        }
      }, 200);
    });
    return;
  }
  // Modo navegador (npm run dev sem Tauri): usa a Fullscreen API do webview.
  document.addEventListener("fullscreenchange", () => {
    setFullscreenUi(!!document.fullscreenElement);
  });
}

/**
 * Tela cheia de verdade: no Tauri a janela entra em fullscreen nativo (some a
 * moldura e a barra de tarefas do Linux); o cromo do app também é ocultado.
 */
async function toggleFullscreen(): Promise<void> {
  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const next = !(await win.isFullscreen());
      await win.setFullscreen(next);
      setFullscreenUi(next);
    } catch (err) {
      console.error("Falha ao alternar tela cheia:", err);
    }
    return;
  }

  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch (err) {
    console.error("Falha ao alternar tela cheia:", err);
  }
}

function setFullscreenUi(on: boolean): void {
  document.body.classList.toggle("fullscreen-mode", on);
  const label = document.querySelector<HTMLElement>("#menu-fullscreen .menu-label");
  if (label) label.textContent = on ? "Sair da tela cheia" : "Tela cheia";
  toolbar.fullscreenBtn.title = on ? "Sair da tela cheia (F11)" : "Tela cheia (F11)";
  toolbar.fullscreenBtn.setAttribute("aria-pressed", on ? "true" : "false");
  document.getElementById("toolbar")?.classList.remove("visible");
  // O viewport mudou de tamanho: reavalia grid e janelas maximizadas.
  requestAnimationFrame(() => canvas.requestRender());
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

      if (e.key === "Escape") {
        if (closeDialog()) {
          own();
          return;
        }
        if (closeAllMenus()) {
          own();
          return;
        }
        // O fullscreen só sai por F11 ou pelo menu Exibir → Tela cheia.
        return;
      }
      if (e.key === "F11") {
        own();
        void toggleFullscreen();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
        own();
        void toggleFullscreen();
        return;
      }
      if (mod && (e.key === "=" || e.key === "+")) {
        own();
        canvas.zoomBy(1.1);
        return;
      }
      if (mod && (e.key === "-" || e.key === "_")) {
        own();
        canvas.zoomBy(1 / 1.1);
        return;
      }
      if (mod && e.key.toLowerCase() === "t") {
        own();
        await addTerminalAtCenter();
        return;
      }
      if (mod && e.key.toLowerCase() === "q") {
        own();
        await quitApp();
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
    term.refit();
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
  canvas.setZoomAtCenter(1);
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
