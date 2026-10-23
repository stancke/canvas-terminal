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
}

interface Team {
  id: string;
  name: string;
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
    for (const key of Object.keys(settings) as Array<keyof ClickUpSettings>) {
      const value = record[key];
      if (typeof value === "string") settings[key] = value;
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

/** `DEV-142` quando existir, senão o final do id numérico. */
function taskLabel(task: TaskSummary | TaskDetail): string {
  return task.customId ? task.customId : `…${task.id.slice(-6)}`;
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
  spaces: (token: string, teamId: string) =>
    invoke<Space[]>("clickup_spaces", { token, teamId }),
  folders: (token: string, spaceId: string) =>
    invoke<Folder[]>("clickup_folders", { token, spaceId }),
  lists: (token: string, spaceId: string, folderId: string) =>
    invoke<ListRef[]>("clickup_lists", { token, spaceId, folderId: folderId || null }),
  tasks: (token: string, listId: string) =>
    invoke<TaskSummary[]>("clickup_tasks", { token, listId }),
  task: (token: string, taskId: string) =>
    invoke<TaskDetail>("clickup_task", { token, taskId }),
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

  private settings: ClickUpSettings = emptySettings();
  private enabled = false;
  private view: View = "tasks";

  private tasks: TaskSummary[] = [];
  private tasksAt = 0;
  private tasksLoading = false;
  private tasksError: string | null = null;

  private teams: Team[] = [];
  private spaces: Space[] = [];
  private folders: Folder[] = [];
  private lists: ListRef[] = [];
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
    const listSelect = this.selectField("Lista", this.lists, this.settings.listId, "— escolha —");

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
    saveButton.disabled = !listSelect.select.value;

    listSelect.select.addEventListener("change", () => {
      saveButton.disabled = !listSelect.select.value;
    });

    saveButton.addEventListener("click", () => {
      const listId = listSelect.select.value;
      if (!listId) return;
      this.settings.listId = listId;
      this.settings.listName = listSelect.select.selectedOptions[0]?.textContent ?? "";
      this.settings.folderId = folderSelect.select.value;
      this.settings.folderName = this.settings.folderId
        ? (folderSelect.select.selectedOptions[0]?.textContent ?? "")
        : "";
      saveSettings(this.settings);
      this.tasks = [];
      this.tasksAt = 0;
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
      this.view = "setup";
      this.formError = null;
      this.render();
    });

    form.append(teamSelect.wrapper, spaceSelect.wrapper, folderSelect.wrapper, listSelect.wrapper);
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

  private renderTasks(): void {
    this.subtitle.textContent = this.settings.listName;
    this.body.innerHTML = "";

    if (!this.settings.listId) {
      this.body.appendChild(
        this.message("Nenhuma lista escolhida. Use a engrenagem para configurar.", "clickup-hint"),
      );
      return;
    }
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
        this.message("Nenhuma tarefa encontrada nesta lista.", "clickup-hint"),
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
    if (!token || !listId || this.tasksLoading) return;
    if (!force && Date.now() - this.tasksAt < TASKS_TTL_MS) {
      this.renderTasks();
      return;
    }

    this.tasksLoading = true;
    this.tasksError = null;
    if (this.view === "tasks") this.renderTasks();

    try {
      this.tasks = await api.tasks(token, listId);
      this.tasksAt = Date.now();
    } catch (failure) {
      this.tasksError = errorMessage(failure);
    } finally {
      this.tasksLoading = false;
      if (this.view === "tasks") this.renderTasks();
    }
  }

  /* ---- Modal do ticket ---- */

  private async openTask(taskId: string): Promise<void> {
    this.modalTitle.textContent = "Tarefa";
    this.modalBody.innerHTML = "";
    this.modalBody.appendChild(this.message("Carregando tarefa…", "clickup-hint"));
    this.modal.classList.remove("hidden");

    try {
      const detail = await api.task(this.settings.token, taskId);
      this.renderDetail(detail);
    } catch (failure) {
      this.modalBody.innerHTML = "";
      this.modalBody.appendChild(this.message(errorMessage(failure), "usage-error"));
    }
  }

  private renderDetail(task: TaskDetail): void {
    this.modalTitle.textContent = `#${taskLabel(task)}`;
    this.modalBody.innerHTML = "";

    const heading = document.createElement("h3");
    heading.className = "clickup-modal-name";
    heading.textContent = task.name;

    const meta = document.createElement("div");
    meta.className = "clickup-modal-meta";
    meta.appendChild(statusChip(task.status));
    if (task.listName) meta.appendChild(metaItem(task.listName));
    if (task.assignees.length > 0) meta.appendChild(metaItem(task.assignees.join(", ")));
    if (task.dueDate) meta.appendChild(metaItem(`entrega ${formatDate(task.dueDate)}`));
    for (const tag of task.tags) meta.appendChild(metaItem(`#${tag}`, "clickup-tag"));

    this.modalBody.append(heading, meta);

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

    if (task.url) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "clickup-primary clickup-open";
      open.textContent = "Abrir no ClickUp";
      open.addEventListener("click", () => void openExternal(task.url));
      this.modalBody.appendChild(open);
    }
  }

  private closeModal(): void {
    this.modal.classList.add("hidden");
    this.modalBody.innerHTML = "";
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
