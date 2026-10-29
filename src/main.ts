import "@xterm/xterm/css/xterm.css";
import { isTauri } from "@tauri-apps/api/core";
import { Canvas } from "./canvas";
import {
  createTerminal,
  TerminalWindow,
  type TerminalSessionOptions,
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
import { TokenUsageModal } from "./token-usage";
import { ClickUpPlugin } from "./clickup";
import {
  allActions,
  capture,
  format,
  getBinding,
  getLabel,
  matches,
  resetBindings,
  setBinding,
  type ShortcutAction,
} from "./shortcuts";
import {
  applyTheme,
  currentTheme,
  getTheme,
  initTheme,
  onThemeChange,
  THEME_GROUPS,
  type ThemeName,
} from "./theme";
import { autostartAvailable, isAutostartEnabled, setAutostart } from "./autostart";
import {
  DEFAULT_WORKSPACE_COLOR,
  DEFAULT_WORKSPACE_ICON,
  WORKSPACE_COLORS,
  WORKSPACE_ICONS,
  createWorkspaceIcon,
  isWorkspaceIcon,
} from "./workspace-icons";
import { GitPanel } from "./git-panel";
import { LayoutsPanel } from "./layouts-panel";
import { captureLayout, slotRect, type SavedLayout } from "./layouts";
import {
  SCROLLBACK_MAX_CHARS,
  isHistoryRestoreEnabled,
  loadScrollbacks,
  saveScrollbacks,
  setHistoryRestoreEnabled,
} from "./session-store";

const DEFAULT_W = 720;
const DEFAULT_H = 420;
/** Miniatura salva no perfil: pequena o bastante para o localStorage. */
const WORKSPACE_IMAGE_SIZE = 96;
const WORKSPACE_IMAGE_MAX = 380_000;
const RAIL_COLLAPSED_KEY = "canvas-terminal.rail-collapsed.v1";
const SHELL_KEY = "canvas-terminal.shell.v1";
const SCROLLBACK_SAVE_INTERVAL_MS = 20_000;

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
let tokenUsageModal: TokenUsageModal | null = null;
let clickUpPlugin: ClickUpPlugin | null = null;
let gitPanel: GitPanel | null = null;
let layoutsPanel: LayoutsPanel | null = null;
/** Histórico salvo dos terminais, por `sessionId` (ver session-store.ts). */
let scrollbacks: Record<string, string> = {};
/** Transmissão de entrada ligada: o que se digita vai a todos os participantes. */
let broadcastOn = false;
let layoutBusy = false;
let hintTimer: ReturnType<typeof setTimeout> | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let workspaces: Workspace[] = [];
let activeWorkspace: Workspace | null = null;
/** Preferência do usuário para o painel lateral (maximizado sempre recolhe). */
let railUserCollapsed = false;
/** Ordem dos grupos (áreas) exibida somente nas abas do modo maximizado. */
let tabGroupOrder: string[] = [];

const ui = {
  fullscreenBtn: document.querySelector<HTMLButtonElement>("#btn-fullscreen")!,
  zoom: document.querySelector<HTMLSpanElement>("#zoom-indicator")!,
  count: document.querySelector<HTMLSpanElement>("#terminal-count")!,
  countLabel: document.querySelector<HTMLSpanElement>("#terminal-count-label")!,
  coords: document.querySelector<HTMLSpanElement>("#coords")!,
  appMenu: document.querySelector<HTMLElement>("#app-menu")!,
  appMenuButton: document.querySelector<HTMLButtonElement>("#rail-app-menu")!,
};

const menuEls = Array.from(document.querySelectorAll<HTMLElement>("#app-menu .menu"));

const contextMenu = document.querySelector<HTMLDivElement>("#context-menu")!;

async function main(): Promise<void> {
  if (isTauri()) document.body.classList.add("tauri-env");
  initTheme();
  renderThemeMenu();
  syncThemeUi();
  onThemeChange(() => syncThemeUi());

  await initPtyListener();
  // Uma recarga do webview deixaria os PTYs antigos órfãos: limpa antes de restaurar.
  await killAllTerminals().catch(() => 0);
  const saveSession = () => {
    try {
      persist();
      flushSave();
      snapshotScrollbacks();
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

  scrollbacks = isHistoryRestoreEnabled() ? loadScrollbacks() : {};
  // O histórico muda o tempo todo: grava em intervalos, não a cada saída.
  setInterval(snapshotScrollbacks, SCROLLBACK_SAVE_INTERVAL_MS);

  canvas = new Canvas("#viewport", "#world");
  canvas.onEmptyContextMenu = showEmptyContextMenu;
  canvas.onViewChange = () => {
    updateStatus();
    persist();
  };
  // Maximizado o zoom do canvas fica travado; Ctrl+roda passa a ajustar o
  // zoom próprio do terminal em foco.
  canvas.onLockedZoom = (factor) => changeZoom(factor);

  // Rede de segurança da geometria: se o viewport mudar de tamanho sem evento
  // (ou uma troca de área deixar a janela com a medida antiga), realinha a
  // janela maximizada em vez de deixar uma faixa de canvas clicável embaixo.
  setInterval(() => {
    for (const workspace of workspaces) {
      for (const terminal of workspace.terminals) terminal.syncMaximizedSize();
    }
  }, 500);

  shells = await listShells();
  initShellSelection();

  bindAppChrome();
  bindWorkspaceRail();
  bindQuickPanel();
  bindPlugins();
  bindGlobalShortcuts();
  bindFullscreenWatcher();
  bindContextMenu();
  bindTitlebarContext();

  layoutsPanel = new LayoutsPanel({
    apply: (layout) => void applyLayout(layout),
    capture: (name, details) => {
      const layout = captureLayout(
        name,
        canvas.getAllTerminals().map((terminal) => terminal.getState()),
        details,
      );
      if (layout) showToast(`Layout “${layout.name}” salvo`);
      return layout;
    },
    terminalCount: () => canvas.getAllTerminals().length,
  });

  gitPanel = new GitPanel(
    document.getElementById("git-modal")!,
    () => suggestGitFolder(),
  );
  // Abrir outro modal fecha o Git (e vice-versa pelo botão do Git).
  document.addEventListener("plugin-panel-opened", () => gitPanel?.close());

  // Atalho flutuante de diff do Git no modo maximizado (canto superior direito).
  const gitDiffHotzone = document.getElementById("git-diff-hotzone")!;
  const openGitDiff = () => {
    closeAppMenu();
    closeThemeMenu();
    document.dispatchEvent(
      new CustomEvent("plugin-panel-opened", { detail: "git" }),
    );
    gitPanel?.open();
  };
  gitDiffHotzone.addEventListener("click", openGitDiff);
  gitDiffHotzone.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openGitDiff();
  });

  await restoreWorkspaces();
  updateStatus();
  trackMouseCoordinates();

  if (activeWorkspace && activeWorkspace.terminals.length === 0) {
    await addTerminalAtCenter();
  }
}

/** Shell padrão escolhido em Configurações → Terminal. */
let selectedShellId = "";

function initShellSelection(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(SHELL_KEY);
  } catch {
    stored = null;
  }
  selectedShellId =
    stored && shells.some((shell) => shell.id === stored)
      ? stored
      : (shells[0]?.id ?? "");
}

