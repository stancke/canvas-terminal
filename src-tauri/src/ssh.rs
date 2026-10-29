//! Terminais remotos: executa o cliente `ssh` do sistema dentro de um PTY.
//!
//! Usar o OpenSSH instalado (em vez de uma biblioteca SSH) mantém o
//! `~/.ssh/config`, o `known_hosts` e o agente funcionando como no terminal
//! comum. A senha salva é entregue pelo próprio binário do app atuando como
//! `SSH_ASKPASS`, para não precisar de `sshpass` nem digitar no PTY às cegas.

use crate::pty::{PtyState, Sink, spawn_command};
use portable_pty::CommandBuilder;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::AppHandle;

/// Liga o modo askpass quando o app é chamado pelo `ssh`.
const ASKPASS_FLAG: &str = "CANVAS_TERMINAL_ASKPASS";
/// Senha (ou frase-senha da chave) repassada ao processo askpass.
const ASKPASS_SECRET: &str = "CANVAS_TERMINAL_SSH_SECRET";

/// Dados de conexão enviados pelo frontend.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTarget {
    pub host: String,
    pub port: Option<u16>,
    pub user: Option<String>,
    /// Caminho da chave privada (aceita `~`).
    pub identity_file: Option<String>,
    /// Senha do usuário ou frase-senha da chave; vazio = o `ssh` pergunta.
    pub password: Option<String>,
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

/// Recusa valores que o `ssh` interpretaria como opção ou que quebrariam o
/// destino (`user@host`).
fn validate_token(value: &str, field: &str) -> Result<(), String> {
    if value.starts_with('-') || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("{field} inválido: '{value}'."));
    }
    Ok(())
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    } else if path == "~" {
        if let Some(home) = home_dir() {
            return home;
        }
    }
    PathBuf::from(path)
}

/// Monta os argumentos do `ssh` (sem o executável).
pub fn ssh_args(target: &SshTarget) -> Result<Vec<String>, String> {
    let host = target.host.trim();
    if host.is_empty() {
        return Err("Informe o servidor da conexão SSH.".into());
    }
    validate_token(host, "Servidor")?;

    let mut args = Vec::new();
    if let Some(port) = target.port.filter(|p| *p != 0 && *p != 22) {
        args.push("-p".into());
        args.push(port.to_string());
    }
    if let Some(key) = non_empty(&target.identity_file) {
        let path = expand_home(key);
        if !path.is_file() {
            return Err(format!("Chave SSH não encontrada: {}", path.display()));
        }
        args.push("-i".into());
        args.push(path.to_string_lossy().into_owned());
        // Sem isso o agente pode oferecer outras chaves antes e o servidor
        // derrubar a conexão por excesso de tentativas.
        args.push("-o".into());
        args.push("IdentitiesOnly=yes".into());
    }
    if non_empty(&target.password).is_some() {
        // Com askpass forçado, a pergunta "yes/no" do primeiro acesso também
        // iria para o helper (que só responde senha): aceita hosts novos,
        // mas continua recusando chave de host alterada.
        args.push("-o".into());
        args.push("StrictHostKeyChecking=accept-new".into());
        // Senha salva errada: falha uma vez em vez de repetir a mesma senha.
        args.push("-o".into());
        args.push("NumberOfPasswordPrompts=1".into());
    }

    let destination = match non_empty(&target.user) {
        Some(user) => {
            validate_token(user, "Usuário")?;
            format!("{user}@{host}")
        }
        None => host.to_string(),
    };
    args.push("--".into());
    args.push(destination);
    Ok(args)
}

/// Localiza o executável `ssh` no PATH (e no OpenSSH nativo do Windows).
fn find_ssh() -> Option<PathBuf> {
    let name = if cfg!(windows) { "ssh.exe" } else { "ssh" };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    if cfg!(windows) {
        if let Some(root) = std::env::var_os("SystemRoot") {
            dirs.push(Path::new(&root).join("System32").join("OpenSSH"));
        }
    }
    dirs.into_iter()
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
}

