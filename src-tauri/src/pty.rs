//! Backend PTY: gerencia sessões de terminal reais usando portable-pty.

use crate::shells::{ShellInfo, default_cwd, default_shell, list_shells};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

/// Evento enviado do backend para o frontend a cada mudança no PTY.
#[derive(Clone, Debug, Serialize)]
pub struct PtyEvent {
    pub id: u32,
    pub kind: String,
    pub data: Option<String>,
    pub code: Option<i32>,
}

/// Abstração de emissão de eventos: permite reutilizar a lógica PTY em testes
/// sem depender de `AppHandle`.
pub trait Sink: Send + Sync + 'static {
    fn emit(&self, event: &PtyEvent);
}

impl Sink for AppHandle {
    fn emit(&self, event: &PtyEvent) {
        let _ = tauri::Emitter::emit(self, "pty-event", event.clone());
    }
}

impl Sink for Arc<Mutex<Vec<PtyEvent>>> {
    fn emit(&self, event: &PtyEvent) {
        if let Ok(mut vec) = self.lock() {
            vec.push(event.clone());
        }
    }
}

/// Sessão PTY ativa.
pub struct Session {
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn MasterPty + Send>,
    /// Compartilhado com a thread que vigia o fim do processo: no Windows a
    /// leitura do PTY não termina sozinha, então quem descobre a saída é o
    /// `try_wait` sobre este `child`.
    pub child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    pub cols: u16,
    pub rows: u16,
    pub shell_id: String,
}

/// Estado compartilhado com todas as sessões PTY.
pub struct PtyState {
    pub next_id: AtomicU32,
    pub sessions: Mutex<HashMap<u32, Session>>,
}

impl PtyState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            next_id: AtomicU32::new(1),
            sessions: Mutex::new(HashMap::new()),
        })
    }

    /// Mata todas as sessões ativas (usado no encerramento do app).
    pub fn kill_all(self: &Arc<Self>) {
        let ids: Vec<u32> = {
            let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            sessions.keys().copied().collect()
        };
        for id in ids {
            let _ = pty_kill_internal(self, id);
        }
    }
}

/// Lista os shells disponíveis no sistema, na ordem de preferência.
#[tauri::command]
pub fn pty_list_shells() -> Result<Vec<ShellInfo>, String> {
    let shells = list_shells();
    if shells.is_empty() {
        return Err("Nenhum shell compatível foi encontrado neste sistema.".into());
    }
    Ok(shells)
}

/// Retorna o diretório inicial padrão do usuário.
#[tauri::command]
pub fn pty_default_cwd() -> Result<String, String> {
    Ok(default_cwd())
}

/// Abre um novo PTY executando o shell solicitado.
pub fn pty_spawn_internal<S: Sink + Clone>(
    state: &Arc<PtyState>,
    sink: S,
    shell: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let shells = pty_list_shells()?;
    let shell_info = if let Some(id) = shell {
        shells
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| format!("Shell '{}' não está disponível.", id))?
    } else {
        default_shell(&shells)
    };

    let cwd = cwd.unwrap_or_else(default_cwd);
    let cwd_path = std::path::Path::new(&cwd);
    let cwd = if cwd_path.is_dir() {
        cwd
    } else {
        default_cwd()
    };

    let mut cmd = CommandBuilder::new(&shell_info.path);
    cmd.args(&shell_info.args);
    cmd.cwd(&cwd);
    spawn_command(
        state,
        sink,
        cmd,
        cols,
        rows,
        shell_info.id,
        &shell_info.name,
    )
}

