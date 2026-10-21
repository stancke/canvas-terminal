//! Canvas Terminal — backend Tauri 2 + portable-pty.

pub mod pty;
pub mod shells;

use pty::{
    PtyState, pty_alive, pty_default_cwd, pty_kill, pty_kill_all, pty_list_shells, pty_resize,
    pty_spawn, pty_write,
};
use std::sync::Arc;
use tauri::{generate_context, generate_handler, Builder, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = PtyState::new();

    Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::clone(&state))
        .invoke_handler(generate_handler![
            pty_list_shells,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_alive,
            pty_kill_all,
            pty_default_cwd,
        ])
        .build(generate_context!())
        .expect("falha ao construir aplicação Tauri")
        .run(move |_, event| match event {
            RunEvent::ExitRequested { .. } => {
                state.kill_all();
            }
            RunEvent::WindowEvent {
                event: tauri::WindowEvent::Destroyed,
                ..
            } => {
                state.kill_all();
            }
            _ => {}
        });
}
