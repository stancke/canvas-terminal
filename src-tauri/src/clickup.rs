//! Plugin ClickUp: consulta a API REST v2 usando o token pessoal do usuário.
//!
//! O token é enviado somente para `api.clickup.com`; nada é armazenado aqui —
//! o frontend guarda o token no `localStorage` do próprio app (por plugin).
//!
//! Endpoints usados: `team`, `team/{id}/space`, `space/{id}/folder`,
//! `space/{id}/list`, `folder/{id}/list`, `list/{id}/task` e `task/{id}`.

use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;

const BASE: &str = "https://api.clickup.com/api/v2";

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> Result<&'static reqwest::Client, String> {
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let built = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .user_agent("CanvasTerminal/0.1")
        .build()
        .map_err(|err| format!("cliente HTTP: {err}"))?;
    let _ = CLIENT.set(built);
    CLIENT.get().ok_or_else(|| "cliente HTTP indisponível".to_string())
}

async fn get_json(path: &str, token: &str) -> Result<Value, String> {
    let url = reqwest::Url::parse(&format!("{BASE}{path}"))
        .map_err(|err| format!("URL inválida do ClickUp: {err}"))?;
    get_json_url(url, token).await
}

async fn get_json_url(url: reqwest::Url, token: &str) -> Result<Value, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Informe o token pessoal do ClickUp.".into());
    }

    let response = client()?
        .get(url)
        .header("Authorization", token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|err| format!("falha ao conectar no ClickUp: {err}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("resposta inválida do ClickUp: {err}"))?;

    let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    if !status.is_success() {
        let message = parsed
            .get("err")
            .and_then(Value::as_str)
            .or_else(|| parsed.get("ECODE").and_then(Value::as_str))
            .unwrap_or("erro desconhecido");
        return Err(match status.as_u16() {
            401 => format!("Token do ClickUp inválido ou expirado ({message})."),
            403 => format!("Sem permissão para acessar este recurso ({message})."),
            code => format!("ClickUp respondeu {code}: {message}"),
        });
    }
    Ok(parsed)
}

/* ---- Estruturas enviadas ao frontend ---- */

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Space {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub username: String,
    pub email: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub lists: Vec<ListRef>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRef {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub name: String,
    /// Cor em hexadecimal informada pelo ClickUp (`#87909e`).
    pub color: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub id: String,
    pub custom_id: Option<String>,
    pub name: String,
    pub status: Status,
    pub url: Option<String>,
    pub assignees: Vec<String>,
    pub due_date: Option<String>,
    pub updated: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub title: String,
    pub url: Option<String>,
    pub thumbnail: Option<String>,
    pub extension: Option<String>,
    pub mimetype: Option<String>,
    pub is_image: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetail {
    pub id: String,
    pub custom_id: Option<String>,
    pub name: String,
    pub status: Status,
    pub description: String,
    pub url: Option<String>,
    pub list_name: Option<String>,
    pub assignees: Vec<String>,
    pub tags: Vec<String>,
    pub due_date: Option<String>,
    pub created: Option<String>,
    pub attachments: Vec<Attachment>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub text: String,
    pub author: String,
    pub date: Option<String>,
    pub resolved: bool,
}

/* ---- Comandos ---- */

/// Workspaces (teams) visíveis para o token.
#[tauri::command]
pub async fn clickup_teams(token: String) -> Result<Vec<Team>, String> {
    let data = get_json("/team", &token).await?;
    Ok(array(&data, "teams")
        .iter()
        .filter_map(|item| {
            Some(Team {
                id: text(item, "id")?,
                name: text(item, "name").unwrap_or_else(|| "Workspace".into()),
            })
        })
        .collect())
}

/// Usuário dono do token (usado pelo filtro “atribuídas a mim”).
#[tauri::command]
pub async fn clickup_user(token: String) -> Result<User, String> {
    let data = get_json("/user", &token).await?;
    let user = data
        .get("user")
        .ok_or_else(|| "Usuário do ClickUp não encontrado.".to_string())?;
    Ok(User {
        id: text(user, "id").ok_or_else(|| "Usuário do ClickUp sem id.".to_string())?,
        username: text(user, "username")
            .or_else(|| text(user, "email"))
            .unwrap_or_else(|| "você".into()),
        email: text(user, "email"),
    })
}

#[tauri::command]
pub async fn clickup_spaces(token: String, team_id: String) -> Result<Vec<Space>, String> {
    let data = get_json(&format!("/team/{team_id}/space?archived=false"), &token).await?;
    Ok(array(&data, "spaces")
        .iter()
        .filter_map(|item| {
            Some(Space {
                id: text(item, "id")?,
                name: text(item, "name").unwrap_or_else(|| "Espaço".into()),
            })
        })
        .collect())
}

/// Pastas do espaço, já com as listas de cada uma.
#[tauri::command]
pub async fn clickup_folders(token: String, space_id: String) -> Result<Vec<Folder>, String> {
    let data = get_json(&format!("/space/{space_id}/folder?archived=false"), &token).await?;
    Ok(array(&data, "folders")
        .iter()
        .filter_map(|item| {
            Some(Folder {
                id: text(item, "id")?,
                name: text(item, "name").unwrap_or_else(|| "Pasta".into()),
                lists: parse_lists(item),
            })
        })
        .collect())
}

/// Listas soltas do espaço (fora de pastas) ou de uma pasta específica.
#[tauri::command]
pub async fn clickup_lists(
    token: String,
    space_id: String,
    folder_id: Option<String>,
) -> Result<Vec<ListRef>, String> {
    let path = match folder_id.filter(|id| !id.is_empty()) {
        Some(folder) => format!("/folder/{folder}/list?archived=false"),
        None => format!("/space/{space_id}/list?archived=false"),
    };
    let data = get_json(&path, &token).await?;
    Ok(parse_lists(&data))
}

/// Status configurados na lista (para os filtros do plugin).
#[tauri::command]
pub async fn clickup_list_statuses(token: String, list_id: String) -> Result<Vec<Status>, String> {
    let data = get_json(&format!("/list/{list_id}"), &token).await?;
    Ok(array(&data, "statuses")
        .iter()
        .map(parse_status)
        .collect())
}

/// Tarefas da lista (primeira página, ordenadas pelas mais recentes).
#[tauri::command]
pub async fn clickup_tasks(
    token: String,
    list_id: String,
    assignees: Vec<String>,
    statuses: Vec<String>,
) -> Result<Vec<TaskSummary>, String> {
    let mut url = reqwest::Url::parse(&format!("{BASE}/list/{list_id}/task"))
        .map_err(|err| format!("URL inválida do ClickUp: {err}"))?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("archived", "false")
            .append_pair("page", "0")
            .append_pair("order_by", "updated")
            .append_pair("reverse", "true")
            .append_pair("subtasks", "true")
            .append_pair("include_closed", "true");
        for assignee in assignees.iter().filter(|id| !id.trim().is_empty()) {
            query.append_pair("assignees[]", assignee);
        }
        for status in statuses.iter().filter(|name| !name.trim().is_empty()) {
            query.append_pair("statuses[]", status);
        }
    }

    let data = get_json_url(url, &token).await?;
    Ok(array(&data, "tasks")
        .iter()
        .filter_map(parse_summary)
        .collect())
}

/// Detalhes da tarefa: descrição, anexos, tags e responsáveis.
#[tauri::command]
pub async fn clickup_task(token: String, task_id: String) -> Result<TaskDetail, String> {
    let data = get_json(&format!("/task/{task_id}"), &token).await?;
    parse_detail(&data).ok_or_else(|| "Tarefa não encontrada.".to_string())
}

/// Comentários da tarefa, do mais antigo para o mais recente.
#[tauri::command]
pub async fn clickup_comments(token: String, task_id: String) -> Result<Vec<Comment>, String> {
    let data = get_json(&format!("/task/{task_id}/comment?start=0"), &token).await?;
    Ok(array(&data, "comments")
        .iter()
        .filter_map(parse_comment)
        .collect())
}

/* ---- Parsers ---- */

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn text(value: &Value, key: &str) -> Option<String> {
    match value.get(key) {
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text.clone()),
        Some(Value::Number(number)) => Some(number.to_string()),
        _ => None,
    }
}

fn timestamp(value: &Value, key: &str) -> Option<String> {
    match value.get(key) {
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        Some(Value::Number(number)) => Some(number.to_string()),
        _ => None,
    }
}

fn parse_status(value: &Value) -> Status {
    // Em tarefas o status é `{ "status": { "status": "...", ... } }`; na lista
    // de status do list ele vem direto: `{ "status": "...", "color": ... }`.
    let object = value
        .get("status")
        .filter(|candidate| candidate.is_object())
        .unwrap_or(value);
    let name = text(object, "status")
        .or_else(|| {
            value
                .get("status")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "sem status".into());
    Status {
        name,
        color: text(object, "color"),
        kind: text(object, "type"),
    }
}

fn parse_assignees(value: &Value) -> Vec<String> {
    value
        .get("assignees")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|user| text(user, "username").or_else(|| text(user, "email")))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_summary(value: &Value) -> Option<TaskSummary> {
    let id = text(value, "id")?;
    Some(TaskSummary {
        id,
        custom_id: text(value, "custom_id"),
        name: text(value, "name").unwrap_or_else(|| "(sem nome)".into()),
        status: parse_status(value),
        url: text(value, "url"),
        assignees: parse_assignees(value),
        due_date: timestamp(value, "due_date"),
        updated: timestamp(value, "date_updated"),
    })
}

fn parse_comment(value: &Value) -> Option<Comment> {
    let id = text(value, "id")?;
    let author = value
        .get("user")
        .and_then(|user| text(user, "username").or_else(|| text(user, "email")))
        .unwrap_or_else(|| "Alguém".into());
    let text = text(value, "comment_text")
        .or_else(|| {
            value
                .get("comment")
                .and_then(Value::as_array)
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter_map(|block| text(block, "text"))
                        .collect::<Vec<_>>()
                        .join("")
                })
        })
        .unwrap_or_default();
    Some(Comment {
        id,
        text,
        author,
        date: timestamp(value, "date"),
        resolved: value
            .get("resolved")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn parse_lists(value: &Value) -> Vec<ListRef> {
    array(value, "lists")
        .iter()
        .filter_map(|item| {
            Some(ListRef {
                id: text(item, "id")?,
                name: text(item, "name").unwrap_or_else(|| "Lista".into()),
            })
        })
        .collect()
}

fn parse_attachments(value: &Value) -> Vec<Attachment> {
    array(value, "attachments")
        .iter()
        .filter_map(|item| {
            let extension = text(item, "extension").map(|ext| ext.to_lowercase());
            let mimetype = text(item, "mimetype");
            let is_image = mimetype
                .as_deref()
                .map(|mime| mime.starts_with("image/"))
                .unwrap_or(false)
                || extension
                    .as_deref()
                    .map(is_image_extension)
                    .unwrap_or(false);
            Some(Attachment {
                id: text(item, "id").unwrap_or_default(),
                title: text(item, "title").unwrap_or_else(|| "anexo".into()),
                url: text(item, "url"),
                thumbnail: text(item, "thumbnail_small").or_else(|| text(item, "thumbnail_large")),
                extension,
                mimetype,
                is_image,
            })
        })
        .collect()
}

fn is_image_extension(extension: &str) -> bool {
    matches!(
        extension,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif" | "heic"
    )
}

fn parse_detail(value: &Value) -> Option<TaskDetail> {
    let id = text(value, "id")?;
    let description = text(value, "markdown_description")
        .or_else(|| text(value, "description"))
        .or_else(|| text(value, "text_content"))
        .unwrap_or_default();

    let tags = value
        .get("tags")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|tag| text(tag, "name"))
                .collect()
        })
        .unwrap_or_default();

    Some(TaskDetail {
        id,
        custom_id: text(value, "custom_id"),
        name: text(value, "name").unwrap_or_else(|| "(sem nome)".into()),
        status: parse_status(value),
        description,
        url: text(value, "url"),
        list_name: value
            .get("list")
            .and_then(|list| text(list, "name"))
            .or_else(|| text(value, "list_name")),
        assignees: parse_assignees(value),
        tags,
        due_date: timestamp(value, "due_date"),
        created: timestamp(value, "date_created"),
        attachments: parse_attachments(value),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TASK_JSON: &str = r##"{
        "id": "86a1b2c3d",
        "custom_id": "DEV-142",
        "name": "Corrigir login do painel",
        "status": { "status": "em andamento", "color": "#4ea1ff", "type": "custom" },
        "markdown_description": "Descrição **curta**\n\n![print](https://cdn.example/img.png)",
        "url": "https://app.clickup.com/t/86a1b2c3d",
        "list": { "name": "Sprint 42" },
        "assignees": [ { "username": "ana" }, { "email": "bruno@example.com" } ],
        "tags": [ { "name": "bug" }, { "name": "front" } ],
        "due_date": "1792000000000",
        "date_created": "1791000000000",
        "attachments": [
            {
                "id": "att1",
                "title": "erro.png",
                "extension": "png",
                "mimetype": "image/png",
                "url": "https://cdn.example/erro.png",
                "thumbnail_small": "https://cdn.example/erro-thumb.png"
            },
            {
                "id": "att2",
                "title": "log.txt",
                "extension": "txt",
                "mimetype": "text/plain",
                "url": "https://cdn.example/log.txt"
            }
        ]
    }"##;

    #[test]
    fn le_resumo_da_tarefa() {
        let value: Value = serde_json::from_str(TASK_JSON).expect("json válido");
        let summary = parse_summary(&value).expect("resumo");
        assert_eq!(summary.id, "86a1b2c3d");
        assert_eq!(summary.custom_id.as_deref(), Some("DEV-142"));
        assert_eq!(summary.status.name, "em andamento");
        assert_eq!(summary.status.color.as_deref(), Some("#4ea1ff"));
        assert_eq!(summary.assignees, vec!["ana", "bruno@example.com"]);
    }

    #[test]
    fn le_detalhe_com_anexos() {
        let value: Value = serde_json::from_str(TASK_JSON).expect("json válido");
        let detail = parse_detail(&value).expect("detalhe");
        assert_eq!(detail.list_name.as_deref(), Some("Sprint 42"));
        assert_eq!(detail.tags, vec!["bug", "front"]);
        assert_eq!(detail.attachments.len(), 2);
        assert!(detail.attachments[0].is_image);
        assert!(!detail.attachments[1].is_image);
        assert!(detail.description.contains("**curta**"));
        assert_eq!(detail.created.as_deref(), Some("1791000000000"));
    }

    #[test]
    fn tolera_status_em_texto_simples() {
        let value: Value = serde_json::json!({
            "id": "1",
            "name": "Sem objeto de status",
            "status": "done"
        });
        let summary = parse_summary(&value).expect("resumo");
        assert_eq!(summary.status.name, "done");
        assert!(summary.status.color.is_none());
    }

    #[test]
    fn le_status_da_definicao_da_lista() {
        let value: Value = serde_json::json!({
            "status": "em andamento",
            "color": "#ee5e99",
            "type": "custom"
        });
        let status = parse_status(&value);
        assert_eq!(status.name, "em andamento");
        assert_eq!(status.color.as_deref(), Some("#ee5e99"));
        assert_eq!(status.kind.as_deref(), Some("custom"));
    }

    #[test]
    fn reconhece_extensoes_de_imagem() {
        assert!(is_image_extension("png"));
        assert!(is_image_extension("jpeg"));
        assert!(!is_image_extension("pdf"));
        assert!(!is_image_extension("zip"));
    }
}
