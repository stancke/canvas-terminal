import "@xterm/xterm/css/xterm.css";
import { isTauri } from "@tauri-apps/api/core";
import { Canvas } from "./canvas";
import {
  createTerminal,
  TerminalWindow,
  type TerminalGroupReorderDetail,
  type TerminalTabGroup,
  type TerminalTabRef,
  type TerminalTabReorderDetail,
} from "./terminal-window";
import {
  defaultCwd,
  initPtyListener,
  killAllTerminals,
  listShells,
  type ShellInfo,
} from "./pty";
import {
  flushSave,
  loadWorkspaces,
  saveWorkspaces,
  toSavedTerminal,
  type SavedTerminal,
  type SavedView,
  type SavedWorkspace,
} from "./persistence";
import {
  createQuickCommand,
  loadQuickCommands,
  saveQuickCommands,
  type QuickCommand,
} from "./snippets";
import { initTheme, onThemeChange, themeLabel, toggleTheme } from "./theme";

const DEFAULT_W = 720;
const DEFAULT_H = 420;
/** Altura do cabeçalho fixo quando há terminal maximizado. */
const HEADER_HEIGHT = 42;

interface Workspace {
  id: string;
  name: string;
  view: SavedView;
  /** Terminais já instanciados (PTYs vivos) nesta área. */
  terminals: TerminalWindow[];
  /** Terminais salvos de uma área ainda não aberta nesta sessão. */
  pending: SavedTerminal[];
  initialized: boolean;
  lastFocusedId?: number;
  /** Índice do terminal focado, persistido para reabrir no mesmo. */
  focusedIndex?: number;
}

let canvas: Canvas;
let shells: ShellInfo[] = [];
let focusedTerminal: TerminalWindow | null = null;
let zCounter = 10;
let quickCommands: QuickCommand[] = [];
let hintTimer: ReturnType<typeof setTimeout> | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toolbarForcedOpen = false;
let workspaces: Workspace[] = [];
let activeWorkspace: Workspace | null = null;
/** Ordem dos grupos (áreas) exibida somente nas abas do modo maximizado. */
let tabGroupOrder: string[] = [];

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
  const saveSession = () => {
    try {
      persist();
      flushSave();
    } catch (err) {
      // Nunca deixa uma falha de persistência bloquear o fechamento.
      console.error("Falha ao salvar o perfil:", err);
    }
  };
  window.addEventListener("beforeunload", () => {
    saveSession();
    void killAllTerminals().catch(() => 0);
  });
  window.addEventListener("pagehide", saveSession);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveSession();
  });

  canvas = new Canvas("#viewport", "#world");
  canvas.onEmptyContextMenu = showEmptyContextMenu;
  canvas.onViewChange = () => {
    updateStatus();
    persist();
  };

  shells = await listShells();
  populateShellSelect();

  bindToolbar();
  bindWorkspaceTabs();
  bindQuickPanel();
  bindGlobalShortcuts();
  bindAutoHideToolbar();
  bindFullscreenWatcher();
  bindContextMenu();
  bindTitlebarContext();

  await restoreWorkspaces();
  updateStatus();
  trackMouseCoordinates();

  if (activeWorkspace && activeWorkspace.terminals.length === 0) {
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
  if (!activeWorkspace) return;
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
  if (!activeWorkspace) throw new Error("Nenhuma área de trabalho ativa");
  return addTerminalToWorkspace(activeWorkspace, shellId, x, y, w, h, cwd, title);
}

function terminalTitleFor(
  workspace: Workspace,
  shellId: string,
  title?: string,
): string {
  if (title) return title;
  const shell = shells.find((s) => s.id === shellId) || shells[0];
  return `${shell?.name ?? shellId} #${workspace.terminals.length + 1}`;
}

