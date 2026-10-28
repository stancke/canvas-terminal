//! Plugin "Uso de tokens": agrega o consumo local dos agentes instalados
//! (Claude Code e OpenCode) em janelas de 5 horas e de 7 dias.
//!
//! Tudo é lido dos arquivos do próprio usuário — nada sai da máquina:
//!
//! - **Claude Code**: `~/.claude/projects/**/*.jsonl`, campo `message.usage`
//!   de cada mensagem do assistente.
//! - **OpenCode**: `~/.local/share/opencode/storage/message/**/*.json`, campo
//!   `tokens` das mensagens do assistente.
//!
//! Os arquivos são cacheados por (mtime, tamanho) para que o painel possa ser
//! atualizado a cada poucos segundos sem reler transcrições inteiras.

use serde::Serialize;
use serde_json::Value;
use rusqlite::{Connection, OpenFlags};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Janela de sessão do Claude Code (renovada a cada 5 horas de uso).
const FIVE_HOURS_MS: i64 = 5 * 60 * 60 * 1000;
/// Janela semanal.
const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Folga para relógios levemente adiantados.
const FUTURE_TOLERANCE_MS: i64 = 5 * 60 * 1000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Tokens {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    reasoning: u64,
}

impl Tokens {
    /// Tokens "novos" — tudo menos o cache lido.
    ///
    /// O `cache_read` é a releitura do mesmo contexto a cada turno: ele domina
    /// o volume bruto (costuma passar de 95% do total) e não acompanha o
    /// consumo real da janela. Somá-lo ao total fazia o painel crescer muito
    /// mais rápido que o medidor oficial de limites.
    fn total(&self) -> u64 {
        self.input + self.output + self.cache_write + self.reasoning
    }

    fn processed(&self) -> u64 {
        self.total() + self.cache_read
    }

    fn is_empty(&self) -> bool {
        self.processed() == 0
    }
}

/// Uma mensagem do assistente já normalizada (timestamp + tokens).
#[derive(Clone, Debug)]
struct Entry {
    at: i64,
    tokens: Tokens,
    /// Id da mensagem: evita contar duas vezes sessões retomadas/duplicadas.
    id: Option<String>,
}

/// Arquivos já lidos, com a assinatura usada para invalidar o cache.
type FileCache = HashMap<PathBuf, (u64, u64, Vec<Entry>)>;

static CACHE: OnceLock<Mutex<FileCache>> = OnceLock::new();

fn cache() -> &'static Mutex<FileCache> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/* ---- Estruturas enviadas ao frontend ---- */

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowUsage {
    /// Soma dos tokens novos: entrada, saída, cache escrito e raciocínio.
    /// O cache lido fica de fora (vai em [`WindowUsage::cache_read`]).
    pub total: u64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub reasoning: u64,
    /// Quantidade de mensagens do assistente na janela.
    pub messages: u64,
    /// Quando a janela se libera por completo (epoch em ms).
    pub resets_at: Option<i64>,
}

impl WindowUsage {
    fn add(&mut self, tokens: &Tokens) {
        self.total += tokens.total();
        self.input += tokens.input;
        self.output += tokens.output;
        self.cache_read += tokens.cache_read;
        self.cache_write += tokens.cache_write;
        self.reasoning += tokens.reasoning;
        self.messages += 1;
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub id: String,
    pub name: String,
    /// `true` quando os dados locais do agente foram encontrados.
    pub installed: bool,
    pub five_hours: WindowUsage,
    pub week: WindowUsage,
    /// Última mensagem vista (epoch em ms).
    pub last_activity: Option<i64>,
    /// Caminhos lidos (útil para diagnóstico no tooltip).
    pub sources: Vec<String>,
    /// Problemas parciais (ex.: banco ocupado), sem impedir a leitura do resto.
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub generated_at: i64,
    pub agents: Vec<AgentUsage>,
}

/* ---- Comando exposto ao frontend ---- */

/// Relatório de consumo dos agentes instalados nesta máquina.
#[tauri::command]
pub async fn usage_report() -> Result<UsageReport, String> {
    tauri::async_runtime::spawn_blocking(collect_report)
        .await
        .map_err(|err| format!("falha ao ler o uso de tokens: {err}"))
}

fn collect_report() -> UsageReport {
    let now = now_ms();
    UsageReport {
        generated_at: now,
        agents: vec![collect_claude(now), collect_opencode(now)],
    }
}

/* ---- Claude Code ---- */

fn collect_claude(now: i64) -> AgentUsage {
    let mut sources = Vec::new();
    let mut files = Vec::new();
    let mut installed = false;

    for dir in claude_project_dirs() {
        installed = true;
        collect_files(&dir, "jsonl", &mut files);
        sources.push(dir.display().to_string());
    }

    let mut entries = read_files(&files, parse_claude_file);

    entries.retain(|entry| entry.at <= now + FUTURE_TOLERANCE_MS);
    entries.sort_by_key(|entry| entry.at);

    let unique = unique_entries(&entries, now);
    let session = session_window(&unique, now);
    let week = weekly_window(now, claude_weekly_reset());

    let (five_hours, week, last_activity) = summarize(&unique, now, session, week);

    AgentUsage {
        id: "claude".into(),
        name: "Claude Code".into(),
        installed,
        five_hours,
        week,
        last_activity,
        sources,
        warnings: Vec::new(),
        error: None,
    }
}

fn claude_project_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(config) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        dirs.push(PathBuf::from(config).join("projects"));
    }
    if let Some(home) = home_dir() {
        dirs.push(home.join(".claude").join("projects"));
    }
    dedupe_existing(dirs)
}

