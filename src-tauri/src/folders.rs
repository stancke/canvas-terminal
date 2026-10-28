//! Navegação de pastas para o seletor do painel do Git.
//!
//! Lista apenas subpastas (sem arquivos), marca as que parecem repositórios
//! Git e devolve o caminho do pai para a navegação. Nada é escrito no disco.

use serde::Serialize;
use std::fs;
use std::path::PathBuf;

const MAX_ENTRIES: usize = 1000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub name: String,
    pub path: String,
    /// Pasta contém um `.git` (diretório ou arquivo, no caso de worktrees).
    pub repo: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    pub path: String,
    pub parent: Option<String>,
    pub home: Option<String>,
    pub entries: Vec<FolderEntry>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

fn fallback_dir() -> PathBuf {
    home_dir()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

#[tauri::command]
pub fn list_folders(path: Option<String>) -> Result<FolderListing, String> {
    let home = home_dir();
    let requested = path
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(fallback_dir);

    let directory = requested
        .canonicalize()
        .map_err(|error| format!("Pasta não encontrada: {error}"))?;
    if !directory.is_dir() {
        return Err("O caminho escolhido não é uma pasta.".to_string());
    }

    let mut entries = Vec::new();
    let read = fs::read_dir(&directory)
        .map_err(|error| format!("Sem permissão para ler esta pasta: {error}"))?;
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        // `Path::is_dir` segue symlinks; o diretório pode apontar para um repo.
        if !path.is_dir() {
            continue;
        }
        entries.push(FolderEntry {
            repo: path.join(".git").exists(),
            name,
            path: path.to_string_lossy().to_string(),
        });
    }

    entries.sort_by(|a, b| {
        b.repo
            .cmp(&a.repo)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries.truncate(MAX_ENTRIES);

    Ok(FolderListing {
        path: directory.to_string_lossy().to_string(),
        parent: directory
            .parent()
            .map(|parent| parent.to_string_lossy().to_string()),
        home: home.map(|path| path.to_string_lossy().to_string()),
        entries,
    })
}