/** Cria o TerminalWindow (PTY + xterm) e liga os callbacks à área de trabalho. */
async function createTerminalForWorkspace(
  workspace: Workspace,
  shellId: string,
  cwd: string,
  title: string,
  x: number,
  y: number,
  w: number,
  h: number,
  startupCommand = "",
): Promise<TerminalWindow> {
  const terminal = await createTerminal(canvas, shellId, cwd, title, x, y, w, h);
  terminal.element.style.zIndex = String(++zCounter);

  terminal.onFocus = (id) => {
    focusedTerminal = terminal;
    workspace.lastFocusedId = id;
    const index = workspace.terminals.findIndex((entry) => entry.id === id);
    if (index >= 0) workspace.focusedIndex = index;
  };
  terminal.onClose = () => {
    workspace.terminals = workspace.terminals.filter((entry) => entry !== terminal);
    if (workspace === activeWorkspace) {
      if (focusedTerminal === terminal) focusedTerminal = null;
      canvas.removeTerminal(terminal.id);
    }
    if (workspace.lastFocusedId === terminal.id) {
      workspace.lastFocusedId =
        workspace.terminals[workspace.terminals.length - 1]?.id;
    }
    const focusedIndex = workspace.terminals.findIndex(
      (entry) => entry.id === workspace.lastFocusedId,
    );
    workspace.focusedIndex = focusedIndex >= 0 ? focusedIndex : undefined;
    renderWorkspaceTabs();
    // Atualiza as abas agrupadas do terminal maximizado (inclusive grupos de
    // áreas que não estão ativas).
    notifyTerminalTabsChanged();
    persist();
    updateStatus();
  };
  terminal.onRestart = async (state) => {
    await addTerminalToWorkspace(
      workspace,
      state.shellId,
      state.x,
      state.y,
      state.w,
      state.h,
      state.cwd,
      state.title,
      state.startupCommand,
    );
  };
  terminal.onChange = () => {
    persist();
    updateStatus();
  };
  terminal.onRequestTerminalTabs = () => terminalTabGroups();
  terminal.onSelectTerminalTab = (ref) => void selectTerminalTab(ref);
  terminal.onToggleAppMenu = () => toggleMaximizedAppMenu();
  terminal.startupCommand = startupCommand.trim();
  if (terminal.startupCommand) terminal.scheduleStartupCommand();

  return terminal;
}

async function addTerminalToWorkspace(
  workspace: Workspace,
  shellId: string,
  x: number,
  y: number,
  w: number,
  h: number,
  cwd?: string,
  title?: string,
  startupCommand?: string,
): Promise<TerminalWindow> {
  const cwdPath = cwd || (await defaultCwd());
  const terminalTitle = terminalTitleFor(workspace, shellId, title);
  const terminal = await createTerminalForWorkspace(
    workspace,
    shellId,
    cwdPath,
    terminalTitle,
    x,
    y,
    w,
    h,
    startupCommand,
  );

  workspace.terminals.push(terminal);
  if (workspace === activeWorkspace) {
    const previousMaximized = workspace.terminals.find(
      (entry) => entry.maximized && entry !== terminal,
    );
    canvas.addTerminal(terminal.id, terminal);
    focusedTerminal = terminal;
    // Se a área está em modo maximizado, o novo terminal assume o lugar como
    // nova aba maximizada (em vez de flutuar por cima da janela maximizada).
    if (previousMaximized) {
      previousMaximized.toggleMaximize();
      terminal.toggleMaximize();
    }
    terminal.focus();
  }
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
  on("menu-save", () => saveNow());
  on("menu-quit", () => void quitApp());

  on("menu-theme", () => toggleTheme());
  on("menu-reset-zoom", () => resetZoom());
  on("menu-center", () => centerView());
  on("menu-fullscreen", () => void toggleFullscreen());

  on("menu-new-workspace", () => void createWorkspace());
  on("menu-next-workspace", () => void cycleWorkspace(1));
  on("menu-prev-workspace", () => void cycleWorkspace(-1));
  on("menu-organize", () => organizeTerminals());
  on("menu-cycle", () => cycleFocus(1));
  on("menu-maximize", () => focusedTerminal?.toggleMaximize());
  on("menu-minimize", () => focusedTerminal?.toggleMinimize());
  on("menu-startup-command", () => {
    if (focusedTerminal) editStartupCommand(focusedTerminal);
    else flashHint("Selecione um terminal para configurar o comando.");
  });

  on("menu-shortcuts", () => showShortcutsDialog());
  on("menu-about", () => showAboutDialog());
}

/* ---- Diálogos ---- */

let dialogConfirmAction: (() => void) | null = null;

function bindDialog(): void {
  const dialog = document.getElementById("app-dialog")!;
  document.getElementById("dialog-close")?.addEventListener("click", () => closeDialog());
  document.getElementById("dialog-cancel")?.addEventListener("click", () => closeDialog());
  document.getElementById("dialog-confirm")?.addEventListener("click", () => {
    const action = dialogConfirmAction;
    closeDialog();
    action?.();
  });
  dialog.addEventListener("mousedown", (e) => {
    if (e.target === dialog) closeDialog();
  });
}

