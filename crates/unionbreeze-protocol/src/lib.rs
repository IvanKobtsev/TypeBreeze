use lsp_types::{Range, Url};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentUnionsParams {
    pub text_document: lsp_types::TextDocumentIdentifier,
    pub text: String,
    pub client_version: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveLiteralParams {
    pub text_document: lsp_types::TextDocumentIdentifier,
    pub position: lsp_types::Position,
    pub text: String,
    pub client_version: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamePlanParams {
    pub text_document: lsp_types::TextDocumentIdentifier,
    pub position: lsp_types::Position,
    pub text: String,
    pub client_version: i64,
    pub new_value: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamePlan {
    pub old_value: String,
    pub contextual_type_name: String,
    pub targets: Vec<RenameTarget>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameTarget {
    pub uri: Url,
    pub range: Range,
    pub expected_text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnumToUnionParams {
    pub text_document: lsp_types::TextDocumentIdentifier,
    pub position: lsp_types::Position,
    pub text: String,
    pub client_version: i64,
    pub documents: Vec<DocumentUnionsParams>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnumToUnionPlan {
    pub enum_name: Option<String>,
    pub needs_object: Option<bool>,
    pub reason: Option<String>,
    pub location: Option<Location>,
    pub documents: Vec<EnumDocumentSnapshot>,
    pub edits: Vec<EnumTextEdit>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnumDocumentSnapshot {
    pub uri: Url,
    pub expected_text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnumTextEdit {
    pub uri: Url,
    pub range: Range,
    pub expected_text: String,
    pub new_text: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentUnionsResponse {
    pub version: Option<i32>,
    pub client_version: Option<i64>,
    pub generation: u64,
    pub literals: Vec<ResolvedLiteral>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLiteral {
    pub range: Range,
    pub kind: LiteralKind,
    pub current_value: String,
    pub contextual_type_name: String,
    pub domain: Location,
    pub declared_members: Vec<Member>,
    pub assignable_members: Vec<Member>,
    pub has_usages: Option<bool>,
    pub usage_locations: Vec<Location>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LiteralKind {
    Declaration,
    Usage,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Location {
    pub uri: Url,
    pub range: Range,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub value: String,
    pub declaration: Location,
    pub deprecated: bool,
    pub declaration_order: usize,
}
