/**
 * Histórico (scrollback) dos terminais, guardado à parte do perfil para que o
 * salvamento frequente do layout não precise reserializar o conteúdo dos
 * terminais. Cada entrada é indexada pelo `sessionId` do terminal.
 */

const STORAGE_KEY = "canvas-terminal.scrollback.v1";
const ENABLED_KEY = "canvas-terminal.restore-history.v1";

/** Teto por terminal (caracteres já serializados com sequências ANSI). */
export const SCROLLBACK_MAX_CHARS = 150_000;

/** O histórico pode conter senhas e tokens digitados: o usuário pode desligar. */
export function isHistoryRestoreEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setHistoryRestoreEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
    if (!enabled) localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignora quota/escrita bloqueada.
  }
}

export function loadScrollbacks(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const result: Record<string, string> = {};
    for (const [id, text] of Object.entries(parsed)) {
      if (typeof text === "string" && text) result[id] = text;
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Grava o mapa inteiro. Se estourar a quota do localStorage, descarta os
 * maiores históricos até caber: perder histórico é melhor que perder o perfil.
 */
export function saveScrollbacks(entries: Record<string, string>): void {
  const working = { ...entries };
  for (;;) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(working));
      return;
    } catch {
      const biggest = Object.keys(working).sort(
        (a, b) => working[b].length - working[a].length,
      )[0];
      if (!biggest) return;
      delete working[biggest];
    }
  }
}