function showDialog(title: string, html: string): void {
  document.getElementById("dialog-title")!.textContent = title;
  document.getElementById("dialog-body")!.innerHTML = html;
  document.getElementById("dialog-footer")!.classList.add("hidden");
  dialogConfirmAction = null;
  document.getElementById("app-dialog")!.classList.remove("hidden");
}

/** Diálogo com ações (Cancelar / Confirmar). */
function showConfirm(
  title: string,
  html: string,
  confirmLabel: string,
  action: () => void,
): void {
  showDialog(title, html);
  document.getElementById("dialog-footer")!.classList.remove("hidden");
  const confirmButton = document.getElementById("dialog-confirm") as HTMLButtonElement;
  confirmButton.textContent = confirmLabel;
  dialogConfirmAction = action;
}

function closeDialog(): boolean {
  const dialog = document.getElementById("app-dialog")!;
  if (dialog.classList.contains("hidden")) return false;
  dialog.classList.add("hidden");
  document.getElementById("dialog-footer")!.classList.add("hidden");
  dialogConfirmAction = null;
  return true;
}

function showShortcutsDialog(): void {
  const shortcuts: Array<[string, string]> = [
    ["Novo terminal", "Ctrl+T"],
    ["Salvar estado do canvas", "Ctrl+S"],
    ["Nova área de trabalho", "Ctrl+Shift+T"],
    ["Próxima / área anterior", "Ctrl+Tab / Ctrl+Shift+Tab"],
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

/** Configura o comando automático de um terminal, salvo no perfil. */
function editStartupCommand(terminal: TerminalWindow): void {
  showConfirm(
    "Comando de inicialização",
    `<p>Este comando será executado automaticamente quando o terminal abrir:
     ao iniciar o app ou reiniciar o terminal.</p>
     <input id="startup-command-input" class="dialog-input" type="text"
       maxlength="2000" placeholder="Ex.: npm run dev" />
     <p class="dialog-hint">Deixe em branco para desativar.</p>`,
    "Salvar",
    () => {
      const input = document.getElementById(
        "startup-command-input",
      ) as HTMLInputElement | null;
      const command = input?.value.trim() ?? "";
      terminal.setStartupCommand(command);
      flashHint(
        command
          ? "Comando de inicialização salvo."
          : "Comando de inicialização removido.",
      );
    },
  );

  const input = document.getElementById(
    "startup-command-input",
  ) as HTMLInputElement | null;
  if (input) {
    input.value = terminal.startupCommand;
    input.focus();
    input.select();
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        (document.getElementById("dialog-confirm") as HTMLButtonElement | null)?.click();
      }
    });
  }
}

async function quitApp(): Promise<void> {
  try {
    persist();
    flushSave();
  } catch (err) {
    console.error("Falha ao salvar o perfil antes de sair:", err);
  }

  if (!isTauri()) {
    window.close();
    return;
  }

  try {
    await killAllTerminals().catch(() => 0);
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    void win.close().catch(() => {
      void win.destroy().catch(() => {});
    });
    // Se algo impedir o fechamento normal, força a destruição da janela.
    setTimeout(() => {
      void win.destroy().catch(() => {});
    }, 1500);
  } catch (err) {
    console.error("Falha ao fechar o aplicativo:", err);
    window.close();
  }
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
  panel.classList.add("visible");
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

  // Auto-hide: o painel só aparece quando o mouse encosta no canto inferior
  // esquerdo e se esconde ao sair, como o cabeçalho.
  const hotzone = document.getElementById("quick-hotzone")!;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  const showPanel = () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    panel.classList.add("visible");
  };

  const scheduleHidePanel = () => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (panel.contains(document.activeElement)) return;
      if (panel.matches(":hover")) return;
      panel.classList.remove("visible");
    }, 350);
  };

  hotzone.addEventListener("mouseenter", showPanel);
  hotzone.addEventListener("click", showPanel);
  panel.addEventListener("mouseenter", showPanel);
  panel.addEventListener("mouseleave", scheduleHidePanel);
  panel.addEventListener("focusin", showPanel);
  panel.addEventListener("focusout", scheduleHidePanel);

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

/* ---- Áreas de trabalho (abas) ---- */

function makeWorkspaceId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
}

function nextWorkspaceName(): string {
  const names = new Set(workspaces.map((workspace) => workspace.name));
  let index = workspaces.length + 1;
  while (names.has(`Área ${index}`)) index++;
  return `Área ${index}`;
}