/// `~/.claude.json` guarda a última utilização conhecida das janelas oficiais.
///
/// Só usamos o horário de reset semanal: ele é fixo por conta e continua
/// válido mesmo quando o cache está velho (basta rolar em passos de 7 dias).
fn claude_config_files() -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Some(config) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        files.push(PathBuf::from(config).join(".claude.json"));
    }
    if let Some(home) = home_dir() {
        files.push(home.join(".claude.json"));
    }
    files.retain(|path| path.is_file());
    files
}

fn claude_weekly_reset() -> Option<i64> {
    for path in claude_config_files() {
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&content) else {
            continue;
        };
        let reset = value
            .pointer("/cachedUsageUtilization/utilization/seven_day/resets_at")
            .and_then(Value::as_str)
            .and_then(parse_rfc3339_ms);
        if reset.is_some() {
            return reset;
        }
    }
    None
}

/// Cada linha do `.jsonl` é um evento; só interessam as respostas do modelo.
fn parse_claude_file(content: &str) -> Vec<Entry> {
    let mut entries = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || !line.contains("\"usage\"") {
            continue;
        }
        if let Some(entry) = parse_claude_line(line) {
            entries.push(entry);
        }
    }
    entries
}

fn parse_claude_line(line: &str) -> Option<Entry> {
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let at = parse_rfc3339_ms(value.get("timestamp")?.as_str()?)?;
    let message = value.get("message")?;
    let usage = message.get("usage")?;

    let tokens = Tokens {
        input: number(usage, "input_tokens"),
        output: number(usage, "output_tokens"),
        cache_write: number(usage, "cache_creation_input_tokens"),
        cache_read: number(usage, "cache_read_input_tokens"),
        reasoning: 0,
    };

    Some(Entry {
        at,
        tokens,
        id: message
            .get("id")
            .and_then(Value::as_str)
            .map(|id| format!("claude:{id}")),
    })
}

/* ---- OpenCode ---- */

fn collect_opencode(now: i64) -> AgentUsage {
    let mut sources = Vec::new();
    let mut warnings = Vec::new();
    let mut entries = Vec::new();
    let mut installed = false;

    // Formato antigo: uma mensagem por arquivo JSON.
    for dir in opencode_message_dirs() {
        installed = true;
        let mut files = Vec::new();
        collect_files(&dir, "json", &mut files);
        sources.push(dir.display().to_string());
        entries.extend(read_files(&files, parse_opencode_file));
    }

    // Formato atual: banco SQLite (`opencode.db`).
    for db in opencode_db_paths() {
        installed = true;
        sources.push(db.display().to_string());
        entries.extend(read_opencode_db(&db, now, &mut warnings));
    }

    entries.retain(|entry| entry.at <= now + FUTURE_TOLERANCE_MS);
    entries.sort_by_key(|entry| entry.at);

    let unique = unique_entries(&entries, now);
    // O OpenCode não expõe janelas oficiais: mantém o recorte móvel.
    let session = rolling_window(now, FIVE_HOURS_MS);
    let week = rolling_window(now, WEEK_MS);

    let (five_hours, week, last_activity) = summarize(&unique, now, session, week);

    AgentUsage {
        id: "opencode".into(),
        name: "OpenCode".into(),
        installed,
        five_hours,
        week,
        last_activity,
        sources,
        warnings,
        error: None,
    }
}