/// Abre um PTY com `ssh` conectado ao servidor.
pub fn pty_spawn_ssh_internal<S: Sink + Clone>(
    state: &Arc<PtyState>,
    sink: S,
    target: SshTarget,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let args = ssh_args(&target)?;
    let ssh = find_ssh().ok_or_else(|| {
        "Cliente OpenSSH (ssh) não encontrado. Instale-o para usar terminais remotos.".to_string()
    })?;

    let mut cmd = CommandBuilder::new(&ssh);
    cmd.args(&args);
    if let Some(home) = home_dir() {
        cmd.cwd(home);
    }
    if let Some(secret) = non_empty(&target.password) {
        let exe = std::env::current_exe()
            .map_err(|e| format!("Falha ao localizar o executável do app: {}", e))?;
        cmd.env("SSH_ASKPASS", exe);
        // OpenSSH ≥ 8.4: usa o askpass mesmo com terminal e sem DISPLAY.
        cmd.env("SSH_ASKPASS_REQUIRE", "force");
        cmd.env(ASKPASS_FLAG, "1");
        cmd.env(ASKPASS_SECRET, secret);
    }

    let label = format!("ssh {}", target.host.trim());
    spawn_command(state, sink, cmd, cols, rows, "ssh".into(), &label)
}

/// Comando Tauri: cria um terminal remoto via SSH.
#[tauri::command]
pub fn pty_spawn_ssh(
    app: AppHandle,
    state: tauri::State<'_, Arc<PtyState>>,
    target: SshTarget,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    pty_spawn_ssh_internal(&*state, app, target, cols, rows)
}

/// Resposta do askpass para um prompt do `ssh`: só senhas e frases-senha.
/// Qualquer outra pergunta (PIN, confirmação) fica sem resposta, e o `ssh`
/// trata como recusa em vez de receber a senha no lugar errado.
pub fn askpass_reply(prompt: &str, secret: &str) -> Option<String> {
    let prompt = prompt.to_lowercase();
    if prompt.contains("password") || prompt.contains("passphrase") {
        Some(secret.to_string())
    } else {
        None
    }
}

/// Ponto de entrada do modo askpass; `true` quando o processo atuou como
/// helper e deve encerrar sem abrir a interface.
pub fn run_askpass_if_requested() -> bool {
    if std::env::var_os(ASKPASS_FLAG).is_none() {
        return false;
    }
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let secret = std::env::var(ASKPASS_SECRET).unwrap_or_default();
    match askpass_reply(&prompt, &secret) {
        Some(reply) => {
            println!("{reply}");
            std::process::exit(0);
        }
        None => std::process::exit(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(host: &str) -> SshTarget {
        SshTarget {
            host: host.into(),
            ..Default::default()
        }
    }

    #[test]
    fn monta_destino_com_usuario_e_porta() {
        let t = SshTarget {
            user: Some("deploy".into()),
            port: Some(2222),
            ..target("exemplo.com")
        };
        assert_eq!(
            ssh_args(&t).unwrap(),
            vec!["-p", "2222", "--", "deploy@exemplo.com"]
        );
    }

    #[test]
    fn senha_desvia_pergunta_de_host_novo() {
        let t = SshTarget {
            password: Some("segredo".into()),
            ..target("exemplo.com")
        };
        let args = ssh_args(&t).unwrap();
        assert!(args.contains(&"StrictHostKeyChecking=accept-new".to_string()));
        assert!(!args.iter().any(|a| a.contains("segredo")));
    }

    #[test]
    fn recusa_host_que_parece_opcao() {
        assert!(ssh_args(&target("-oProxyCommand=x")).is_err());
        assert!(ssh_args(&target("a b")).is_err());
        assert!(ssh_args(&target("  ")).is_err());
    }

    #[test]
    fn chave_inexistente_gera_erro() {
        let t = SshTarget {
            identity_file: Some("/caminho/que/nao/existe".into()),
            ..target("exemplo.com")
        };
        assert!(ssh_args(&t).is_err());
    }

    #[test]
    fn askpass_responde_so_senha() {
        assert_eq!(
            askpass_reply("user@host's password: ", "x").as_deref(),
            Some("x")
        );
        assert_eq!(
            askpass_reply("Enter passphrase for key '/k': ", "x").as_deref(),
            Some("x")
        );
        assert_eq!(askpass_reply("Are you sure (yes/no)?", "x"), None);
    }
}
