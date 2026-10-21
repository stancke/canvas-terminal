/**
 * Comandos rápidos do painel inferior esquerdo.
 *
 * Ficam no `localStorage` para sobreviverem a recarregamentos e são colados no
 * terminal em foco (sem executar) ao clicar.
 */

export interface QuickCommand {
  id: string;
  label: string;
  command: string;
  /** Se `true`, envia Enter depois de colar o comando. */
  execute: boolean;
}

const STORAGE_KEY = "canvas-terminal.quick-commands.v1";

function makeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
}

export function loadQuickCommands(): QuickCommand[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const commands: QuickCommand[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.command !== "string" || !record.command.trim()) continue;

      const command = record.command;
      const label =
        typeof record.label === "string" && record.label.trim()
          ? record.label.trim()
          : command;
      const id = typeof record.id === "string" && record.id ? record.id : makeId();
      const execute = record.execute === true;
      commands.push({ id, label, command, execute });
    }
    return commands;
  } catch {
    return [];
  }
}

export function saveQuickCommands(commands: QuickCommand[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(commands));
  } catch {
    // Ignora quota/escrita bloqueada.
  }
}

export function createQuickCommand(
  label: string,
  command: string,
  execute: boolean,
): QuickCommand {
  const trimmed = command.trim();
  return {
    id: makeId(),
    label: label.trim() || trimmed,
    command: trimmed,
    execute,
  };
}