fn opencode_message_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(data) = std::env::var_os("XDG_DATA_HOME") {
        dirs.push(PathBuf::from(data).join("opencode/storage/message"));
    }
    if let Some(home) = home_dir() {
        dirs.push(home.join(".local/share/opencode/storage/message"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join("opencode/storage/message"));
    }
    dedupe_existing(dirs)
}

fn opencode_db_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(data) = std::env::var_os("XDG_DATA_HOME") {
        paths.push(PathBuf::from(data).join("opencode/opencode.db"));
    }
    if let Some(home) = home_dir() {
        paths.push(home.join(".local/share/opencode/opencode.db"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        paths.push(PathBuf::from(local).join("opencode/opencode.db"));
    }
    paths.retain(|path| path.is_file());
    paths
}

/// Cada arquivo é uma mensagem completa; só as do assistente têm `tokens`.
fn parse_opencode_file(content: &str) -> Vec<Entry> {
    let Ok(value) = serde_json::from_str::<Value>(content) else {
        return Vec::new();
    };
    if value.get("role").and_then(Value::as_str) != Some("assistant") {
        return Vec::new();
    }
    let Some(at) = value
        .pointer("/time/created")
        .and_then(Value::as_i64)
        .filter(|ms| *ms > 0)
    else {
        return Vec::new();
    };
    let Some(tokens) = value.get("tokens") else {
        return Vec::new();
    };

    let parsed = Tokens {
        input: number(tokens, "input"),
        output: number(tokens, "output"),
        cache_read: tokens
            .pointer("/cache/read")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_write: tokens
            .pointer("/cache/write")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        reasoning: number(tokens, "reasoning"),
    };
    if parsed.is_empty() {
        return Vec::new();
    }

    vec![Entry {
        at,
        tokens: parsed,
        id: value
            .get("id")
            .and_then(Value::as_str)
            .map(|id| format!("opencode:{id}")),
    }]
}

/* ---- OpenCode: banco SQLite ---- */

/// Versões recentes do OpenCode gravam as mensagens em `session_message`
/// (schema novo) ou `message` (schema antigo); ambas guardam o JSON em `data`.
const SQL_SESSION_MESSAGE: &str = "\
    SELECT id, time_created, \
           json_extract(data, '$.tokens.input'), \
           json_extract(data, '$.tokens.output'), \
           json_extract(data, '$.tokens.reasoning'), \
           json_extract(data, '$.tokens.cache.read'), \
           json_extract(data, '$.tokens.cache.write') \
      FROM session_message \
     WHERE type = 'assistant' AND time_created >= ?1";

const SQL_MESSAGE: &str = "\
    SELECT id, time_created, \
           json_extract(data, '$.tokens.input'), \
           json_extract(data, '$.tokens.output'), \
           json_extract(data, '$.tokens.reasoning'), \
           json_extract(data, '$.tokens.cache.read'), \
           json_extract(data, '$.tokens.cache.write') \
      FROM message \
     WHERE json_extract(data, '$.role') = 'assistant' AND time_created >= ?1";

fn read_opencode_db(path: &Path, now: i64, warnings: &mut Vec<String>) -> Vec<Entry> {
    let conn = match Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(conn) => conn,
        Err(err) => {
            warnings.push(format!("banco do OpenCode indisponível: {err}"));
            return Vec::new();
        }
    };

    // O banco pode estar em uso pelo OpenCode: espera um pouco em vez de falhar.
    let _ = conn.busy_timeout(std::time::Duration::from_millis(400));

    let tables = table_names(&conn);
    let since = now - WEEK_MS - FUTURE_TOLERANCE_MS;
    let mut entries = Vec::new();

    if tables.contains("session_message") {
        match query_usage(&conn, SQL_SESSION_MESSAGE, since) {
            Ok(mut found) => entries.append(&mut found),
            Err(err) => warnings.push(format!("tabela session_message: {err}")),
        }
    }
    if tables.contains("message") {
        match query_usage(&conn, SQL_MESSAGE, since) {
            Ok(mut found) => entries.append(&mut found),
            Err(err) => warnings.push(format!("tabela message: {err}")),
        }
    }

    entries
}

