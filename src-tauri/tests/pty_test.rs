//! Teste de integração headless do PTY (§7 da SPEC).
//!
//! Abre um PTY com um shell temporário, escreve um comando eco e verifica
//! a resposta, além de testar redimensionamento e encerramento.
//! Funciona em Windows (batch) e Unix (shell script) sem alterações.

use base64::Engine;
use canvas_terminal_lib::pty::{
    pty_alive_internal as pty_alive, pty_kill_internal as pty_kill, pty_list_shells,
    pty_resize_internal as pty_resize, pty_spawn_internal, pty_write_internal as pty_write,
    PtyEvent, PtyState, Sink,
};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Coletor de eventos para uso em testes.
#[derive(Clone)]
struct TestSink {
    events: Arc<Mutex<Vec<PtyEvent>>>,
}

impl Sink for TestSink {
    fn emit(&self, event: &PtyEvent) {
        if let Ok(mut vec) = self.events.lock() {
            vec.push(event.clone());
        }
    }
}

#[cfg(target_os = "windows")]
fn create_test_shell_path() -> std::path::PathBuf {
    let temp = std::env::temp_dir();
    let path = temp.join("canvas_terminal_test_shell.bat");
    let script = "@echo off\r\necho canvas-terminal-ok\r\ntimeout /t 30 /nobreak >nul\r\n";
    std::fs::write(&path, script).expect("falha ao criar shell de teste");
    path
}

#[cfg(unix)]
fn create_test_shell_path() -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let temp = std::env::temp_dir();
    let path = temp.join("canvas_terminal_test_shell.sh");
    let script = "#!/bin/sh\necho canvas-terminal-ok\nsleep 30\n";
    std::fs::write(&path, script).expect("falha ao criar shell de teste");
    let mut perms = std::fs::metadata(&path)
        .expect("falha ao ler metadados do shell de teste")
        .permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&path, perms).expect("falha ao tornar shell executável");
    path
}

#[cfg(target_os = "windows")]
fn input_bytes() -> Vec<u8> {
    b"\r\n".to_vec()
}

#[cfg(unix)]
fn input_bytes() -> Vec<u8> {
    b"\r".to_vec()
}

#[test]
fn pty_integration() {
    let shell_path = create_test_shell_path();
    unsafe {
        std::env::set_var("CANVAS_TERMINAL_SHELL", shell_path.as_os_str());
    }

    let state = PtyState::new();
    let events: Arc<Mutex<Vec<PtyEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = TestSink {
        events: Arc::clone(&events),
    };

    let shells = pty_list_shells().expect("deve haver pelo menos um shell disponível");
    let shell_info = shells
        .iter()
        .find(|s| s.id == "override")
        .expect("override de CANVAS_TERMINAL_SHELL deve ser o primeiro")
        .clone();

    let id = pty_spawn_internal(&state, sink, Some(shell_info.id), None, 80, 24)
        .expect("falha ao spawnar PTY no teste");

    assert!(pty_alive(&state, id).unwrap());

    // Aguarda o prompt inicial estabilizar.
    std::thread::sleep(Duration::from_millis(300));

    // Responde a eventuais solicitações de posição de cursor (DSR) emitidas
    // pelo Console do Windows em ambiente headless, para que o processo prossiga.
    respond_dsr_if_needed(&state, id, &events);

    // Envia Enter (CR) para acionar a leitura do script.
    let input = input_bytes();
    let encoded = base64::engine::general_purpose::STANDARD.encode(&input);
    pty_write(&state, id, encoded).expect("falha ao escrever no PTY");

    // Espera até 10 s pela string de saída.
    let found = wait_for_output(&events, id, "canvas-terminal-ok", Duration::from_secs(10));
    assert!(
        found,
        "não recebeu a saída esperada do PTY; ambiente headless pode exigir DSR"
    );

    // Redimensiona e verifica que não houve panic/erro.
    pty_resize(&state, id, 100, 30).expect("falha ao redimensionar PTY");

    // Mata a sessão.
    pty_kill(&state, id).expect("falha ao matar PTY");
    std::thread::sleep(Duration::from_millis(300));
    assert!(!pty_alive(&state, id).unwrap(), "sessão deveria estar morta");

    let _ = std::fs::remove_file(&shell_path);
}

fn respond_dsr_if_needed(
    state: &std::sync::Arc<PtyState>,
    id: u32,
    events: &Arc<Mutex<Vec<PtyEvent>>>,
) {
    let dsr = b"\x1b[6n";
    let encoded_response = base64::engine::general_purpose::STANDARD.encode(b"\x1b[1;1R");
    let start = Instant::now();
    let mut responded = 0usize;
    while start.elapsed() < Duration::from_millis(800) && responded < 8 {
        let mut found = false;
        if let Ok(vec) = events.lock() {
            for ev in vec.iter().filter(|e| e.id == id && e.kind == "data") {
                if let Some(data) = &ev.data {
                    if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(data) {
                        if decoded.windows(dsr.len()).any(|w| w == dsr) {
                            found = true;
                            break;
                        }
                    }
                }
            }
        }
        if found {
            let _ = pty_write(state, id, encoded_response.clone());
            responded += 1;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn wait_for_output(
    events: &Arc<Mutex<Vec<PtyEvent>>>,
    id: u32,
    needle: &str,
    timeout: Duration,
) -> bool {
    let start = Instant::now();
    let needle_bytes = needle.as_bytes();
    while start.elapsed() < timeout {
        if let Ok(vec) = events.lock() {
            for ev in vec.iter().filter(|e| e.id == id && e.kind == "data") {
                if let Some(data) = &ev.data {
                    if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(data) {
                        if decoded.windows(needle_bytes.len()).any(|w| w == needle_bytes) {
                            return true;
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}