function chooseShell(id: string): void {
  if (!shells.some((shell) => shell.id === id)) return;
  selectedShellId = id;
  try {
    localStorage.setItem(SHELL_KEY, id);
  } catch {
    // Ignora quota/escrita bloqueada.
  }
}

function selectedShell(): string {
  return selectedShellId || shells[0]?.id || "";
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
  session: TerminalSessionOptions = {},
): Promise<TerminalWindow> {
  const terminal = await createTerminal(canvas, shellId, cwd, title, x, y, w, h, session);
  terminal.element.style.zIndex = String(++zCounter);
  terminal.onUserInput = (id, data) => broadcastInput(id, data);
  terminal.onBroadcastToggle = () => syncBroadcastBadge();
  // Terminal novo numa área em transmissão entra na transmissão.
  if (broadcastOn && workspace === activeWorkspace) terminal.setBroadcastMember(true);

  terminal.onFocus = (id) => {
    focusedTerminal = terminal;
    workspace.lastFocusedId = id;
    const index = workspace.terminals.findIndex((entry) => entry.id === id);
    if (index >= 0) workspace.focusedIndex = index;
    // Cada aba maximizada tem o seu zoom: o indicador do cabeçalho acompanha.
    updateStatus();
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
    syncBroadcastBadge();
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
  syncBroadcastBadge();
  return terminal;
}

/* ---- Temas (cabeçalho) ---- */

let themeMenu: HTMLElement | null = null;

function themeMenuElement(): HTMLElement | null {
  themeMenu ??= document.getElementById("theme-menu");
  return themeMenu;
}

/** Monta o menu de temas a partir do registro (grupos + "obter mais"). */
function renderThemeMenu(): void {
  const menu = themeMenuElement();
  if (!menu) return;
  menu.innerHTML = "";

  for (const group of THEME_GROUPS) {
    const heading = document.createElement("div");
    heading.className = "theme-menu-group";
    heading.textContent = group.label;
    menu.appendChild(heading);

    for (const id of group.themes) {
      const definition = getTheme(id);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "theme-option";
      button.dataset.themeId = id;
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-checked", "false");

      const swatch = document.createElement("span");
      swatch.className = "theme-swatch";
      swatch.style.setProperty("--swatch-bg", definition.preview.background);
      swatch.style.setProperty("--swatch-surface", definition.preview.surface);
      swatch.style.setProperty("--swatch-accent", definition.preview.accent);

      const name = document.createElement("span");
      name.className = "theme-name";
      name.textContent = definition.name;

      const check = document.createElement("span");
      check.className = "theme-check";
      check.textContent = "✓";
      check.setAttribute("aria-hidden", "true");

      button.append(swatch, name, check);
      button.addEventListener("click", () => {
        applyTheme(id);
        closeThemeMenu();
      });
      menu.appendChild(button);
    }
  }
}

function syncThemeUi(): void {
  const menu = themeMenuElement();
  if (menu) {
    for (const option of menu.querySelectorAll<HTMLButtonElement>(".theme-option[data-theme-id]")) {
      const selected = option.dataset.themeId === currentTheme();
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-checked", String(selected));
    }
  }
  // A aba Aparência, se estiver aberta, reflete o novo tema na hora.
  const modal = settingsModal();
  if (modal && !modal.classList.contains("hidden") && currentSettingsTab === "appearance") {
    renderSettings();
  }
}

function themeMenuOpen(): boolean {
  const menu = themeMenuElement();
  return !!menu && !menu.classList.contains("hidden");
}

function openThemeMenu(): void {
  const menu = themeMenuElement();
  const button = document.getElementById("header-theme");
  if (!menu || !button) return;
  syncThemeUi();
  menu.classList.remove("hidden");
  button.setAttribute("aria-expanded", "true");
  // Encosta o menu na borda direita do botão, sem sair da janela.
  const rect = button.getBoundingClientRect();
  const width = menu.offsetWidth;
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
}

function closeThemeMenu(): boolean {
  const menu = themeMenuElement();
  const button = document.getElementById("header-theme");
  if (!menu || menu.classList.contains("hidden")) return false;
  menu.classList.add("hidden");
  button?.setAttribute("aria-expanded", "false");
  return true;
}

function toggleThemeMenu(): void {
  if (themeMenuOpen()) closeThemeMenu();
  else openThemeMenu();
}

function bindAppChrome(): void {
  bindMenubar();
  bindMenuActions();
  bindDialog();
  bindThemeMenu();
  bindSettingsModal();
  bindWindowChrome();
  bindHeaderActions();
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

/* ---- Cabeçalho: atalhos, tema e controles da janela ---- */

function bindThemeMenu(): void {
  const button = document.getElementById("header-theme");
  const menu = themeMenuElement();
  if (!button || !menu) return;

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    closeAppMenu();
    toggleThemeMenu();
  });
  menu.addEventListener("click", (event) => event.stopPropagation());

  document.addEventListener("click", () => closeThemeMenu());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && themeMenuOpen()) {
      event.preventDefault();
      closeThemeMenu();
      button.focus();
    }
  });
  window.addEventListener("resize", () => closeThemeMenu());
}

