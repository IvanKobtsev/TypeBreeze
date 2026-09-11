use lsp_types::{Range, Url};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionCompletionParams {
    pub text_document: lsp_types::TextDocumentIdentifier,
    pub position: lsp_types::Position,
    pub text: String,
    pub client_version: i64,
    #[serde(default)]
    pub documents: Vec<DocumentUnionsParams>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionCompletions {
    #[serde(default)]
    pub snapshot: String,
    #[serde(default)]
    pub expected_text: String,
    #[serde(default)]
    pub documents: Vec<EnumDocumentSnapshot>,
    pub candidates: Vec<ExtensionCandidate>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionCandidate {
    pub id: String,
    pub name: String,
    pub source_module: String,
    pub signature: String,
    pub remaining_parameters: String,
    pub return_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<ExtensionCallPlan>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionCallPlan {
    pub snapshot: String,
    pub expected_text: String,
    pub edits: Vec<ExtensionOffsetEdit>,
    pub caret_offset: usize,
    pub parameter_info: bool,
}

/// Offsets are UTF-16 code units, matching TypeScript and IntelliJ documents.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionOffsetEdit {
    pub start: usize,
    pub end: usize,
    pub expected_text: String,
    pub new_text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingTypeParams {
    pub text_document: lsp_types::TextDocumentIdentifier,
    pub position: lsp_types::Position,
    pub text: String,
    pub client_version: i64,
    pub key_type_parameter: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingTypeInfo {
    pub valid: bool,
    pub reason: Option<String>,
    pub type_name: String,
    pub path: String,
    #[serde(default)]
    pub finite_key_domain: bool,
    #[serde(default)]
    pub key_domain_type: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingGenerationPlan {
    #[serde(default)]
    pub files: Vec<GeneratedMappingFile>,
    #[serde(default)]
    pub diagnostics: Vec<MappingDiagnostic>,
    #[serde(default)]
    pub occurrences: Vec<MappingOccurrence>,
    #[serde(default)]
    pub diagnostic_documents: Vec<lsp_types::PublishDiagnosticsParams>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingOccurrence {
    pub uri: Url,
    pub range: Range,
    pub kind: MappingOccurrenceKind,
    pub mapping_name: String,
    pub target_uri: Url,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MappingOccurrenceKind {
    Connector,
    Component,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedMappingFile {
    pub path: String,
    pub content: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingDiagnostic {
    pub path: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentUnionsParams {
    pub text_document: lsp_types::TextDocumentIdentifier,
    pub text: String,
    pub client_version: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentExtensionsResponse {
    pub client_version: Option<i64>,
    pub generation: u64,
    pub occurrences: Vec<ExtensionOccurrence>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionOccurrence {
    pub range: Range,
    pub kind: ExtensionOccurrenceKind,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionOccurrenceKind {
    Declaration,
    Call,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_wire_format_round_trips() {
        let json = serde_json::json!({
            "snapshot": "abc", "expectedText": "value.", "documents": [], "candidates": [{
                "id": "file:///project/string.ext.ts#0", "name": "trim",
                "sourceModule": "string.ext.ts", "signature": "(value: string): string",
                "remainingParameters": "", "returnType": "string", "plan": {
                    "snapshot": "abc", "expectedText": "value.",
                    "edits": [{"start": 0, "end": 6, "expectedText": "value.", "newText": "trim(value)"}],
                    "caretOffset": 11, "parameterInfo": false
                }
            }]
        });
        let response: ExtensionCompletions = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(serde_json::to_value(response).unwrap(), json);
        let empty: ExtensionCompletions =
            serde_json::from_value(serde_json::json!({"candidates": []})).unwrap();
        assert!(empty.candidates.is_empty());
    }
}