fn table_names(conn: &Connection) -> HashSet<String> {
    let mut names = HashSet::new();
    let Ok(mut statement) = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    else {
        return names;
    };
    if let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) {
        for name in rows.flatten() {
            names.insert(name);
        }
    }
    names
}

fn query_usage(conn: &Connection, sql: &str, since: i64) -> rusqlite::Result<Vec<Entry>> {
    let mut statement = conn.prepare(sql)?;
    let rows = statement.query_map([since], |row| {
        Ok(Entry {
            id: row
                .get::<_, Option<String>>(0)?
                .map(|id| format!("opencode:{id}")),
            at: normalize_ms(row.get::<_, i64>(1)?),
            tokens: Tokens {
                input: non_negative(row.get::<_, Option<i64>>(2)?),
                output: non_negative(row.get::<_, Option<i64>>(3)?),
                reasoning: non_negative(row.get::<_, Option<i64>>(4)?),
                cache_read: non_negative(row.get::<_, Option<i64>>(5)?),
                cache_write: non_negative(row.get::<_, Option<i64>>(6)?),
            },
        })
    })?;

    Ok(rows
        .flatten()
        .filter(|entry| entry.at > 0 && !entry.tokens.is_empty())
        .collect())
}

/// Aceita timestamps em segundos (versões antigas) ou milissegundos.
fn normalize_ms(value: i64) -> i64 {
    if value > 0 && value < 100_000_000_000 {
        value * 1_000
    } else {
        value
    }
}

fn non_negative(value: Option<i64>) -> u64 {
    value.filter(|number| *number > 0).unwrap_or(0) as u64
}

/* ---- Agregação ---- */

/// Intervalo de apuração de uma janela.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Span {
    start: i64,
    /// `None` para janela móvel (o reset é calculado pela mensagem mais antiga).
    end: Option<i64>,
    length: i64,
}

impl Span {
    fn rolling(now: i64, length: i64) -> Self {
        Self {
            start: now - length,
            end: None,
            length,
        }
    }

    fn fixed(start: i64, end: i64, length: i64) -> Self {
        Self {
            start,
            end: Some(end),
            length,
        }
    }
}

/// Remove mensagens repetidas (sessões retomadas) e o que já saiu da semana.
fn unique_entries<'a>(entries: &'a [Entry], now: i64) -> Vec<&'a Entry> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut unique: Vec<&Entry> = Vec::with_capacity(entries.len());

    for entry in entries {
        if entry.at < now - WEEK_MS - FUTURE_TOLERANCE_MS {
            continue;
        }
        if let Some(id) = entry.id.as_deref() {
            if !seen.insert(id) {
                continue;
            }
        }
        unique.push(entry);
    }
    unique
}

/// Janela de sessão do Claude Code: bloco fixo de 5 h que começa na primeira
/// mensagem depois do bloco anterior. É assim que o servidor conta a janela —
/// um recorte móvel de 5 h nunca bate com o reset mostrado no `/usage`.
fn session_window(entries: &[&Entry], now: i64) -> Span {
    let mut block_start: Option<i64> = None;

    for entry in entries {
        if entry.at > now {
            break;
        }
        match block_start {
            None => block_start = Some(entry.at),
            Some(start) if entry.at >= start + FIVE_HOURS_MS => block_start = Some(entry.at),
            _ => {}
        }
    }

    match block_start {
        Some(start) if now < start + FIVE_HOURS_MS => {
            Span::fixed(start, start + FIVE_HOURS_MS, FIVE_HOURS_MS)
        }
        // Sem sessão em andamento: a janela de 5 h está zerada.
        _ => Span::rolling(now, FIVE_HOURS_MS),
    }
}

/// Janela semanal oficial. O reset é fixo por conta; quando o horário é
/// conhecido (cache do `~/.claude.json`), rolamos em passos de 7 dias até
/// envolver o instante atual. Sem ele, cai no recorte móvel de 7 dias.
fn weekly_window(now: i64, official_reset: Option<i64>) -> Span {
    if let Some(mut end) = official_reset {
        while end <= now {
            end += WEEK_MS;
        }
        while end - WEEK_MS > now {
            end -= WEEK_MS;
        }
        if end - WEEK_MS <= now && now < end {
            return Span::fixed(end - WEEK_MS, end, WEEK_MS);
        }
    }
    Span::rolling(now, WEEK_MS)
}

