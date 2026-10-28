import { invoke, isTauri } from "@tauri-apps/api/core";

export interface GitFile {
  path: string;
  /** Letra do `git status` (M, A, D, R, C, U...). */
  status: string;
  staged: boolean;
  additions: number;
  deletions: number;
  untracked: boolean;
}

export interface GitStatus {
  root: string;
  branch: string;
  files: GitFile[];
}

interface FolderEntry {
  name: string;
  path: string;
  repo: boolean;
}

interface FolderListing {
  path: string;
  parent: string | null;
  home: string | null;
  entries: FolderEntry[];
}

/** Pasta rastreada pelo painel: escolhida uma vez e lembrada para sempre. */
const GIT_FOLDER_KEY = "canvas-terminal.git-folder.v1";

/** Limite defensivo: diffs gigantes não travam o modal. */
const MAX_DIFF_LINES = 4000;

function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

function dirName(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}

function displayStatus(file: GitFile): string {
  return file.untracked ? "U" : file.status || "M";
}

function statusClass(file: GitFile): string {
  if (file.untracked) return "untracked";
  switch (file.status) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    default:
      return "modified";
  }
}

function formatCount(value: number): string {
  return value > 999 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function folderIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.innerHTML =
    '<path d="M2 5.2A1.2 1.2 0 0 1 3.2 4h2.6l1.4 1.6h4.6A1.2 1.2 0 0 1 13 6.8v4.4a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.2z"/>';
  return svg;
}

/**
 * Modal com as alterações do Git. A pasta rastreada é escolhida pelo usuário
 * na primeira abertura (e pode ser trocada depois); a escolha fica salva em
 * localStorage e é usada em todas as aberturas seguintes.
 */
export class GitPanel {
  private readonly modal: HTMLElement;
  private readonly defaultFolder: () => Promise<string>;
  private status: GitStatus | null = null;
  private selectedPath = "";
  private savedFolder = "";
  /** Invalida respostas antigas ao fechar/trocar de arquivo. */
  private loadToken = 0;
  private diffToken = 0;
  /** Picker de pastas. */
  private pickerOpen = false;
  private pickerPath = "";
  private pickerParent: string | null = null;
  private pickerToken = 0;
  private pickerBusy = false;

  constructor(modal: HTMLElement, defaultFolder: () => Promise<string>) {
    this.modal = modal;
    this.defaultFolder = defaultFolder;
    try {
      this.savedFolder = localStorage.getItem(GIT_FOLDER_KEY) ?? "";
    } catch {
      this.savedFolder = "";
    }

    this.modal
      .querySelector("#git-modal-close")
      ?.addEventListener("click", () => this.closeModal());
    this.modal
      .querySelector("#git-refresh")
      ?.addEventListener("click", () => {
        if (this.pickerOpen) void this.loadPicker(this.pickerPath);
        else void this.refresh();
      });
    this.modal
      .querySelector("#git-folder-button")
      ?.addEventListener("click", () => {
        void this.openPicker(this.savedFolder || this.pickerPath);
      });
    this.modal.addEventListener("mousedown", (event) => {
      if (event.target === this.modal) this.closeModal();
    });

    this.modal
      .querySelector("#git-picker-up")
      ?.addEventListener("click", () => {
        if (this.pickerParent) void this.loadPicker(this.pickerParent);
      });
    this.modal
      .querySelector("#git-picker-home")
      ?.addEventListener("click", () => {
        // Sem caminho, o backend resolve a pasta inicial (home do usuário).
        void this.loadPicker("");
      });
    this.modal
      .querySelector("#git-picker-cancel")
      ?.addEventListener("click", () => this.closePicker());
    this.modal
      .querySelector("#git-picker-choose")
      ?.addEventListener("click", () => this.choosePath(this.pickerPath));
  }

  open(): void {
    this.modal.classList.remove("hidden");
    if (!this.savedFolder) {
      this.renderNoFolderState();
      void this.openPicker();
      return;
    }
    void this.refresh();
  }

