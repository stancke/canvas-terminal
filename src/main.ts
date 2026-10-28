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
import {
  PLUGINS,
  isPluginEnabled,
  loadPluginSettings,
  savePluginSettings,
  type PluginDefinition,
  type PluginSettings,
} from "./plugins";
import { TokenUsageWidget } from "./token-usage";
import { ClickUpPlugin } from "./clickup";
import { initTheme, onThemeChange, themeLabel, toggleTheme } from "./theme";
import {
  DEFAULT_WORKSPACE_COLOR,
  DEFAULT_WORKSPACE_ICON,
  WORKSPACE_COLORS,
  WORKSPACE_ICONS,
  createWorkspaceIcon,
  isWorkspaceIcon,
} from "./workspace-icons";
import { GitPanel } from "./git-panel";

const DEFAULT_W = 720;
const DEFAULT_H = 420;
/** Miniatura salva no perfil: pequena o bastante para o localStorage. */
const WORKSPACE_IMAGE_SIZE = 96;
const WORKSPACE_IMAGE_MAX = 380_000;
const RAIL_COLLAPSED_KEY = "canvas-terminal.rail-collapsed.v1";

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
  /** Aparência no painel lateral. */
  color: string;
  icon: string;
  /** Pasta padrão dos novos terminais desta área. */
  folder: string;
  /** Miniatura (data URL) que substitui o ícone. */
  image: string;
}

let canvas: Canvas;
let shells: ShellInfo[] = [];
let focusedTerminal: TerminalWindow | null = null;
let zCounter = 10;
let quickCommands: QuickCommand[] = [];
let pluginSettings: PluginSettings = { enabled: {} };
let tokenUsageWidget: TokenUsageWidget | null = null;
let clickUpPlugin: ClickUpPlugin | null = null;
let gitPanel: GitPanel | null = null;
let hintTimer: ReturnType<typeof setTimeout> | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let workspaces: Workspace[] = [];
let activeWorkspace: Workspace | null = null;
/** Preferência do usuário para o painel lateral (maximizado sempre recolhe). */
let railUserCollapsed = false;
/** Ordem dos grupos (áreas) exibida somente nas abas do modo maximizado. */
let tabGroupOrder: string[] = [];

const ui = {
  shellSelect: document.querySelector<HTMLSelectElement>("#shell-select")!,
  fullscreenBtn: document.querySelector<HTMLButtonElement>("#btn-fullscreen")!,
  zoom: document.querySelector<HTMLSpanElement>("#zoom-indicator")!,
  count: document.querySelector<HTMLSpanElement>("#terminal-count")!,
  coords: document.querySelector<HTMLSpanElement>("#coords")!,
  appMenu: document.querySelector<HTMLElement>("#app-menu")!,
  appMenuButton: document.querySelector<HTMLButtonElement>("#rail-app-menu")!,
};

const menuEls = Array.from(document.querySelectorAll<HTMLElement>("#app-menu .menu"));

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

  bindAppChrome();
  bindWorkspaceRail();
  bindQuickPanel();
  bindPlugins();
  bindGlobalShortcuts();
  bindFullscreenWatcher();
  bindContextMenu();
  bindTitlebarContext();

  gitPanel = new GitPanel(
    document.getElementById("git-modal")!,
    () => suggestGitFolder(),
  );

  await restoreWorkspaces();
  updateStatus();
  trackMouseCoordinates();

  if (activeWorkspace && activeWorkspace.terminals.length === 0) {
    await addTerminalAtCenter();
  }
}

function populateShellSelect(): void {
  ui.shellSelect.innerHTML = "";
  for (const shell of shells) {
    const opt = document.createElement("option");
    opt.value = shell.id;
    opt.textContent = shell.name;
    ui.shellSelect.appendChild(opt);
  }
}

function selectedShell(): string {
  return ui.shellSelect.value || shells[0]?.id || "";
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
    renderWorkspaceRail();
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
  const cwdPath = cwd || workspace.folder || (await defaultCwd());
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
  renderWorkspaceRail();
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

function bindAppChrome(): void {
  bindMenubar();
  bindMenuActions();
  bindDialog();
  ui.fullscreenBtn.addEventListener("click", () => void toggleFullscreen());
  ui.appMenuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleAppMenu();
  });
  document.getElementById("app-menu-close")?.addEventListener("click", () => {
    closeAppMenu();
    ui.appMenuButton.focus();
  });
  // O handler global ignora Esc quando o foco está em um campo do menu; aqui
  // o painel fecha mesmo a partir do seletor de shell.
  ui.appMenu.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeAppMenu();
    ui.appMenuButton.focus();
  });

  bindRailState();
}

