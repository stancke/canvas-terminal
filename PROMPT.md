Leia o arquivo `SPEC.md` deste diretório POR INTEIRO e implemente o aplicativo completo descrito nele.

Contexto que você precisa saber:
- Diretório de trabalho: `C:\PROJETOS STANCKE\canvas-terminal` (projeto Tauri 2 já scaffoldado com template `vanilla-ts` + Vite).
- `npm install` já foi executado; `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`, `@tauri-apps/api` já estão em `node_modules`.
- Ainda faltam as crates Rust: rode `cargo add portable-pty base64` dentro de `src-tauri`.
- Ambiente: Windows 10, git-bash, Node 22, Rust stable (msvc), MSVC 2019 BuildTools, WebView2 instalado.

Regras de execução (obrigatórias):
1. Implemente TODOS os arquivos da §2 da spec, com o conteúdo funcional descrito nas §3, §4, §5, §6, §7. Não entregue esqueletos, TODOs ou stubs — código completo e funcional.
2. Rode você mesmo os comandos de verificação da §7 e itere até passarem:
   - `npm run build`
   - `cd src-tauri && cargo build`
   - `cd src-tauri && cargo test`  (o teste de integração de PTY da §7 PRECISA passar de verdade)
   Corrija todo erro que aparecer (tipo, borrow checker, API do xterm, API do Tauri 2) em vez de contornar removendo funcionalidade. ATENÇÃO: as APIs do Tauri 2 e do `@xterm/xterm` v6 mudaram em relação às versões antigas — verifique os tipos instalados em `node_modules/@xterm/xterm/typings/xterm.d.ts` e a doc do Tauri 2 em https://v2.tauri.app antes de usar uma API.
3. UI e mensagens em português do Brasil, tema escuro, conforme §6.
4. Não escreva nada fora deste diretório.
5. Não pare no meio da tarefa para pedir permissão, não pergunte nada e não encerre com um plano ou promessas. Continue trabalhando até os 3 comandos do item 2 passarem.
6. Se `cargo build` do app completo (`npm run tauri build` ou `tauri dev`) for lento, NÃO é necessário gerar o instalador — mas o `cargo build` do `src-tauri` precisa passar.
7. Ao final, escreva `IMPLEMENTATION_LOG.md` com: arquivos criados/alterados, os comandos exatos que você rodou, a saída real (resumida) de cada um, e qualquer limitação conhecida. Termine sua resposta final com a frase `STATUS: COMPLETO` apenas se os 3 comandos passarem; caso contrário `STATUS: BLOQUEADO: <motivo>`.
