/**
 * Registro de plugins do Canvas Terminal.
 *
 * O usuário ativa/desativa plugins pelo menu "Plugins" do cabeçalho. O estado
 * fica no `localStorage` para sobreviver a recarregamentos, igual aos comandos
 * rápidos e ao layout das áreas de trabalho.
 */

export interface PluginDefinition {
  id: string;
  name: string;
  /** Texto curto exibido abaixo do nome no menu. */
  description: string;
}

export const PLUGINS: PluginDefinition[] = [
  {
    id: "token-usage",
    name: "Uso de tokens",
    description: "Consumo de Claude Code e OpenCode por janela de 5 h e semanal.",
  },
  {
    id: "clickup",
    name: "ClickUp",
    description: "Tarefas da lista escolhida, com status e detalhes do ticket.",
  },
];

const STORAGE_KEY = "canvas-terminal.plugins.v1";

export interface PluginSettings {
  enabled: Record<string, boolean>;
}

function defaultSettings(): PluginSettings {
  const enabled: Record<string, boolean> = {};
  for (const plugin of PLUGINS) enabled[plugin.id] = false;
  return { enabled };
}

export function loadPluginSettings(): PluginSettings {
  const settings = defaultSettings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return settings;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return settings;
    const enabled = (parsed as Record<string, unknown>).enabled;
    if (typeof enabled !== "object" || enabled === null) return settings;
    for (const plugin of PLUGINS) {
      const value = (enabled as Record<string, unknown>)[plugin.id];
      if (typeof value === "boolean") settings.enabled[plugin.id] = value;
    }
  } catch {
    // localStorage indisponível: usa o padrão (tudo desligado).
  }
  return settings;
}

export function savePluginSettings(settings: PluginSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignora quota/escrita bloqueada.
  }
}

export function isPluginEnabled(settings: PluginSettings, id: string): boolean {
  return settings.enabled[id] === true;
}

export function togglePlugin(settings: PluginSettings, id: string): boolean {
  const next = settings.enabled[id] !== true;
  settings.enabled[id] = next;
  return next;
}
