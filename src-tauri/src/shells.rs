//! Descoberta de shells disponíveis no sistema.
//!
//! A API é única para todas as plataformas (`list_shells`, `default_shell`,
//! `default_cwd`). Cada implementação fica isolada em seu sub-módulo `#[cfg]`.

use serde::Serialize;

/// Informações sobre um shell disponível.
#[derive(Clone, Debug, Serialize)]
pub struct ShellInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub args: Vec<String>,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::ShellInfo;
    use std::path::Path;

    fn systemroot() -> String {
        std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())
    }

    fn programfiles() -> String {
        std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into())
    }

    fn programfiles_x86() -> String {
        std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".into())
    }

    pub fn list_shells() -> Vec<ShellInfo> {
        let mut shells = Vec::new();

        let pwsh = format!(r"{}\PowerShell\7\pwsh.exe", programfiles());
        if Path::new(&pwsh).is_file() {
            shells.push(ShellInfo {
                id: "pwsh".into(),
                name: "PowerShell 7".into(),
                path: pwsh,
                args: vec![],
            });
        }

        let powershell = format!(r"{}\System32\WindowsPowerShell\v1.0\powershell.exe", systemroot());
        if Path::new(&powershell).is_file() {
            shells.push(ShellInfo {
                id: "powershell".into(),
                name: "Windows PowerShell".into(),
                path: powershell,
                args: vec![],
            });
        }

        let cmd = format!(r"{}\System32\cmd.exe", systemroot());
        if Path::new(&cmd).is_file() {
            shells.push(ShellInfo {
                id: "cmd".into(),
                name: "Prompt de Comando".into(),
                path: cmd,
                args: vec![],
            });
        }

        let git_bash = format!(r"{}\Git\bin\bash.exe", programfiles());
        let git_bash_x86 = format!(r"{}\Git\bin\bash.exe", programfiles_x86());
        if Path::new(&git_bash).is_file() {
            shells.push(ShellInfo {
                id: "bash".into(),
                name: "Git Bash".into(),
                path: git_bash,
                args: vec!["--login".into(), "-i".into()],
            });
        } else if Path::new(&git_bash_x86).is_file() {
            shells.push(ShellInfo {
                id: "bash".into(),
                name: "Git Bash".into(),
                path: git_bash_x86,
                args: vec!["--login".into(), "-i".into()],
            });
        }

        let wsl = format!(r"{}\System32\wsl.exe", systemroot());
        if Path::new(&wsl).is_file() {
            shells.push(ShellInfo {
                id: "wsl".into(),
                name: "WSL".into(),
                path: wsl,
                args: vec![],
            });
        }

        // `CANVAS_TERMINAL_SHELL` tem prioridade máxima em qualquer plataforma.
        if let Ok(override_shell) = std::env::var("CANVAS_TERMINAL_SHELL") {
            let trimmed = override_shell.trim();
            if !trimmed.is_empty() && Path::new(trimmed).is_file() {
                let name = Path::new(trimmed)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Shell Personalizado".into());
                shells.insert(
                    0,
                    ShellInfo {
                        id: "override".into(),
                        name,
                        path: trimmed.into(),
                        args: vec![],
                    },
                );
            }
        }

        shells
    }

    pub fn default_shell(shells: &[ShellInfo]) -> ShellInfo {
        shells
            .first()
            .cloned()
            .expect("lista de shells não deve estar vazia")
    }

    pub fn default_cwd() -> String {
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".into())
    }
}

#[cfg(unix)]
mod imp {
    use super::ShellInfo;
    use std::path::{Path, PathBuf};

    fn candidate_dirs() -> Vec<PathBuf> {
        let mut dirs = Vec::new();
        if let Ok(path) = std::env::var("PATH") {
            dirs.extend(std::env::split_paths(&path));
        }
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
        dirs.push(PathBuf::from("/bin"));
        dirs
    }

    fn is_executable(path: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt;
        if !path.is_file() {
            return false;
        }
        if let Ok(meta) = std::fs::metadata(path) {
            return meta.permissions().mode() & 0o111 != 0;
        }
        false
    }

    fn find_executable(name: &str, dirs: &[PathBuf]) -> Option<String> {
        for dir in dirs {
            let path = dir.join(name);
            if is_executable(&path) {
                return Some(path.to_string_lossy().to_string());
            }
        }
        None
    }

    pub fn list_shells() -> Vec<ShellInfo> {
        let dirs = candidate_dirs();
        let mut shells = Vec::new();

        let candidates: [(&str, &str, Vec<String>); 5] = [
            ("bash", "Bash", vec!["-l".into()]),
            ("zsh", "Zsh", vec!["-l".into()]),
            ("fish", "Fish", vec![]),
            ("pwsh", "PowerShell 7", vec![]),
            ("sh", "sh", vec![]),
        ];

        for (id, name, args) in candidates {
            if let Some(path) = find_executable(id, &dirs) {
                shells.push(ShellInfo {
                    id: id.into(),
                    name: name.into(),
                    path,
                    args,
                });
            }
        }

        // `CANVAS_TERMINAL_SHELL` tem prioridade máxima em qualquer plataforma.
        if let Ok(override_shell) = std::env::var("CANVAS_TERMINAL_SHELL") {
            let trimmed = override_shell.trim();
            if !trimmed.is_empty() && Path::new(trimmed).is_file() {
                let name = Path::new(trimmed)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Shell Personalizado".into());
                shells.insert(
                    0,
                    ShellInfo {
                        id: "override".into(),
                        name,
                        path: trimmed.into(),
                        args: vec![],
                    },
                );
            }
        }

        shells
    }

    pub fn default_shell(shells: &[ShellInfo]) -> ShellInfo {
        if let Ok(shell_env) = std::env::var("SHELL") {
            let shell_path = Path::new(&shell_env);
            if let Some(found) = shells.iter().find(|s| Path::new(&s.path) == shell_path) {
                return found.clone();
            }
        }
        for id in ["bash", "zsh", "sh"] {
            if let Some(found) = shells.iter().find(|s| s.id == id) {
                return found.clone();
            }
        }
        shells
            .first()
            .cloned()
            .expect("lista de shells não deve estar vazia")
    }

    pub fn default_cwd() -> String {
        std::env::var("HOME").unwrap_or_else(|_| ".".into())
    }
}

/// Lista os shells disponíveis no sistema, na ordem de preferência.
pub fn list_shells() -> Vec<ShellInfo> {
    imp::list_shells()
}

/// Escolhe o shell padrão a partir da lista detectada.
pub fn default_shell(shells: &[ShellInfo]) -> ShellInfo {
    imp::default_shell(shells)
}

/// Retorna o diretório inicial padrão do usuário.
pub fn default_cwd() -> String {
    imp::default_cwd()
}