function bindHeaderActions(): void {
  document.getElementById("header-zoom")?.addEventListener("click", () => resetZoom());
  document.getElementById("header-settings")?.addEventListener("click", () => {
    openSettings("general");
  });
}

/** Mesmo tipo local de `@tauri-apps/api/window` (não é exportado pelo pacote). */
type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

async function currentWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

async function toggleWindowMaximize(): Promise<void> {
  if (!isTauri()) return;
  try {
    const win = await currentWindow();
    await win.toggleMaximize();
    await syncWindowMaximized();
  } catch (err) {
    console.error("Falha ao maximizar a janela:", err);
  }
}

async function syncWindowMaximized(): Promise<void> {
  if (!isTauri()) return;
  try {
    const win = await currentWindow();
    const maximized = await win.isMaximized();
    document.body.classList.toggle("window-maximized", maximized);
    const button = document.getElementById("win-maximize");
    if (button) {
      const label = maximized ? "Restaurar" : "Maximizar";
      button.title = label;
      button.setAttribute("aria-label", label);
    }
  } catch {
    // Sem permissão/evento: mantém o estado atual.
  }
}

function bindWindowChrome(): void {
  const minimize = document.getElementById("win-minimize");
  const maximize = document.getElementById("win-maximize");
  const close = document.getElementById("win-close");
  const header = document.getElementById("app-header");

  minimize?.addEventListener("click", () => {
    if (!isTauri()) return;
    void currentWindow().then((win) => win.minimize());
  });
  maximize?.addEventListener("click", () => void toggleWindowMaximize());
  close?.addEventListener("click", () => {
    if (!isTauri()) {
      window.close();
      return;
    }
    void currentWindow().then((win) => win.close());
  });

  header?.addEventListener("dblclick", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, .header-pill")) return;
    void toggleWindowMaximize();
  });

  // Bordas invisíveis: substituem o redimensionamento da moldura nativa.
  for (const handle of document.querySelectorAll<HTMLElement>("[data-resize]")) {
    handle.addEventListener("pointerdown", (event) => {
      if (!isTauri()) return;
      event.preventDefault();
      const direction = handle.dataset.resize as ResizeDirection | undefined;
      if (!direction) return;
      void currentWindow().then((win) => win.startResizeDragging(direction));
    });
  }

  void syncWindowMaximized();
  let resizeTimer: number | null = null;
  window.addEventListener("resize", () => {
    if (resizeTimer !== null) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resizeTimer = null;
      void syncWindowMaximized();
    }, 120);
  });
}

/* ---- Configurações ---- */

type SettingsTab =
  | "general"
  | "appearance"
  | "terminal"
  | "plugins"
  | "shortcuts"
  | "about";

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "Geral" },
  { id: "appearance", label: "Aparência" },
  { id: "terminal", label: "Terminal" },
  { id: "plugins", label: "Plugins" },
  { id: "shortcuts", label: "Atalhos" },
  { id: "about", label: "Sobre" },
];

let currentSettingsTab: SettingsTab = "general";

function settingsModal(): HTMLElement | null {
  return document.getElementById("settings-modal");
}

function openSettings(tab: SettingsTab = "general"): void {
  closeAppMenu();
  closeThemeMenu();
  hideContextMenu();
  gitPanel?.close();
  // Fecha os modais de plugin para a tela de configurações não abrir por cima.
  document.dispatchEvent(
    new CustomEvent("plugin-panel-opened", { detail: "settings" }),
  );
  currentSettingsTab = tab;
  syncSettingsTabs();
  renderSettings();
  settingsModal()?.classList.remove("hidden");
}

function closeSettings(): boolean {
  const modal = settingsModal();
  if (!modal || modal.classList.contains("hidden")) return false;
  modal.classList.add("hidden");
  return true;
}

