//! Teste de integração dos comandos somente-leitura do Git.
//!
//! Cria um repositório temporário com um arquivo modificado e outro novo,
//! executa `git_status`/`git_diff` e confere contagens e diffs.

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_repo() -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("canvas-terminal-git-{unique}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn git(dir: &PathBuf, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(dir)
        .arg("-c")
        .arg("user.email=teste@example.com")
        .arg("-c")
        .arg("user.name=Teste")
        .args(args)
        .status()
        .expect("git precisa estar instalado para este teste");
    assert!(status.success(), "git {args:?} falhou");
}

#[test]
fn status_and_diff_report_working_changes() {
    let dir = temp_repo();
    git(&dir, &["init", "-q"]);
    fs::write(dir.join("a.txt"), "one\n").unwrap();
    git(&dir, &["add", "a.txt"]);
    git(&dir, &["commit", "-q", "-m", "initial"]);

    fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
    fs::write(dir.join("new.txt"), "hello\nworld\n").unwrap();

    let status = canvas_terminal_lib::git::git_status(dir.to_string_lossy().to_string()).unwrap();
    assert!(!status.branch.is_empty());
    assert_eq!(status.files.len(), 2);

    let modified = status
        .files
        .iter()
        .find(|file| file.path == "a.txt")
        .expect("a.txt modificado");
    assert_eq!(modified.status, "M");
    assert_eq!(modified.additions, 1);
    assert_eq!(modified.deletions, 0);
    assert!(!modified.untracked);

    let created = status
        .files
        .iter()
        .find(|file| file.path == "new.txt")
        .expect("new.txt não rastreado");
    assert!(created.untracked);
    assert_eq!(created.additions, 2);

    let created_diff =
        canvas_terminal_lib::git::git_diff(status.root.clone(), "new.txt".into(), false).unwrap();
    assert!(created_diff.contains("+hello"));
    assert!(created_diff.contains("+world"));

    let modified_diff =
        canvas_terminal_lib::git::git_diff(status.root.clone(), "a.txt".into(), false).unwrap();
    assert!(modified_diff.contains("+two"));

    // Caminho fora do repositório é recusado.
    let invalid =
        canvas_terminal_lib::git::git_diff(status.root.clone(), "../fora.txt".into(), false);
    assert!(invalid.is_err());

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn folder_picker_lists_directories_and_marks_repositories() {
    let dir = temp_repo();
    fs::create_dir(dir.join("sub")).unwrap();
    fs::create_dir(dir.join("repo")).unwrap();
    fs::create_dir(dir.join("repo").join(".git")).unwrap();
    fs::create_dir(dir.join(".oculta")).unwrap();

    let listing =
        canvas_terminal_lib::folders::list_folders(Some(dir.to_string_lossy().to_string()))
            .unwrap();

    let names: Vec<&str> = listing
        .entries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();
    assert!(!names.contains(&".oculta"));
    assert!(names.contains(&"sub"));
    assert!(names.contains(&"repo"));

    let repo = listing
        .entries
        .iter()
        .find(|entry| entry.name == "repo")
        .expect("repo listado");
    assert!(repo.repo);
    assert_eq!(
        listing.entries.first().map(|entry| entry.name.as_str()),
        Some("repo")
    );
    assert!(listing.parent.is_some());

    let missing =
        canvas_terminal_lib::folders::list_folders(Some("/caminho/que/nao/existe".into()));
    assert!(missing.is_err());

    fs::remove_dir_all(&dir).ok();
}
