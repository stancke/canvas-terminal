import { invoke } from "@tauri-apps/api/core";

/**
 * Conexões SSH salvas para terminais remotos.
 *
 * O terminal remoto guarda no perfil `shell: "ssh:<id>"`; os dados da conexão
 * ficam aqui, então editar a conexão vale para todos os terminais dela. A
 * senha fica no localStorage, como os tokens das integrações.
 */

const STORAGE_KEY = "canvas-terminal.ssh-hosts.v1";
export const SSH_SHELL_PREFIX = "ssh:";

export interface SshHost {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  /** Caminho da chave privada; vazio usa a configuração padrão do `ssh`. */
  identityFile: string;
  /** Senha ou frase-senha da chave; vazio faz o `ssh` perguntar no terminal. */
  password: string;
}

function makeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
}

function parseHost(value: unknown): SshHost | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.host !== "string" || !v.host) return null;
  const text = (key: string) => (typeof v[key] === "string" ? (v[key] as string) : "");
  const port =
    typeof v.port === "number" && Number.isInteger(v.port) && v.port > 0 && v.port < 65536
      ? v.port
      : 22;
  return {
    id: v.id,
    name: text("name"),
    host: v.host,
    port,
    user: text("user"),
    identityFile: text("identityFile"),
    password: text("password"),
  };
}

export function loadSshHosts(): SshHost[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.map(parseHost).filter((host): host is SshHost => host !== null);
  } catch {
    return [];
  }
}

function saveSshHosts(hosts: SshHost[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(hosts));
  } catch {
    // Ignora quota/escrita bloqueada.
  }
}

export function getSshHost(id: string): SshHost | undefined {
  return loadSshHosts().find((host) => host.id === id);
}

export function upsertSshHost(host: SshHost): void {
  const hosts = loadSshHosts();
  const index = hosts.findIndex((entry) => entry.id === host.id);
  if (index >= 0) hosts[index] = host;
  else hosts.push(host);
  saveSshHosts(hosts);
}

export function removeSshHost(id: string): void {
  saveSshHosts(loadSshHosts().filter((host) => host.id !== id));
}

export function isSshShell(shellId: string): boolean {
  return shellId.startsWith(SSH_SHELL_PREFIX);
}

export function sshShellId(host: SshHost): string {
  return `${SSH_SHELL_PREFIX}${host.id}`;
}

export function sshHostIdOf(shellId: string): string {
  return shellId.slice(SSH_SHELL_PREFIX.length);
}

/** Nome exibido: o apelido ou `usuario@servidor`. */
export function sshHostLabel(host: SshHost): string {
  if (host.name.trim()) return host.name.trim();
  const target = host.user ? `${host.user}@${host.host}` : host.host;
  return host.port !== 22 ? `${target}:${host.port}` : target;
}