  /**
   * Fecha em camadas: primeiro o seletor de pastas, depois o modal. Devolve
   * `true` se algo foi fechado (usado pelo Esc global).
   */
  close(): boolean {
    if (!this.isOpen()) return false;
    if (this.pickerOpen) {
      this.closePicker();
      return true;
    }
    return this.closeModal();
  }

  private isOpen(): boolean {
    return !this.modal.classList.contains("hidden");
  }

  private closeModal(): boolean {
    if (!this.isOpen()) return false;
    this.pickerOpen = false;
    this.pickerToken++;
    this.modal.querySelector("#git-picker")?.classList.add("hidden");
    this.modal.classList.add("hidden");
    this.loadToken++;
    this.diffToken++;
    return true;
  }

  /* ---- Status / diff ---- */

  private async refresh(): Promise<void> {
    const token = ++this.loadToken;
    this.diffToken++;

    const directory = this.savedFolder;
    this.status = null;
    this.selectedPath = "";
    this.title("Alterações");
    this.setBranch("");
    this.setSummary("");
    this.setFolder(directory || "Nenhuma pasta escolhida");

    if (!directory) {
      this.renderNoFolderState();
      return;
    }

    this.renderFilesMessage("Carregando alterações...");
    this.renderDiffMessage("Carregando...");

    if (!isTauri()) {
      this.showError(
        "Disponível no aplicativo desktop",
        "As alterações do Git são lidas pelo backend do Canvas Terminal.",
      );
      return;
    }

    try {
      const status = await invoke<GitStatus>("git_status", { dir: directory });
      if (token !== this.loadToken) return;
      this.status = status;
      this.title(baseName(status.root) || "Alterações");
      this.setBranch(status.branch);
      this.setFolder(status.root);
      this.setSummary("", status.files);
      this.renderFiles(status.files);

      if (status.files.length === 0) {
        this.renderDiffMessage(
          "Nenhuma alteração no repositório.",
          "O working tree está limpo.",
        );
        return;
      }

      const first =
        status.files.find((file) => file.path === this.selectedPath) ??
        status.files[0];
      this.selectFile(first);
    } catch (error) {
      if (token !== this.loadToken) return;
      this.showError("Não foi possível ler o repositório", String(error));
    }
  }

  private renderNoFolderState(): void {
    this.title("Alterações");
    this.setBranch("");
    this.setSummary("");
    this.setFolder("Nenhuma pasta escolhida");
    this.renderFilesMessage("A pasta rastreada ainda não foi escolhida.");

    const diff = this.modal.querySelector<HTMLElement>("#git-diff");
    if (!diff) return;
    diff.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "git-empty";
    const strong = document.createElement("strong");
    strong.textContent = "Selecione a pasta do repositório Git";
    const detail = document.createElement("span");
    detail.textContent =
      "A escolha fica salva e é usada em todas as próximas aberturas do painel.";
    const choose = document.createElement("button");
    choose.type = "button";
    choose.className = "dialog-button git-empty-action";
    choose.textContent = "Escolher pasta...";
    choose.addEventListener("click", () => void this.openPicker());
    empty.append(strong, detail, choose);
    diff.appendChild(empty);
  }

  private showError(title: string, detail: string): void {
    this.renderFilesMessage(detail);
    const diff = this.modal.querySelector<HTMLElement>("#git-diff");
    if (!diff) return;
    diff.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "git-empty error";
    const strong = document.createElement("strong");
    strong.textContent = title;
    const code = document.createElement("code");
    code.textContent = detail;
    empty.append(strong, code);

    if (this.savedFolder) {
      const change = document.createElement("button");
      change.type = "button";
      change.className = "dialog-button git-empty-action";
      change.textContent = "Escolher outra pasta...";
      change.addEventListener("click", () => void this.openPicker(this.savedFolder));
      empty.appendChild(change);
    }
    diff.appendChild(empty);
    this.setSummary("");
  }

  private title(value: string): void {
    const el = this.modal.querySelector<HTMLElement>("#git-modal-title");
    if (el) el.textContent = value;
  }

