#![allow(clippy::collapsible_if)]

use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_span::SourceType;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StringMember {
    pub value: String,
    pub span: Span,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum TypePart {
    String(StringMember),
    Reference(String),
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TypeAlias {
    pub name: String,
    pub name_span: Span,
    pub parts: Vec<TypePart>,
    pub exported: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Import {
    pub imported: String,
    pub local: String,
    pub specifier: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum UsageContext {
    Variable {
        type_name: String,
    },
    Argument {
        callee: String,
        index: usize,
    },
    Property {
        owner_type: String,
        property: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StringUsage {
    pub value: String,
    pub span: Span,
    pub context: UsageContext,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Function {
    pub name: String,
    pub parameters: Vec<Option<String>>,
    pub generic: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Interface {
    pub name: String,
    pub properties: Vec<(String, String)>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct TypeScriptFacts {
    pub aliases: Vec<TypeAlias>,
    pub imports: Vec<Import>,
    pub functions: Vec<Function>,
    pub interfaces: Vec<Interface>,
    pub usages: Vec<StringUsage>,
    pub parse_errors: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Kind {
    Ident,
    String,
    Symbol,
}
#[derive(Clone, Debug)]
struct Token {
    kind: Kind,
    text: String,
    span: Span,
}

pub fn parse_typescript(path: &Path, source: &str) -> TypeScriptFacts {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).unwrap_or_default();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    let mut facts = TypeScriptFacts {
        parse_errors: parsed.errors.into_iter().map(|e| e.to_string()).collect(),
        ..Default::default()
    };
    let tokens = tokenize(source);
    parse_imports(&tokens, &mut facts);
    parse_aliases(&tokens, &mut facts);
    parse_interfaces(&tokens, &mut facts);
    parse_functions(&tokens, &mut facts);
    parse_variable_usages(&tokens, &mut facts);
    parse_call_usages(&tokens, &mut facts);
    parse_object_usages(&tokens, &mut facts);
    facts
}

fn tokenize(source: &str) -> Vec<Token> {
    let b = source.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if b.get(i..i + 2) == Some(b"//") {
            i += 2;
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b.get(i..i + 2) == Some(b"/*") {
            i += 2;
            while i + 1 < b.len() && &b[i..i + 2] != b"*/" {
                i += 1;
            }
            i = (i + 2).min(b.len());
            continue;
        }
        if matches!(b[i], b'\'' | b'"') {
            let q = b[i];
            let start = i;
            i += 1;
            while i < b.len() && b[i] != q {
                if b[i] == b'\\' && i + 1 < b.len() {
                    i += 2;
                    continue;
                }
                i += 1;
            }
            let value = decode_string(&source[start + 1..i.min(b.len())]);
            i = (i + 1).min(b.len());
            out.push(Token {
                kind: Kind::String,
                text: value,
                span: Span { start, end: i },
            });
            continue;
        }
        if b[i].is_ascii_alphabetic() || matches!(b[i], b'_' | b'$') {
            let start = i;
            i += 1;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || matches!(b[i], b'_' | b'$')) {
                i += 1;
            }
            out.push(Token {
                kind: Kind::Ident,
                text: source[start..i].into(),
                span: Span { start, end: i },
            });
            continue;
        }
        out.push(Token {
            kind: Kind::Symbol,
            text: (b[i] as char).to_string(),
            span: Span {
                start: i,
                end: i + 1,
            },
        });
        i += 1;
    }
    out
}

fn decode_string(raw: &str) -> String {
    let mut chars = raw.chars();
    let mut value = String::new();
    while let Some(character) = chars.next() {
        if character != '\\' {
            value.push(character);
            continue;
        }
        value.push(match chars.next() {
            Some('n') => '\n',
            Some('r') => '\r',
            Some('t') => '\t',
            Some('b') => '\u{8}',
            Some('f') => '\u{c}',
            Some(other) => other,
            None => '\\',
        });
    }
    value
}

fn ident(t: Option<&Token>) -> Option<String> {
    t.filter(|t| t.kind == Kind::Ident).map(|t| t.text.clone())
}
fn find_matching(t: &[Token], open: usize, left: &str, right: &str) -> Option<usize> {
    let mut d = 0;
    for (i, x) in t.iter().enumerate().skip(open) {
        if x.text == left {
            d += 1
        } else if x.text == right {
            d -= 1;
            if d == 0 {
                return Some(i);
            }
        }
    }
    None
}

fn parse_imports(t: &[Token], f: &mut TypeScriptFacts) {
    let mut i = 0;
    while i < t.len() {
        if t[i].text != "import" {
            i += 1;
            continue;
        }
        i += 1;
        if t.get(i).is_some_and(|x| x.text == "type") {
            i += 1
        }
        if t.get(i).is_some_and(|x| x.text == "{") {
            if let Some(end) = find_matching(t, i, "{", "}") {
                let mut j = i + 1;
                while j < end {
                    if let Some(imported) = ident(t.get(j)) {
                        let mut local = imported.clone();
                        if t.get(j + 1).is_some_and(|x| x.text == "as") {
                            if let Some(x) = ident(t.get(j + 2)) {
                                local = x;
                                j += 2
                            }
                        }
                        if let Some(from) = t
                            .iter()
                            .enumerate()
                            .skip(end + 1)
                            .find(|(_, x)| x.text == "from")
                            .map(|x| x.0)
                        {
                            if let Some(spec) = t.get(from + 1).filter(|x| x.kind == Kind::String) {
                                f.imports.push(Import {
                                    imported,
                                    local,
                                    specifier: spec.text.clone(),
                                })
                            }
                        }
                    }
                    j += 1
                }
                i = end
            }
        }
        i += 1
    }
}

fn parse_aliases(t: &[Token], f: &mut TypeScriptFacts) {
    let mut i = 0;
    while i < t.len() {
        let exported = t.get(i).is_some_and(|x| x.text == "export");
        let p = if exported { i + 1 } else { i };
        if !t.get(p).is_some_and(|x| x.text == "type") {
            i += 1;
            continue;
        }
        let Some(name) = ident(t.get(p + 1)) else {
            i += 1;
            continue;
        };
        if !t.get(p + 2).is_some_and(|x| x.text == "=") {
            i += 1;
            continue;
        }
        let mut parts = Vec::new();
        let mut j = p + 3;
        while j < t.len() && !matches!(t[j].text.as_str(), ";" | "}") {
            if t[j].kind == Kind::String {
                parts.push(TypePart::String(StringMember {
                    value: t[j].text.clone(),
                    span: t[j].span,
                }))
            } else if t[j].kind == Kind::Ident {
                parts.push(if t[j].text == "string" {
                    TypePart::Unsupported
                } else {
                    TypePart::Reference(t[j].text.clone())
                })
            } else if !matches!(t[j].text.as_str(), "|" | "(" | ")") {
                parts.push(TypePart::Unsupported)
            }
            j += 1
        }
        f.aliases.push(TypeAlias {
            name,
            name_span: t[p + 1].span,
            parts,
            exported,
        });
        i = j + 1
    }
}

fn parse_interfaces(t: &[Token], f: &mut TypeScriptFacts) {
    let mut i = 0;
    while i < t.len() {
        if t[i].text != "interface" {
            i += 1;
            continue;
        }
        let Some(name) = ident(t.get(i + 1)) else {
            i += 1;
            continue;
        };
        if !t.get(i + 2).is_some_and(|x| x.text == "{") {
            i += 1;
            continue;
        }
        let Some(end) = find_matching(t, i + 2, "{", "}") else {
            break;
        };
        let mut props = Vec::new();
        let mut j = i + 3;
        while j + 2 < end {
            if let (Some(p), true, Some(ty)) =
                (ident(t.get(j)), t[j + 1].text == ":", ident(t.get(j + 2)))
            {
                props.push((p, ty));
                j += 3
            } else {
                j += 1
            }
        }
        f.interfaces.push(Interface {
            name,
            properties: props,
        });
        i = end + 1
    }
}

fn parse_functions(t: &[Token], f: &mut TypeScriptFacts) {
    let mut i = 0;
    while i < t.len() {
        if t[i].text != "function" {
            i += 1;
            continue;
        }
        let Some(name) = ident(t.get(i + 1)) else {
            i += 1;
            continue;
        };
        let generic = t.get(i + 2).is_some_and(|x| x.text == "<");
        let Some(open) = t
            .iter()
            .enumerate()
            .skip(i + 2)
            .find(|(_, x)| x.text == "(")
            .map(|x| x.0)
        else {
            i += 1;
            continue;
        };
        let Some(end) = find_matching(t, open, "(", ")") else {
            break;
        };
        let mut params = Vec::new();
        let mut j = open + 1;
        while j < end {
            if t.get(j + 1).is_some_and(|x| x.text == ":") {
                params.push(ident(t.get(j + 2)));
                while j < end && t[j].text != "," {
                    j += 1
                }
            } else {
                j += 1
            }
            if t.get(j).is_some_and(|x| x.text == ",") {
                j += 1
            }
        }
        f.functions.push(Function {
            name,
            parameters: params,
            generic,
        });
        i = end + 1
    }
}

fn parse_variable_usages(t: &[Token], f: &mut TypeScriptFacts) {
    for i in 0..t.len().saturating_sub(5) {
        if matches!(t[i].text.as_str(), "const" | "let" | "var")
            && t[i + 2].text == ":"
            && t[i + 4].text == "="
            && t[i + 5].kind == Kind::String
        {
            if let Some(ty) = ident(t.get(i + 3)) {
                f.usages.push(StringUsage {
                    value: t[i + 5].text.clone(),
                    span: t[i + 5].span,
                    context: UsageContext::Variable { type_name: ty },
                })
            }
        }
    }
}

fn parse_call_usages(t: &[Token], f: &mut TypeScriptFacts) {
    for i in 0..t.len().saturating_sub(2) {
        if t[i].kind != Kind::Ident || t[i + 1].text != "(" {
            continue;
        }
        let Some(end) = find_matching(t, i + 1, "(", ")") else {
            continue;
        };
        let mut arg = 0;
        for x in &t[i + 2..end] {
            if x.text == "," {
                arg += 1
            } else if x.kind == Kind::String {
                f.usages.push(StringUsage {
                    value: x.text.clone(),
                    span: x.span,
                    context: UsageContext::Argument {
                        callee: t[i].text.clone(),
                        index: arg,
                    },
                })
            }
        }
    }
}

fn parse_object_usages(t: &[Token], f: &mut TypeScriptFacts) {
    let mut i = 0;
    while i + 6 < t.len() {
        if !matches!(t[i].text.as_str(), "const" | "let" | "var") {
            i += 1;
            continue;
        }
        let mut owner = None;
        let mut open = None;
        if t.get(i + 2).is_some_and(|x| x.text == ":") {
            owner = ident(t.get(i + 3));
            open = t
                .iter()
                .enumerate()
                .skip(i + 4)
                .take(3)
                .find(|(_, x)| x.text == "{")
                .map(|x| x.0)
        } else if let Some(o) = t
            .iter()
            .enumerate()
            .skip(i + 2)
            .take(4)
            .find(|(_, x)| x.text == "{")
            .map(|x| x.0)
        {
            if let Some(end) = find_matching(t, o, "{", "}") {
                if t.get(end + 1).is_some_and(|x| x.text == "satisfies") {
                    owner = ident(t.get(end + 2));
                    open = Some(o)
                }
            }
        }
        let (Some(owner), Some(open)) = (owner, open) else {
            i += 1;
            continue;
        };
        let Some(end) = find_matching(t, open, "{", "}") else {
            break;
        };
        let mut j = open + 1;
        while j + 2 < end {
            if let Some(property) = ident(t.get(j)) {
                if t[j + 1].text == ":" && t[j + 2].kind == Kind::String {
                    f.usages.push(StringUsage {
                        value: t[j + 2].text.clone(),
                        span: t[j + 2].span,
                        context: UsageContext::Property {
                            owner_type: owner.clone(),
                            property,
                        },
                    });
                    j += 3;
                    continue;
                }
            }
            j += 1
        }
        i = end + 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extracts_mvp_facts() {
        let f = parse_typescript(
            Path::new("x.ts"),
            "export type Status='draft'|'published'; function setStatus(x: Status){}; const a: Status='draft'; setStatus('published'); interface Item { status: Status } const item: Item={status:'draft'};",
        );
        assert_eq!(f.aliases.len(), 1);
        assert_eq!(f.usages.len(), 3);
        assert_eq!(f.functions[0].parameters[0].as_deref(), Some("Status"));
    }
    #[test]
    fn preserves_unicode_literal_values_and_byte_spans() {
        let source = "type Mood='😀'|'calm'; const mood:Mood='😀';";
        let f = parse_typescript(Path::new("x.tsx"), source);
        assert_eq!(
            f.aliases[0].parts[0],
            TypePart::String(StringMember {
                value: "😀".into(),
                span: Span { start: 10, end: 16 }
            })
        );
        assert_eq!(
            &source[f.usages[0].span.start..f.usages[0].span.end],
            "'😀'"
        )
    }
}
