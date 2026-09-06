// Extension discovery and speculative calls share the project's TypeScript checker.
// Speculative source never enters the editor or the union worker's overlays.
const path = require('path');
const crypto = require('crypto');
const { fileURLToPath, pathToFileURL } = require('url');

module.exports = function extensions(T, root, overlays) {
  let service, configKey, scriptNames = [], options = {}, projectReferences;
  const probes = new Map();
  const declarations = new WeakMap();
  const read = file => probes.get(path.resolve(file)) ?? overlays.get(path.resolve(file))?.text ?? T.sys.readFile(file);
  const exists = file => overlays.has(path.resolve(file)) || T.sys.fileExists(file);
  const host = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => scriptNames,
    getScriptVersion: file => hash(read(file) ?? ''),
    getScriptSnapshot: file => { const text = read(file); return text === undefined ? undefined : T.ScriptSnapshot.fromString(text); },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: value => T.getDefaultLibFilePath(value),
    fileExists: exists, readFile: read, readDirectory: T.sys.readDirectory,
    directoryExists: directory => T.sys.directoryExists(directory) || [...overlays.keys()].some(file => file.startsWith(path.resolve(directory) + path.sep)),
    getDirectories: T.sys.getDirectories,
    realpath: T.sys.realpath, useCaseSensitiveFileNames: () => T.sys.useCaseSensitiveFileNames,
    getNewLine: () => '\n', getProjectReferences: () => projectReferences,
  };
  function hash(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
  function inside(file) { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && !relative.split(path.sep).includes('node_modules'); }
  function refresh(file) {
    const config = T.findConfigFile(path.dirname(file), T.sys.fileExists, 'tsconfig.json');
    const configHost = { ...T.sys, readFile: read, fileExists: exists,
      readDirectory(directory, extensions, excludes, includes, depth) {
        const disk = T.sys.readDirectory(directory, extensions, excludes, includes, depth);
        const virtual = T.matchFiles(directory, extensions, excludes, includes, T.sys.useCaseSensitiveFileNames, root, depth,
          dir => {
            const files = [], directories = new Set();
            for (const name of overlays.keys()) {
              const relative = path.relative(dir, name);
              if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
              const parts = relative.split(path.sep);
              if (parts.length === 1) files.push(parts[0]); else directories.add(parts[0]);
            }
            return { files, directories: [...directories] };
          }, value => value);
        return [...new Set([...disk, ...virtual])];
      },
    };
    const parsed = config ? T.getParsedCommandLineOfConfigFile(config, {}, { ...configHost, onUnRecoverableConfigFileDiagnostic() {} }) : null;
    options = parsed?.options ?? { strict: true, target: T.ScriptTarget.ESNext, module: T.ModuleKind.ESNext, moduleResolution: T.ModuleResolutionKind.Bundler, jsx: T.JsxEmit.Preserve };
    scriptNames = parsed?.fileNames ?? [...new Set([...T.sys.readDirectory(root, ['.ts', '.tsx'], ['**/node_modules/**', '**/.git/**']), ...overlays.keys()])];
    scriptNames = scriptNames.map(name => path.resolve(name));
    if (!scriptNames.includes(file)) scriptNames.push(file);
    projectReferences = parsed?.projectReferences;
    const key = JSON.stringify([config, options, scriptNames, projectReferences]);
    if (key !== configKey) { service?.dispose(); service = T.createLanguageService(host); configKey = key; }
    return service.getProgram();
  }
  function canonical(checker, symbol) {
    if (!symbol) return symbol;
    if (symbol.flags & T.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return checker.getExportSymbolOfSymbol(symbol);
  }
  function context(source, at) {
    let found;
    function visit(node) {
      if (at < node.getFullStart() || at > node.end) return;
      if (T.isPropertyAccessExpression(node) && at >= node.name.getStart(source) && at <= node.name.end) found = node;
      T.forEachChild(node, visit);
    }
    visit(source);
    if (!found || found.questionDotToken || found.flags & T.NodeFlags.OptionalChain) return null;
    for (let node = found.parent; node; node = node.parent) {
      if (T.isTypeNode(node) || T.isImportDeclaration(node) || T.isExportDeclaration(node)) return null;
    }
    const gap = source.text.slice(found.expression.end, found.name.getStart(source));
    if (!/^\s*\.\s*$/.test(gap)) return null;
    // The parser can attach trailing trivia to a missing name. Never complete there.
    const prefix = source.text.slice(found.name.getStart(source), at);
    if (prefix && !T.isIdentifierText(prefix, T.ScriptTarget.Latest)) return null;
    return { start: found.getStart(source), end: found.end, receiver: found.expression.getText(source), node: found,
      prefix };
  }
  function eligible(fn) {
    const first = fn.parameters.find(parameter => parameter.name.getText() !== 'this');
    return first?.type && !first.dotDotDotToken;
  }
  function requiredArguments(checker, signature, location) {
    const last = signature.parameters.at(-1);
    const declaration = last?.valueDeclaration ?? last?.declarations?.[0];
    if (!declaration?.dotDotDotToken) return signature.minArgumentCount;
    let type = checker.getTypeOfSymbolAtLocation(last, location);
    type = checker.getBaseConstraintOfType(type) ?? type;
    const minimum = checker.isTupleType(type) ? type.target.minLength : 0;
    return Math.max(signature.minArgumentCount, minimum ? signature.parameters.length - 1 + minimum : 0);
  }
  function sourceDeclarations(source) {
    if (declarations.has(source)) return declarations.get(source);
    const result = [];
    function visit(node) {
      if (T.isFunctionDeclaration(node) && node.name && eligible(node)) result.push({ name: node.name, fn: node });
      if (T.isVariableDeclaration(node) && T.isIdentifier(node.name) && node.initializer &&
          (T.isArrowFunction(node.initializer) || T.isFunctionExpression(node.initializer)) && eligible(node.initializer)) {
        result.push({ name: node.name, fn: node.initializer });
      }
      T.forEachChild(node, visit);
    }
    visit(source); declarations.set(source, result); return result;
  }
  function moduleName(source, target) {
    // Use TypeScript's own module-specifier policy (paths, NodeNext extensions, etc.).
    return T.moduleSpecifiers.getModuleSpecifier(options, source, source.fileName, target.fileName,
      T.createModuleSpecifierResolutionHost(service.getProgram(), host));
  }
  function binding(checker, source, node, symbol, target, exportName, reserved, preferredName) {
    const scope = checker.getSymbolsInScope(node, T.SymbolFlags.Value | T.SymbolFlags.Alias);
    const local = scope.find(item => canonical(checker, item) === symbol && !(item.declarations || []).some(declaration =>
      T.isImportSpecifier(declaration) && (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly) ||
      T.isImportClause(declaration) && declaration.isTypeOnly));
    if (local) return { expression: local.name, importEdit: null };
    for (const statement of source.statements) {
      const clause = T.isImportDeclaration(statement) && statement.importClause;
      if (!clause || clause.isTypeOnly || !clause.namedBindings || !T.isNamespaceImport(clause.namedBindings)) continue;
      const module = checker.getSymbolAtLocation(statement.moduleSpecifier);
      const member = module && checker.getExportsOfModule(module).find(item => canonical(checker, item) === symbol);
      if (member) return { expression: `${clause.namedBindings.name.text}.${member.name}`, importEdit: null };
    }
    if (exportName == null || target === source) return null;
    const base = preferredName;
    let name = base, suffix = 2;
    while (reserved.has(name)) name = `${base}${suffix++}`;
    reserved.add(name);
    const module = moduleName(source, target);
    const matching = source.statements.find(statement => T.isImportDeclaration(statement) && statement.importClause &&
      !statement.importClause.isTypeOnly && checker.getSymbolAtLocation(statement.moduleSpecifier) === target.symbol);
    if (matching?.importClause.namedBindings && T.isNamedImports(matching.importClause.namedBindings) && exportName !== 'default') {
      const bindings = matching.importClause.namedBindings;
      const existing = bindings.elements.map(element => element.getText(source));
      existing.push(exportName === name ? name : `${exportName} as ${name}`);
      return { expression: name, importEdit: { start: bindings.getStart(source), end: bindings.end, newText: `{ ${existing.join(', ')} }` } };
    }
    const quote = source.statements.find(T.isImportDeclaration)?.moduleSpecifier.getText(source)[0] ?? "'";
    const text = exportName === 'default' ? name : `{ ${exportName === name ? name : `${exportName} as ${name}`} }`;
    // Insert after a shebang and directive prologue, but before other statements.
    let start = source.text.startsWith('#!') ? source.text.indexOf('\n') + 1 : 0;
    for (const statement of source.statements) {
      if (T.isExpressionStatement(statement) && T.isStringLiteral(statement.expression)) start = statement.end;
      else break;
    }
    const newline = source.text.includes('\r\n') ? '\r\n' : '\n';
    return { expression: name, importEdit: { start, end: start, newText: `${start && source.text[start - 1] !== '\n' ? newline : ''}import ${text} from ${quote}${module}${quote};${newline}` } };
  }
  function apply(text, edits) {
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.newText + text.slice(edit.end);
    return text;
  }
  function compute(params) {
    for (const document of params.documents ?? []) overlays.set(path.resolve(fileURLToPath(document.textDocument.uri)), { text: document.text, version: document.clientVersion });
    const file = path.resolve(fileURLToPath(params.textDocument.uri));
    if (params.text !== undefined) overlays.set(file, { text: params.text, version: params.clientVersion });
    const program = refresh(file), source = program.getSourceFile(file);
    if (!source) return { candidates: [] };
    const at = source.getPositionOfLineAndCharacter(params.position.line, params.position.character);
    const ctx = context(source, at);
    if (!ctx) return { candidates: [] };
    const checker = program.getTypeChecker();
    const receiverType = checker.getTypeAtLocation(ctx.node.expression);
    const sources = program.getSourceFiles().filter(item => inside(item.fileName) && !program.isSourceFileDefaultLibrary(item));
    const snapshot = hash(configKey + sources.map(item => item.fileName + '\0' + item.text).join('\0'));
    // IntelliJ documents normalize disk line endings, including unopened files.
    const documents = sources.map(item => ({ uri: pathToFileURL(item.fileName).href, expectedText: item.text.replace(/\r\n?/g, '\n') }));
    const discovered = [], seen = new Set();
    for (const target of sources) {
      if (target.isDeclarationFile || !/\.ext\.tsx?$/.test(target.fileName) || !scriptNames.includes(path.resolve(target.fileName))) continue;
      const exports = target.symbol ? checker.getExportsOfModule(target.symbol) : [];
      for (const declaration of sourceDeclarations(target)) {
        const symbol = canonical(checker, checker.getSymbolAtLocation(declaration.name));
        if (!symbol || seen.has(symbol)) continue;
        seen.add(symbol);
        if (T.isFunctionDeclaration(declaration.fn) && !symbol.declarations?.some(item => T.isFunctionDeclaration(item) && item.body)) continue;
        const signatures = checker.getTypeOfSymbolAtLocation(symbol, declaration.name).getCallSignatures();
        if (!signatures.some(signature => signature.getDeclaration() && eligible(signature.getDeclaration()))) continue;
        if (!signatures.some(signature => signature.typeParameters?.length || signature.parameters[0] &&
            checker.isTypeAssignableTo(receiverType, checker.getTypeOfSymbolAtLocation(signature.parameters[0], ctx.node)))) continue;
        const exported = exports.find(item => canonical(checker, item) === symbol);
        const reserved = new Set(checker.getSymbolsInScope(ctx.node, T.SymbolFlags.Value | T.SymbolFlags.Type | T.SymbolFlags.Alias).map(item => item.name));
        const access = binding(checker, source, ctx.node, symbol, target, exported?.name, reserved, declaration.name.text);
        if (!access) continue;
        discovered.push({ id: `${pathToFileURL(target.fileName).href}#${declaration.name.getStart(target)}`, name: declaration.name.text,
          sourceModule: path.relative(root, target.fileName).replaceAll('\\', '/'), sourceFile: target.fileName, access,
          arities: [...new Set([1, ...signatures.filter(signature => signature.getDeclaration() && eligible(signature.getDeclaration()))
            .map(signature => Math.max(1, requiredArguments(checker, signature, ctx.node)))])].sort((a, b) => a - b) });
      }
    }
    const candidates = [];
    // Each probe is an ordinary call in the original lexical/control-flow context.
    for (const candidate of discovered) {
      const { expression, importEdit } = candidate.access;
      for (const arity of candidate.arities) {
        // `never` placeholders satisfy trailing parameters without widening the
        // receiver's inferred type. Try overload arities independently.
        const call = `${expression}(${ctx.receiver}${', undefined as never'.repeat(arity - 1)})`;
        const edits = [{ start: ctx.start, end: ctx.end, newText: call }, ...(importEdit ? [importEdit] : [])];
        const probe = apply(source.text, edits);
        const shift = importEdit && importEdit.start <= ctx.start ? importEdit.newText.length - (importEdit.end - importEdit.start) : 0;
        const callStart = ctx.start + shift;
        try {
          probes.set(file, probe);
          const next = service.getProgram(), nextSource = next.getSourceFile(file), nextChecker = next.getTypeChecker();
          let callNode;
          function visit(node) {
            if (T.isCallExpression(node) && node.getStart(nextSource) === callStart && node.end === callStart + call.length) callNode = node;
            if (callStart >= node.getFullStart() && callStart <= node.end) T.forEachChild(node, visit);
          }
          visit(nextSource);
          if (!callNode) continue;
          const diagnostics = next.getSemanticDiagnostics(nextSource).filter(diagnostic => diagnostic.start < callNode.end && diagnostic.start + (diagnostic.length || 0) > callStart);
          if (diagnostics.length) continue;
          const signature = nextChecker.getResolvedSignature(callNode);
          if (!signature || !signature.getDeclaration() || !eligible(signature.getDeclaration())) continue;
          if (signature.getDeclaration().getSourceFile().fileName !== candidate.sourceFile) continue;
          // Confirm receiver assignability against the instantiated signature.
          const receiverType = nextChecker.getTypeAtLocation(callNode.arguments[0]);
          const firstType = nextChecker.getTypeOfSymbolAtLocation(signature.parameters[0], callNode);
          if (!nextChecker.isTypeAssignableTo(receiverType, firstType)) continue;
          const required = requiredArguments(nextChecker, signature, callNode) > 1;
          const newText = `${expression}(${ctx.receiver}${required ? ', ' : ''})`;
          const replacement = { start: ctx.start, end: ctx.end, expectedText: source.text.slice(ctx.start, ctx.end), newText };
          const finalEdits = [replacement, ...(importEdit ? [{ ...importEdit, expectedText: source.text.slice(importEdit.start, importEdit.end) }] : [])];
          candidates.push({ id: candidate.id, name: candidate.name, sourceModule: candidate.sourceModule,
            signature: nextChecker.signatureToString(signature), remainingParameters: signature.parameters.slice(1).map(parameter => {
              const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
              return `${declaration?.dotDotDotToken ? '...' : ''}${parameter.name}${parameter.flags & T.SymbolFlags.Optional || declaration?.initializer ? '?' : ''}: ${nextChecker.typeToString(nextChecker.getTypeOfSymbolAtLocation(parameter, callNode))}`;
            }).join(', '),
            returnType: nextChecker.typeToString(nextChecker.getReturnTypeOfSignature(signature)),
            plan: { snapshot, expectedText: source.text, edits: finalEdits, caretOffset: ctx.start + shift + newText.length - (required ? 1 : 0), parameterInfo: required } });
          break;
        } finally { probes.delete(file); }
      }
    }
    return { snapshot, documents, candidates };
  }
  return {
    completions: compute,
    callPlan(params) {
      const result = compute(params);
      if (result.snapshot !== params.snapshot) return null;
      return result.candidates.find(candidate => candidate.id === params.candidateId)?.plan ?? null;
    },
  };
};