  private setBranch(branch: string): void {
    const el = this.modal.querySelector<HTMLElement>("#git-branch");
    if (!el) return;
    el.textContent = branch;
    el.classList.toggle("hidden", !branch);
    el.title = branch ? `Branch atual: ${branch}` : "";
  }

  private setFolder(folder: string): void {
    const el = this.modal.querySelector<HTMLElement>("#git-folder");
    if (!el) return;
    el.textContent = folder;
    el.title = folder;
  }

  private setSummary(text: string, files?: GitFile[]): void {
    const el = this.modal.querySelector<HTMLElement>("#git-summary");
    if (!el) return;
    el.innerHTML = "";
    if (!files) {
      el.textContent = text;
      return;
    }
    const count = files.length;
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    if (count === 0) {
      const empty = document.createElement("span");
      empty.textContent = "Sem alterações";
      el.appendChild(empty);
      return;
    }
    const label = document.createElement("span");
    label.textContent = `${count} alteraç${count === 1 ? "ão" : "ões"} · `;
    el.appendChild(label);

    const add = document.createElement("span");
    add.className = "git-add";
    add.textContent = `+${formatCount(additions)}`;
    const del = document.createElement("span");
    del.className = "git-del";
    del.textContent = ` −${formatCount(deletions)}`;
    el.append(add, del);
  }

  /* ---- Lista de arquivos ---- */

  private renderFilesMessage(message: string): void {
    const list = this.modal.querySelector<HTMLElement>("#git-file-list");
    if (!list) return;
    list.innerHTML = "";
    const empty = document.createElement("p");
    empty.className = "git-file-list-empty";
    empty.textContent = message;
    list.appendChild(empty);
  }