/* ---- Menu do aplicativo (antigo cabeçalho) ---- */

function appMenuOpen(): boolean {
  return !ui.appMenu.classList.contains("hidden");
}

function openAppMenu(): void {
  ui.appMenu.classList.remove("hidden");
  ui.appMenuButton.setAttribute("aria-expanded", "true");
}

/** Fecha o painel do menu; devolve `true` se ele estava aberto. */
function closeAppMenu(): boolean {
  if (!appMenuOpen()) return false;
  closeAllMenus();
  ui.appMenu.classList.add("hidden");
  ui.appMenuButton.setAttribute("aria-expanded", "false");
  return true;
}

function toggleAppMenu(): void {
  if (appMenuOpen()) closeAppMenu();
  else openAppMenu();
}

/* ---- Recolher / expandir o painel lateral ---- */

/**
 * Aplica o estado do painel: a preferência do usuário, forçada a recolhido
 * quando há um terminal maximizado (o canvas usa a largura toda).
 * Devolve `true` se a classe mudou nesta chamada.
 */
function applyRailState(): boolean {
  const maximized = document.body.classList.contains("terminal-maximized");
  const collapsed = railUserCollapsed || maximized;
  const changed = document.body.classList.contains("rail-collapsed") !== collapsed;
  document.body.classList.toggle("rail-collapsed", collapsed);

  const toggle = document.getElementById("rail-toggle");
  if (toggle) {
    const label = collapsed
      ? "Expandir painel lateral"
      : "Recolher painel lateral";
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("aria-expanded", String(!collapsed));
  }
  return changed;
}

function setRailUserCollapsed(value: boolean): void {
  railUserCollapsed = value;
  try {
    localStorage.setItem(RAIL_COLLAPSED_KEY, value ? "1" : "0");
  } catch {
    // Ignora quota/escrita bloqueada.
  }
  if (value) closeAppMenu();
  if (applyRailState()) refreshMaximizedGeometry();
}

function bindRailState(): void {
  try {
    railUserCollapsed = localStorage.getItem(RAIL_COLLAPSED_KEY) === "1";
  } catch {
    railUserCollapsed = false;
  }
  document.getElementById("rail-toggle")?.addEventListener("click", () => {
    // No modo maximizado a alça fica oculta; a guarda evita estados estranhos.
    if (document.body.classList.contains("terminal-maximized")) return;
    setRailUserCollapsed(!railUserCollapsed);
  });
  applyRailState();
}

/** Fecha o painel quando o clique acontece fora da alça e do próprio painel. */
function bindAppMenuDismiss(): void {
  document.addEventListener("click", (event) => {
    if (!appMenuOpen()) return;
    const target = event.target as Node;
    if (ui.appMenu.contains(target) || ui.appMenuButton.contains(target)) return;
    if ((event.target as HTMLElement).closest("#context-menu")) return;
    closeAppMenu();
  });
}

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
    if (!ui.appMenu.contains(e.target as Node)) closeAllMenus();
  });

  bindAppMenuDismiss();
}

