/**
 * Inicialização automática do aplicativo.
 *
 * No app Tauri usa o plugin oficial `tauri-plugin-autostart` (Windows: entrada
 * de inicialização; Linux: arquivo `~/.config/autostart/*.desktop`; macOS:
 * LaunchAgent). No modo navegador (`npm run dev`) a preferência fica no
 * `localStorage` para a tela de configurações continuar funcional.
 */

import { invoke, isTauri } from "@tauri-apps/api/core";

const STORAGE_KEY = "canvas-terminal.autostart.v1";

export function autostartAvailable(): boolean {
  return isTauri();
}

export async function isAutostartEnabled(): Promise<boolean> {
  if (isTauri()) {
    return invoke<boolean>("plugin:autostart|is_enabled");
  }
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export async function setAutostart(enabled: boolean): Promise<void> {
  if (isTauri()) {
    await invoke(`plugin:autostart|${enabled ? "enable" : "disable"}`);
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    throw new Error("Não foi possível salvar a preferência neste navegador.");
  }
}