/// Abre um PTY executando `cmd` e registra a sessão (shell local ou `ssh`).
pub(crate) fn spawn_command<S: Sink + Clone>(
    state: &Arc<PtyState>,
    sink: S,
    mut cmd: CommandBuilder,
    cols: u16,
    rows: u16,
    shell_id: String,
    label: &str,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Falha ao abrir PTY: {}", e))?;

    cmd.env("TERM", "xterm-256color");
    #[cfg(unix)]
    cmd.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Falha ao iniciar '{}': {}", label, e))?;

    // O slave deve ser dropado para garantir EOF correto no PTY.
    drop(pair.slave);

    let master = pair.master;
    let writer = master
        .take_writer()
        .map_err(|e| format!("Falha ao obter escritor do PTY: {}", e))?;

    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let reader = master
        .try_clone_reader()
        .map_err(|e| format!("Falha ao obter leitor do PTY: {}", e))?;

    let child = Arc::new(Mutex::new(child));
    {
        let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.insert(
            id,
            Session {
                writer,
                master,
                child: Arc::clone(&child),
                cols,
                rows,
                shell_id,
            },
        );
    }

    // Duas threads por sessão: uma só lê a saída; a outra descobre quando o
    // processo termina e emite `exit`. Separar é obrigatório no Windows porque
    // a leitura do ConPTY fica bloqueada depois que o processo filho sai — sem
    // isso o frontend nunca sabe que o terminal acabou (não volta o botão
    // Conectar nem o aviso "Processo finalizado").
    let reader_sink = sink.clone();
    std::thread::spawn(move || {
        pty_reader_loop(id, reader, reader_sink);
    });

    let state_for_watcher = Arc::clone(state);
    std::thread::spawn(move || {
        pty_exit_watcher(id, state_for_watcher, sink, child);
    });

    Ok(id)
}

/// Lê a saída do PTY até o descritor fechar (o pseudoconsole é fechado pelo
/// vigia) e repassa cada bloco ao `sink`.
fn pty_reader_loop<S: Sink>(id: u32, mut reader: Box<dyn Read + Send>, sink: S) {
    let mut buf = [0u8; 16 * 1024];
    let mut pending = Vec::new();

    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                pending.extend_from_slice(&buf[..n]);
                // Envio imediato, sem janela de coalescência: este laço bloqueia
                // no `read` seguinte, então qualquer atraso artificial poderia
                // segurar o eco indefinidamente quando o shell fica quieto —
                // exatamente o sintoma de "a letra demora a aparecer".
                // Saídas volumosas já vêm em blocos grandes do ConPTY, portanto
                // continuam sendo poucos eventos.
                flush_pending(id, &mut pending, &sink);
            }
            Err(_) => break,
        }
    }

    flush_pending(id, &mut pending, &sink);
}

/// Vigia o processo da sessão e emite `exit` quando ele termina.
fn pty_exit_watcher<S: Sink>(
    id: u32,
    state: Arc<PtyState>,
    sink: S,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
) {
    let code = loop {
        let status = {
            let mut child = child.lock().unwrap_or_else(|e| e.into_inner());
            child.try_wait()
        };
        match status {
            Ok(Some(status)) => break status.exit_code() as i32,
            // Processo morto sem código legível: segue como saída com erro.
            Err(_) => break 1,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(120)),
        }
    };

    // Dá tempo de a thread de leitura drenar a última saída (o adeus do `ssh`,
    // por exemplo) antes de fechar o pseudoconsole.
    std::thread::sleep(std::time::Duration::from_millis(120));

    // Remover a sessão solta o `master` e fecha o pseudoconsole, que é o que
    // faz a leitura terminar.
    {
        let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.remove(&id);
    }

    sink.emit(&PtyEvent {
        id,
        kind: "exit".into(),
        data: None,
        code: Some(code),
    });
}

fn flush_pending<S: Sink>(id: u32, pending: &mut Vec<u8>, sink: &S) {
    if pending.is_empty() {
        return;
    }
    let encoded = BASE64.encode(&*pending);
    pending.clear();
    sink.emit(&PtyEvent {
        id,
        kind: "data".into(),
        data: Some(encoded),
        code: None,
    });
}

