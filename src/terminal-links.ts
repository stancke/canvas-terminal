import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openPath, resolvePath, type ResolvedPath } from "./pty";

/** Abre uma URL no navegador padrão (fora do Tauri, numa nova aba). */
export async function openExternalUrl(url: string): Promise<void> {
  if (!/^(https?:|mailto:)/i.test(url)) return;
  if (isTauri()) await openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/** Ctrl (ou Cmd) + clique: evita abrir links ao selecionar texto ou em TUIs. */
export function isLinkActivation(event: MouseEvent): boolean {
  return event.ctrlKey || event.metaKey;
}

// Caminho absoluto/relativo/`~`, ou nome com extensão seguido de :linha.
// O lookbehind impede casar pedaços de URLs (`https://host/a/b`).
const PATH_PATTERN =
  /(?<![\w.\/~@:+-])((?:~|\.{1,2})?(?:\/[\w.@+-]+)+\/?|[\w@+-][\w.@+-]*(?:\/[\w.@+-]+)+\/?|[\w@+-][\w.@+-]*\.[A-Za-z]\w{0,7}(?=:\d))(?::(\d+)(?::(\d+))?)?/g;

const MAX_LINKS_PER_LINE = 6;
const CACHE_LIMIT = 500;

/**
 * Links de caminho de arquivo (`src/main.ts:42`, `~/projeto`). Só viram link os
 * caminhos que existem de fato, conferidos no backend e guardados em cache.
 */
export function registerPathLinks(
  term: Terminal,
  getCwd: () => string,
  onMissing: (message: string) => void,
): void {
  const cache = new Map<string, ResolvedPath | null>();

  const resolve = async (path: string): Promise<ResolvedPath | null> => {
    const key = `${getCwd()}\u0000${path}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    let resolved: ResolvedPath | null = null;
    try {
      resolved = await resolvePath(path, getCwd());
    } catch {
      resolved = null;
    }
    // Resultado negativo expira junto com o cache: o arquivo pode ser criado depois.
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, resolved);
    return resolved;
  };

  const provider: ILinkProvider = {
    provideLinks(lineNumber, callback) {
      const line = term.buffer.active.getLine(lineNumber - 1);
      const text = line?.translateToString(true) ?? "";
      if (!text) {
        callback(undefined);
        return;
      }

      const candidates: Array<{ path: string; start: number; length: number }> = [];
      for (const match of text.matchAll(PATH_PATTERN)) {
        const path = match[1].replace(/[.,;]+$/, "");
        if (!path || match.index === undefined) continue;
        const full = match[0].slice(0, path.length + (match[0].length - match[1].length));
        candidates.push({ path, start: match.index, length: full.length });
        if (candidates.length >= MAX_LINKS_PER_LINE) break;
      }
      if (candidates.length === 0) {
        callback(undefined);
        return;
      }

      void Promise.all(
        candidates.map(async (candidate): Promise<ILink | null> => {
          const resolved = await resolve(candidate.path);
          if (!resolved) return null;
          return {
            text: text.slice(candidate.start, candidate.start + candidate.length),
            range: {
              start: { x: candidate.start + 1, y: lineNumber },
              end: { x: candidate.start + candidate.length, y: lineNumber },
            },
            activate: (event) => {
              if (!isLinkActivation(event)) return;
              void openPath(resolved.path).catch(() =>
                onMissing("não foi possível abrir o caminho."),
              );
            },
          };
        }),
      ).then((links) => {
        const found = links.filter((link): link is ILink => link !== null);
        callback(found.length > 0 ? found : undefined);
      });
    },
  };

  term.registerLinkProvider(provider);
}
