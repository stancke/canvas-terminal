/**
 * Plugin ClickUp: lista as tarefas de uma lista do ClickUp e abre os detalhes
 * do ticket em uma modal.
 *
 * O token pessoal da API fica no `localStorage` do app
 * (`canvas-terminal.clickup.v1`) e é enviado apenas para `api.clickup.com`,
 * através dos comandos Tauri em `src-tauri/src/clickup.rs`.
 */

import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

const STORAGE_KEY = "canvas-terminal.clickup.v1";
/** Tarefas em cache por 30 s; o botão ⟳ força a atualização. */
const TASKS_TTL_MS = 30_000;

export interface ClickUpSettings {
  token: string;
  teamId: string;
  teamName: string;
  spaceId: string;
  spaceName: string;
  /** Vazio quando a lista não está dentro de uma pasta. */
  folderId: string;
  folderName: string;
  listId: string;
  listName: string;
  /** Filtro “atribuídas a mim” (ligado por padrão). */
  filterMine: boolean;
  /** Nomes de status marcados; `null` = ainda não configurado (aplica o padrão). */
  filterStatuses: string[] | null;
}

/** Status marcados por padrão quando a lista usa os nomes do fluxo da Selecty. */
const DEFAULT_FILTER_STATUS_NAMES = ["aberto", "em andamento", "rejeitado"];

interface Team {
  id: string;
  name: string;
}

interface ClickUpUser {
  id: string;
  username: string;
  email: string | null;
}

interface Space {
  id: string;
  name: string;
}

interface Folder {
  id: string;
  name: string;
  lists: ListRef[];
}

interface ListRef {
  id: string;
  name: string;
}

interface Status {
  name: string;
  color: string | null;
  type: string | null;
}

export interface TaskSummary {
  id: string;
  customId: string | null;
  name: string;
  status: Status;
  url: string | null;
  assignees: string[];
  dueDate: string | null;
  updated: string | null;
}

export interface Attachment {
  id: string;
  title: string;
  url: string | null;
  thumbnail: string | null;
  extension: string | null;
  mimetype: string | null;
  isImage: boolean;
}

export interface TaskDetail {
  id: string;
  customId: string | null;
  name: string;
  status: Status;
  description: string;
  url: string | null;
  listName: string | null;
  assignees: string[];
  tags: string[];
  dueDate: string | null;
  created: string | null;
  attachments: Attachment[];
}

export interface TaskComment {
  id: string;
  text: string;
  author: string;
  date: string | null;
  resolved: boolean;
}

type View = "setup" | "select" | "tasks";

function emptySettings(): ClickUpSettings {
  return {
    token: "",
    teamId: "",
    teamName: "",
    spaceId: "",
    spaceName: "",
    folderId: "",
    folderName: "",
    listId: "",
    listName: "",
    filterMine: true,
    filterStatuses: null,
  };
}

function loadSettings(): ClickUpSettings {
  const settings = emptySettings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return settings;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return settings;
    const record = parsed as Record<string, unknown>;
    const stringKeys = [
      "token",
      "teamId",
      "teamName",
      "spaceId",
      "spaceName",
      "folderId",
      "folderName",
      "listId",
      "listName",
    ] as const;
    for (const key of stringKeys) {
      const value = record[key];
      if (typeof value === "string") settings[key] = value;
    }
    if (typeof record.filterMine === "boolean") {
      settings.filterMine = record.filterMine;
    }
    if (Array.isArray(record.filterStatuses)) {
      settings.filterStatuses = record.filterStatuses.filter(
        (name): name is string => typeof name === "string",
      );
    }
  } catch {
    // localStorage indisponível: começa sem token.
  }
  return settings;
}

function saveSettings(settings: ClickUpSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignora quota/escrita bloqueada.
  }
}

/* ---- Formatação ---- */

function normalizeStatusName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function withAlpha(hex: string, alpha: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return `rgba(139, 148, 158, ${alpha})`;
  const value = parseInt(match[1], 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function formatDate(value: string | null): string {
  if (!value) return "";
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  return new Date(timestamp).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
  });
}