function syncSettingsTabs(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(".settings-tab")) {
    const selected = button.dataset.settingsTab === currentSettingsTab;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  }
  const heading = document.getElementById("settings-heading");
  if (heading) {
    heading.textContent =
      SETTINGS_TABS.find((tab) => tab.id === currentSettingsTab)?.label ?? "Configurações";
  }
}

function bindSettingsModal(): void {
  const modal = settingsModal();
  if (!modal) return;
  document.getElementById("settings-close")?.addEventListener("click", () => closeSettings());
  modal.addEventListener("mousedown", (event) => {
    if (event.target === modal) closeSettings();
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeSettings();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>(".settings-tab")) {
    button.addEventListener("click", () => {
      const tab = button.dataset.settingsTab as SettingsTab | undefined;
      if (!tab) return;
      currentSettingsTab = tab;
      syncSettingsTabs();
      renderSettings();
    });
  }
  // Abrir um modal de plugin fecha as configurações (e vice-versa).
  document.addEventListener("plugin-panel-opened", ((event: Event) => {
    if ((event as CustomEvent<string>).detail !== "settings") closeSettings();
  }) as EventListener);
}

function renderSettings(): void {
  const body = document.getElementById("settings-body");
  if (!body) return;

  if (currentSettingsTab === "general") {
    body.innerHTML = `
      <h3>Geral</h3>
      <p class="settings-intro">
        Preferências gerais do aplicativo. A inicialização automática usa o
        mecanismo do seu sistema operacional.
      </p>
      <div class="settings-panel">
        <div class="settings-row">
          <div class="settings-row-text">
            <span class="settings-row-title">Abrir o Canvas Terminal ao iniciar a sessão</span>
            <span class="settings-row-desc">
              Abre o aplicativo automaticamente quando você entrar no computador.
              No Linux, cria uma entrada em <code>~/.config/autostart/</code>; no
              Windows, registra o app na inicialização do usuário.
              ${
                autostartAvailable()
                  ? ""
                  : " No modo navegador, esta opção é apenas simulada."
              }
            </span>
          </div>
          <label class="settings-toggle" id="settings-autostart-wrap"
            title="Abrir automaticamente ao iniciar a sessão">
            <input type="checkbox" id="settings-autostart" aria-label="Abrir o Canvas Terminal ao iniciar a sessão" />
            <span class="settings-toggle-track"></span>
          </label>
        </div>
        <p class="settings-status" id="settings-autostart-status">Verificando…</p>
      </div>
    `;
    bindAutostartRow();
    return;
  }

  if (currentSettingsTab === "appearance") {
    const cards = THEME_GROUPS.map((group) => {
      const items = group.themes
        .map((id) => {
          const theme = getTheme(id);
          return `
            <button class="settings-theme-card" type="button" data-theme-id="${id}"
              style="--theme-bg:${theme.preview.background};--theme-surface:${theme.preview.surface};--theme-accent:${theme.preview.accent}">
              <span class="settings-theme-preview" aria-hidden="true">
                <span></span><span></span>
              </span>
              <span class="settings-theme-name">${theme.name}</span>
              <span class="settings-theme-check">✓</span>
            </button>
          `;
        })
        .join("");
      return `
        <div class="settings-nav-group" style="padding-left:0">${group.label}</div>
        <div class="settings-theme-grid">${items}</div>
      `;
    }).join("");

    body.innerHTML = `
      <h3>Aparência</h3>
      <p class="settings-intro">
        O tema muda a interface e a paleta do terminal ao mesmo tempo. Você também
        pode trocar pelo ícone de paleta no cabeçalho.
      </p>
      ${cards}
    `;

    for (const card of body.querySelectorAll<HTMLButtonElement>(".settings-theme-card")) {
      const id = card.dataset.themeId as ThemeName | undefined;
      if (id) {
        card.classList.toggle("active", id === currentTheme());
        card.addEventListener("click", () => applyTheme(id));
      }
    }
    return;
  }

  if (currentSettingsTab === "terminal") {
    const options = shells
      .map(
        (shell) =>
          `<option value="${escapeHtml(shell.id)}">${escapeHtml(shell.name)}</option>`,
      )
      .join("");

    body.innerHTML = `
      <h3>Terminal</h3>
      <p class="settings-intro">
        Preferências dos terminais criados a partir de agora. Cada área de
        trabalho pode ter sua própria pasta inicial.
      </p>
      <div class="settings-panel">
        <div class="settings-row">
          <div class="settings-row-text">
            <span class="settings-row-title">Shell padrão</span>
            <span class="settings-row-desc">
              Shell usado em novos terminais e no botão de novo terminal.
            </span>
          </div>
          <select id="settings-shell" class="settings-select"
            title="Shell padrão para novos terminais" ${shells.length === 0 ? "disabled" : ""}>
            ${options}
          </select>
        </div>
        <p class="settings-status" id="settings-shell-status"></p>
      </div>
      <div class="settings-panel">
        <div class="settings-row">
          <div class="settings-row-text">
            <span class="settings-row-title">Restaurar histórico dos terminais</span>
            <span class="settings-row-desc">
              Ao reabrir o app, cada terminal volta na pasta em que estava e
              mostra o histórico da sessão anterior (os processos em execução
              não são retomados). O histórico fica salvo neste computador e pode
              conter dados sensíveis exibidos no terminal.
            </span>
          </div>
          <label class="settings-toggle" title="Restaurar histórico dos terminais">
            <input type="checkbox" id="settings-history" aria-label="Restaurar histórico dos terminais"
              ${isHistoryRestoreEnabled() ? "checked" : ""} />
            <span class="settings-toggle-track"></span>
          </label>
        </div>
      </div>
    `;
    bindShellRow();
    document.getElementById("settings-history")?.addEventListener("change", (event) => {
      const enabled = (event.target as HTMLInputElement).checked;
      setHistoryRestoreEnabled(enabled);
      if (enabled) snapshotScrollbacks();
      else scrollbacks = {};
      showToast(enabled ? "Histórico dos terminais será restaurado" : "Histórico dos terminais apagado");
    });
    return;
  }

  if (currentSettingsTab === "plugins") {
    body.innerHTML = `
      <h3>Plugins</h3>
      <p class="settings-intro">
        Ative os plugins que quiser usar. Os botões deles aparecem no rodapé do
        painel lateral, acima do Git.
      </p>
      <div id="settings-plugin-list" class="settings-plugin-list"></div>
    `;
    const list = document.getElementById("settings-plugin-list");
    if (list) renderPluginSettings(list);
    return;
  }

  if (currentSettingsTab === "about") {
    body.innerHTML = `
      <h3>Sobre</h3>
      <p class="settings-intro">
        Canvas Terminal é um canvas infinito com terminais reais, construído com
        Tauri 2, TypeScript e xterm.js.
      </p>
      <div class="settings-panel">
        <div class="settings-row">
          <div class="settings-row-text">
            <span class="settings-row-title">Canvas Terminal</span>
            <span class="settings-row-desc">Versão 0.1.0 · licença MIT</span>
          </div>
        </div>
      </div>
      <div class="settings-panel">
        <div class="settings-row">
          <div class="settings-row-text">
            <span class="settings-row-title">Persistência</span>
            <span class="settings-row-desc">
              Terminais, áreas de trabalho, zoom, posição, tema e plugins são
              salvos automaticamente neste computador.
            </span>
          </div>
        </div>
      </div>
    `;
    return;
  }

  if (currentSettingsTab === "shortcuts") {
    body.innerHTML = `
      <h3>Atalhos</h3>
      <p class="settings-intro">
        Clique em uma combinação e pressione as teclas para redefinir.
      </p>
      <table class="settings-shortcuts">
        ${allActions()
          .map(
            (action) => `
              <tr data-action="${action}">
                <td>${getLabel(action)}</td>
                <td>
                  <button
                    class="settings-shortcut-value"
                    type="button"
                    data-action="${action}"
                  >${format(getBinding(action))}</button>
                </td>
              </tr>
            `,
          )
          .join("")}
      </table>
      <div class="settings-shortcuts-footer">
        <button id="shortcuts-reset" class="settings-button" type="button">
          Restaurar padrão
        </button>
      </div>
    `;

    for (const button of body.querySelectorAll<HTMLButtonElement>(".settings-shortcut-value")) {
      button.addEventListener("click", () => startShortcutCapture(button));
    }

    body.querySelector("#shortcuts-reset")?.addEventListener("click", () => {
      resetBindings();
      renderSettings();
      showToast("Atalhos restaurados");
    });
    return;
  }
}

function startShortcutCapture(button: HTMLButtonElement): void {
  const action = button.dataset.action as ShortcutAction;
  const original = button.textContent ?? "";
  button.textContent = "Pressione as teclas…";
  button.classList.add("capturing");

  const handler = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const captured = capture(event);
    if (!captured) return;

    // Tab sem modificadores é usado na navegação; não permite.
    if (captured.key === "tab" && !captured.ctrl && !captured.alt && !captured.shift) {
      return;
    }

    window.removeEventListener("keydown", handler, true);
    button.classList.remove("capturing");

    // Se a combinação for idêntica à padrão, limpa o custom.
    setBinding(action, captured);
    button.textContent = format(captured);
    showToast("Atalho atualizado");
  };

  window.addEventListener("keydown", handler, true);

  // Cancela se clicar fora ou pressionar Esc.
  const cancel = (event: MouseEvent | KeyboardEvent) => {
    if (event instanceof KeyboardEvent && event.key !== "Escape") return;
    window.removeEventListener("keydown", handler, true);
    button.classList.remove("capturing");
    button.textContent = original;
    document.removeEventListener("mousedown", cancel);
  };
  document.addEventListener("mousedown", cancel);
}

