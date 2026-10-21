<#
    limpar-conhosts-orfaos.ps1

    Encerra hospedeiros ConPTY (conhost.exe) que ficaram órfãos e estão girando
    em 100% de CPU. Cada terminal do Canvas Terminal é um ConPTY; se o processo
    do app morrer de forma abrupta (Gerenciador de Tarefas, taskkill /F, crash)
    em um momento ruim, o conhost pode sobreviver sem cliente e entrar em laço
    de CPU, saturando a máquina — o sintoma é o app inteiro (e o Windows) ficar
    lento, com as letras demorando a aparecer no terminal.

    Filtros de segurança (todos precisam ser verdadeiros):
      1. o processo-pai do conhost não existe mais (está órfão);
      2. o conhost não possui janela visível (não é um console clássico que
         você esteja usando — ConPTY não tem janela);
      3. o conhost consumiu CPU de forma sustentada durante a amostragem.

    Uso:
        pwsh -NoProfile -ExecutionPolicy Bypass -File limpar-conhosts-orfaos.ps1 -Simular
        pwsh -NoProfile -ExecutionPolicy Bypass -File limpar-conhosts-orfaos.ps1

    -Simular apenas lista o que seria encerrado, sem tocar em nada.
#>
[CmdletBinding()]
param(
    [switch]$Simular,
    [double]$LimiteCpu = 30.0,   # % de um núcleo, sustentado
    [int]$AmostraSegundos = 3
)

$ErrorActionPreference = 'Stop'
$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors

# --- deteccao de janela visivel por PID (ConPTY nao tem janela) -------------
if (-not ('Janelas.Win32' -as [type])) {
    Add-Type -Namespace Janelas -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
'@
}

function TemJanelaVisivel([int]$pidAlvo) {
    $script:achou = $false
    $cb = [Janelas.Win32+EnumWindowsProc]{
        param($h, $l)
        $p = 0
        [void][Janelas.Win32]::GetWindowThreadProcessId($h, [ref]$p)
        if ($p -eq $pidAlvo -and [Janelas.Win32]::IsWindowVisible($h)) { $script:achou = $true; return $false }
        return $true
    }
    [void][Janelas.Win32]::EnumWindows($cb, [IntPtr]::Zero)
    return $script:achou
}

# --- retrato dos processos --------------------------------------------------
$todos = Get-CimInstance Win32_Process
$vivos = @{}
foreach ($p in $todos) { $vivos[[int]$p.ProcessId] = $p }

$conhosts = $todos | Where-Object { $_.Name -eq 'conhost.exe' }
$candidatos = @()
$ignorados = @()

foreach ($c in $conhosts) {
    $pid_ = [int]$c.ProcessId
    $pai = [int]$c.ParentProcessId
    if ($vivos[$pai]) { continue }                      # pai vivo: nao e orfao
    if (TemJanelaVisivel $pid_) {                       # console classico em uso
        $ignorados += "conhost $pid_ (tem janela visivel)"
        continue
    }
    $proc = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    $t0 = $proc.TotalProcessorTime.TotalMilliseconds
    Start-Sleep -Seconds $AmostraSegundos
    $proc2 = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
    if (-not $proc2) { continue }
    $pct = (($proc2.TotalProcessorTime.TotalMilliseconds - $t0) / ($AmostraSegundos * 1000.0)) * 100
    if ($pct -lt $LimiteCpu) { continue }               # orfao, mas parado: inofensivo

    # irmaos orfaos: mesmos spawner morto, nome de shell
    $irmaos = @($todos | Where-Object {
        [int]$_.ParentProcessId -eq $pai -and [int]$_.ProcessId -ne $pid_ -and
        $_.Name -match '^(pwsh|powershell|cmd|bash|wsl)\.exe$'
    })

    $candidatos += [pscustomobject]@{
        conhost = $pid_
        cpuPct  = [math]::Round($pct, 1)
        cpuSeg  = [math]::Round($proc2.CPU, 1)
        irmaos  = ($irmaos.ProcessId -join ',')
    }
}

foreach ($i in $ignorados) { "ignorado: $i" }

if (-not $candidatos) {
    "Nada a fazer: nenhum conhost orfao girando foi encontrado."
    return
}

"encontrados $($candidatos.Count) conhost(s) orfao(s) girando:"
$candidatos | Format-Table -AutoSize | Out-String -Width 140

if ($Simular) { "modo -Simular: nada foi encerrado."; return }

foreach ($c in $candidatos) {
    if ($c.irmaos) {
        foreach ($s in ($c.irmaos -split ', ')) {
            Stop-Process -Id ([int]$s) -Force -ErrorAction SilentlyContinue
            "  irmao orfao encerrado: $s"
        }
    }
    Stop-Process -Id $c.conhost -Force -ErrorAction SilentlyContinue
    "conhost $($c.conhost) encerrado (girava a $($c.cpuPct)% de um nucleo)"
}
"concluido."