function makeWorkspace(name?: string, view?: SavedView): Workspace {
  return {
    id: makeWorkspaceId(),
    name: name ?? nextWorkspaceName(),
    view: view ?? { panX: 0, panY: 0, zoom: 1 },
    terminals: [],
    pending: [],
    initialized: true,
    lastFocusedId: undefined,
    focusedIndex: undefined,
  };
}

function savedToWorkspace(saved: SavedWorkspace): Workspace {
  return {
    id: saved.id,
    name: saved.name,
    view: saved.view,
    terminals: [],
    pending: saved.terminals,
    initialized: false,
    lastFocusedId: undefined,
    focusedIndex: saved.focusedIndex,
  };
}

/** Mantém a ordem dos grupos válida, anexando áreas novas ao final. */
function normalizeTabGroupOrder(order?: string[]): string[] {
  const ids = new Set(workspaces.map((workspace) => workspace.id));
  const result: string[] = [];
  for (const id of order ?? []) {
    if (ids.has(id) && !result.includes(id)) result.push(id);
  }
  for (const workspace of workspaces) {
    if (!result.includes(workspace.id)) result.push(workspace.id);
  }
  return result;
}

/** Instancia os terminais salvos de uma área na primeira vez que ela abre. */
async function instantiateWorkspace(workspace: Workspace): Promise<void> {
  if (workspace.initialized) return;
  workspace.initialized = true;
  const pending = workspace.pending;
  workspace.pending = [];

  for (const item of pending) {
    try {
      const title = terminalTitleFor(workspace, item.shell, item.title);
      const base = item.maximized && item.geom ? item.geom : item;
      const terminal = await createTerminalForWorkspace(
        workspace,
        item.shell,
        item.cwd,
        title,
        base.x,
        base.y,
        base.w,
        base.h,
        item.startupCommand,
      );
      if (item.maximized && item.geom) {
        terminal.savedGeom = {
          id: terminal.id,
          shellId: item.shell,
          cwd: item.cwd,
          title,
          x: item.geom.x,
          y: item.geom.y,
          w: item.geom.w,
          h: item.geom.h,
          maximized: false,
          minimized: false,
          startupCommand: item.geom.startupCommand ?? item.startupCommand,
        };
        terminal.maximized = true;
      }
      if (item.minimized && !item.maximized) {
        terminal.element.classList.add("minimized");
      }
      workspace.terminals.push(terminal);
    } catch {
      // Uma sessão que falhou não impede a restauração das demais.
    }
  }
}

/** Anexa a área ao canvas (a view é aplicada antes de posicionar as janelas). */
async function showWorkspace(workspace: Workspace): Promise<void> {
  await instantiateWorkspace(workspace);

  activeWorkspace = workspace;
  canvas.setView(workspace.view.panX, workspace.view.panY, workspace.view.zoom);
  canvas.attachTerminals(workspace.terminals);

  const maximized = workspace.terminals.find((terminal) => terminal.maximized);
  const preferred =
    workspace.focusedIndex !== undefined
      ? workspace.terminals[workspace.focusedIndex]
      : undefined;
  focusedTerminal =
    maximized ??
    preferred ??
    workspace.terminals.find((terminal) => terminal.id === workspace.lastFocusedId) ??
    workspace.terminals[0] ??
    null;

  if (focusedTerminal) {
    focusedTerminal.focus();
  } else {
    canvas.setCanvasActive(true);
  }

  renderWorkspaceTabs();
  updateStatus();
}

let workspaceBusy = false;

/** Serializa troca/criação/remoção de áreas (spawns de PTY podem demorar). */
async function withWorkspaceLock(task: () => Promise<void>): Promise<void> {
  if (workspaceBusy) return;
  workspaceBusy = true;
  try {
    await task();
  } finally {
    workspaceBusy = false;
  }
}

async function switchToWorkspace(target: Workspace): Promise<void> {
  // Prepara a área de destino (spawn dos PTYs) *antes* de desanexar a atual:
  // assim o usuário não vê um canvas em branco enquanto os terminais sobem.
  await instantiateWorkspace(target);

  if (activeWorkspace) {
    activeWorkspace.view = {
      panX: canvas.panX,
      panY: canvas.panY,
      zoom: canvas.zoom,
    };
    canvas.detachTerminals();
  }

  await showWorkspace(target);
  persist();
}