/** Abre um PTY com `ssh` conectado ao servidor da conexão. */
export async function spawnSshTerminal(
  shellId: string,
  cols: number,
  rows: number,
): Promise<number> {
  const host = getSshHost(sshHostIdOf(shellId));
  if (!host) throw new Error("Conexão SSH não encontrada (foi removida).");
  return invoke<number>("pty_spawn_ssh", {
    target: {
      host: host.host,
      port: host.port,
      user: host.user || null,
      identityFile: host.identityFile || null,
      password: host.password || null,
    },
    cols,
    rows,
  });
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Formulário da conexão (diálogo do app). Com `choices`, mostra um seletor
 * para reaproveitar uma conexão salva.
 */
export function sshFormHtml(host: SshHost | undefined, choices: SshHost[] = []): string {
  const h = host ?? emptySshHost();
  const options = choices
    .map(
      (entry) =>
        `<option value="${escapeAttr(entry.id)}" ${entry.id === h.id ? "selected" : ""}>${escapeAttr(sshHostLabel(entry))}</option>`,
    )
    .join("");
  const picker = choices.length
    ? `<label class="ssh-field">
         <span>Conexão</span>
         <select id="ssh-pick" class="settings-select">
           <option value="">Nova conexão…</option>
           ${options}
         </select>
       </label>`
    : "";
  return `
    <div class="ssh-form" data-host-id="${escapeAttr(h.id)}">
      ${picker}
      <label class="ssh-field">
        <span>Nome (opcional)</span>
        <input id="ssh-name" class="dialog-input" type="text" maxlength="80"
          placeholder="Ex.: Produção" value="${escapeAttr(h.name)}" />
      </label>
      <div class="ssh-row">
        <label class="ssh-field ssh-grow">
          <span>Servidor</span>
          <input id="ssh-host" class="dialog-input" type="text" maxlength="255"
            placeholder="exemplo.com ou 10.0.0.5" value="${escapeAttr(h.host)}" />
        </label>
        <label class="ssh-field ssh-port">
          <span>Porta</span>
          <input id="ssh-port" class="dialog-input" type="number" min="1" max="65535"
            value="${h.port}" />
        </label>
      </div>
      <label class="ssh-field">
        <span>Usuário</span>
        <input id="ssh-user" class="dialog-input" type="text" maxlength="80"
          placeholder="Ex.: root" value="${escapeAttr(h.user)}" />
      </label>
      <label class="ssh-field">
        <span>Senha ou frase-senha da chave</span>
        <input id="ssh-password" class="dialog-input" type="password" maxlength="1024"
          autocomplete="off" value="${escapeAttr(h.password)}" />
      </label>
      <label class="ssh-field">
        <span>Chave privada (caminho)</span>
        <input id="ssh-key" class="dialog-input" type="text" maxlength="1024"
          placeholder="~/.ssh/id_ed25519" value="${escapeAttr(h.identityFile)}" />
      </label>
      <p class="dialog-hint">
        Sem senha, o <code>ssh</code> pergunta no próprio terminal. Sem chave,
        valem o agente e o <code>~/.ssh/config</code>. A senha fica salva neste
        computador.
      </p>
      <p class="dialog-hint ssh-error" id="ssh-error" hidden></p>
    </div>`;
}

function emptySshHost(): SshHost {
  return { id: makeId(), name: "", host: "", port: 22, user: "", identityFile: "", password: "" };
}

/** Preenche os campos com a conexão escolhida no seletor. */
export function bindSshForm(root: ParentNode, choices: SshHost[]): void {
  const pick = root.querySelector<HTMLSelectElement>("#ssh-pick");
  pick?.addEventListener("change", () => {
    const host = choices.find((entry) => entry.id === pick.value) ?? emptySshHost();
    const form = root.querySelector<HTMLElement>(".ssh-form");
    if (form) form.dataset.hostId = host.id;
    const set = (id: string, value: string) => {
      const input = root.querySelector<HTMLInputElement>(`#${id}`);
      if (input) input.value = value;
    };
    set("ssh-name", host.name);
    set("ssh-host", host.host);
    set("ssh-port", String(host.port));
    set("ssh-user", host.user);
    set("ssh-password", host.password);
    set("ssh-key", host.identityFile);
  });
}

/** Lê o formulário; devolve uma mensagem de erro quando estiver inválido. */
export function readSshForm(root: ParentNode): SshHost | string {
  const value = (id: string) =>
    root.querySelector<HTMLInputElement>(`#${id}`)?.value.trim() ?? "";
  const host = value("ssh-host");
  const user = value("ssh-user");
  if (!host) return "Informe o servidor.";
  if (/\s/.test(host) || host.startsWith("-")) return "Servidor inválido.";
  if (/\s/.test(user) || user.startsWith("-")) return "Usuário inválido.";
  const port = Number(value("ssh-port") || "22");
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "Porta inválida.";
  const id = root.querySelector<HTMLElement>(".ssh-form")?.dataset.hostId || makeId();
  return {
    id,
    name: value("ssh-name"),
    host,
    port,
    user,
    identityFile: value("ssh-key"),
    // Senha não é aparada: espaços podem fazer parte dela.
    password: root.querySelector<HTMLInputElement>("#ssh-password")?.value ?? "",
  };
}
