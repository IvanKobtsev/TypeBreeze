use anyhow::{Context, Result, anyhow};
use lsp_server::{Connection, Message, Notification, Request, Response};
use lsp_types::notification::Notification as LspNotification;
use lsp_types::request::Request as LspRequest;
use lsp_types::{
    DidChangeTextDocumentParams, DidCloseTextDocumentParams, DidOpenTextDocumentParams, Hover,
    HoverContents, HoverParams, InitializeParams, MarkupContent, MarkupKind, ServerCapabilities,
    TextDocumentPositionParams, TextDocumentSyncCapability, TextDocumentSyncKind,
    notification::{
        DidChangeTextDocument, DidCloseTextDocument, DidOpenTextDocument, Exit, Initialized,
        PublishDiagnostics,
    },
    request::{GotoDefinition, HoverRequest},
};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
};
use typebreeze_protocol::ResolvedLiteral;
use url::Url;

fn main() -> Result<()> {
    let (connection, io) = Connection::stdio();
    let init = ServerCapabilities {
        text_document_sync: Some(TextDocumentSyncCapability::Kind(TextDocumentSyncKind::FULL)),
        hover_provider: Some(lsp_types::HoverProviderCapability::Simple(true)),
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
    let worker = CompilerWorker::start(&root)
        .map(Arc::new)
        .map_err(|error| {
            log(&format!(
                "TypeScript compiler worker unavailable: {error:#}"
            ));
            error
        })?;
    log("TypeScript compiler worker ready");
    run(&connection, worker)?;
    io.join().context("join LSP IO")?;
    Ok(())
}
fn run(connection: &Connection, worker: Arc<CompilerWorker>) -> Result<()> {
    for msg in &connection.receiver {
        match msg {
            Message::Request(req) => {
                if connection.handle_shutdown(&req)? {
                    return Ok(());
                }
                handle_request(connection, &worker, req)
            }
            Message::Notification(n) => handle_notification(connection, &worker, n),
            Message::Response(_) => {}
        }
    }
    Ok(())
}
fn handle_notification(connection: &Connection, worker: &CompilerWorker, n: Notification) {
    match n.method.as_str() {
        Initialized::METHOD => publish_extension_diagnostics(connection, worker),
        DidOpenTextDocument::METHOD => {
            if let Ok(p) = serde_json::from_value::<DidOpenTextDocumentParams>(n.params) {
                let extension_file = is_extension_file(&p.text_document.uri);
                worker
                    .update(
                        &p.text_document.uri,
                        p.text_document.version,
                        &p.text_document.text,
                    )
                    .unwrap_or_else(|error| log(&format!("didOpen update failed: {error:#}")));
                if extension_file {
                    publish_extension_diagnostics(connection, worker);
                }
            }
        }
        DidChangeTextDocument::METHOD => {
            if let Ok(p) = serde_json::from_value::<DidChangeTextDocumentParams>(n.params)
                && let Some(change) = p.content_changes.into_iter().last()
            {
                let extension_file = is_extension_file(&p.text_document.uri);
                worker
                    .update(&p.text_document.uri, p.text_document.version, &change.text)
                    .unwrap_or_else(|error| log(&format!("didChange update failed: {error:#}")));
                if extension_file {
                    publish_extension_diagnostics(connection, worker);
                }
            }
        }
        DidCloseTextDocument::METHOD => {
            if let Ok(p) = serde_json::from_value::<DidCloseTextDocumentParams>(n.params) {
                let extension_file = is_extension_file(&p.text_document.uri);
                worker
                    .request("close", serde_json::json!({"uri":p.text_document.uri}))
                    .unwrap_or_else(|error| {
                        log(&format!("didClose update failed: {error:#}"));
                        None
                    });
                if extension_file {
                    publish_extension_diagnostics(connection, worker);
                }
            }
        }
        Exit::METHOD => {}
        _ => {}
    }
}
fn is_extension_file(uri: &Url) -> bool {
    let path = uri.path().to_ascii_lowercase();
    path.ends_with(".ext.ts") || path.ends_with(".ext.tsx")
}
fn publish_extension_diagnostics(connection: &Connection, worker: &CompilerWorker) {
    let Ok(Some(serde_json::Value::Array(files))) =
        worker.request("extensionDiagnostics", serde_json::json!({}))
    else {
        return;
    };
    for params in files {
        let _ = connection
            .sender
            .send(Message::Notification(Notification::new(
                PublishDiagnostics::METHOD.to_owned(),
                params,
            )));
    }
}
fn handle_request(connection: &Connection, worker: &CompilerWorker, req: Request) {
    let result = match req.method.as_str() {
        "typeBreeze/documentUnions" => worker.request("documentUnions", req.params).ok().flatten(),
        "typeBreeze/resolveLiteral" => worker.request("resolveLiteral", req.params).ok().flatten(),
        "typeBreeze/navigationTargets" => worker
            .request("navigationTargets", req.params)
            .ok()
            .flatten(),
        "typeBreeze/renamePlan" => worker.request("renamePlan", req.params).ok().flatten(),
        "typeBreeze/enumToUnionPlan" => {
            worker.request("enumToUnionPlan", req.params).ok().flatten()
        }
        "typeBreeze/extensionCompletions" => {
            serde_json::from_value::<typebreeze_protocol::ExtensionCompletionParams>(req.params)
                .ok()
                .and_then(|params| {
                    worker
                        .request("extensionCompletions", serde_json::to_value(params).ok()?)
                        .ok()
                        .flatten()
                })
        }
        HoverRequest::METHOD => serde_json::from_value::<HoverParams>(req.params)
            .ok()
            .and_then(|p| hover_result(worker, &p.text_document_position_params))
            .and_then(|x| serde_json::to_value(x).ok()),
        GotoDefinition::METHOD => worker
            .request("navigationTargets", req.params)
            .ok()
            .flatten(),
        _ => None,
    };
    let response = if let Some(value) = result {
        Response::new_ok(req.id, value)
    } else {
        Response::new_ok(req.id, serde_json::Value::Null)
    };
    let _ = connection.sender.send(Message::Response(response));
}
fn hover_result(worker: &CompilerWorker, params: &TextDocumentPositionParams) -> Option<Hover> {
    let resolved: ResolvedLiteral = serde_json::from_value(
        worker
            .request("resolveLiteral", serde_json::to_value(params).ok()?)
            .ok()??,
    )
    .ok()?;
    let values = resolved
        .declared_members
        .iter()
        .map(|m| format!("`{}`", m.value))
        .collect::<Vec<_>>()
        .join(" · ");
    Some(Hover {
        contents: HoverContents::Markup(MarkupContent {
            kind: MarkupKind::Markdown,
            value: format!(
                "Union member `{}`\n\nDefined by `{}`\n\n{}",
                resolved.current_value, resolved.contextual_type_name, values
            ),
        }),
        range: Some(resolved.range),
    })
}
struct WorkerProcess {
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}
struct CompilerWorker {
    process: Mutex<WorkerProcess>,
}
impl CompilerWorker {
    fn start(root: &Path) -> Result<Self> {
        let directory = std::env::temp_dir().join(format!(
            "typebreeze-ts-worker-{}-{}",
            env!("CARGO_PKG_VERSION"),
            std::process::id()
        ));
        fs::create_dir_all(&directory)?;
        let script = directory.join("worker.cjs");
        fs::write(
            directory.join("extensions.cjs"),
            include_str!("../../../typescript-worker/extensions.cjs"),
        )?;
        fs::write(
            &script,
            include_str!("../../../typescript-worker/worker.cjs"),
        )?;
        let node = std::env::var_os("TYPEBREEZE_NODE").unwrap_or_else(|| "node".into());
        let mut child = Command::new(node)
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("start Node.js TypeScript compiler worker")?;
        let stdin = child.stdin.take().context("worker stdin")?;
        let stdout = BufReader::new(child.stdout.take().context("worker stdout")?);
        let worker = Self {
            process: Mutex::new(WorkerProcess {
                _child: child,
                stdin,
                stdout,
                next_id: 1,
            }),
        };
        worker.request("initialize", serde_json::json!({"root":root}))?;
        Ok(worker)
    }
    fn update(&self, uri: &Url, version: i32, text: &str) -> Result<()> {
        self.request(
            "update",
            serde_json::json!({"uri":uri,"version":version,"text":text}),
        )
        .map(|_| ())
    }
    fn request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<Option<serde_json::Value>> {
        let mut process = self
            .process
            .lock()
            .map_err(|_| anyhow!("compiler worker lock poisoned"))?;
        let id = process.next_id;
        process.next_id += 1;
        serde_json::to_writer(
            &mut process.stdin,
            &serde_json::json!({"id":id,"method":method,"params":params}),
        )?;
        process.stdin.write_all(b"\n")?;
        process.stdin.flush()?;
        let mut line = String::new();
        process.stdout.read_line(&mut line)?;
        let response: serde_json::Value =
            serde_json::from_str(&line).context("invalid compiler worker response")?;
        if let Some(error) = response.get("error") {
            return Err(anyhow!("{error}"));
        }
        Ok(response.get("result").cloned().filter(|x| !x.is_null()))
    }
}
fn log(message: &str) {
    if std::env::var_os("TYPEBREEZE_LOG").is_some() || std::env::var_os("RUST_LOG").is_some() {
        eprintln!("[typebreeze] {message}")
    }
}