function selectedShellLabel(): string {
  const shell = shells.find((entry) => entry.id === selectedShell());
  if (!shell) return "Nenhum shell detectado.";
  return shell.path ? `${shell.name} — ${shell.path}` : shell.name;
}

function bindShellRow(): void {
  const select = document.getElementById("settings-shell") as HTMLSelectElement | null;
  const status = document.getElementById("settings-shell-status");
  if (!select || !status) return;

  select.value = selectedShell();
  status.textContent = `Padrão atual: ${selectedShellLabel()}`;
  select.addEventListener("change", () => {
    chooseShell(select.value);
    status.textContent = `Padrão atual: ${selectedShellLabel()}`;
    showToast("Shell padrão atualizado");
  });
}

function bindAutostartRow(): void {
  const input = document.getElementById("settings-autostart") as HTMLInputElement | null;
  const wrap = document.getElementById("settings-autostart-wrap");
  const status = document.getElementById("settings-autostart-status");
  if (!input || !wrap || !status) return;

  wrap.classList.add("busy");
  void (async () => {
    try {
      input.checked = await isAutostartEnabled();
      status.textContent = input.checked
        ? "Ativado para a sua sessão de usuário."
        : "Desativado.";
      status.classList.remove("error");
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : String(error);
      status.classList.add("error");
    } finally {
      wrap.classList.remove("busy");
    }
  })();

  input.addEventListener("change", () => {
    const enabled = input.checked;
    wrap.classList.add("busy");
    status.classList.remove("error");
    status.textContent = enabled ? "Ativando…" : "Desativando…";
    void setAutostart(enabled)
      .then(() => {
        status.textContent = enabled
          ? "Ativado para a sua sessão de usuário."
          : "Desativado.";
        showToast(
          enabled
            ? "O app abrirá ao iniciar a sua sessão"
            : "Inicialização automática desativada",
        );
      })
      .catch((error) => {
        input.checked = !enabled;
        status.textContent =
          error instanceof Error ? error.message : String(error);
        status.classList.add("error");
      })
      .finally(() => wrap.classList.remove("busy"));
  });
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

  on("menu-settings", () => openSettings("general"));
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
  on("menu-layouts", () => openLayouts());
  on("menu-search", () => openTerminalSearch());
  on("menu-broadcast", () => setBroadcast(!broadcastOn));
  on("menu-startup-command", () => {
    if (focusedTerminal) editStartupCommand(focusedTerminal);
    else flashHint("Selecione um terminal para configurar o comando.");
  });
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
    snapshotScrollbacks();
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

/* ---- Busca, broadcast, layouts e histórico ---- */

function openTerminalSearch(): void {
  if (!focusedTerminal) {
    flashHint("Clique em um terminal antes de buscar.");
    return;
  }
  focusedTerminal.openSearch();
}

function openLayouts(): void {
  closeAllMenus();
  closeAppMenu();
  layoutsPanel?.open();
}

/** Grava o histórico dos terminais alterados desde a última gravação. */
function snapshotScrollbacks(): void {
  if (!isHistoryRestoreEnabled()) return;
  const next: Record<string, string> = {};
  let changed = false;

  for (const workspace of workspaces) {
    if (!workspace.initialized) {
      // Área ainda não aberta nesta sessão: preserva o histórico já salvo.
      for (const item of workspace.pending) {
        const saved =
          item.sessionId && !item.startupCommand
            ? scrollbacks[item.sessionId]
            : undefined;
        if (item.sessionId && saved) next[item.sessionId] = saved;
      }
      continue;
    }
    for (const terminal of workspace.terminals) {
      // Terminais com comando de inicialização não guardam histórico.
      if (terminal.startupCommand) continue;
      let text = scrollbacks[terminal.sessionId];
      if (terminal.scrollbackDirty) {
        terminal.scrollbackDirty = false;
        const fresh = terminal.serializeScrollback(SCROLLBACK_MAX_CHARS);
        // `null` = tela alternativa (TUI) ou grande demais: mantém o anterior.
        if (fresh !== null && fresh !== text) {
          text = fresh;
          changed = true;
        }
      }
      if (text) next[terminal.sessionId] = text;
    }
  }

  if (Object.keys(next).length !== Object.keys(scrollbacks).length) changed = true;
  scrollbacks = next;
  if (changed) saveScrollbacks(next);
}

/** Reenvia a digitação de um terminal aos demais participantes do broadcast. */
function broadcastInput(sourceId: number, data: string): void {
  if (!broadcastOn) return;
  const targets = canvas.getAllTerminals().filter((terminal) => terminal.broadcastMember);
  if (!targets.some((terminal) => terminal.id === sourceId)) return;
  for (const terminal of targets) {
    if (terminal.id !== sourceId) terminal.sendInput(data);
  }
}

function syncBroadcastBadge(): void {
  const badge = document.getElementById("broadcast-badge");
  if (!badge) return;
  const members = canvas
    ? canvas.getAllTerminals().filter((terminal) => terminal.broadcastMember).length
    : 0;
  badge.classList.toggle("hidden", !broadcastOn);
  badge.textContent = broadcastOn
    ? `● Transmitindo para ${members} ${members === 1 ? "terminal" : "terminais"}`
    : "";
}

function setBroadcast(on: boolean): void {
  if (on === broadcastOn) return;
  if (on && canvas.getAllTerminals().length < 2) {
    flashHint("Abra ao menos dois terminais para transmitir a entrada.");
    return;
  }
  broadcastOn = on;
  document.body.classList.toggle("broadcast-on", on);
  for (const terminal of canvas.getAllTerminals()) terminal.setBroadcastMember(on);
  syncBroadcastBadge();
  flashHint(
    on
      ? "Broadcast ligado: o que você digitar vai a todos os terminais marcados."
      : "Broadcast desligado.",
  );
}

/**
 * Aplica um layout à área ativa: reposiciona os terminais abertos (na ordem em
 * que existem) e abre os que faltam. Nenhum terminal é fechado.
 */
async function applyLayout(layout: SavedLayout): Promise<void> {
  const workspace = activeWorkspace;
  if (!workspace || layoutBusy) return;
  layoutBusy = true;
  try {
    // Janelas maximizadas ou minimizadas escondiam o resultado.
    for (const terminal of canvas.getAllTerminals()) {
      if (terminal.maximized) terminal.toggleMaximize();
    }
    for (const terminal of canvas.getAllTerminals()) {
      if (terminal.element.classList.contains("minimized")) terminal.toggleMinimize();
    }

    const area = canvas.worldRectVisible();
    const existing = canvas.getAllTerminals();
    let opened = 0;
    for (const [index, slot] of layout.slots.entries()) {
      const rect = slotRect(slot, area);
      const terminal = existing[index];
      if (terminal) {
        terminal.x = rect.x;
        terminal.y = rect.y;
        terminal.w = rect.w;
        terminal.h = rect.h;
        terminal.savedGeom = undefined;
        terminal.render(canvas.zoom);
        terminal.refit();
        continue;
      }
      const open = (shellId: string) =>
        addTerminalToWorkspace(
          workspace,
          shellId,
          rect.x,
          rect.y,
          rect.w,
          rect.h,
          slot.cwd || undefined,
          slot.title || undefined,
          slot.startupCommand || undefined,
        );
      try {
        await open(slot.shell || selectedShell());
      } catch {
        // O shell salvo pode não existir nesta máquina: usa o padrão.
        await open(selectedShell());
      }
      opened++;
    }
    persist();
    updateStatus();
    flashHint(
      opened > 0
        ? `Layout “${layout.name}” aplicado (${opened} novo${opened === 1 ? "" : "s"}).`
        : `Layout “${layout.name}” aplicado.`,
    );
  } catch (error) {
    flashHint(`Não foi possível aplicar o layout: ${error instanceof Error ? error.message : error}`);
  } finally {
    layoutBusy = false;
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
  const railQuick = document.getElementById("rail-quick")!;
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

  railQuick.addEventListener("click", togglePanel);
  railQuick.addEventListener("keydown", (event) => {
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
  tokenUsageModal = new TokenUsageModal();
  clickUpPlugin = new ClickUpPlugin();
  applyPluginStates();

  // Os botões do painel lateral continuam visíveis com o plugin desligado;
  // o primeiro clique ativa o plugin e abre o modal correspondente.
  document.addEventListener("plugin-activate-request", ((event: Event) => {
    const id = (event as CustomEvent<string>).detail;
    const plugin = PLUGINS.find((entry) => entry.id === id);
    if (!plugin) return;
    if (!isPluginEnabled(pluginSettings, plugin.id)) {
      activatePlugin(plugin, true);
    }
    if (plugin.id === "token-usage") tokenUsageModal?.open();
    else if (plugin.id === "clickup") clickUpPlugin?.open();
  }) as EventListener);
}

/** Monta os interruptores da aba Plugins das configurações. */
function renderPluginSettings(list: HTMLElement): void {
  list.innerHTML = "";

  for (const plugin of PLUGINS) {
    const row = document.createElement("div");
    row.className = "plugin-item settings-plugin-item";
    row.dataset.id = plugin.id;
    row.setAttribute("role", "switch");
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
    row.addEventListener("click", () =>
      activatePlugin(plugin, !isPluginEnabled(pluginSettings, plugin.id)),
    );
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activatePlugin(plugin, !isPluginEnabled(pluginSettings, plugin.id));
    });

    list.appendChild(row);
  }

  syncPluginSettings();
}

function syncPluginSettings(): void {
  for (const row of document.querySelectorAll<HTMLElement>(
    "#settings-plugin-list .plugin-item",
  )) {
    const id = row.dataset.id ?? "";
    const enabled = isPluginEnabled(pluginSettings, id);
    row.setAttribute("aria-checked", String(enabled));
  }
}

/** Liga/desliga um plugin, persiste e aplica o efeito. */
function activatePlugin(plugin: PluginDefinition, enabled: boolean): void {
  pluginSettings.enabled[plugin.id] = enabled;
  savePluginSettings(pluginSettings);
  syncPluginSettings();
  applyPluginStates();
  flashHint(`Plugin "${plugin.name}" ${enabled ? "ativado" : "desativado"}.`);
}

function applyPluginStates(): void {
  tokenUsageModal?.setEnabled(isPluginEnabled(pluginSettings, "token-usage"));
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
        {
          sessionId: item.sessionId,
          zoom: item.zoom,
          // Com comando de inicialização o terminal se reconstrói sozinho
          // (ex.: `claude --continue`): o histórico antigo só poluiria a tela.
          restoreScrollback:
            item.sessionId && !item.startupCommand
              ? scrollbacks[item.sessionId]
              : undefined,
        },
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
          zoom: item.geom.zoom ?? item.zoom ?? 1,
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

  // A transmissão vale só para a área onde foi ligada.
  if (activeWorkspace !== workspace) setBroadcast(false);
  activeWorkspace = workspace;
  // Cada área tem o seu zoom. Maximizado, o canvas fica em 100% e quem tem
  // zoom próprio é o terminal.
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
    closeThemeMenu();
    document.dispatchEvent(
      new CustomEvent("plugin-panel-opened", { detail: "git" }),
    );
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
  syncHeaderTitle();
}

/** O centro do cabeçalho mostra a área ativa (ou o nome do app). */
function syncHeaderTitle(): void {
  const title = document.getElementById("header-title");
  const icon = document.querySelector<HTMLElement>(".header-terminal-icon");
  if (!title) return;
  title.textContent = activeWorkspace?.name || "Canvas Terminal";
  title.title = activeWorkspace?.folder
    ? `${activeWorkspace.name}\n${activeWorkspace.folder}`
    : title.textContent;
  if (icon) icon.style.color = activeWorkspace?.color || "";
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
  closeThemeMenu();
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

      if (matches(e, "save")) {
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
        if (closeSettings()) {
          own();
          return;
        }
        if (layoutsPanel?.close()) {
          own();
          return;
        }
        if (closeThemeMenu()) {
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
      if (matches(e, "toggle-fullscreen")) {
        own();
        void toggleFullscreen();
        return;
      }
      if (matches(e, "zoom-in")) {
        own();
        changeZoom(1.1);
        return;
      }
      if (matches(e, "zoom-out")) {
        own();
        changeZoom(1 / 1.1);
        return;
      }
      if (mod && e.key === "Tab") {
        own();
        await cycleWorkspace(e.shiftKey ? -1 : 1);
        return;
      }
      if (matches(e, "new-workspace")) {
        own();
        await createWorkspace();
        return;
      }
      if (matches(e, "new-terminal")) {
        own();
        await addTerminalAtCenter();
        return;
      }
      if (matches(e, "quit")) {
        own();
        await quitApp();
        return;
      }
      if (matches(e, "close-terminal")) {
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
      if (matches(e, "cycle-focus-forward")) {
        own();
        cycleFocus(1);
        return;
      }
      if (matches(e, "cycle-focus-backward")) {
        own();
        cycleFocus(-1);
        return;
      }
      if (matches(e, "zoom-reset")) {
        own();
        resetZoom();
        return;
      }
      if (matches(e, "rename-terminal") && focusedTerminal) {
        own();
        focusedTerminal.rename();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        own();
        organizeTerminals();
        return;
      }
      if (matches(e, "toggle-theme-menu")) {
        own();
        toggleThemeMenu();
        return;
      }
      if (matches(e, "open-settings")) {
        own();
        if (!closeSettings()) openSettings("general");
        return;
      }
      if (matches(e, "search-terminal")) {
        own();
        openTerminalSearch();
        return;
      }
      if (matches(e, "toggle-broadcast")) {
        own();
        setBroadcast(!broadcastOn);
        return;
      }
      if (matches(e, "open-layouts")) {
        own();
        if (!layoutsPanel?.close()) openLayouts();
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
  const maximized = maximizedTerminal();
  if (maximized) {
    maximized.setZoom(1);
    updateStatus();
    return;
  }
  canvas.setZoomAtCenter(1);
}

/** Terminal ocupando a tela (modo maximizado), se houver. */
function maximizedTerminal(): TerminalWindow | null {
  return canvas.getAllTerminals().find((terminal) => terminal.maximized) ?? null;
}

/**
 * Cada terminal maximizado tem o seu zoom; fora do modo maximizado o zoom é o
 * da área (canvas). Ctrl+= / Ctrl+- / Ctrl+0 e Ctrl+roda passam por aqui.
 */
function changeZoom(factor: number): void {
  const maximized = maximizedTerminal();
  if (maximized) {
    maximized.setZoom(maximized.zoom * factor);
    updateStatus();
    return;
  }
  canvas.zoomBy(factor);
}

function updateStatus(): void {
  syncMaximizedView();
  const maximized = maximizedTerminal();
  // A janela maximizada precisa caber no viewport agora: troca de área, abas,
  // recolher o painel e zoom podem ter mudado o tamanho útil sem outro render.
  if (maximized) maximized.render(canvas.zoom);
  const zoom = maximized ? maximized.zoom : canvas.zoom;
  ui.zoom.textContent = `${Math.round(zoom * 100)}%`;
  const count = canvas.getAllTerminals().length;
  ui.count.textContent = String(count);
  ui.countLabel.textContent = count === 1 ? "terminal" : "terminais";
}

/**
 * O modo maximizado ocupa todo o viewport com o canvas travado em 100%; o
 * zoom aparece no indicador, mas é o zoom próprio do terminal. Ao restaurar,
 * cada área volta ao zoom que tinha no modo normal.
 */
function syncMaximizedView(): void {
  const all = canvas.getAllTerminals();
  const maximized = all.some((terminal) => terminal.maximized);
  const wasMaximized = document.body.classList.contains("terminal-maximized");
  const changed = maximized !== wasMaximized;

  // Estado de terminais minimizados: pelo menos um minimizado e nenhum
  // maximizado (os dois modos não coexistem).
  const minimized = !maximized && all.some((terminal) => terminal.element.classList.contains("minimized"));
  document.body.classList.toggle("terminals-minimized", minimized);

  if (changed) {
    document.body.classList.toggle("terminal-maximized", maximized);
    closeAppMenu();

    if (maximized) {
      // Guarda o zoom normal antes de maximizar: a janela ocupa o viewport e o
      // zoom da área fica reservado para quando ela for restaurada.
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
  // Síncrono: a janela maximizada não pode ficar um frame no tamanho antigo
  // (o que deixava uma faixa de canvas clicável por baixo dela).
  for (const terminal of canvas.getAllTerminals()) {
    if (terminal.maximized) terminal.render(canvas.zoom);
  }
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
  // Maximizado o canvas fica em 100% (quem tem zoom é o terminal), mas o zoom
  // normal da área deve ser preservado para quando ela for restaurada.
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
  snapshotScrollbacks();
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
