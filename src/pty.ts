import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ShellInfo {
  id: string;
  name: string;
  path: string;
  args: string[];
}

export interface PtyEvent {
  id: number;
  kind: "data" | "exit";
  data: string | null;
  code: number | null;
}

export type PtyDataHandler = (event: PtyEvent) => void;

let unlisten: UnlistenFn | null = null;
const handlers = new Map<number, PtyDataHandler>();
/** Eventos recebidos antes de o handler da sessão existir (banner + prompt). */
const pendingEvents = new Map<number, PtyEvent[]>();
const PENDING_LIMIT = 1024;

export async function initPtyListener(): Promise<void> {
  if (unlisten) return;
  unlisten = await listen<PtyEvent>("pty-event", (event) => {
    const payload = event.payload;
    const handler = handlers.get(payload.id);
    if (handler) {
      handler(payload);
      return;
    }
    // O PTY já emite saída logo após o spawn, antes de o TerminalWindow
    // registrar seu handler: bufferiza para não perder o prompt inicial.
    const queue = pendingEvents.get(payload.id);
    if (queue) {
      if (queue.length >= PENDING_LIMIT) queue.shift();
      queue.push(payload);
    } else {
      pendingEvents.set(payload.id, [payload]);
    }
  });
}

export function onPtyData(id: number, handler: PtyDataHandler): void {
  handlers.set(id, handler);
  const queue = pendingEvents.get(id);
  if (queue) {
    pendingEvents.delete(id);
    for (const payload of queue) handler(payload);
  }
}

/** Encerra todas as sessões PTY do backend (recarga/fechamento da página). */
export async function killAllTerminals(): Promise<number> {
  return invoke<number>("pty_kill_all");
}

export function offPtyData(id: number): void {
  handlers.delete(id);
  pendingEvents.delete(id);
}

export async function listShells(): Promise<ShellInfo[]> {
  return invoke<ShellInfo[]>("pty_list_shells");
}

export async function defaultCwd(): Promise<string> {
  return invoke<string>("pty_default_cwd");
}

export async function spawnTerminal(
  shell: string,
  cwd: string,
  cols: number,
  rows: number,
): Promise<number> {
  return invoke<number>("pty_spawn", { shell: shell || null, cwd: cwd || null, cols, rows });
}

export async function writeTerminal(id: number, data: Uint8Array): Promise<void> {
  return invoke("pty_write", { id, data: bytesToBase64(data) });
}

/** base64 em blocos: colagens grandes não estouram a pilha do spread. */
function bytesToBase64(data: Uint8Array): string {
  const CHUNK = 32768;
  let binary = "";
  for (let i = 0; i < data.length; i += CHUNK) {
    binary += String.fromCharCode(...data.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function resizeTerminal(id: number, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}

export async function killTerminal(id: number): Promise<void> {
  return invoke("pty_kill", { id });
}

export async function isTerminalAlive(id: number): Promise<boolean> {
  return invoke<boolean>("pty_alive", { id });
}
