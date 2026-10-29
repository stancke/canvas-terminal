//! Resolução de caminhos exibidos no terminal.

use canvas_terminal_lib::links::resolve;

#[test]
fn resolve_separa_linha_e_coluna() {
    let dir = std::env::temp_dir().canonicalize().unwrap();
    let file = dir.join("canvas_terminal_links_test.txt");
    std::fs::write(&file, "x").unwrap();

    let found = resolve(
        "canvas_terminal_links_test.txt:12:3",
        Some(dir.to_str().unwrap()),
    )
    .expect("deveria resolver");
    assert_eq!(found.line, Some(12));
    assert_eq!(found.column, Some(3));
    assert!(!found.is_dir);
    assert_eq!(std::path::PathBuf::from(&found.path), file);

    std::fs::remove_file(&file).ok();
}

#[test]
fn resolve_ignora_caminho_inexistente() {
    assert!(resolve("/caminho/que/nao/existe.rs:1", None).is_none());
    assert!(resolve("relativo.rs", None).is_none());
}
