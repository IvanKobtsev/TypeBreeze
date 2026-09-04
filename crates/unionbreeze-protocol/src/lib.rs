use lsp_types::{Position, Range, Url};
use serde::{Deserialize, Serialize};
use unionbreeze_typescript::Span;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentUnionsParams {
    pub text_document: lsp_types::TextDocumentIdentifier,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentUnionsResponse {
    pub version: Option<i32>,
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

pub fn span_to_range(source: &str, span: Span) -> Range {
    Range::new(
        offset_to_position(source, span.start),
        offset_to_position(source, span.end),
    )
}
pub fn position_to_offset(source: &str, p: Position) -> Option<usize> {
    let mut line = 0u32;
    let mut start = 0;
    for (i, c) in source.char_indices() {
        if line == p.line {
            start = i;
            break;
        }
        if c == '\n' {
            line += 1;
            start = i + 1
        }
    }
    if line != p.line {
        return None;
    }
    let mut utf16 = 0u32;
    for (i, c) in source[start..].char_indices() {
        if c == '\n' {
            break;
        }
        if utf16 >= p.character {
            return Some(start + i);
        }
        utf16 += c.len_utf16() as u32;
    }
    (utf16 == p.character).then_some(
        source
            .len()
            .min(start + source[start..].find('\n').unwrap_or(source.len() - start)),
    )
}
fn offset_to_position(source: &str, offset: usize) -> Position {
    let prefix = &source[..offset.min(source.len())];
    let line = prefix.bytes().filter(|b| *b == b'\n').count() as u32;
    let tail = prefix.rsplit_once('\n').map_or(prefix, |x| x.1);
    Position::new(line, tail.encode_utf16().count() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf16_positions() {
        let s = "😀x";
        assert_eq!(
            span_to_range(s, Span { start: 4, end: 5 }).start.character,
            2
        );
        assert_eq!(position_to_offset(s, Position::new(0, 2)), Some(4));
    }
}
