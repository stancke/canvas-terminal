//! Integração somente-leitura com o Git: status e diffs para o painel lateral.
//!
//! Os comandos recebem a pasta da área de trabalho e executam o binário `git`
//! com argumentos fixos (nunca flags vindas da interface). O frontend só exibe
//! o resultado.

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output};

/// Tamanho máximo de um diff devolvido ao frontend.
const MAX_DIFF_BYTES: usize = 512 * 1024;
/// Limite de linhas sintetizadas para arquivos ainda não rastreados.
const MAX_UNTRACKED_LINES: usize = 5000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileEntry {
    pub path: String,
    /// Letra de status (M, A, D, R, C, U ou ? para não rastreado).
    pub status: String,
    pub staged: bool,
    pub additions: u32,
    pub deletions: u32,
    pub untracked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub root: String,
    pub branch: String,
    pub files: Vec<GitFileEntry>,
}

fn run_git(dir: &Path, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(dir)
        .arg("--no-pager")
        .arg("-c")
        .arg("core.quotepath=false")
        .arg("-c")
        .arg("color.ui=false")
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0");
    // No Windows o app não tem console: evita piscar uma janela preta a cada
    // comando do git.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "Git não está instalado ou não está no PATH.".to_string()
        } else {
            format!("Falha ao executar o git: {error}")
        }
    })
}

fn repository_root(dir: &Path) -> Result<PathBuf, String> {
    if !dir.is_dir() {
        return Err(format!("Pasta não encontrada: {}", dir.display()));
    }
    let output = run_git(dir, &["rev-parse", "--show-toplevel"])?;
    if !output.status.success() {
        return Err("Esta pasta não está dentro de um repositório Git.".to_string());
    }
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return Err("Não foi possível localizar a raiz do repositório Git.".to_string());
    }
    Ok(PathBuf::from(root))
}

fn branch_name(root: &Path) -> String {
    let Ok(output) = run_git(root, &["rev-parse", "--abbrev-ref", "HEAD"]) else {
        return "sem commits".to_string();
    };
    if !output.status.success() {
        return "sem commits".to_string();
    }
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if name.is_empty() || name == "HEAD" {
        "sem commits".to_string()
    } else {
        name
    }
}

/// Lê `git diff --numstat` num mapa caminho -> (adições, remoções).
fn numstat(root: &Path, cached: bool) -> HashMap<String, (u32, u32)> {
    let mut args = vec!["diff", "--numstat", "--no-color", "--no-ext-diff"];
    if cached {
        args.push("--cached");
    }
    args.push("--");

    let mut stats = HashMap::new();
    let Ok(output) = run_git(root, &args) else {
        return stats;
    };
    if !output.status.success() {
        return stats;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(add), Some(del), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let Ok(add) = add.parse::<u32>() else {
            continue;
        };
        let Ok(del) = del.parse::<u32>() else {
            continue;
        };
        stats.insert(path.to_string(), (add, del));
    }
    stats
}

fn count_lines(path: &Path) -> (u32, u32) {
    // Arquivos enormes não entram na contagem: o diff também seria truncado.
    if let Ok(metadata) = fs::metadata(path) {
        if metadata.len() > 2_000_000 {
            return (0, 0);
        }
    }
    let Ok(bytes) = fs::read(path) else {
        return (0, 0);
    };
    if bytes.contains(&0) {
        return (0, 0);
    }
    let mut additions = bytes.iter().filter(|byte| **byte == b'\n').count() as u32;
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        additions += 1;
    }
    (additions, 0)
}

/// Rejeita caminhos absolutos e qualquer tentativa de sair do repositório.
fn safe_relative(path: &str) -> Result<&Path, String> {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Err("Caminho inválido para o Git.".to_string());
    }
    for component in candidate.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err("Caminho inválido para o Git.".to_string()),
        }
    }
    Ok(candidate)
}

fn truncate_diff(mut text: String) -> String {
    if text.len() <= MAX_DIFF_BYTES {
        return text;
    }
    let mut cut = MAX_DIFF_BYTES;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
    if let Some(index) = text.rfind('\n') {
        text.truncate(index + 1);
    }
    text.push_str("\n… diff truncado (arquivo muito grande).\n");
    text
}

