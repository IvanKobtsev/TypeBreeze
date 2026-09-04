use arc_swap::ArcSwap;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use unionbreeze_typescript::{
    Span, StringUsage, TypePart, TypeScriptFacts, UsageContext, parse_typescript,
};
use url::Url;

#[derive(Clone, Debug)]
pub struct SourceFile {
    pub path: PathBuf,
    pub uri: Url,
    pub text: Arc<str>,
    pub version: Option<i32>,
    pub facts: TypeScriptFacts,
}
#[derive(Clone, Debug)]
pub struct ResolvedMember {
    pub value: String,
    pub path: PathBuf,
    pub span: Span,
    pub order: usize,
}
#[derive(Clone, Debug)]
pub struct ResolvedDomain {
    pub type_name: String,
    pub path: PathBuf,
    pub name_span: Span,
    pub members: Vec<ResolvedMember>,
}
#[derive(Clone, Debug)]
pub struct ResolvedUsage {
    pub path: PathBuf,
    pub usage: StringUsage,
    pub domain: ResolvedDomain,
}
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub files: HashMap<PathBuf, Arc<SourceFile>>,
    pub generation: u64,
}
pub struct Project {
    root: PathBuf,
    snapshot: ArcSwap<Snapshot>,
    next_generation: AtomicU64,
}