/// Comando Tauri: cria um novo PTY.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: tauri::State<'_, Arc<PtyState>>,
    shell: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    pty_spawn_internal(&*state, app, shell, cwd, cols, rows)
}

/// Escreve dados (base64) no PTY.
#[tauri::command]
pub fn pty_write(
    state: tauri::State<'_, Arc<PtyState>>,
    id: u32,
    data: String,
) -> Result<(), String> {
    pty_write_internal(&*state, id, data)
}

pub fn pty_write_internal(state: &Arc<PtyState>, id: u32, data: String) -> Result<(), String> {
    let bytes = BASE64
        .decode(data)
        .map_err(|e| format!("Dados inválidos (base64): {}", e))?;
    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(session) = sessions.get_mut(&id) {
        session
            .writer
            .write_all(&bytes)
            .and_then(|_| session.writer.flush())
            .map_err(|e| format!("Falha ao escrever no PTY: {}", e))?;
        Ok(())
    } else {
        Err("Sessão PTY não encontrada.".into())
    }
}

/// Redimensiona o PTY.
#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, Arc<PtyState>>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    pty_resize_internal(&*state, id, cols, rows)
}

pub fn pty_resize_internal(
    state: &Arc<PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(session) = sessions.get_mut(&id) {
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Falha ao redimensionar PTY: {}", e))?;
        session.cols = cols;
        session.rows = rows;
        Ok(())
    } else {
        Err("Sessão PTY não encontrada.".into())
    }
}

/// Encerra um PTY.
#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, Arc<PtyState>>, id: u32) -> Result<(), String> {
    pty_kill_internal(&*state, id)
}

pub fn pty_kill_internal(state: &Arc<PtyState>, id: u32) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(session) = sessions.remove(&id) {
        // O vigia percebe o término e emite `exit` como em qualquer saída.
        let mut child = session.child.lock().unwrap_or_else(|e| e.into_inner());
        let _ = child.kill();
    }
    Ok(())
}

/// Encerra todas as sessões PTY ativas de uma vez.
///
/// O frontend chama isto ao carregar e ao descarregar a página: uma recarga do
/// webview deixa os PTYs anteriores órfãos, porque o JavaScript que os criou
/// deixou de existir.
#[tauri::command]
pub fn pty_kill_all(state: tauri::State<'_, Arc<PtyState>>) -> Result<u32, String> {
    let ids: Vec<u32> = {
        let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.keys().copied().collect()
    };
    let total = ids.len() as u32;
    for id in ids {
        let _ = pty_kill_internal(&*state, id);
    }
    Ok(total)
}

/// Verifica se uma sessão PTY ainda está viva.
#[tauri::command]
pub fn pty_alive(state: tauri::State<'_, Arc<PtyState>>, id: u32) -> Result<bool, String> {
    pty_alive_internal(&*state, id)
}

pub fn pty_alive_internal(state: &Arc<PtyState>, id: u32) -> Result<bool, String> {
    let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    Ok(sessions.contains_key(&id))
}

/// Pasta de trabalho atual do shell da sessão.
///
/// Serve para restaurar o terminal na mesma pasta depois de reabrir o app.
/// Só há leitura confiável no Linux (`/proc/<pid>/cwd`); nas demais
/// plataformas devolve `None` e o frontend usa o OSC 7 enviado pelo shell.
#[tauri::command]
pub fn pty_cwd(state: tauri::State<'_, Arc<PtyState>>, id: u32) -> Result<Option<String>, String> {
    pty_cwd_internal(&*state, id)
}

pub fn pty_cwd_internal(state: &Arc<PtyState>, id: u32) -> Result<Option<String>, String> {
    let pid = {
        let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.get(&id).and_then(|session| {
            session
                .child
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .process_id()
        })
    };
    Ok(pid.and_then(process_cwd))
}

#[cfg(target_os = "linux")]
fn process_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

#[cfg(not(target_os = "linux"))]
fn process_cwd(_pid: u32) -> Option<String> {
    None
}