async function activateWorkspace(id: string): Promise<void> {
  await withWorkspaceLock(async () => {
    const target = workspaces.find((workspace) => workspace.id === id);
    if (!target || target === activeWorkspace) return;
    await switchToWorkspace(target);
  });
}

async function restoreWorkspaces(): Promise<void> {
  const layout = loadWorkspaces();

  if (layout) {
    workspaces = layout.workspaces.map(savedToWorkspace);
    tabGroupOrder = normalizeTabGroupOrder(layout.tabGroupOrder);
    const active =
      workspaces.find((workspace) => workspace.id === layout.activeId) ??
      workspaces[0];
    await showWorkspace(active);
  } else {
    const workspace = makeWorkspace("Área 1");
    workspaces = [workspace];
    tabGroupOrder = normalizeTabGroupOrder();
    await showWorkspace(workspace);
  }

  renderWorkspaceTabs();
}

async function createWorkspace(): Promise<void> {
  await withWorkspaceLock(async () => {
    const workspace = makeWorkspace(undefined, { panX: 0, panY: 0, zoom: 1 });
    workspaces.push(workspace);
    tabGroupOrder.push(workspace.id);
    renderWorkspaceTabs();
    notifyTerminalTabsChanged();
    await switchToWorkspace(workspace);
    await addTerminalAtCenter();
    persist();
  });
}

async function cycleWorkspace(direction: number): Promise<void> {
  if (workspaces.length < 2 || !activeWorkspace) return;
  const index = workspaces.indexOf(activeWorkspace);
  const next = workspaces[(index + direction + workspaces.length) % workspaces.length];
  await activateWorkspace(next.id);
}

function notifyTerminalTabsChanged(): void {
  document.dispatchEvent(new CustomEvent("canvas-terminals-changed"));
}

function moveArrayItem<T>(
  list: T[],
  fromIndex: number,
  toItem: T,
  after: boolean,
): void {
  if (fromIndex < 0) return;
  const fromItem = list[fromIndex];
  if (!fromItem || fromItem === toItem) return;

  list.splice(fromIndex, 1);
  let insert = list.indexOf(toItem);
  if (insert < 0) return;
  if (after) insert += 1;
  list.splice(insert, 0, fromItem);
}

/** Reordena abas de terminal dentro do grupo (só afeta a faixa maximizada). */
function reorderTerminalTab(detail: TerminalTabReorderDetail): void {
  const workspace = workspaces.find(
    (entry) => entry.id === detail.from.workspaceId,
  );
  if (!workspace || workspace.id !== detail.to.workspaceId) return;

  if (workspace.initialized) {
    const list = workspace.terminals;
    const fromIndex = list.findIndex(
      (terminal) => terminal.id === detail.from.terminalId,
    );
    const toItem = list.find(
      (terminal) => terminal.id === detail.to.terminalId,
    );
    if (!toItem) return;
    moveArrayItem(list, fromIndex, toItem, detail.after);
    const focusedIndex = list.findIndex(
      (terminal) => terminal.id === workspace.lastFocusedId,
    );
    if (focusedIndex >= 0) workspace.focusedIndex = focusedIndex;
  } else {
    const list = workspace.pending;
    const fromIndex = detail.from.pendingIndex ?? -1;
    const toIndex = detail.to.pendingIndex ?? -1;
    const toItem = list[toIndex];
    if (!toItem) return;
    const focusedItem =
      workspace.focusedIndex !== undefined
        ? list[workspace.focusedIndex]
        : undefined;
    moveArrayItem(list, fromIndex, toItem, detail.after);
    if (focusedItem) {
      const focusedIndex = list.indexOf(focusedItem);
      if (focusedIndex >= 0) workspace.focusedIndex = focusedIndex;
    }
  }

  notifyTerminalTabsChanged();
  persist();
}

/** Reordena os grupos de áreas (somente a ordem da faixa maximizada). */
function reorderTerminalGroup(detail: TerminalGroupReorderDetail): void {
  if (detail.fromId === detail.toId) return;

  const order = normalizeTabGroupOrder(tabGroupOrder);
  const fromIndex = order.indexOf(detail.fromId);
  const toIndex = order.indexOf(detail.toId);
  if (fromIndex < 0 || toIndex < 0) return;

  const [moved] = order.splice(fromIndex, 1);
  let insert = order.indexOf(detail.toId);
  if (insert < 0) return;
  if (detail.after) insert += 1;
  order.splice(insert, 0, moved);

  tabGroupOrder = order;
  notifyTerminalTabsChanged();
  persist();
}