fn rolling_window(now: i64, length: i64) -> Span {
    Span::rolling(now, length)
}

/// Totais por janela (5 h e semana) e timestamp da última atividade.
fn summarize(
    entries: &[&Entry],
    now: i64,
    session: Span,
    week: Span,
) -> (WindowUsage, WindowUsage, Option<i64>) {
    let five_hours = window_usage(entries, &session);
    let week_usage = window_usage(entries, &week);
    let last_activity = entries
        .iter()
        .map(|entry| entry.at)
        .filter(|at| *at <= now + FUTURE_TOLERANCE_MS)
        .max();

    (five_hours, week_usage, last_activity)
}

fn window_usage(entries: &[&Entry], span: &Span) -> WindowUsage {
    let mut usage = WindowUsage::default();
    let mut oldest = i64::MAX;

    for entry in entries {
        if entry.at < span.start {
            continue;
        }
        if span.end.is_some_and(|end| entry.at >= end) {
            continue;
        }
        usage.add(&entry.tokens);
        oldest = oldest.min(entry.at);
    }

    if usage.messages > 0 {
        usage.resets_at = span
            .end
            // Janela móvel: só fica livre quando a mensagem mais antiga sai.
            .or_else(|| (oldest != i64::MAX).then(|| oldest + span.length));
    }
    usage
}

/* ---- Leitura de arquivos com cache ---- */

fn read_files(files: &[PathBuf], parse: fn(&str) -> Vec<Entry>) -> Vec<Entry> {
    let mut entries = Vec::new();
    for path in files {
        entries.extend(read_cached(path, parse));
    }
    entries
}

fn read_cached(path: &Path, parse: fn(&str) -> Vec<Entry>) -> Vec<Entry> {
    let Ok(meta) = fs::metadata(path) else {
        return Vec::new();
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let len = meta.len();

    if let Ok(guard) = cache().lock() {
        if let Some((cached_mtime, cached_len, entries)) = guard.get(path) {
            if *cached_mtime == mtime && *cached_len == len {
                return entries.clone();
            }
        }
    }

    let content = fs::read_to_string(path).unwrap_or_default();
    let entries = parse(&content);

    if let Ok(mut guard) = cache().lock() {
        guard.insert(path.to_path_buf(), (mtime, len, entries.clone()));
    }
    entries
}

fn collect_files(dir: &Path, extension: &str, out: &mut Vec<PathBuf>) {
    let Ok(read) = fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, extension, out);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some(extension) {
            out.push(path);
        }
    }
}

fn dedupe_existing(dirs: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        let key = dir.display().to_string().to_lowercase();
        if seen.insert(key) {
            result.push(dir);
        }
    }
    result
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/* ---- Utilitários ---- */

fn number(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Converte o `timestamp` RFC 3339 do Claude Code em epoch ms.
fn parse_rfc3339_ms(text: &str) -> Option<i64> {
    if text.len() < 19 {
        return None;
    }
    let year: i64 = text.get(0..4)?.parse().ok()?;
    let month: u32 = text.get(5..7)?.parse().ok()?;
    let day: u32 = text.get(8..10)?.parse().ok()?;
    let hour: i64 = text.get(11..13)?.parse().ok()?;
    let minute: i64 = text.get(14..16)?.parse().ok()?;
    let second: i64 = text.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let bytes = text.as_bytes();
    let mut index = 19;
    let mut millis: i64 = 0;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        let mut fraction = text[start..index].to_string();
        while fraction.len() < 3 {
            fraction.push('0');
        }
        millis = fraction[..3].parse().unwrap_or(0);
    }

    let rest = text.get(index..).unwrap_or("");
    let mut offset_minutes: i64 = 0;
    if rest.starts_with('+') || rest.starts_with('-') {
        let sign: i64 = if rest.starts_with('-') { -1 } else { 1 };
        let offset_hours: i64 = rest.get(1..3)?.parse().ok()?;
        let offset_mins: i64 = rest.get(4..6)?.parse().ok()?;
        offset_minutes = sign * (offset_hours * 60 + offset_mins);
    }

    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1_000 + millis)
}