#[tauri::command]
pub fn git_status(dir: String) -> Result<GitStatus, String> {
    let root = repository_root(Path::new(&dir))?;
    let branch = branch_name(&root);

    let output = run_git(
        &root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let staged_stats = numstat(&root, true);
    let unstaged_stats = numstat(&root, false);

    let mut files = Vec::new();
    let mut fields = output.stdout.split(|byte| *byte == 0);
    while let Some(entry) = fields.next() {
        if entry.len() < 4 {
            continue;
        }
        let x = entry[0] as char;
        let y = entry[1] as char;
        let path = String::from_utf8_lossy(&entry[3..]).to_string();

        // Renomeações/cópias guardam o caminho original no campo seguinte.
        if x == 'R' || x == 'C' {
            let _ = fields.next();
        }

        let untracked = x == '?';
        let staged = !untracked && x != ' ';
        let status = if untracked {
            "?".to_string()
        } else if y != ' ' && y != '?' {
            y.to_string()
        } else {
            x.to_string()
        };

        let (mut additions, mut deletions) = if untracked {
            count_lines(&root.join(&path))
        } else if let Some(stats) = unstaged_stats.get(&path) {
            *stats
        } else if let Some(stats) = staged_stats.get(&path) {
            *stats
        } else {
            (0, 0)
        };

        if additions == 0 && deletions == 0 && !untracked {
            if let Some(stats) = staged_stats.get(&path) {
                additions = stats.0;
                deletions = stats.1;
            }
        }

        files.push(GitFileEntry {
            path,
            status,
            staged,
            additions,
            deletions,
            untracked,
        });
    }

    Ok(GitStatus {
        root: root.to_string_lossy().to_string(),
        branch,
        files,
    })
}

#[tauri::command]
pub fn git_diff(dir: String, path: String, staged: bool) -> Result<String, String> {
    let root = repository_root(Path::new(&dir))?;
    let relative = safe_relative(&path)?;

    // Arquivo fora do índice (novo): o git não gera diff, então montamos um.
    let tracked = run_git(&root, &["ls-files", "--error-unmatch", "--", &path])
        .map(|output| output.status.success())
        .unwrap_or(false);

    if !tracked {
        let target = root.join(relative);
        let canonical_root = root
            .canonicalize()
            .map_err(|error| format!("Falha ao acessar o repositório: {error}"))?;
        let canonical_target = target
            .canonicalize()
            .map_err(|error| format!("Arquivo não encontrado: {error}"))?;
        if !canonical_target.starts_with(&canonical_root) {
            return Err("Caminho inválido para o Git.".to_string());
        }
        if let Ok(metadata) = fs::metadata(&canonical_target) {
            if metadata.len() > 4_000_000 {
                return Ok("Arquivo muito grande — diff não exibido.\n".to_string());
            }
        }

        let bytes = fs::read(&canonical_target)
            .map_err(|error| format!("Falha ao ler o arquivo: {error}"))?;
        if bytes.contains(&0) {
            return Ok("Arquivo binário — diff não exibido.\n".to_string());
        }
        let text = String::from_utf8_lossy(&bytes);
        let total = if text.ends_with('\n') {
            text.split('\n').count().saturating_sub(1)
        } else {
            text.split('\n').count()
        };
        let shown = total.min(MAX_UNTRACKED_LINES);
        let mut diff = format!(
            "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{shown} @@\n"
        );
        for line in text.split('\n').take(shown) {
            diff.push('+');
            diff.push_str(line);
            diff.push('\n');
        }
        if total > shown {
            diff.push_str("… arquivo truncado.\n");
        }
        return Ok(truncate_diff(diff));
    }

    let has_head = run_git(&root, &["rev-parse", "--verify", "HEAD"])
        .map(|output| output.status.success())
        .unwrap_or(false);

    let mut args = vec!["diff", "--no-color", "--no-ext-diff", "--unified=3"];
    if staged || !has_head {
        args.push("--cached");
    } else {
        args.push("HEAD");
    }
    args.push("--");
    args.push(&path);

    let output = run_git(&root, &args)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(truncate_diff(
        String::from_utf8_lossy(&output.stdout).to_string(),
    ))
}