/** Grupos exibidos nas abas do terminal maximizado: todas as áreas. */
function terminalTabGroups(): TerminalTabGroup[] {
  const groups: TerminalTabGroup[] = [];

  for (const id of normalizeTabGroupOrder(tabGroupOrder)) {
    const workspace = workspaces.find((entry) => entry.id === id);
    if (!workspace) continue;

    const isActive = workspace === activeWorkspace;
    const terminals: TerminalTabRef[] = workspace.initialized
      ? workspace.terminals.map((terminal) => ({
          workspaceId: workspace.id,
          terminalId: terminal.id,
          label: terminal.title,
        }))
      : workspace.pending.map((saved, index) => ({
          workspaceId: workspace.id,
          pendingIndex: index,
          label: saved.title || `Terminal ${index + 1}`,
        }));

    if (terminals.length === 0) continue;
    groups.push({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      activeWorkspace: isActive,
      terminals,
    });
  }

  return groups;
}

/** Clicou numa aba do terminal maximizado: troca de área e maximiza o alvo. */
async function selectTerminalTab(ref: TerminalTabRef): Promise<void> {
  const workspace = workspaces.find((entry) => entry.id === ref.workspaceId);
  if (!workspace) return;

  await withWorkspaceLock(async () => {
    if (workspace !== activeWorkspace) {
      await switchToWorkspace(workspace);
    }

    let target: TerminalWindow | undefined;
    if (ref.terminalId !== undefined) {
      target = workspace.terminals.find((terminal) => terminal.id === ref.terminalId);
    } else if (ref.pendingIndex !== undefined) {
      target = workspace.terminals[ref.pendingIndex];
    }
    if (!target) {
      target = workspace.terminals.find((terminal) => terminal.maximized);
    }
    if (!target) target = workspace.terminals[0];
    if (!target) return;

    for (const terminal of workspace.terminals) {
      if (terminal !== target && terminal.maximized) terminal.toggleMaximize();
    }
    if (!target.maximized) {
      target.toggleMaximize();
    } else {
      // Garante que a janela já maximizada seja reposicionada/redimensionada
      // e que a faixa de abas seja exibida após a troca de área.
      target.render(canvas.zoom);
      target.refit();
    }
    target.focus();
    persist();
  });
}

function bindWorkspaceTabs(): void {
  document.getElementById("workspace-add")?.addEventListener("click", () => {
    void createWorkspace();
  });

  const list = document.getElementById("workspace-tab-list");
  list?.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey || list.scrollWidth <= list.clientWidth) return;
      list.scrollLeft += event.deltaY || event.deltaX;
      event.preventDefault();
    },
    { passive: false },
  );

  document.addEventListener("terminal-tab-reorder", ((event: Event) => {
    reorderTerminalTab(
      (event as CustomEvent<TerminalTabReorderDetail>).detail,
    );
  }) as EventListener);
  document.addEventListener("terminal-group-reorder", ((event: Event) => {
    reorderTerminalGroup(
      (event as CustomEvent<TerminalGroupReorderDetail>).detail,
    );
  }) as EventListener);
}

function renderWorkspaceTabs(): void {
  const list = document.getElementById("workspace-tab-list");
  if (!list) return;
  list.innerHTML = "";

  for (const workspace of workspaces) {
    const tab = document.createElement("div");
    tab.className =
      "workspace-tab" + (workspace === activeWorkspace ? " active" : "");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(workspace === activeWorkspace));
    tab.tabIndex = 0;
    tab.title = workspace.name;

    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = workspace.name;
    name.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      startWorkspaceRename(workspace, name);
    });
    tab.appendChild(name);

    tab.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if ((event.target as HTMLElement).closest(".tab-close")) return;
      showWorkspaceTabContextMenu(event.clientX, event.clientY, workspace, name);
    });

    if (workspaces.length > 1) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "tab-close";
      close.title = "Fechar área de trabalho";
      close.textContent = "×";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        requestCloseWorkspace(workspace);
      });
      tab.appendChild(close);
    }

    tab.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest(".tab-close")) return;
      void activateWorkspace(workspace.id);
    });
    tab.addEventListener("keydown", (event) => {
      if ((event.target as HTMLElement).closest(".tab-close")) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void activateWorkspace(workspace.id);
      }
    });

    list.appendChild(tab);
  }

  list
    .querySelector<HTMLElement>(".workspace-tab.active")
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function showWorkspaceTabContextMenu(
  x: number,
  y: number,
  workspace: Workspace,
  nameEl: HTMLElement,
): void {
  const items = [
    {
      label: "Renomear área de trabalho",
      action: () => startWorkspaceRename(workspace, nameEl),
    },
  ];
  if (workspaces.length > 1) {
    items.push({
      label: "Fechar área de trabalho",
      action: () => requestCloseWorkspace(workspace),
    });
  }
  renderContextMenu(items, x, y);
}

