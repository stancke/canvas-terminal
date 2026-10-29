//! Links clicáveis no terminal: resolve e abre caminhos de arquivo exibidos
//! na saída (`src/main.ts:42:7`, `~/projeto`, `./README.md`).

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Serialize)]
pub struct ResolvedPath {
    pub path: String,
    pub is_dir: bool,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

/// Separa o sufixo `:linha[:coluna]` do caminho.
fn split_position(raw: &str) -> (&str, Option<u32>, Option<u32>) {
    let mut path = raw;
    let mut numbers: Vec<u32> = Vec::new();
    for _ in 0..2 {
        match path.rsplit_once(':') {
            Some((head, tail)) if !head.is_empty() => match tail.parse::<u32>() {
                Ok(n) => {
                    numbers.push(n);
                    path = head;
                }
                Err(_) => break,
            },
            _ => break,
        }
    }
    numbers.reverse();
    (path, numbers.first().copied(), numbers.get(1).copied())
}

/// Expande `~` e resolve caminhos relativos contra a pasta do terminal.
pub fn resolve(raw: &str, base: Option<&str>) -> Option<ResolvedPath> {
    let (path, line, column) = split_position(raw.trim());
    if path.is_empty() {
        return None;
    }

    let expanded: PathBuf = if let Some(rest) = path.strip_prefix("~/") {
        PathBuf::from(std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?)
            .join(rest)
    } else if path == "~" {
        PathBuf::from(std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?)
    } else {
        let candidate = Path::new(path);
        if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            Path::new(base?).join(candidate)
        }
    };

    let canonical = expanded.canonicalize().ok()?;
    Some(ResolvedPath {
        is_dir: canonical.is_dir(),
        path: canonical.to_string_lossy().into_owned(),
        line,
        column,
    })
}

/// Resolve um caminho mostrado no terminal; `None` se ele não existe.
#[tauri::command]
pub fn resolve_path(path: String, cwd: Option<String>) -> Option<ResolvedPath> {
    resolve(&path, cwd.as_deref())
}

/// Abre o arquivo/pasta no aplicativo padrão do sistema.
#[tauri::command]
pub fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("Falha ao abrir o caminho: {}", e))
}