/// Dias desde 1970-01-01 (algoritmo civil_from_days de Howard Hinnant).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = month as i64;
    let day_of_year =
        (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day as i64 - 1;
    let day_of_era =
        year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converte_timestamp_iso_em_ms() {
        // 2026-10-21T03:32:44.030Z
        assert_eq!(parse_rfc3339_ms("2026-10-21T03:32:44.030Z"), Some(1_792_553_564_030));
        // Sem fração e com offset.
        assert_eq!(
            parse_rfc3339_ms("1970-01-01T00:00:00Z"),
            Some(0)
        );
        assert_eq!(
            parse_rfc3339_ms("1970-01-01T01:00:00+01:00"),
            Some(0)
        );
    }

    #[test]
    fn le_linha_do_claude_code() {
        let line = r#"{"type":"assistant","timestamp":"2026-10-21T03:32:44.030Z","message":{"id":"msg_1","role":"assistant","usage":{"input_tokens":120,"output_tokens":30,"cache_creation_input_tokens":40,"cache_read_input_tokens":50}}}"#;
        let entry = parse_claude_line(line).expect("linha deveria ser interpretada");
        assert_eq!(entry.tokens.input, 120);
        assert_eq!(entry.tokens.output, 30);
        assert_eq!(entry.tokens.cache_write, 40);
        assert_eq!(entry.tokens.cache_read, 50);
        // O cache lido não entra no total "novo", mas continua sendo processado.
        assert_eq!(entry.tokens.total(), 190);
        assert_eq!(entry.tokens.processed(), 240);
        assert_eq!(entry.id.as_deref(), Some("claude:msg_1"));
    }

    #[test]
    fn ignora_linhas_que_nao_sao_do_assistente() {
        let line = r#"{"type":"user","timestamp":"2026-10-21T03:32:44.030Z","message":{"usage":{}}}"#;
        assert!(parse_claude_line(line).is_none());
    }

    #[test]
    fn le_mensagem_do_opencode() {
        let content = r#"{
          "id": "msg_2",
          "role": "assistant",
          "time": { "created": 1771099301577 },
          "tokens": {
            "input": 1104,
            "output": 235,
            "reasoning": 27,
            "cache": { "read": 13966, "write": 0 }
          }
        }"#;
        let entries = parse_opencode_file(content);
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.at, 1_771_099_301_577);
        assert_eq!(entry.tokens.total(), 1_366);
        assert_eq!(entry.tokens.processed(), 15_332);
        assert_eq!(entry.id.as_deref(), Some("opencode:msg_2"));
    }

    #[test]
    fn soma_janelas_de_cinco_horas_e_semana() {
        let now = 1_000_000_000_000;
        let entries = vec![
            Entry {
                at: now - 60 * 60 * 1000,
                tokens: Tokens {
                    input: 100,
                    output: 50,
                    ..Tokens::default()
                },
                id: None,
            },
            Entry {
                at: now - 6 * 60 * 60 * 1000,
                tokens: Tokens {
                    input: 7,
                    output: 3,
                    ..Tokens::default()
                },
                id: None,
            },
            Entry {
                at: now - 8 * 24 * 60 * 60 * 1000,
                tokens: Tokens {
                    input: 999,
                    output: 1,
                    ..Tokens::default()
                },
                id: None,
            },
        ];

        let unique = unique_entries(&entries, now);
        let (five_hours, week, last) = summarize(
            &unique,
            now,
            session_window(&unique, now),
            rolling_window(now, WEEK_MS),
        );
        assert_eq!(five_hours.total, 150);
        assert_eq!(five_hours.messages, 1);
        assert_eq!(week.total, 160);
        assert_eq!(week.messages, 2);
        assert_eq!(last, Some(now - 60 * 60 * 1000));
    }

    #[test]
    fn sessao_de_cinco_horas_comeca_na_primeira_mensagem_do_bloco() {
        let now = 1_000_000_000_000;
        let tokens = Tokens {
            input: 10,
            ..Tokens::default()
        };
        let first = Entry {
            at: now - 9 * 60 * 60 * 1000,
            tokens: tokens.clone(),
            id: Some("a".into()),
        };
        let start = Entry {
            at: now - 4 * 60 * 60 * 1000,
            tokens: tokens.clone(),
            id: Some("b".into()),
        };
        let same_block = Entry {
            at: now - 3 * 60 * 60 * 1000,
            tokens,
            id: Some("c".into()),
        };

        let entries = vec![first, start.clone(), same_block];
        let refs: Vec<&Entry> = entries.iter().collect();
        let span = session_window(&refs, now);
        assert_eq!(span.start, start.at);
        assert_eq!(span.end, Some(start.at + FIVE_HOURS_MS));

        let five_hours = window_usage(&refs, &span);
        assert_eq!(five_hours.messages, 2);
        assert_eq!(five_hours.total, 20);
        assert_eq!(five_hours.resets_at, Some(start.at + FIVE_HOURS_MS));
    }

    #[test]
    fn sessao_encerrada_deixa_a_janela_de_cinco_horas_zerada() {
        let now = 1_000_000_000_000;
        let entry = Entry {
            at: now - 7 * 60 * 60 * 1000,
            tokens: Tokens {
                input: 10,
                ..Tokens::default()
            },
            id: None,
        };
        let refs = vec![&entry];
        let five_hours = window_usage(&refs, &session_window(&refs, now));
        assert_eq!(five_hours.total, 0);
        assert_eq!(five_hours.resets_at, None);
    }

    #[test]
    fn semana_usa_o_reset_oficial_rolado_em_passos_de_sete_dias() {
        let now = 1_000_000_000_000;
        let reset = now + 2 * 24 * 60 * 60 * 1000;
        let span = weekly_window(now, Some(reset));
        assert_eq!(span.end, Some(reset));
        assert_eq!(span.start, reset - WEEK_MS);

        // Cache de dias atrás: a âncora continua válida rolando para frente.
        let old_reset = now - 2 * 24 * 60 * 60 * 1000;
        let span = weekly_window(now, Some(old_reset));
        assert_eq!(span.end, Some(old_reset + WEEK_MS));
        assert_eq!(span.start, old_reset + WEEK_MS - WEEK_MS);

        // Sem horário oficial, cai no recorte móvel.
        let span = weekly_window(now, None);
        assert_eq!(span.end, None);
        assert_eq!(span.start, now - WEEK_MS);
    }

    #[test]
    fn le_uso_do_banco_do_opencode() {
        let conn = Connection::open_in_memory().expect("banco em memória");
        conn.execute_batch(
            r#"
            CREATE TABLE session_message (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            INSERT INTO session_message VALUES
                ('msg_1', 'assistant', 1792720072740,
                 '{"tokens":{"input":10,"output":5,"reasoning":1,"cache":{"read":100,"write":2}}}');
            INSERT INTO session_message VALUES
                ('msg_2', 'user', 1792720072741, '{}');
            INSERT INTO session_message VALUES
                ('msg_3', 'assistant', 1792720072742,
                 '{"tokens":{"input":0,"output":0}}');
            "#,
        )
        .expect("schema de teste");

        let entries = query_usage(&conn, SQL_SESSION_MESSAGE, 0).expect("consulta");
        assert_eq!(entries.len(), 1, "só mensagens com tokens contam");
        assert_eq!(entries[0].tokens.total(), 18);
        assert_eq!(entries[0].tokens.processed(), 118);
        assert_eq!(entries[0].tokens.cache_read, 100);
        assert_eq!(entries[0].id.as_deref(), Some("opencode:msg_1"));
    }

    #[test]
    fn aceita_timestamp_em_segundos() {
        assert_eq!(normalize_ms(1_792_720_072), 1_792_720_072_000);
        assert_eq!(normalize_ms(1_792_720_072_000), 1_792_720_072_000);
    }

    #[test]
    #[ignore = "depende dos dados locais da máquina"]
    fn dump_relatorio_local() {
        println!("{:#?}", collect_report());
    }

    #[test]
    fn conta_mensagem_repetida_uma_unica_vez() {
        let now = 1_000_000_000_000;
        let entry = Entry {
            at: now - 1_000,
            tokens: Tokens {
                input: 10,
                output: 5,
                ..Tokens::default()
            },
            id: Some("claude:msg_repetida".into()),
        };
        let entries = vec![entry.clone(), entry];
        let unique = unique_entries(&entries, now);
        let (five_hours, _, _) = summarize(
            &unique,
            now,
            session_window(&unique, now),
            rolling_window(now, WEEK_MS),
        );
        assert_eq!(five_hours.total, 15);
        assert_eq!(five_hours.messages, 1);
    }
}