function startWorkspaceRename(workspace: Workspace, nameEl: HTMLElement): void {
  if (nameEl.isContentEditable) return;
  nameEl.contentEditable = "true";
  nameEl.classList.add("editing");
  nameEl.focus();

  const range = document.createRange();
  range.selectNodeContents(nameEl);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);

  const finish = (commit: boolean) => {
    nameEl.removeEventListener("keydown", onKey, true);
    nameEl.removeEventListener("blur", onBlur, true);
    const value = (nameEl.textContent || "").trim();
    nameEl.contentEditable = "false";
    nameEl.classList.remove("editing");
    if (commit && value) workspace.name = value;
    renderWorkspaceTabs();
    notifyTerminalTabsChanged();
    persist();
  };
  const onKey = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  };
  const onBlur = () => finish(true);

  nameEl.addEventListener("keydown", onKey, true);
  nameEl.addEventListener("blur", onBlur, true);
}

function requestCloseWorkspace(workspace: Workspace): void {
  if (workspaces.length <= 1) return;
  const count = workspace.terminals.length + workspace.pending.length;
  if (count === 0) {
    void removeWorkspace(workspace);
    return;
  }
  showConfirm(
    "Fechar área de trabalho",
    `<p>Fechar <strong>${escapeHtml(workspace.name)}</strong>?</p>
     <p>${
       count === 1
         ? "1 terminal desta área será encerrado."
         : `${count} terminais desta área serão encerrados.`
     }</p>`,
    "Fechar área",
    () => void removeWorkspace(workspace),
  );
}