impl Project {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            snapshot: ArcSwap::from_pointee(Snapshot::default()),
            next_generation: AtomicU64::new(1),
        }
    }
    pub fn snapshot(&self) -> Arc<Snapshot> {
        self.snapshot.load_full()
    }
    pub fn index_workspace(&self) {
        let mut files = HashMap::new();
        for entry in ignore::WalkBuilder::new(&self.root)
            .hidden(false)
            .build()
            .filter_map(Result::ok)
        {
            let path = entry.path();
            if path.is_file()
                && is_typescript(path)
                && let Ok(text) = fs::read_to_string(path)
            {
                insert_file(&mut files, path.to_path_buf(), text, None)
            }
        }
        self.publish(files)
    }
    pub fn update(&self, path: PathBuf, text: String, version: Option<i32>) {
        let mut files = self.snapshot().files.clone();
        insert_file(&mut files, path, text, version);
        self.publish(files)
    }
    pub fn remove(&self, path: &Path) {
        let mut files = self.snapshot().files.clone();
        files.remove(&normalize(path));
        self.publish(files)
    }
    fn publish(&self, files: HashMap<PathBuf, Arc<SourceFile>>) {
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        self.snapshot
            .store(Arc::new(Snapshot { files, generation }))
    }
    pub fn document_usages(&self, path: &Path) -> Vec<ResolvedUsage> {
        let snap = self.snapshot();
        let path = normalize(path);
        let Some(file) = snap.files.get(&path) else {
            return vec![];
        };
        file.facts
            .usages
            .iter()
            .filter_map(|u| resolve_usage(&snap, file, u))
            .collect()
    }
    pub fn resolve_at(&self, path: &Path, offset: usize) -> Option<ResolvedUsage> {
        self.document_usages(path)
            .into_iter()
            .find(|r| r.usage.span.start <= offset && offset <= r.usage.span.end)
    }
    pub fn document_domains(&self, path: &Path) -> Vec<ResolvedDomain> {
        let snap = self.snapshot();
        let path = normalize(path);
        let Some(file) = snap.files.get(&path) else {
            return vec![];
        };
        file.facts
            .aliases
            .iter()
            .filter_map(|a| resolve_domain(&snap, file, &a.name, &mut HashSet::new()))
            .collect()
    }
}
fn insert_file(
    files: &mut HashMap<PathBuf, Arc<SourceFile>>,
    path: PathBuf,
    text: String,
    version: Option<i32>,
) {
    let path = normalize(&path);
    let uri = Url::from_file_path(&path).expect("absolute TypeScript path");
    let facts = parse_typescript(&path, &text);
    files.insert(
        path.clone(),
        Arc::new(SourceFile {
            path,
            uri,
            text: Arc::from(text),
            version,
            facts,
        }),
    );
}
fn is_typescript(p: &Path) -> bool {
    matches!(p.extension().and_then(|x| x.to_str()), Some("ts" | "tsx"))
}
fn normalize(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}
fn resolve_usage(
    snapshot: &Snapshot,
    file: &SourceFile,
    usage: &StringUsage,
) -> Option<ResolvedUsage> {
    let type_name = match &usage.context {
        UsageContext::Variable { type_name } => type_name.clone(),
        UsageContext::Argument { callee, index } => resolve_function(snapshot, file, callee)?
            .parameters
            .get(*index)?
            .clone()?,
        UsageContext::Property {
            owner_type,
            property,
        } => resolve_interface(snapshot, file, owner_type)?
            .properties
            .iter()
            .find(|(p, _)| p == property)?
            .1
            .clone(),
    };
    let domain = resolve_domain(snapshot, file, &type_name, &mut HashSet::new())?;
    domain
        .members
        .iter()
        .any(|m| m.value == usage.value)
        .then_some(ResolvedUsage {
            path: file.path.clone(),
            usage: usage.clone(),
            domain,
        })
}
fn resolve_function(
    snapshot: &Snapshot,
    file: &SourceFile,
    name: &str,
) -> Option<unionbreeze_typescript::Function> {
    let local: Vec<_> = file
        .facts
        .functions
        .iter()
        .filter(|x| x.name == name && !x.generic)
        .cloned()
        .collect();
    if local.len() == 1 {
        return local.into_iter().next();
    }
    let (target, remote) = resolve_import(snapshot, file, name)?;
    let hits: Vec<_> = target
        .facts
        .functions
        .iter()
        .filter(|x| x.name == remote && !x.generic)
        .cloned()
        .collect();
    (hits.len() == 1).then(|| hits[0].clone())
}
fn resolve_interface(
    snapshot: &Snapshot,
    file: &SourceFile,
    name: &str,
) -> Option<unionbreeze_typescript::Interface> {
    if let Some(x) = file.facts.interfaces.iter().find(|x| x.name == name) {
        return Some(x.clone());
    }
    let (target, remote) = resolve_import(snapshot, file, name)?;
    target
        .facts
        .interfaces
        .iter()
        .find(|x| x.name == remote)
        .cloned()
}
fn resolve_domain(
    snapshot: &Snapshot,
    file: &SourceFile,
    name: &str,
    visiting: &mut HashSet<(PathBuf, String)>,
) -> Option<ResolvedDomain> {
    let (owner, remote) = if file.facts.aliases.iter().any(|x| x.name == name) {
        (Arc::new(file.clone()), name.to_string())
    } else {
        resolve_import(snapshot, file, name)?
    };
    let key = (owner.path.clone(), remote.clone());
    if !visiting.insert(key.clone()) {
        return None;
    }
    let alias = owner.facts.aliases.iter().find(|x| x.name == remote)?;
    let mut members = Vec::new();
    for part in &alias.parts {
        match part {
            TypePart::String(x) => members.push(ResolvedMember {
                value: x.value.clone(),
                path: owner.path.clone(),
                span: x.span,
                order: 0,
            }),
            TypePart::Reference(r) => {
                let nested = resolve_domain(snapshot, &owner, r, visiting)?;
                members.extend(nested.members)
            }
            TypePart::Unsupported => return None,
        }
    }
    visiting.remove(&key);
    let mut seen = HashSet::new();
    members.retain(|m| seen.insert(m.value.clone()));
    for (i, m) in members.iter_mut().enumerate() {
        m.order = i
    }
    if members.len() < 2 || members.len() > 100 {
        return None;
    }
    Some(ResolvedDomain {
        type_name: name.to_string(),
        path: owner.path.clone(),
        name_span: alias.name_span,
        members,
    })
}
fn resolve_import(
    snapshot: &Snapshot,
    file: &SourceFile,
    local: &str,
) -> Option<(Arc<SourceFile>, String)> {
    let import = file.facts.imports.iter().find(|x| x.local == local)?;
    let path = resolve_module(snapshot, &file.path, &import.specifier)?;
    Some((snapshot.files.get(&path)?.clone(), import.imported.clone()))
}
fn resolve_module(snapshot: &Snapshot, from: &Path, specifier: &str) -> Option<PathBuf> {
    if !specifier.starts_with('.') {
        if let Some(mapped) = resolve_tsconfig_path(snapshot, from, specifier) {
            return Some(mapped);
        }
        for ancestor in from.ancestors().skip(1) {
            let package = ancestor.join("node_modules").join(specifier);
            if let Some(found) = module_candidate(snapshot, &package) {
                return Some(found);
            }
        }
        return None;
    }
    let base = from.parent()?.join(specifier);
    module_candidate(snapshot, &base)
}
fn module_candidate(snapshot: &Snapshot, base: &Path) -> Option<PathBuf> {
    for p in [
        base.with_extension("ts"),
        base.with_extension("tsx"),
        base.with_extension("d.ts"),
        base.join("index.ts"),
        base.join("index.tsx"),
        base.join("index.d.ts"),
    ] {
        let n = normalize(&p);
        if snapshot.files.contains_key(&n) {
            return Some(n);
        }
    }
    let package_json = base.join("package.json");
    if let Ok(text) = fs::read_to_string(package_json) {
        let json: serde_json::Value = serde_json::from_str(&text).ok()?;
        for key in ["types", "typings"] {
            if let Some(entry) = json.get(key).and_then(|x| x.as_str()) {
                let n = normalize(&base.join(entry));
                if snapshot.files.contains_key(&n) {
                    return Some(n);
                }
            }
        }
    }
    None
}
fn resolve_tsconfig_path(snapshot: &Snapshot, from: &Path, specifier: &str) -> Option<PathBuf> {
    let config = from
        .ancestors()
        .skip(1)
        .map(|d| d.join("tsconfig.json"))
        .find(|p| p.is_file())?;
    let root = config.parent()?.to_path_buf();
    let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&config).ok()?).ok()?;
    let options = json.get("compilerOptions")?;
    let base = root.join(
        options
            .get("baseUrl")
            .and_then(|x| x.as_str())
            .unwrap_or("."),
    );
    if let Some(paths) = options.get("paths").and_then(|x| x.as_object()) {
        for (pattern, targets) in paths {
            let capture = if let Some((a, b)) = pattern.split_once('*') {
                specifier
                    .strip_prefix(a)
                    .and_then(|rest| rest.strip_suffix(b))
            } else if pattern == specifier {
                Some("")
            } else {
                None
            };
            if let Some(capture) = capture {
                for target in targets
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|x| x.as_str())
                {
                    let mapped = target.replace('*', capture);
                    if let Some(path) = module_candidate(snapshot, &base.join(mapped)) {
                        return Some(path);
                    }
                }
            }
        }
    }
    module_candidate(snapshot, &base.join(specifier))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn project(files: &[(&str, &str)]) -> (tempfile::TempDir, Project) {
        let d = tempfile::tempdir().unwrap();
        let p = Project::new(d.path());
        for (n, s) in files {
            let path = d.path().join(n);
            fs::write(&path, s).unwrap();
            p.update(path, (*s).into(), Some(1));
        }
        (d, p)
    }
    #[test]
    fn resolves_local_and_imported() {
        let (d, p) = project(&[
            ("types.ts", "export type Status='draft'|'published';"),
            (
                "main.ts",
                "import { Status } from './types'; const x: Status='draft';",
            ),
        ]);
        let r = p.document_usages(&d.path().join("main.ts"));
        assert_eq!(r[0].domain.members.len(), 2)
    }
    #[test]
    fn rejects_open_union() {
        let (d, p) = project(&[(
            "main.ts",
            "type Status='draft'|string; const x: Status='draft';",
        )]);
        assert!(p.document_usages(&d.path().join("main.ts")).is_empty())
    }
    #[test]
    fn resolves_argument_property_satisfies_and_alias_order() {
        let (d, p) = project(&[(
            "main.ts",
            "type A='first'|'second'; type B=A|'third'; function set(x:B){} interface Item { status:B } set('first'); const a:Item={status:'second'}; const b={status:'third'} satisfies Item;",
        )]);
        let resolved = p.document_usages(&d.path().join("main.ts"));
        assert_eq!(resolved.len(), 3);
        assert_eq!(
            resolved[0]
                .domain
                .members
                .iter()
                .map(|m| m.value.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second", "third"]
        );
    }
    #[test]
    fn rejects_cycles() {
        let (d, p) = project(&[("main.ts", "type A=B|'a'; type B=A|'b'; const x:A='a';")]);
        assert!(p.document_usages(&d.path().join("main.ts")).is_empty())
    }
    #[test]
    fn resolves_tsconfig_wildcard_path() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join("src/types")).unwrap();
        fs::write(
            d.path().join("tsconfig.json"),
            r#"{"compilerOptions":{"baseUrl":".","paths":{"@types/*":["src/types/*"]}}}"#,
        )
        .unwrap();
        let p = Project::new(d.path());
        p.update(
            d.path().join("src/types/status.ts"),
            "export type Status='a'|'b';".into(),
            None,
        );
        p.update(
            d.path().join("src/main.ts"),
            "import { Status } from '@types/status'; const x:Status='a';".into(),
            None,
        );
        assert_eq!(p.document_usages(&d.path().join("src/main.ts")).len(), 1)
    }
}