function bindMenuActions(): void {
  const on = (id: string, action: () => void) => {
    document.getElementById(id)?.addEventListener("click", () => {
      closeAllMenus();
      closeAppMenu();
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
  on("menu-edit-workspace", () => {
    if (activeWorkspace) editWorkspace(activeWorkspace);
    else flashHint("Nenhuma área de trabalho ativa.");
  });
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
    ["Trocar de área no canvas", "Q / E"],
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

  // O painel abre e fecha somente pelo clique na alça lateral (sem hover).
  const hotzone = document.getElementById("quick-hotzone")!;
  const togglePanel = () => {
    const visible = panel.classList.toggle("visible");
    if (!visible) closeQuickForm();
  };

  hotzone.addEventListener("click", togglePanel);
  hotzone.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    togglePanel();
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

/* ---- Plugins ---- */

function bindPlugins(): void {
  pluginSettings = loadPluginSettings();
  tokenUsageWidget = new TokenUsageWidget();
  clickUpPlugin = new ClickUpPlugin();
  renderPluginMenu();
  applyPluginStates();
}

/** Monta o menu "Plugins" a partir do registro (um interruptor por plugin). */
function renderPluginMenu(): void {
  const list = document.getElementById("plugin-list");
  if (!list) return;
  list.innerHTML = "";

  for (const plugin of PLUGINS) {
    const row = document.createElement("div");
    row.className = "plugin-item";
    row.dataset.id = plugin.id;
    row.setAttribute("role", "menuitemcheckbox");
    row.tabIndex = 0;

    const info = document.createElement("div");
    info.className = "plugin-info";

    const name = document.createElement("span");
    name.className = "plugin-name";
    name.textContent = plugin.name;

    const description = document.createElement("span");
    description.className = "plugin-desc";
    description.textContent = plugin.description;

    info.append(name, description);

    const toggle = document.createElement("span");
    toggle.className = "plugin-switch";
    toggle.setAttribute("aria-hidden", "true");

    row.append(info, toggle);
    row.addEventListener("click", () => activatePlugin(plugin, !isPluginEnabled(pluginSettings, plugin.id)));
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activatePlugin(plugin, !isPluginEnabled(pluginSettings, plugin.id));
    });

    list.appendChild(row);
  }

  syncPluginMenu();
}

function syncPluginMenu(): void {
  for (const row of document.querySelectorAll<HTMLElement>("#plugin-list .plugin-item")) {
    const id = row.dataset.id ?? "";
    const enabled = isPluginEnabled(pluginSettings, id);
    row.setAttribute("aria-checked", String(enabled));
  }
}

/** Liga/desliga um plugin, persiste e aplica o efeito (o menu fica aberto). */
function activatePlugin(plugin: PluginDefinition, enabled: boolean): void {
  pluginSettings.enabled[plugin.id] = enabled;
  savePluginSettings(pluginSettings);
  syncPluginMenu();
  applyPluginStates();
  flashHint(`Plugin "${plugin.name}" ${enabled ? "ativado" : "desativado"}.`);
}

function applyPluginStates(): void {
  tokenUsageWidget?.setEnabled(isPluginEnabled(pluginSettings, "token-usage"));
  clickUpPlugin?.setEnabled(isPluginEnabled(pluginSettings, "clickup"));
}

/* ---- Áreas de trabalho (painel lateral) ---- */

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

function nextWorkspaceColor(): string {
  return WORKSPACE_COLORS[workspaces.length % WORKSPACE_COLORS.length];
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
    color: nextWorkspaceColor(),
    icon: DEFAULT_WORKSPACE_ICON,
    folder: "",
    image: "",
  };
}

function savedToWorkspace(saved: SavedWorkspace, index = 0): Workspace {
  return {
    id: saved.id,
    name: saved.name,
    view: saved.view,
    terminals: [],
    pending: saved.terminals,
    initialized: false,
    lastFocusedId: undefined,
    focusedIndex: saved.focusedIndex,
    color:
      saved.color ??
      WORKSPACE_COLORS[index % WORKSPACE_COLORS.length] ??
      DEFAULT_WORKSPACE_COLOR,
    icon: isWorkspaceIcon(saved.icon) ? saved.icon : DEFAULT_WORKSPACE_ICON,
    folder: saved.folder ?? "",
    image: saved.image ?? "",
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

/** Localiza o terminal de uma aba (por id vivo ou índice salvo). */
function findTerminalByRef(
  workspace: Workspace,
  ref: TerminalTabRef,
): TerminalWindow | undefined {
  if (ref.terminalId !== undefined) {
    return workspace.terminals.find(
      (terminal) => terminal.id === ref.terminalId,
    );
  }
  if (ref.pendingIndex !== undefined) {
    return workspace.terminals[ref.pendingIndex];
  }
  return undefined;
}

/** Maximiza o terminal escolhido e restaura os demais maximizados da área. */
function maximizeWorkspaceTerminal(
  workspace: Workspace,
  target: TerminalWindow,
): void {
  for (const terminal of workspace.terminals) {
    if (terminal !== target && terminal.maximized) terminal.toggleMaximize();
  }
  if (!target.maximized) {
    target.toggleMaximize();
  } else {
    // Reaplica geometria/classe e reajusta o xterm após o attach.
    target.render(canvas.zoom);
    target.refit();
  }
}

/** Anexa a área ao canvas (a view é aplicada antes de posicionar as janelas). */
async function showWorkspace(
  workspace: Workspace,
  focusRef?: TerminalTabRef,
  forceNormal = false,
): Promise<void> {
  await instantiateWorkspace(workspace);

  activeWorkspace = workspace;
  // Cada área tem o seu zoom. No modo maximizado ele é sempre 100%.
  const maximizedMode = !forceNormal && workspaceIsMaximized(workspace);
  canvas.zoomLocked = maximizedMode;
  canvas.setView(
    workspace.view.panX,
    workspace.view.panY,
    maximizedMode ? 1 : (workspace.view.zoom || 1),
  );
  canvas.attachTerminals(workspace.terminals);

  // Navegação feita a partir do modo normal: a área de destino abre normal,
  // mesmo que tivesse um terminal maximizado salvo.
  if (forceNormal) {
    for (const terminal of workspace.terminals) {
      if (terminal.maximized) terminal.toggleMaximize();
    }
  }

  const target = focusRef
    ? findTerminalByRef(workspace, focusRef)
    : undefined;
  const maximized = forceNormal
    ? undefined
    : workspace.terminals.find((terminal) => terminal.maximized);
  const preferred =
    workspace.focusedIndex !== undefined
      ? workspace.terminals[workspace.focusedIndex]
      : undefined;
  focusedTerminal =
    target ??
    maximized ??
    preferred ??
    workspace.terminals.find((terminal) => terminal.id === workspace.lastFocusedId) ??
    workspace.terminals[0] ??
    null;

  if (target) {
    maximizeWorkspaceTerminal(workspace, target);
  }

  if (focusedTerminal) {
    focusedTerminal.focus();
  } else {
    canvas.setCanvasActive(true);
  }

  renderWorkspaceRail();
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

async function switchToWorkspace(
  target: Workspace,
  focusRef?: TerminalTabRef,
  forceNormal = false,
): Promise<void> {
  // Prepara a área de destino (spawn dos PTYs) *antes* de desanexar a atual:
  // assim o usuário não vê um canvas em branco enquanto os terminais sobem.
  await instantiateWorkspace(target);

  if (activeWorkspace) {
    // Enquanto o zoom está travado (maximizado) ou a área tem um terminal
    // maximizado, preserva o zoom normal da área em vez de salvar o 100%.
    const keepZoom =
      canvas.zoomLocked ||
      workspaceIsMaximized(activeWorkspace) ||
      document.body.classList.contains("terminal-maximized");
    activeWorkspace.view = {
      panX: canvas.panX,
      panY: canvas.panY,
      zoom: keepZoom ? activeWorkspace.view.zoom : canvas.zoom,
    };
    canvas.detachTerminals();
  }

  await showWorkspace(target, focusRef, forceNormal);
  persist();
}

async function activateWorkspace(id: string): Promise<void> {
  await withWorkspaceLock(async () => {
    const target = workspaces.find((workspace) => workspace.id === id);
    if (!target || target === activeWorkspace) return;
    // Se a navegação começou no modo normal, a área escolhida abre normal.
    const wasMaximized = canvas
      .getAllTerminals()
      .some((terminal) => terminal.maximized);
    await switchToWorkspace(target, undefined, !wasMaximized);
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

  renderWorkspaceRail();
}

async function createWorkspace(): Promise<void> {
  await withWorkspaceLock(async () => {
    const workspace = makeWorkspace(undefined, {
      panX: 0,
      panY: 0,
      zoom: 1,
    });
    workspaces.push(workspace);
    tabGroupOrder.push(workspace.id);
    renderWorkspaceRail();
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
      // A própria troca já anexa e maximiza o terminal clicado.
      await switchToWorkspace(workspace, ref);
      return;
    }

    let target = findTerminalByRef(workspace, ref);
    if (!target) {
      target = workspace.terminals.find((terminal) => terminal.maximized);
    }
    if (!target) target = workspace.terminals[0];
    if (!target) return;

    maximizeWorkspaceTerminal(workspace, target);
    target.focus();
    persist();
  });
}

function bindWorkspaceRail(): void {
  document.getElementById("workspace-add")?.addEventListener("click", () => {
    void createWorkspace();
  });

  document.getElementById("rail-git")?.addEventListener("click", () => {
    closeAppMenu();
    gitPanel?.open();
  });

  // Navegação por setas entre as áreas (padrão de tablist vertical).
  const list = document.getElementById("workspace-rail-list");
  list?.addEventListener("keydown", (event) => {
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    const buttons = Array.from(
      list.querySelectorAll<HTMLButtonElement>(".rail-workspace"),
    );
    if (buttons.length === 0) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = current < 0 ? 0 : current;
    if (event.key === "ArrowDown") next = (next + 1) % buttons.length;
    else if (event.key === "ArrowUp") {
      next = (next - 1 + buttons.length) % buttons.length;
    } else if (event.key === "Home") next = 0;
    else next = buttons.length - 1;
    buttons[next]?.focus();
  });

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

/** Iniciais exibidas quando a área usa o ícone de letras. */
function workspaceInitials(workspace: Workspace): string {
  const parts = workspace.name.trim().split(/\s+/).filter(Boolean);
  const initials = parts.map((part) => part[0]).join("").slice(0, 2);
  return (initials || "?").toUpperCase();
}

function workspaceHasTerminals(workspace: Workspace): boolean {
  return workspace.initialized
    ? workspace.terminals.length > 0
    : workspace.pending.length > 0;
}

/** Uma área está no modo maximizado quando algum terminal está maximizado. */
function workspaceIsMaximized(workspace: Workspace | null): boolean {
  return !!workspace?.terminals.some((terminal) => terminal.maximized);
}

function renderWorkspaceRail(): void {
  const list = document.getElementById("workspace-rail-list");
  if (!list) return;
  list.innerHTML = "";

  for (const workspace of workspaces) {
    const active = workspace === activeWorkspace;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rail-workspace" + (active ? " active" : "");
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    button.title = workspace.folder
      ? `${workspace.name}\n${workspace.folder}`
      : workspace.name;
    button.dataset.workspaceId = workspace.id;
    button.style.setProperty("--ws-color", workspace.color);
    button.style.color = workspace.color;
    if (active) {
      button.style.background = `${workspace.color}24`;
      button.style.borderColor = `${workspace.color}70`;
    }

    if (workspace.image) {
      const image = document.createElement("img");
      image.className = "rail-workspace-image";
      image.src = workspace.image;
      image.alt = "";
      button.appendChild(image);
    } else if (workspace.icon === "letters") {
      const letters = document.createElement("span");
      letters.className = "rail-workspace-letters";
      letters.textContent = workspaceInitials(workspace);
      button.appendChild(letters);
    } else {
      button.appendChild(createWorkspaceIcon(workspace.icon, 22));
    }

    if (workspaceHasTerminals(workspace)) {
      const dot = document.createElement("span");
      dot.className = "rail-workspace-dot";
      dot.title = "Terminais abertos nesta área";
      button.appendChild(dot);
    }

    button.addEventListener("click", () => {
      void activateWorkspace(workspace.id);
    });
    button.addEventListener("dblclick", (event) => {
      event.preventDefault();
      editWorkspace(workspace, true);
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showWorkspaceContextMenu(event.clientX, event.clientY, workspace);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      void activateWorkspace(workspace.id);
    });

    list.appendChild(button);
  }

  list
    .querySelector<HTMLElement>(".rail-workspace.active")
    ?.scrollIntoView({ block: "nearest" });
}

function showWorkspaceContextMenu(
  x: number,
  y: number,
  workspace: Workspace,
): void {
  closeAppMenu();
  const items = [
    {
      label: "Editar área de trabalho",
      action: () => editWorkspace(workspace),
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

/* ---- Editar área de trabalho (nome, cor, ícone, imagem e pasta) ---- */

function workspaceEditorHtml(workspace: Workspace): string {
  const swatches = WORKSPACE_COLORS.map(
    (color) =>
      `<button type="button" class="workspace-color" data-color="${color}"` +
      ` style="--ws-color:${color}" title="${color}" aria-label="Cor ${color}"></button>`,
  ).join("");

  const icons = WORKSPACE_ICONS.map((icon) => {
    const preview =
      icon.id === "letters"
        ? `<span class="workspace-icon-letters">${escapeHtml(
            workspaceInitials(workspace),
          )}</span>`
        : `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor"` +
          ` stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">` +
          icon.markup +
          `</svg>`;
    return (
      `<button type="button" class="workspace-icon-option" data-icon="${icon.id}"` +
      ` title="${icon.label}" aria-label="${icon.label}">${preview}</button>`
    );
  }).join("");

  return `
    <div class="workspace-edit-head">
      <span id="ws-edit-preview" class="workspace-edit-preview"></span>
      <span class="workspace-edit-titles">
        <span id="ws-edit-title" class="workspace-edit-title"></span>
        <span class="workspace-edit-subtitle">Área de trabalho</span>
      </span>
    </div>

    <label class="dialog-field">
      <span class="dialog-field-label">Nome</span>
      <input id="ws-edit-name" class="dialog-input" type="text" maxlength="80"
        placeholder="Nome da área de trabalho" value="${escapeHtml(workspace.name)}" />
    </label>

    <div class="dialog-field">
      <span class="dialog-field-label">Cor</span>
      <div id="ws-edit-colors" class="workspace-colors">${swatches}</div>
    </div>

    <div class="dialog-field">
      <span class="dialog-field-label">Ícone</span>
      <div id="ws-edit-icons" class="workspace-icons">${icons}</div>
    </div>

    <div class="dialog-field">
      <span class="dialog-field-label">Imagem</span>
      <div class="workspace-image-row">
        <button type="button" id="ws-edit-image-pick" class="dialog-button">
          Escolher uma imagem...
        </button>
        <button type="button" id="ws-edit-image-clear" class="dialog-link">Remover</button>
        <input id="ws-edit-image-input" type="file" accept="image/*" class="hidden" />
      </div>
      <p class="dialog-hint">A imagem substitui o ícone no painel lateral.</p>
    </div>

    <div class="dialog-field">
      <span class="dialog-field-label">Pasta</span>
      <div class="workspace-folder-row">
        <input id="ws-edit-folder" class="dialog-input" type="text" maxlength="4096"
          placeholder="Nenhuma: novos terminais seguem as configurações"
          value="${escapeHtml(workspace.folder)}" />
        <button type="button" id="ws-edit-folder-pick" class="dialog-button"
          title="Usar a pasta do terminal em foco (ou a pasta padrão)">Escolher...</button>
      </div>
      <p class="dialog-hint">
        Novos terminais desta área abrem nesta pasta. O painel do Git usa a
        pasta escolhida dentro dele.
      </p>
    </div>
  `;
}

function editWorkspace(workspace: Workspace, focusName = false): void {
  closeAppMenu();
  const draft = {
    color: workspace.color || DEFAULT_WORKSPACE_COLOR,
    icon: isWorkspaceIcon(workspace.icon)
      ? workspace.icon
      : DEFAULT_WORKSPACE_ICON,
    image: workspace.image || "",
  };

  showConfirm(
    "Editar área de trabalho",
    workspaceEditorHtml(workspace),
    "Salvar",
    () => {
      const nameInput = document.getElementById(
        "ws-edit-name",
      ) as HTMLInputElement | null;
      const folderInput = document.getElementById(
        "ws-edit-folder",
      ) as HTMLInputElement | null;
      const name = nameInput?.value.trim() ?? "";
      if (name) workspace.name = name;
      workspace.color = draft.color;
      workspace.icon = draft.icon;
      workspace.image = draft.image;
      workspace.folder = folderInput?.value.trim() ?? "";
      renderWorkspaceRail();
      notifyTerminalTabsChanged();
      persist();
      updateStatus();
    },
  );

  const preview = document.getElementById("ws-edit-preview")!;
  const title = document.getElementById("ws-edit-title")!;
  const nameInput = document.getElementById(
    "ws-edit-name",
  ) as HTMLInputElement;
  const folderInput = document.getElementById(
    "ws-edit-folder",
  ) as HTMLInputElement;
  const imageInput = document.getElementById(
    "ws-edit-image-input",
  ) as HTMLInputElement;
  const colorButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#ws-edit-colors .workspace-color"),
  );
  const iconButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#ws-edit-icons .workspace-icon-option"),
  );

  const refreshPreview = () => {
    preview.innerHTML = "";
    preview.style.setProperty("--ws-color", draft.color);
    preview.style.background = `${draft.color}22`;
    preview.style.borderColor = `${draft.color}66`;
    if (draft.image) {
      const image = document.createElement("img");
      image.src = draft.image;
      image.alt = "";
      preview.appendChild(image);
    } else if (draft.icon === "letters") {
      const letters = document.createElement("span");
      letters.className = "workspace-edit-letters";
      letters.textContent = workspaceInitials({
        ...workspace,
        name: nameInput.value || workspace.name,
      });
      preview.appendChild(letters);
    } else {
      const icon = createWorkspaceIcon(draft.icon, 24);
      icon.style.color = draft.color;
      preview.appendChild(icon);
    }
    preview.style.color = draft.color;
    title.textContent = nameInput.value.trim() || workspace.name;

    for (const button of colorButtons) {
      button.classList.toggle("selected", button.dataset.color === draft.color);
    }
    for (const button of iconButtons) {
      button.classList.toggle(
        "selected",
        !draft.image && button.dataset.icon === draft.icon,
      );
    }

    const lettersPreview = document.querySelector<HTMLElement>(
      "#ws-edit-icons .workspace-icon-letters",
    );
    if (lettersPreview) {
      lettersPreview.textContent = workspaceInitials({
        ...workspace,
        name: nameInput.value || workspace.name,
      });
    }
  };

  const selectColor = (color: string) => {
    draft.color = color;
    refreshPreview();
  };
  const selectIcon = (icon: string) => {
    draft.icon = icon;
    draft.image = "";
    refreshPreview();
  };

  for (const button of colorButtons) {
    button.addEventListener("click", () => selectColor(button.dataset.color || draft.color));
  }
  for (const button of iconButtons) {
    button.addEventListener("click", () => selectIcon(button.dataset.icon || draft.icon));
  }

  nameInput.addEventListener("input", refreshPreview);
  nameInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    (document.getElementById("dialog-confirm") as HTMLButtonElement | null)?.click();
  });
  folderInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeDialog();
  });

  document
    .getElementById("ws-edit-image-pick")
    ?.addEventListener("click", () => imageInput.click());
  document
    .getElementById("ws-edit-image-clear")
    ?.addEventListener("click", () => {
      draft.image = "";
      refreshPreview();
    });
  imageInput.addEventListener("change", () => {
    const file = imageInput.files?.[0];
    imageInput.value = "";
    if (!file) return;
    void fileToWorkspaceImage(file)
      .then((dataUrl) => {
        draft.image = dataUrl;
        refreshPreview();
      })
      .catch((err) => {
        flashHint(err instanceof Error ? err.message : "Imagem não suportada.");
      });
  });

  document
    .getElementById("ws-edit-folder-pick")
    ?.addEventListener("click", () => {
      void (async () => {
        const candidate =
          focusedTerminal?.cwd || (await defaultCwd().catch(() => ""));
        if (!candidate) {
          folderInput.focus();
          flashHint("Digite o caminho da pasta.");
          return;
        }
        folderInput.value = candidate;
        folderInput.focus();
      })();
    });

  refreshPreview();
  if (focusName) {
    nameInput.focus();
    nameInput.select();
  } else {
    nameInput.focus();
    nameInput.setSelectionRange(nameInput.value.length, nameInput.value.length);
  }
}

/** Reduz a imagem escolhida para uma miniatura pequena (localStorage). */
function fileToWorkspaceImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("Selecione um arquivo de imagem."));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Não foi possível ler a imagem."));
    reader.onload = () => {
      const source = String(reader.result || "");
      const image = new Image();
      image.onerror = () => reject(new Error("Imagem inválida."));
      image.onload = () => {
        if (!image.width || !image.height) {
          reject(new Error("Imagem inválida."));
          return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = WORKSPACE_IMAGE_SIZE;
        canvas.height = WORKSPACE_IMAGE_SIZE;
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("Não foi possível processar a imagem."));
          return;
        }
        const scale = Math.max(
          WORKSPACE_IMAGE_SIZE / image.width,
          WORKSPACE_IMAGE_SIZE / image.height,
        );
        const width = image.width * scale;
        const height = image.height * scale;
        context.drawImage(
          image,
          (WORKSPACE_IMAGE_SIZE - width) / 2,
          (WORKSPACE_IMAGE_SIZE - height) / 2,
          width,
          height,
        );
        let dataUrl = canvas.toDataURL("image/png");
        if (dataUrl.length > WORKSPACE_IMAGE_MAX) {
          dataUrl = canvas.toDataURL("image/jpeg", 0.8);
        }
        if (dataUrl.length > WORKSPACE_IMAGE_MAX) {
          reject(new Error("Imagem muito grande. Use uma imagem menor."));
          return;
        }
        resolve(dataUrl);
      };
      image.src = source;
    };
    reader.readAsDataURL(file);
  });
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
      const wasMaximized = canvas
        .getAllTerminals()
        .some((terminal) => terminal.maximized);
      await switchToWorkspace(next, undefined, !wasMaximized);
    }

    for (const terminal of workspace.terminals) terminal.destroy();
    workspace.terminals = [];
    workspace.pending = [];
    workspaces = workspaces.filter((entry) => entry !== workspace);
    tabGroupOrder = tabGroupOrder.filter((id) => id !== workspace.id);

    renderWorkspaceRail();
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
  ui.fullscreenBtn.title = on ? "Sair da tela cheia (F11)" : "Tela cheia (F11)";
  ui.fullscreenBtn.setAttribute("aria-pressed", on ? "true" : "false");
  closeAppMenu();
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

      // Navegação por teclado no canvas: Q/E trocam de área de trabalho.
      if (
        !mod &&
        !e.shiftKey &&
        !e.altKey &&
        canvas.canvasActive &&
        !document.querySelector('[aria-modal="true"]:not(.hidden)') &&
        !canvas.getAllTerminals().some((terminal) => terminal.maximized) &&
        (document.activeElement === canvas.viewport ||
          document.activeElement === document.body)
      ) {
        const key = e.key.toLowerCase();
        if (key === "q" || key === "e") {
          own();
          if (e.repeat) return;
          await cycleWorkspace(key === "q" ? -1 : 1);
          // Mantém o modo de navegação para permitir trocar várias áreas.
          if (!canvas.getAllTerminals().some((terminal) => terminal.maximized)) {
            canvas.setCanvasActive(true);
          }
          return;
        }
      }

      if (e.key === "Escape") {
        if (closeDialog()) {
          own();
          return;
        }
        if (gitPanel?.close()) {
          own();
          return;
        }
        if (closeAllMenus()) {
          own();
          return;
        }
        if (closeAppMenu()) {
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
  const target = e.target;
  if (!(target instanceof HTMLElement)) return false;
  if (isInsideTerminal(target)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}

/** O xterm.js captura a digitação num <textarea> oculto: atalhos globais seguem valendo. */
function isInsideTerminal(el: unknown): boolean {
  if (!(el instanceof HTMLElement)) return false;
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
  syncMaximizedView();
  ui.zoom.textContent = `${Math.round(canvas.zoom * 100)}%`;
  ui.count.textContent = String(canvas.getAllTerminals().length);
}

/**
 * O modo maximizado ocupa todo o viewport com zoom 100%; ao restaurar, cada
 * área volta ao zoom que tinha no modo normal.
 */
function syncMaximizedView(): void {
  const maximized = canvas
    .getAllTerminals()
    .some((terminal) => terminal.maximized);
  const wasMaximized = document.body.classList.contains("terminal-maximized");
  const changed = maximized !== wasMaximized;

  if (changed) {
    document.body.classList.toggle("terminal-maximized", maximized);
    closeAppMenu();

    if (maximized) {
      // Guarda o zoom normal antes de exibir o terminal maximizado em 100%.
      if (activeWorkspace && canvas.zoom !== 1) {
        activeWorkspace.view.zoom = canvas.zoom;
      }
      canvas.zoomLocked = true;
      canvas.setView(canvas.panX, canvas.panY, 1, false);
    } else {
      canvas.zoomLocked = false;
      canvas.setView(
        canvas.panX,
        canvas.panY,
        activeWorkspace?.view.zoom ?? 1,
        false,
      );
    }
  }

  // Maximizado: painel sempre recolhido. Ao restaurar, volta à preferência
  // do usuário (recolhido ou expandido).
  const railChanged = applyRailState();
  if (changed || railChanged) refreshMaximizedGeometry();
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

/** Botão ☰ das abas maximizadas: abre/fecha o menu do aplicativo. */
function toggleMaximizedAppMenu(): void {
  if (!document.body.classList.contains("terminal-maximized")) return;
  toggleAppMenu();
}

function trackMouseCoordinates(): void {
  canvas.viewport.addEventListener("mousemove", (e) => {
    const p = canvas.screenToWorld(e.clientX, e.clientY);
    ui.coords.textContent = `${Math.round(p.x)}, ${Math.round(p.y)}`;
  });
}

function persist(): void {
  if (!activeWorkspace) return;
  // No modo maximizado o zoom exibido é 100%, mas o zoom normal da área deve
  // ser preservado para quando ela for restaurada.
  const keepZoom =
    canvas.zoomLocked ||
    workspaceIsMaximized(activeWorkspace) ||
    document.body.classList.contains("terminal-maximized");
  activeWorkspace.view = {
    panX: canvas.panX,
    panY: canvas.panY,
    zoom: keepZoom ? activeWorkspace.view.zoom : canvas.zoom,
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
        color: workspace.color,
        icon: workspace.icon,
        folder: workspace.folder || undefined,
        image: workspace.image || undefined,
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

  const screen = canvas.worldToScreen(point.x, point.y);
  renderContextMenu(items, screen.x, screen.y);
}

/**
 * Sugestão inicial para o seletor de pasta do painel do Git: a pasta da área,
 * o cwd do terminal em foco/primeiro terminal ou a pasta padrão do app.
 * Depois da primeira escolha, o painel usa sempre a pasta persistida.
 */
async function suggestGitFolder(): Promise<string> {
  if (activeWorkspace?.folder) return activeWorkspace.folder;
  const cwd =
    focusedTerminal?.cwd || canvas.getAllTerminals()[0]?.cwd || "";
  if (cwd) return cwd;
  return defaultCwd().catch(() => "");
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
  contextMenu.style.left = `${Math.max(
    (document.getElementById("workspace-rail")?.getBoundingClientRect().right ?? 0) + 6,
    Math.min(x, window.innerWidth - 160),
  )}px`;
  contextMenu.style.top = `${Math.min(y, window.innerHeight - 120)}px`;
  contextMenu.classList.remove("hidden");
}

function hideContextMenu(): void {
  contextMenu.classList.add("hidden");
}

main().catch((err) => {
  document.body.innerHTML = `<pre>MAIN ERROR: ${err}</pre>`;
});
