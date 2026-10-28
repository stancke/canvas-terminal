//! Canvas Terminal — backend Tauri 2 + portable-pty.

pub mod clickup;
pub mod folders;
pub mod git;
pub mod pty;
pub mod shells;
pub mod usage;

use clickup::{
    clickup_comments, clickup_folders, clickup_list_statuses, clickup_lists, clickup_spaces,
    clickup_task, clickup_tasks, clickup_teams, clickup_user,
};
use folders::list_folders;
use git::{git_diff, git_status};
use pty::{
    PtyState, pty_alive, pty_default_cwd, pty_kill, pty_kill_all, pty_list_shells, pty_resize,
    pty_spawn, pty_write,
};
use std::sync::Arc;
use tauri::{generate_context, generate_handler, Builder, RunEvent};
use usage::usage_report;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = PtyState::new();

    Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
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
            usage_report,
            clickup_teams,
            clickup_user,
            clickup_spaces,
            clickup_folders,
            clickup_lists,
            clickup_list_statuses,
            clickup_tasks,
            clickup_task,
            clickup_comments,
            git_status,
            git_diff,
            list_folders,
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