  private renderFiles(files: GitFile[]): void {
    const list = this.modal.querySelector<HTMLElement>("#git-file-list");
    if (!list) return;
    list.innerHTML = "";

    if (files.length === 0) {
      const empty = document.createElement("p");
      empty.className = "git-file-list-empty";
      empty.textContent = "Nenhum arquivo alterado.";
      list.appendChild(empty);
      return;
    }

    for (const file of files) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "git-file";
      row.title = file.path;
      row.dataset.path = file.path;

      const badge = document.createElement("span");
      badge.className = `git-file-badge ${statusClass(file)}`;
      badge.textContent = displayStatus(file);

      const main = document.createElement("span");
      main.className = "git-file-main";
      const name = document.createElement("span");
      name.className = "git-file-name";
      name.textContent = baseName(file.path);
      const dir = document.createElement("span");
      dir.className = "git-file-dir";
      dir.textContent = dirName(file.path) || "raiz do repositório";
      main.append(name, dir);

      const counts = document.createElement("span");
      counts.className = "git-file-counts";
      const add = document.createElement("span");
      add.className = "git-add";
      add.textContent = `+${formatCount(file.additions)}`;
      const del = document.createElement("span");
      del.className = "git-del";
      del.textContent = `−${formatCount(file.deletions)}`;
      counts.append(add, del);

      row.append(badge, main, counts);
      row.addEventListener("click", () => this.selectFile(file));
      list.appendChild(row);
    }
  }

  private selectFile(file: GitFile): void {
    this.selectedPath = file.path;
    for (const row of this.modal.querySelectorAll<HTMLElement>(".git-file")) {
      row.classList.toggle("selected", row.dataset.path === file.path);
    }
    void this.loadDiff(file);
  }

  /* ---- Seletor de pasta ---- */

  private async openPicker(start?: string): Promise<void> {
    const picker = this.modal.querySelector<HTMLElement>("#git-picker");
    if (!picker) return;
    this.pickerOpen = true;
    picker.classList.remove("hidden");
    const initial =
      start ||
      this.savedFolder ||
      (await this.defaultFolder().catch(() => ""));
    if (!this.isOpen()) return;
    await this.loadPicker(initial);
  }

  private closePicker(): void {
    this.pickerOpen = false;
    this.pickerToken++;
    this.modal.querySelector("#git-picker")?.classList.add("hidden");
    if (!this.savedFolder) this.renderNoFolderState();
  }

  private choosePath(path: string): void {
    if (!path || this.pickerBusy) return;
    this.savedFolder = path;
    try {
      localStorage.setItem(GIT_FOLDER_KEY, path);
    } catch {
      // Ignora quota/escrita bloqueada.
    }
    this.pickerOpen = false;
    this.pickerToken++;
    this.modal.querySelector("#git-picker")?.classList.add("hidden");
    void this.refresh();
  }

  private async loadPicker(path: string): Promise<void> {
    const token = ++this.pickerToken;
    this.pickerBusy = true;
    this.setPickerBusy(true);
    this.renderPickerMessage("Carregando pastas...");

    try {
      if (!isTauri()) {
        throw new Error("O seletor de pastas está disponível no aplicativo desktop.");
      }
      const listing = await invoke<FolderListing>("list_folders", {
        path: path || null,
      });
      if (token !== this.pickerToken) return;
      this.pickerPath = listing.path;
      this.pickerParent = listing.parent;
      this.renderPickerPath();
      this.renderPickerEntries(listing.entries);
    } catch (error) {
      if (token !== this.pickerToken) return;
      this.pickerPath = path;
      this.pickerParent = null;
      this.renderPickerPath();
      this.renderPickerMessage(String(error), true);
    } finally {
      if (token === this.pickerToken) {
        this.pickerBusy = false;
        this.setPickerBusy(false);
      }
    }
  }

  private setPickerBusy(busy: boolean): void {
    const choose = this.modal.querySelector<HTMLButtonElement>(
      "#git-picker-choose",
    );
    if (choose) choose.disabled = busy;
  }

  private renderPickerPath(): void {
    const path = this.modal.querySelector<HTMLElement>("#git-picker-path");
    if (path) {
      path.textContent = this.pickerPath || "Selecione uma pasta";
      path.title = this.pickerPath;
    }
    const up = this.modal.querySelector<HTMLButtonElement>("#git-picker-up");
    if (up) up.disabled = !this.pickerParent;
    const home = this.modal.querySelector<HTMLButtonElement>("#git-picker-home");
    if (home) home.disabled = false;
  }

  private renderPickerMessage(message: string, error = false): void {
    const list = this.modal.querySelector<HTMLElement>("#git-picker-list");
    if (!list) return;
    list.innerHTML = "";
    const empty = document.createElement("p");
    empty.className = `git-picker-empty${error ? " error" : ""}`;
    empty.textContent = message;
    list.appendChild(empty);
  }

  private renderPickerEntries(entries: FolderEntry[]): void {
    const list = this.modal.querySelector<HTMLElement>("#git-picker-list");
    if (!list) return;
    list.innerHTML = "";

    if (entries.length === 0) {
      this.renderPickerMessage("Nenhuma subpasta nesta pasta.");
      return;
    }

    for (const entry of entries) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "git-picker-row";
      row.title = entry.path;

      row.appendChild(folderIcon());
      const name = document.createElement("span");
      name.className = "git-picker-row-name";
      name.textContent = entry.name;
      row.appendChild(name);

      if (entry.repo) {
        const badge = document.createElement("span");
        badge.className = "git-picker-repo";
        badge.textContent = "git";
        badge.title = "Repositório Git";
        row.appendChild(badge);
      }

      const chevron = document.createElement("span");
      chevron.className = "git-picker-chevron";
      chevron.textContent = "›";
      row.appendChild(chevron);

      row.addEventListener("click", () => void this.loadPicker(entry.path));
      row.addEventListener("dblclick", () => this.choosePath(entry.path));
      list.appendChild(row);
    }
  }

  /* ---- Diff ---- */

  private async loadDiff(file: GitFile): Promise<void> {
    const diff = this.modal.querySelector<HTMLElement>("#git-diff");
    if (!diff) return;

    const token = ++this.diffToken;
    this.renderDiffMessage("Carregando diferenças...");

    if (!this.status || !isTauri()) return;

    try {
      const text = await invoke<string>("git_diff", {
        dir: this.status.root,
        path: file.path,
        staged: file.staged,
      });
      if (token !== this.diffToken) return;
      this.renderDiff(diff, file, text);
    } catch (error) {
      if (token !== this.diffToken) return;
      diff.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "git-empty error";
      const strong = document.createElement("strong");
      strong.textContent = "Não foi possível carregar o diff";
      const code = document.createElement("code");
      code.textContent = String(error);
      empty.append(strong, code);
      diff.appendChild(empty);
    }
  }

  private renderDiffMessage(title: string, detail = ""): void {
    const diff = this.modal.querySelector<HTMLElement>("#git-diff");
    if (!diff) return;
    diff.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "git-empty";
    const strong = document.createElement("strong");
    strong.textContent = title;
    empty.appendChild(strong);
    if (detail) {
      const text = document.createElement("span");
      text.textContent = detail;
      empty.appendChild(text);
    }
    diff.appendChild(empty);
  }

  private renderDiff(container: HTMLElement, file: GitFile, text: string): void {
    container.innerHTML = "";

    if (!text.trim()) {
      this.renderDiffMessage(
        "Sem diferenças de texto",
        "O arquivo pode ser binário ou estar apenas com o modo alterado.",
      );
      return;
    }

    const head = document.createElement("div");
    head.className = "git-diff-head";
    const badge = document.createElement("span");
    badge.className = `git-file-badge ${statusClass(file)}`;
    badge.textContent = displayStatus(file);
    const path = document.createElement("span");
    path.className = "git-diff-path";
    path.textContent = file.path;
    path.title = file.path;
    const counts = document.createElement("span");
    counts.className = "git-file-counts";
    const add = document.createElement("span");
    add.className = "git-add";
    add.textContent = `+${formatCount(file.additions)}`;
    const del = document.createElement("span");
    del.className = "git-del";
    del.textContent = `−${formatCount(file.deletions)}`;
    counts.append(add, del);
    head.append(badge, path, counts);

    const content = document.createElement("div");
    content.className = "git-diff-content";

    const lines = text.split("\n");
    const max = Math.min(lines.length, MAX_DIFF_LINES);
    let oldLine = 0;
    let newLine = 0;

    for (let index = 0; index < max; index++) {
      const line = lines[index];
      let kind = "context";
      let oldNumber: number | null = null;
      let newNumber: number | null = null;

      if (line.startsWith("@@")) {
        kind = "hunk";
        const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (match) {
          oldLine = Number(match[1]);
          newLine = Number(match[2]);
        }
      } else if (
        line.startsWith("diff --git") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("new file") ||
        line.startsWith("deleted file") ||
        line.startsWith("old mode") ||
        line.startsWith("new mode") ||
        line.startsWith("similarity index") ||
        line.startsWith("rename from") ||
        line.startsWith("rename to") ||
        line.startsWith("Binary files") ||
        line.startsWith("\\ No newline")
      ) {
        kind = "meta";
      } else if (line.startsWith("+")) {
        kind = "add";
        newNumber = newLine++;
      } else if (line.startsWith("-")) {
        kind = "del";
        oldNumber = oldLine++;
      } else {
        kind = "context";
        oldNumber = oldLine++;
        newNumber = newLine++;
      }

      const row = document.createElement("div");
      row.className = `git-line ${kind}`;
      const oldGutter = document.createElement("span");
      oldGutter.className = "git-ln";
      oldGutter.textContent = oldNumber === null ? "" : String(oldNumber);
      const newGutter = document.createElement("span");
      newGutter.className = "git-ln";
      newGutter.textContent = newNumber === null ? "" : String(newNumber);
      const code = document.createElement("span");
      code.className = "git-code";
      code.textContent = line || " ";
      row.append(oldGutter, newGutter, code);
      content.appendChild(row);
    }

    container.append(head, content);

    if (lines.length > max) {
      const note = document.createElement("div");
      note.className = "git-empty";
      const strong = document.createElement("strong");
      strong.textContent = "Diff truncado";
      const detail = document.createElement("span");
      detail.textContent = `Mostrando ${max} de ${lines.length} linhas.`;
      note.append(strong, detail);
      container.appendChild(note);
    }
  }
}
