use anyhow::{Context, Result};
use lsp_server::{Connection, Message, Notification, Request, Response};
use lsp_types::notification::Notification as LspNotification;
use lsp_types::{
    DidChangeTextDocumentParams, DidCloseTextDocumentParams, DidOpenTextDocumentParams,
    InitializeParams, Position, ServerCapabilities, TextDocumentPositionParams,
    TextDocumentSyncCapability, TextDocumentSyncKind,
    notification::{DidChangeTextDocument, DidCloseTextDocument, DidOpenTextDocument, Exit},
};
use std::{path::PathBuf, sync::Arc};
use unionbreeze_core::{Project, ResolvedUsage};
use unionbreeze_protocol::{
    DocumentUnionsParams, DocumentUnionsResponse, LiteralKind, Location, Member, ResolvedLiteral,
    span_to_range,
};
use url::Url;

fn main() -> Result<()> {
    let (connection, io) = Connection::stdio();
    let init = ServerCapabilities {
        text_document_sync: Some(TextDocumentSyncCapability::Kind(TextDocumentSyncKind::FULL)),
        ..Default::default()
    };
    let params: InitializeParams =
        serde_json::from_value(connection.initialize(serde_json::to_value(init)?)?)?;
    let root = params
        .workspace_folders
        .and_then(|folders| folders.into_iter().next())
        .and_then(|folder| folder.uri.to_file_path().ok())
        .or_else(|| std::env::current_dir().ok())
        .context("no workspace root")?;
    let project = Arc::new(Project::new(root));
    project.index_workspace();
    log(&format!(
        "indexed generation {} with {} TypeScript files",
        project.snapshot().generation,
        project.snapshot().files.len()
    ));
    run(&connection, project)?;
    io.join().context("join LSP IO")?;
    Ok(())
}
fn run(connection: &Connection, project: Arc<Project>) -> Result<()> {
    for msg in &connection.receiver {
        match msg {
            Message::Request(req) => {
                if connection.handle_shutdown(&req)? {
                    return Ok(());
                }
                handle_request(connection, &project, req)
            }
            Message::Notification(n) => handle_notification(&project, n),
            Message::Response(_) => {}
        }
    }
    Ok(())
}
fn handle_notification(project: &Project, n: Notification) {
    match n.method.as_str() {
        DidOpenTextDocument::METHOD => {
            if let Ok(p) = serde_json::from_value::<DidOpenTextDocumentParams>(n.params)
                && let Some(path) = uri_path(&p.text_document.uri)
            {
                project.update(path, p.text_document.text, Some(p.text_document.version))
            }
        }
        DidChangeTextDocument::METHOD => {
            if let Ok(p) = serde_json::from_value::<DidChangeTextDocumentParams>(n.params)
                && let (Some(path), Some(change)) = (
                    uri_path(&p.text_document.uri),
                    p.content_changes.into_iter().last(),
                )
            {
                project.update(path, change.text, Some(p.text_document.version))
            }
        }
        DidCloseTextDocument::METHOD => {
            if let Ok(_p) = serde_json::from_value::<DidCloseTextDocumentParams>(n.params) { /* retain workspace contribution */
            }
        }
        Exit::METHOD => {}
        _ => {}
    }
}
fn handle_request(connection: &Connection, project: &Project, req: Request) {
    let result = match req.method.as_str() {
        "unionBreeze/documentUnions" => serde_json::from_value::<DocumentUnionsParams>(req.params)
            .ok()
            .and_then(|p| document_result(project, &p.text_document.uri))
            .and_then(|x| serde_json::to_value(x).ok()),
        "unionBreeze/resolveLiteral" => {
            serde_json::from_value::<TextDocumentPositionParams>(req.params)
                .ok()
                .and_then(|p| resolve_result(project, &p.text_document.uri, p.position))
                .and_then(|x| serde_json::to_value(x).ok())
        }
        _ => None,
    };
    let response = if let Some(value) = result {
        Response::new_ok(req.id, value)
    } else {
        Response::new_ok(req.id, serde_json::Value::Null)
    };
    let _ = connection.sender.send(Message::Response(response));
}
fn document_result(project: &Project, uri: &Url) -> Option<DocumentUnionsResponse> {
    let path = uri_path(uri)?;
    let snap = project.snapshot();
    let file = snap.files.get(&path)?;
    let mut literals: Vec<ResolvedLiteral> = project
        .document_usages(&path)
        .iter()
        .filter_map(|r| convert(&snap, r))
        .collect();
    for domain in project.document_domains(&path) {
        let members = members(&snap, &domain.members);
        let domain_file = snap.files.get(&domain.path)?;
        for member in &domain.members {
            if member.path != path {
                continue;
            }
            let declaration_file = snap.files.get(&member.path)?;
            literals.push(ResolvedLiteral {
                range: span_to_range(&declaration_file.text, member.span),
                kind: LiteralKind::Declaration,
                current_value: member.value.clone(),
                contextual_type_name: domain.type_name.clone(),
                domain: Location {
                    uri: domain_file.uri.clone(),
                    range: span_to_range(&domain_file.text, domain.name_span),
                },
                declared_members: members.clone(),
                assignable_members: Vec::new(),
            })
        }
    }
    Some(DocumentUnionsResponse {
        version: file.version,
        generation: snap.generation,
        literals,
    })
}
fn resolve_result(project: &Project, uri: &Url, position: Position) -> Option<ResolvedLiteral> {
    let path = uri_path(uri)?;
    let snap = project.snapshot();
    let file = snap.files.get(&path)?;
    let offset = unionbreeze_protocol::position_to_offset(&file.text, position)?;
    convert(&snap, &project.resolve_at(&path, offset)?)
}
fn convert(snap: &unionbreeze_core::Snapshot, r: &ResolvedUsage) -> Option<ResolvedLiteral> {
    let domain_file = snap.files.get(&r.domain.path)?;
    let source = snap.files.get(&r.path)?;
    let members = members(snap, &r.domain.members);
    Some(ResolvedLiteral {
        range: span_to_range(&source.text, r.usage.span),
        kind: LiteralKind::Usage,
        current_value: r.usage.value.clone(),
        contextual_type_name: r.domain.type_name.clone(),
        domain: Location {
            uri: domain_file.uri.clone(),
            range: span_to_range(&domain_file.text, r.domain.name_span),
        },
        declared_members: members.clone(),
        assignable_members: members,
    })
}
fn members(
    snap: &unionbreeze_core::Snapshot,
    input: &[unionbreeze_core::ResolvedMember],
) -> Vec<Member> {
    input
        .iter()
        .filter_map(|m| {
            let f = snap.files.get(&m.path)?;
            Some(Member {
                value: m.value.clone(),
                declaration: Location {
                    uri: f.uri.clone(),
                    range: span_to_range(&f.text, m.span),
                },
                deprecated: false,
                declaration_order: m.order,
            })
        })
        .collect()
}
fn uri_path(uri: &Url) -> Option<PathBuf> {
    uri.to_file_path()
        .ok()
        .map(|p| p.canonicalize().unwrap_or(p))
}
fn log(message: &str) {
    if std::env::var_os("UNIONBREEZE_LOG").is_some() || std::env::var_os("RUST_LOG").is_some() {
        eprintln!("[unionbreeze] {message}")
    }
}