async function removeWorkspace(workspace: Workspace): Promise<void> {
  await withWorkspaceLock(async () => {
    if (workspaces.length <= 1) return;

    if (workspace === activeWorkspace) {
      const index = workspaces.indexOf(workspace);
      const next = workspaces[index + 1] ?? workspaces[index - 1];
      if (!next) return;
      await switchToWorkspace(next);
    }

    for (const terminal of workspace.terminals) terminal.destroy();
    workspace.terminals = [];
    workspace.pending = [];
    workspaces = workspaces.filter((entry) => entry !== workspace);
    tabGroupOrder = tabGroupOrder.filter((id) => id !== workspace.id);

    renderWorkspaceTabs();
    notifyTerminalTabsChanged();
    updateStatus();
    persist();
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
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
    // No modo maximizado o cabeçalho só abre pelo botão ☰.
    if (document.body.classList.contains("terminal-maximized")) return;
    bar.classList.add("visible");
  };

  const scheduleHide = (delay = 350) => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      // O cabeçalho aberto pelo botão do modo maximizado não fecha sozinho.
      if (document.body.classList.contains("terminal-maximized")) return;
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

  // Clicar fora do cabeçalho fecha o menu aberto pelo botão ☰.
  document.addEventListener("click", (event) => {
    if (!toolbarForcedOpen) return;
    const target = event.target as HTMLElement;
    if (
      bar.contains(target) ||
      target.closest(".term-menu-btn") ||
      target.closest("#context-menu")
    ) {
      return;
    }
    toolbarForcedOpen = false;
    bar.classList.remove("visible");
    if (updateMaximizedInset()) refreshMaximizedGeometry();
  });

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
  toolbarForcedOpen = false;
  document.getElementById("toolbar")?.classList.remove("visible");
  syncMaximizedView();
  // O viewport mudou de tamanho: reavalia grid e janelas maximizadas.
  refreshMaximizedGeometry();
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

      if (mod && e.key.toLowerCase() === "s") {
        own();
        saveNow();
        return;
      }
      if (e.key === "Escape") {
        if (closeDialog()) {
          own();
          return;
        }
        if (closeAllMenus()) {
          own();
          return;
        }
        if (toolbarForcedOpen) {
          toolbarForcedOpen = false;
          document.getElementById("toolbar")?.classList.remove("visible");
          if (updateMaximizedInset()) refreshMaximizedGeometry();
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
      if (mod && e.key === "Tab") {
        own();
        await cycleWorkspace(e.shiftKey ? -1 : 1);
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "t") {
        own();
        await createWorkspace();
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "t") {
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
  updateStatus();
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
  syncMaximizedView();
}

/**
 * No modo maximizado o cabeçalho não desce mais por hover. Ele é aberto pelo
 * botão ☰ da barra de abas (primeiro item) e, enquanto aberto, o terminal é
 * empurrado para baixo para não cobrir as abas.
 */
function syncMaximizedView(): void {
  const maximized = canvas
    .getAllTerminals()
    .some((terminal) => terminal.maximized);
  const wasMaximized = document.body.classList.contains("terminal-maximized");
  const changed = maximized !== wasMaximized;

  if (changed) {
    document.body.classList.toggle("terminal-maximized", maximized);
    toolbarForcedOpen = false;
    document.getElementById("toolbar")?.classList.remove("visible");
    closeAllMenus();
  }

  if (updateMaximizedInset() || changed) {
    refreshMaximizedGeometry();
  }
}

/** Atualiza o inset do topo conforme o cabeçalho está aberto e há maximizado. */
function updateMaximizedInset(): boolean {
  const bar = document.getElementById("toolbar");
  const maximized = document.body.classList.contains("terminal-maximized");
  const headerOpen = !!bar?.classList.contains("visible");
  const inset = maximized && headerOpen ? HEADER_HEIGHT : 0;
  if (canvas.topInset === inset) return false;
  canvas.topInset = inset;
  return true;
}

/** Re-renderiza o canvas e reajusta o xterm após mudanças de geometria. */
function refreshMaximizedGeometry(): void {
  canvas.requestRender();
  requestAnimationFrame(() => {
    for (const terminal of canvas.getAllTerminals()) {
      if (terminal.maximized) terminal.refit();
    }
  });
}

/** Botão ☰ das abas maximizadas: abre/fecha o cabeçalho do app. */
function toggleMaximizedAppMenu(): void {
  if (!document.body.classList.contains("terminal-maximized")) return;
  const bar = document.getElementById("toolbar");
  if (!bar) return;

  toolbarForcedOpen = !toolbarForcedOpen;
  bar.classList.toggle("visible", toolbarForcedOpen);
  if (!toolbarForcedOpen) closeAllMenus();
  if (updateMaximizedInset()) refreshMaximizedGeometry();
}

function trackMouseCoordinates(): void {
  canvas.viewport.addEventListener("mousemove", (e) => {
    const p = canvas.screenToWorld(e.clientX, e.clientY);
    toolbar.coords.textContent = `${Math.round(p.x)}, ${Math.round(p.y)}`;
  });
}

function persist(): void {
  if (!activeWorkspace) return;
  activeWorkspace.view = {
    panX: canvas.panX,
    panY: canvas.panY,
    zoom: canvas.zoom,
  };

  saveWorkspaces({
    activeId: activeWorkspace.id,
    tabGroupOrder: normalizeTabGroupOrder(tabGroupOrder),
    workspaces: workspaces.map((workspace) => {
      let focusedIndex = workspace.focusedIndex;
      if (workspace.initialized) {
        const index = workspace.terminals.findIndex(
          (terminal) => terminal.id === workspace.lastFocusedId,
        );
        if (index >= 0) focusedIndex = index;
      }
      return {
        id: workspace.id,
        name: workspace.name,
        view: workspace.view,
        focusedIndex,
        terminals: workspace.initialized
          ? workspace.terminals.map((terminal) => toSavedTerminal(terminal.getState()))
          : workspace.pending,
      };
    }),
  });
}

/** Salvamento manual (Ctrl+S / Arquivo → Salvar) com aviso de sucesso. */
function saveNow(): void {
  persist();
  flushSave();
  showToast("Perfil salvo com sucesso");
}

function showToast(message: string): void {
  const toast = document.getElementById("toast");
  if (!toast) return;
  if (toastTimer) clearTimeout(toastTimer);
  toast.textContent = `✓ ${message}`;
  toast.classList.add("visible");
  toastTimer = setTimeout(() => {
    toastTimer = null;
    toast.classList.remove("visible");
  }, 2600);
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
    {
      label: terminal.startupCommand
        ? "Editar comando de inicialização..."
        : "Comando de inicialização...",
      action: () => editStartupCommand(terminal),
    },
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
