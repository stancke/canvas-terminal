Continue o trabalho no aplicativo `C:\PROJETOS STANCKE\canvas-terminal`.

A versão Windows já foi implementada (veja `SPEC.md` e `IMPLEMENTATION_LOG.md`). Agora o requisito novo:
**o app deve ser compatível e compilável para Linux também**, mantendo o Windows funcionando.

Leia `SPEC-LINUX.md` (adendo §9) POR INTEIRO e implemente tudo nele:

1. Refatore a descoberta de shells para `src/shells.rs` com `#[cfg(target_os = "windows")]` /
   `#[cfg(unix)]` e uma API única (`list_shells`, `default_shell`, `default_cwd`).
   Windows mantém pwsh/powershell/cmd/Git Bash/WSL; Linux passa a detectar bash/zsh/fish/pwsh/sh por `$PATH`
   + `/usr/bin` + `/bin`, com default = `$SHELL` → bash → zsh → sh e cwd = `$HOME`.
2. Garanta que **nenhum** caminho ou API específica de SO exista fora de blocos `#[cfg]`, e que o
   teste de integração de PTY funcione nas duas plataformas.
3. Ajuste fonte/atalhos/clipboard do frontend conforme §9.2 (fallbacks de fonte Linux incluídos).
4. Ajuste `tauri.conf.json` (bundle targets para Windows + Linux) e escreva o `README.md` com as
   seções de build Windows e Linux (§9.3).
5. Rode os critérios de aceite da §9.4 e ITERE até: `npm run build` OK, `cargo build` OK,
   `cargo test` passando. Tente também `rustup target add x86_64-unknown-linux-gnu` e
   `cargo check --target x86_64-unknown-linux-gnu`, relatando a saída real (pode falhar apenas por
   falta de libs de sistema GTK/WebKit do Tauri — nesse caso confirme que nenhum erro vem do nosso código).

Regras: não pare no meio, não peça permissão, não escreva nada fora deste diretório, não remova
funcionalidade existente. Atualize `IMPLEMENTATION_LOG.md` com o que mudou e a saída real dos comandos.
Termine com `STATUS: COMPLETO` somente se `npm run build`, `cargo build` e `cargo test` passarem;
caso contrário `STATUS: BLOQUEADO: <motivo>`.
