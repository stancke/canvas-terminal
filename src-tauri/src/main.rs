// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Chamado pelo `ssh` como SSH_ASKPASS: responde a senha e sai sem abrir a UI.
    if canvas_terminal_lib::ssh::run_askpass_if_requested() {
        return;
    }
    canvas_terminal_lib::run()
}