function formatDateTime(value: string | null): string {
  if (!value) return "";
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  return new Date(timestamp).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** `DEV-142` quando existir, senão o id completo da tarefa. */
function taskLabel(task: TaskSummary | TaskDetail): string {
  return task.customId ?? task.id;
}

/** Copia texto para a área de transferência (WebView sem permissão usa o fallback). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Segue para o fallback abaixo. */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

/** Imagens embutidas na descrição em markdown: `![alt](url)`. */
export function extractMarkdownImages(markdown: string): string[] {
  const urls: string[] = [];
  const pattern = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

async function openExternal(url: string | null): Promise<void> {
  if (!url) return;
  try {
    if (isTauri()) await openUrl(url);
    else window.open(url, "_blank", "noopener");
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

/* ---- API ---- */

const api = {
  teams: (token: string) => invoke<Team[]>("clickup_teams", { token }),
  user: (token: string) => invoke<ClickUpUser>("clickup_user", { token }),
  spaces: (token: string, teamId: string) =>
    invoke<Space[]>("clickup_spaces", { token, teamId }),
  folders: (token: string, spaceId: string) =>
    invoke<Folder[]>("clickup_folders", { token, spaceId }),
  lists: (token: string, spaceId: string, folderId: string) =>
    invoke<ListRef[]>("clickup_lists", { token, spaceId, folderId: folderId || null }),
  listStatuses: (token: string, listId: string) =>
    invoke<Status[]>("clickup_list_statuses", { token, listId }),
  tasks: (
    token: string,
    listId: string,
    assignees: string[],
    statuses: string[],
  ) => invoke<TaskSummary[]>("clickup_tasks", { token, listId, assignees, statuses }),
  task: (token: string, taskId: string) =>
    invoke<TaskDetail>("clickup_task", { token, taskId }),
  comments: (token: string, taskId: string) =>
    invoke<TaskComment[]>("clickup_comments", { token, taskId }),
};

/* ---- Painel ---- */

export class ClickUpPlugin {
  private readonly panel: HTMLElement;
  private readonly handle: HTMLElement;
  private readonly body: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly configButton: HTMLButtonElement | null;
  private readonly refreshButton: HTMLButtonElement | null;
  private readonly modal: HTMLElement;
  private readonly modalTitle: HTMLElement;
  private readonly modalBody: HTMLElement;

  private modalTaskId = "";

  private settings: ClickUpSettings = emptySettings();
  private enabled = false;
  private view: View = "tasks";

  private tasks: TaskSummary[] = [];
  private tasksAt = 0;
  private tasksLoading = false;
  private tasksReloadQueued = false;
  private tasksError: string | null = null;

  private teams: Team[] = [];
  private spaces: Space[] = [];
  private folders: Folder[] = [];
  private lists: ListRef[] = [];
  private listStatuses: Status[] = [];
  private statusesListId = "";
  private currentUserId = "";
  private spacesTeamId = "";
  private listsKey = "";
  private formBusy = false;
  private formError: string | null = null;

  constructor() {
    this.panel = document.getElementById("clickup-widget")!;
    this.handle = document.getElementById("clickup-hotzone")!;
    this.body = document.getElementById("clickup-body")!;
    this.subtitle = document.getElementById("clickup-subtitle")!;
    this.configButton = document.getElementById("clickup-config") as HTMLButtonElement | null;
    this.refreshButton = document.getElementById("clickup-refresh") as HTMLButtonElement | null;
    this.modal = document.getElementById("clickup-modal")!;
    this.modalTitle = document.getElementById("clickup-modal-title")!;
    this.modalBody = document.getElementById("clickup-modal-body")!;

    this.settings = loadSettings();

    this.handle.addEventListener("click", () => this.toggle());
    this.handle.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.toggle();
    });
    this.configButton?.addEventListener("click", (event) => {
      event.stopPropagation();
      this.view = "select";
      this.show();
      void this.loadSelectionData();
    });
    this.refreshButton?.addEventListener("click", (event) => {
      event.stopPropagation();
      if (this.view === "tasks") void this.loadTasks(true);
      else void this.loadSelectionData();
    });
    document.getElementById("clickup-modal-close")?.addEventListener("click", () => this.closeModal());
    this.modal.addEventListener("mousedown", (event) => {
      if (event.target === this.modal) this.closeModal();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.modal.classList.contains("hidden")) {
        event.preventDefault();
        event.stopPropagation();
        this.closeModal();
      }
    });
    // Só um painel lateral de plugin fica aberto por vez.
    document.addEventListener("plugin-panel-opened", ((event: Event) => {
      if ((event as CustomEvent<string>).detail !== "clickup") this.hide();
    }) as EventListener);
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    document.body.classList.toggle("clickup-enabled", enabled);

    if (!enabled) {
      this.hide();
      this.closeModal();
      return;
    }

    this.render();
    // Primeira vez: abre direto para colar o token.
    if (!this.settings.token) this.show();
  }

  /* ---- Abrir/fechar ---- */

  private show(): void {
    if (!this.enabled) return;
    document.dispatchEvent(new CustomEvent("plugin-panel-opened", { detail: "clickup" }));
    this.panel.classList.add("visible");
    if (this.view === "tasks" && Date.now() - this.tasksAt > TASKS_TTL_MS) {
      void this.loadTasks();
    }
  }

  private hide(): void {
    this.panel.classList.remove("visible");
  }

  private toggle(): void {
    if (!this.enabled) return;
    if (this.panel.classList.contains("visible")) this.hide();
    else this.show();
  }

  /* ---- Roteamento de telas ---- */

  private render(): void {
    this.body.innerHTML = "";
    this.subtitle.textContent = this.settings.listName;
    this.configButton?.classList.toggle("hidden", !this.settings.token);

    if (!this.settings.token) {
      this.view = "setup";
      this.renderSetup();
      return;
    }
    if (this.view === "setup") this.view = "tasks";
    if (this.view === "select") {
      this.renderSelection();
      return;
    }
    this.view = "tasks";
    this.renderTasks();
  }

  /* ---- Token ---- */

  private renderSetup(): void {
    this.subtitle.textContent = "configurar";

    const hint = document.createElement("p");
    hint.className = "clickup-hint";
    hint.textContent =
      "Cole o token pessoal da API do ClickUp (ClickUp → Configurações → Apps → API Token).";

    const input = document.createElement("input");
    input.type = "password";
    input.className = "clickup-input";
    input.placeholder = "pk_12345678_ABCDEF...";
    input.autocomplete = "off";
    input.spellcheck = false;
    if (this.settings.token) input.value = this.settings.token;

    const connect = document.createElement("button");
    connect.type = "button";
    connect.className = "clickup-primary";
    connect.textContent = "Conectar";

    const error = document.createElement("p");
    error.className = "usage-error clickup-form-error";
    if (this.formError) error.textContent = this.formError;

    const submit = async () => {
      const token = input.value.trim();
      if (!token) {
        this.formError = "Informe o token do ClickUp.";
        error.textContent = this.formError;
        input.focus();
        return;
      }
      if (this.formBusy) return;

      this.formBusy = true;
      connect.disabled = true;
      connect.textContent = "Conectando…";
      this.formError = null;
      error.textContent = "";

      try {
        const teams = await api.teams(token);
        if (teams.length === 0) {
          throw new Error("Nenhum workspace encontrado para este token.");
        }
        this.teams = teams;
        this.spaces = [];
        this.folders = [];
        this.lists = [];
        this.spacesTeamId = "";
        this.listsKey = "";
        this.settings = {
          ...emptySettings(),
          token,
          teamId: teams[0].id,
          teamName: teams[0].name,
        };
        this.currentUserId = "";
        this.listStatuses = [];
        this.statusesListId = "";
        saveSettings(this.settings);
        this.formBusy = false;
        this.view = "select";
        this.render();
        void this.loadSelectionData();
      } catch (failure) {
        this.formError = errorMessage(failure);
        error.textContent = this.formError;
        this.formBusy = false;
        connect.disabled = false;
        connect.textContent = "Conectar";
      }
    };

    connect.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void submit();
    });

    const wrap = document.createElement("div");
    wrap.className = "clickup-form";
    wrap.append(hint, input, connect, error);
    this.body.appendChild(wrap);
    input.focus();
  }

  /* ---- Workspace → espaço → pasta → lista ---- */

  private async loadSelectionData(): Promise<void> {
    const token = this.settings.token;
    if (!token || this.formBusy) return;

    this.formBusy = true;
    this.formError = null;
    this.renderSelection();

    try {
      if (this.teams.length === 0) {
        this.teams = await api.teams(token);
        if (!this.settings.teamId) {
          this.settings.teamId = this.teams[0]?.id ?? "";
          this.settings.teamName = this.teams[0]?.name ?? "";
        }
      }

      if (this.settings.teamId && this.spacesTeamId !== this.settings.teamId) {
        this.spaces = await api.spaces(token, this.settings.teamId);
        this.spacesTeamId = this.settings.teamId;
        const keep = this.spaces.some((space) => space.id === this.settings.spaceId);
        const space = keep ? this.settings.spaceId : (this.spaces[0]?.id ?? "");
        this.settings.spaceId = space;
        this.settings.spaceName = this.spaces.find((item) => item.id === space)?.name ?? "";
        this.folders = [];
        this.lists = [];
        this.listsKey = "";
      }

      if (this.settings.spaceId) {
        this.folders = await api.folders(token, this.settings.spaceId);
        if (!this.folders.some((folder) => folder.id === this.settings.folderId)) {
          this.settings.folderId = "";
          this.settings.folderName = "";
        }
        const key = `${this.settings.spaceId}:${this.settings.folderId}`;
        if (this.listsKey !== key || this.lists.length === 0) {
          this.lists = await api.lists(
            token,
            this.settings.spaceId,
            this.settings.folderId,
          );
          this.listsKey = key;
        }
      } else {
        this.lists = [];
        this.listsKey = "";
      }
    } catch (failure) {
      this.formError = errorMessage(failure);
    } finally {
      this.formBusy = false;
      this.renderSelection();
    }
  }

  private renderSelection(): void {
    this.subtitle.textContent = "selecionar lista";
    this.body.innerHTML = "";

    const form = document.createElement("div");
    form.className = "clickup-form";

    const teamSelect = this.selectField("Workspace", this.teams, this.settings.teamId);
    const spaceSelect = this.selectField("Espaço", this.spaces, this.settings.spaceId);
    const folderSelect = this.selectField(
      "Pasta",
      this.folders,
      this.settings.folderId,
      "— sem pasta —",
    );

    teamSelect.select.addEventListener("change", () => {
      this.settings.teamId = teamSelect.select.value;
      this.settings.teamName =
        this.teams.find((team) => team.id === this.settings.teamId)?.name ?? "";
      this.spaces = [];
      this.folders = [];
      this.lists = [];
      this.spacesTeamId = "";
      this.listsKey = "";
      this.settings.spaceId = "";
      this.settings.folderId = "";
      this.settings.listId = "";
      void this.loadSelectionData();
    });

    spaceSelect.select.addEventListener("change", () => {
      this.settings.spaceId = spaceSelect.select.value;
      this.settings.spaceName =
        this.spaces.find((space) => space.id === this.settings.spaceId)?.name ?? "";
      this.settings.folderId = "";
      this.settings.folderName = "";
      this.folders = [];
      this.lists = [];
      this.listsKey = "";
      void this.loadSelectionData();
    });

    folderSelect.select.addEventListener("change", () => {
      this.settings.folderId = folderSelect.select.value;
      this.settings.folderName = folderSelect.select.value
        ? (folderSelect.select.selectedOptions[0]?.textContent ?? "")
        : "";
      this.lists = [];
      this.listsKey = "";
      void this.loadSelectionData();
    });

    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "clickup-primary";
    saveButton.textContent = "Usar esta lista";

    // A lista de sprints é longa; um <select> comum abre para baixo e fica
    // cortado pela borda da tela. A caixa abaixo rola e pode ser filtrada.
    const listWrapper = document.createElement("div");
    listWrapper.className = "clickup-field";

    const listCaption = document.createElement("span");
    listCaption.className = "clickup-field-label";
    listCaption.textContent = "Lista";

    const listSearch = document.createElement("input");
    listSearch.type = "search";
    listSearch.className = "clickup-input clickup-list-search";
    listSearch.placeholder = "Filtrar sprints…";
    listSearch.autocomplete = "off";
    listSearch.spellcheck = false;
    listSearch.disabled = this.lists.length === 0;

    const listSelect = document.createElement("select");
    listSelect.className = "clickup-select clickup-list-select";
    listSelect.size = 8;
    listSelect.disabled = this.lists.length === 0;

    let chosenListId = this.settings.listId;

    const fillListOptions = () => {
      const query = listSearch.value.trim().toLocaleLowerCase("pt-BR");
      const keep = chosenListId;
      listSelect.innerHTML = "";
      listSelect.appendChild(new Option("— escolha —", ""));

      // A lista escolhida fica no topo para continuar visível.
      const ordered = [...this.lists].sort((a, b) => {
        if (a.id === keep) return -1;
        if (b.id === keep) return 1;
        return 0;
      });
      for (const item of ordered) {
        if (query && !item.name.toLocaleLowerCase("pt-BR").includes(query)) continue;
        listSelect.appendChild(new Option(item.name, item.id));
      }
      if (keep && Array.from(listSelect.options).some((option) => option.value === keep)) {
        listSelect.value = keep;
      }
      saveButton.disabled = !listSelect.value;
    };

    listSearch.addEventListener("input", fillListOptions);
    listSelect.addEventListener("change", () => {
      chosenListId = listSelect.value;
      fillListOptions();
    });

    const listHint = document.createElement("p");
    listHint.className = "clickup-hint";
    listHint.textContent = "Role a lista ou digite para filtrar os sprints.";

    listWrapper.append(listCaption, listSearch, listSelect, listHint);
    fillListOptions();

    saveButton.addEventListener("click", () => {
      const listId = listSelect.value;
      if (!listId) return;
      this.settings.listId = listId;
      this.settings.listName = listSelect.selectedOptions[0]?.textContent ?? "";
      this.settings.folderId = folderSelect.select.value;
      this.settings.folderName = this.settings.folderId
        ? (folderSelect.select.selectedOptions[0]?.textContent ?? "")
        : "";
      saveSettings(this.settings);
      this.tasks = [];
      this.tasksAt = 0;
      this.listStatuses = [];
      this.statusesListId = "";
      this.formError = null;
      this.view = "tasks";
      this.render();
      void this.loadTasks(true);
    });

    const tokenButton = document.createElement("button");
    tokenButton.type = "button";
    tokenButton.className = "clickup-link";
    tokenButton.textContent = "Trocar token";
    tokenButton.addEventListener("click", () => {
      this.settings = emptySettings();
      saveSettings(this.settings);
      this.tasks = [];
      this.teams = [];
      this.spaces = [];
      this.folders = [];
      this.lists = [];
      this.listStatuses = [];
      this.statusesListId = "";
      this.currentUserId = "";
      this.view = "setup";
      this.formError = null;
      this.render();
    });

    form.append(teamSelect.wrapper, spaceSelect.wrapper, folderSelect.wrapper, listWrapper);
    form.append(saveButton, tokenButton);

    if (this.formBusy) {
      form.appendChild(this.message("Carregando dados do ClickUp…", "clickup-hint"));
    }
    if (this.formError) {
      const error = document.createElement("p");
      error.className = "usage-error clickup-form-error";
      error.textContent = this.formError;
      form.appendChild(error);
    }
    if (!this.formBusy && this.spaces.length === 0 && this.settings.teamId) {
      form.appendChild(this.message("Nenhum espaço encontrado neste workspace.", "clickup-hint"));
    }

    this.body.appendChild(form);
  }

  private selectField(
    label: string,
    items: Array<{ id: string; name: string }>,
    selectedId: string,
    emptyLabel = "— escolha —",
  ): { wrapper: HTMLElement; select: HTMLSelectElement } {
    const wrapper = document.createElement("label");
    wrapper.className = "clickup-field";

    const caption = document.createElement("span");
    caption.className = "clickup-field-label";
    caption.textContent = label;

    const select = document.createElement("select");
    select.className = "clickup-select";
    select.appendChild(new Option(emptyLabel, ""));
    for (const item of items) {
      select.appendChild(new Option(item.name, item.id));
    }
    if (selectedId && items.some((item) => item.id === selectedId)) {
      select.value = selectedId;
    }

    wrapper.append(caption, select);
    return { wrapper, select };
  }

  /* ---- Tarefas ---- */

  /** Carrega os status da lista para montar os filtros. */
  private async ensureListStatuses(): Promise<void> {
    const { token, listId } = this.settings;
    if (!token || !listId) return;
    if (this.statusesListId === listId) return;

    try {
      const statuses = await api.listStatuses(token, listId);
      this.listStatuses = statuses;
      this.statusesListId = listId;
    } catch {
      // Sem a lista de status, o filtro por status fica indisponível; tenta
      // novamente na próxima atualização.
      this.listStatuses = [];
      this.statusesListId = "";
    }
  }

  /** Usuário dono do token, necessário para “atribuídas a mim”. */
  private async ensureCurrentUser(): Promise<void> {
    if (!this.settings.filterMine || this.currentUserId) return;
    const user = await api.user(this.settings.token);
    if (!user.id) throw new Error("Não foi possível identificar o usuário do ClickUp.");
    this.currentUserId = user.id;
  }

  /**
   * Resolve os status marcados. Na primeira vez, aplica o padrão
   * Aberto/Em Andamento/Rejeitado; se a lista usar outros nomes, marca todos.
   */
  private ensureStatusSelection(): string[] {
    const statuses = this.listStatuses;
    if (statuses.length === 0) return [];

    const defaults = statuses.filter((status) =>
      DEFAULT_FILTER_STATUS_NAMES.includes(normalizeStatusName(status.name)),
    );

    if (this.settings.filterStatuses === null) {
      this.settings.filterStatuses = (defaults.length > 0 ? defaults : statuses).map(
        (status) => status.name,
      );
      saveSettings(this.settings);
      return this.settings.filterStatuses;
    }

    const selected = this.settings.filterStatuses;
    const actual: string[] = [];
    for (const name of selected) {
      const normalized = normalizeStatusName(name);
      const match = statuses.find(
        (status) => normalizeStatusName(status.name) === normalized,
      );
      if (match) actual.push(match.name);
    }

    if (selected.length > 0 && actual.length === 0) {
      this.settings.filterStatuses = (defaults.length > 0 ? defaults : statuses).map(
        (status) => status.name,
      );
      saveSettings(this.settings);
      return this.settings.filterStatuses;
    }

    if (actual.join("\u0000") !== selected.join("\u0000")) {
      this.settings.filterStatuses = actual;
      saveSettings(this.settings);
    }
    return actual;
  }

  private buildFilters(): HTMLElement {
    // Garante que o padrão seja aplicado antes de montar as caixas.
    if (this.listStatuses.length > 0) this.ensureStatusSelection();

    const wrap = document.createElement("div");
    wrap.className = "clickup-filters";

    const mine = document.createElement("label");
    mine.className = "clickup-filter-mine";
    mine.title = "Mostrar somente tarefas atribuídas a você";

    const mineInput = document.createElement("input");
    mineInput.type = "checkbox";
    mineInput.checked = this.settings.filterMine;
    mineInput.addEventListener("change", () => {
      this.settings.filterMine = mineInput.checked;
      saveSettings(this.settings);
      void this.loadTasks(true);
    });

    const mineLabel = document.createElement("span");
    mineLabel.textContent = "Atribuídas a mim";
    mine.append(mineInput, mineLabel);
    wrap.appendChild(mine);

    if (this.listStatuses.length > 0) {
      const label = document.createElement("span");
      label.className = "clickup-filter-label";
      label.textContent = "Status";
      wrap.appendChild(label);

      const statusWrap = document.createElement("div");
      statusWrap.className = "clickup-filter-statuses";
      const selected = new Set(
        (this.settings.filterStatuses ?? []).map(normalizeStatusName),
      );

      for (const status of this.listStatuses) {
        const item = document.createElement("label");
        item.className = "clickup-filter-status";
        item.title = status.name;

        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = selected.has(normalizeStatusName(status.name));
        const syncChecked = () => {
          item.classList.toggle("checked", input.checked);
        };
        syncChecked();
        input.addEventListener("change", () => {
          syncChecked();
          const current = new Set(this.settings.filterStatuses ?? []);
          const normalized = normalizeStatusName(status.name);
          for (const name of Array.from(current)) {
            if (normalizeStatusName(name) === normalized) current.delete(name);
          }
          if (input.checked) current.add(status.name);
          this.settings.filterStatuses = Array.from(current);
          saveSettings(this.settings);
          void this.loadTasks(true);
        });

        const dot = document.createElement("span");
        dot.className = "clickup-filter-dot";
        if (status.color) dot.style.background = status.color;

        const text = document.createElement("span");
        text.className = "clickup-filter-name";
        text.textContent = status.name;

        item.append(input, dot, text);
        statusWrap.appendChild(item);
      }
      wrap.appendChild(statusWrap);

      if ((this.settings.filterStatuses?.length ?? 0) === 0) {
        const hint = document.createElement("span");
        hint.className = "clickup-filter-hint";
        hint.textContent = "Nenhum status marcado = todos";
        wrap.appendChild(hint);
      }
    }

    return wrap;
  }

  private renderTasks(): void {
    this.subtitle.textContent = this.settings.listName;
    this.body.innerHTML = "";

    if (!this.settings.listId) {
      this.body.appendChild(
        this.message("Nenhuma lista escolhida. Use a engrenagem para configurar.", "clickup-hint"),
      );
      return;
    }

    this.body.appendChild(this.buildFilters());

    if (this.tasksLoading) {
      this.body.appendChild(this.message("Carregando tarefas…", "clickup-hint"));
      return;
    }
    if (this.tasksError) {
      this.body.appendChild(this.message(this.tasksError, "usage-error"));
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "clickup-link";
      retry.textContent = "Tentar novamente";
      retry.addEventListener("click", () => void this.loadTasks(true));
      this.body.appendChild(retry);
      return;
    }
    if (this.tasks.length === 0) {
      this.body.appendChild(
        this.message("Nenhuma tarefa encontrada com estes filtros.", "clickup-hint"),
      );
      return;
    }

    const list = document.createElement("div");
    list.className = "clickup-tasks";
    for (const task of this.tasks) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "clickup-task";
      row.title = task.name;

      const id = document.createElement("span");
      id.className = "clickup-task-id";
      id.textContent = taskLabel(task);

      const name = document.createElement("span");
      name.className = "clickup-task-name";
      name.textContent = task.name;

      row.append(id, name, statusChip(task.status));
      row.addEventListener("click", () => void this.openTask(task.id));
      list.appendChild(row);
    }
    this.body.appendChild(list);
  }

  private async loadTasks(force = false): Promise<void> {
    const { token, listId } = this.settings;
    if (!token || !listId) return;
    if (this.tasksLoading) {
      // Uma troca de filtro durante o carregamento não pode ser perdida.
      if (force) this.tasksReloadQueued = true;
      return;
    }
    if (!force && Date.now() - this.tasksAt < TASKS_TTL_MS) {
      this.renderTasks();
      return;
    }

    this.tasksLoading = true;
    this.tasksError = null;
    if (this.view === "tasks") this.renderTasks();

    try {
      await this.ensureListStatuses();
      const statuses = this.ensureStatusSelection();
      await this.ensureCurrentUser();
      const assignees =
        this.settings.filterMine && this.currentUserId
          ? [this.currentUserId]
          : [];
      this.tasks = await api.tasks(token, listId, assignees, statuses);
      this.tasksAt = Date.now();
    } catch (failure) {
      this.tasksError = errorMessage(failure);
    } finally {
      this.tasksLoading = false;
      if (this.view === "tasks") this.renderTasks();
      if (this.tasksReloadQueued) {
        this.tasksReloadQueued = false;
        void this.loadTasks(true);
      }
    }
  }

  /* ---- Modal do ticket ---- */

  private async openTask(taskId: string): Promise<void> {
    this.modalTaskId = taskId;
    this.modalTitle.textContent = "Tarefa";
    this.modalBody.innerHTML = "";
    this.modalBody.appendChild(this.message("Carregando tarefa…", "clickup-hint"));
    this.modal.classList.remove("hidden");

    try {
      const [detailResult, commentsResult] = await Promise.allSettled([
        api.task(this.settings.token, taskId),
        api.comments(this.settings.token, taskId),
      ]);
      if (this.modalTaskId !== taskId) return;
      if (detailResult.status === "rejected") throw detailResult.reason;

      const comments =
        commentsResult.status === "fulfilled" ? commentsResult.value : [];
      const commentsError =
        commentsResult.status === "rejected"
          ? errorMessage(commentsResult.reason)
          : null;
      this.renderDetail(detailResult.value, comments, commentsError);
    } catch (failure) {
      if (this.modalTaskId !== taskId) return;
      this.modalBody.innerHTML = "";
      this.modalBody.appendChild(this.message(errorMessage(failure), "usage-error"));
    }
  }

  private renderDetail(
    task: TaskDetail,
    comments: TaskComment[] = [],
    commentsError: string | null = null,
  ): void {
    this.modalTitle.textContent = `#${taskLabel(task)}`;
    this.modalBody.innerHTML = "";

    const heading = document.createElement("h3");
    heading.className = "clickup-modal-name";
    heading.textContent = task.name;

    const codeRow = document.createElement("div");
    codeRow.className = "clickup-code-row";

    const codeLabel = document.createElement("span");
    codeLabel.className = "clickup-code-label";
    codeLabel.textContent = "Código";

    const codeValue = document.createElement("code");
    codeValue.className = "clickup-code-value";
    codeValue.textContent = taskLabel(task);
    codeValue.title = "Código completo do ticket";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "clickup-copy";
    copy.textContent = "Copiar código";
    copy.addEventListener("click", () => void this.copyCode(taskLabel(task), copy));

    codeRow.append(codeLabel, codeValue, copy);

    const meta = document.createElement("div");
    meta.className = "clickup-modal-meta";
    meta.appendChild(statusChip(task.status));
    if (task.listName) meta.appendChild(metaItem(task.listName));
    if (task.assignees.length > 0) meta.appendChild(metaItem(task.assignees.join(", ")));
    if (task.dueDate) meta.appendChild(metaItem(`entrega ${formatDate(task.dueDate)}`));
    for (const tag of task.tags) meta.appendChild(metaItem(`#${tag}`, "clickup-tag"));

    this.modalBody.append(heading, codeRow, meta);

    const description = document.createElement("div");
    description.className = "clickup-description";
    description.textContent = task.description?.trim() ? task.description : "Sem descrição.";
    this.modalBody.appendChild(description);

    const images: Array<{ url: string; title: string }> = [];
    for (const attachment of task.attachments) {
      if (!attachment.isImage) continue;
      const url = attachment.thumbnail || attachment.url;
      if (url) images.push({ url, title: attachment.title });
    }
    for (const url of extractMarkdownImages(task.description ?? "")) {
      images.push({ url, title: "imagem da descrição" });
    }

    if (images.length > 0) {
      const gallery = document.createElement("div");
      gallery.className = "clickup-gallery";
      for (const image of images) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "clickup-image";
        button.title = `${image.title} — abrir no navegador`;

        const img = document.createElement("img");
        img.src = image.url;
        img.alt = image.title;
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        img.addEventListener("error", () => button.classList.add("broken"));

        button.appendChild(img);
        button.addEventListener("click", () => void openExternal(image.url));
        gallery.appendChild(button);
      }
      this.modalBody.appendChild(gallery);
    }

    const files = task.attachments.filter(
      (attachment) => !attachment.isImage && attachment.url,
    );
    if (files.length > 0) {
      const fileList = document.createElement("div");
      fileList.className = "clickup-files";
      for (const file of files) {
        const link = document.createElement("button");
        link.type = "button";
        link.className = "clickup-file";
        link.textContent = `📎 ${file.title}`;
        link.addEventListener("click", () => void openExternal(file.url));
        fileList.appendChild(link);
      }
      this.modalBody.appendChild(fileList);
    }

    this.modalBody.appendChild(this.renderComments(comments, commentsError));

    if (task.url) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "clickup-primary clickup-open";
      open.textContent = "Abrir no ClickUp";
      open.addEventListener("click", () => void openExternal(task.url));
      this.modalBody.appendChild(open);
    }
  }

  private renderComments(
    comments: TaskComment[],
    commentsError: string | null,
  ): HTMLElement {
    const section = document.createElement("section");
    section.className = "clickup-comments";

    const title = document.createElement("h4");
    title.className = "clickup-comments-title";
    title.textContent =
      comments.length > 0 ? `Comentários (${comments.length})` : "Comentários";
    section.appendChild(title);

    if (commentsError) {
      section.appendChild(this.message(commentsError, "usage-error"));
      return section;
    }
    if (comments.length === 0) {
      section.appendChild(this.message("Nenhum comentário.", "clickup-hint"));
      return section;
    }

    const list = document.createElement("div");
    list.className = "clickup-comment-list";
    for (const comment of comments) {
      const item = document.createElement("article");
      item.className = "clickup-comment";

      const header = document.createElement("div");
      header.className = "clickup-comment-header";

      const author = document.createElement("span");
      author.className = "clickup-comment-author";
      author.textContent = comment.author;

      const date = document.createElement("span");
      date.className = "clickup-comment-date";
      date.textContent = formatDateTime(comment.date);

      header.append(author);
      if (comment.resolved) {
        const resolved = document.createElement("span");
        resolved.className = "clickup-comment-resolved";
        resolved.textContent = "resolvido";
        header.appendChild(resolved);
      }
      header.appendChild(date);

      const body = document.createElement("p");
      body.className = "clickup-comment-text";
      body.textContent = comment.text.trim() || "(sem texto)";

      item.append(header, body);
      list.appendChild(item);
    }
    section.appendChild(list);
    return section;
  }

  private closeModal(): void {
    this.modalTaskId = "";
    this.modal.classList.add("hidden");
    this.modalBody.innerHTML = "";
  }

  private async copyCode(code: string, button: HTMLButtonElement): Promise<void> {
    const copied = await copyText(code);
    button.textContent = copied ? "Copiado!" : "Falhou ao copiar";
    button.classList.toggle("copied", copied);
    window.setTimeout(() => {
      button.textContent = "Copiar código";
      button.classList.remove("copied");
    }, 1400);
  }

  private message(text: string, className: string): HTMLElement {
    const paragraph = document.createElement("p");
    paragraph.className = className;
    paragraph.textContent = text;
    return paragraph;
  }
}

function metaItem(text: string, className = ""): HTMLElement {
  const item = document.createElement("span");
  item.className = `clickup-meta-item ${className}`.trim();
  item.textContent = text;
  return item;
}

function statusChip(status: Status): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "clickup-status";
  chip.textContent = status.name;
  chip.title = status.name;
  if (status.color) {
    chip.style.color = status.color;
    chip.style.borderColor = withAlpha(status.color, 0.45);
    chip.style.background = withAlpha(status.color, 0.14);
  }
  return chip;
}

function errorMessage(failure: unknown): string {
  if (failure instanceof Error) return failure.message;
  if (typeof failure === "string") return failure;
  return String(failure);
}
