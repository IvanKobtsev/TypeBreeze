// Extension declarations are indexed by project. Completion examines only the
// extension-file index and never builds a speculative program.
const path = require('path');
const crypto = require('crypto');
const { fileURLToPath, pathToFileURL } = require('url');

module.exports = function extensions(T, root, overlays) {
  let service, configKey, scriptNames = [], extensionFiles = [], options = {}, projectReferences;
  let indexGeneration = 0;
  let projectScans = 0;
  let watcher;
  let refreshTimer;
  const pendingChanges = new Set();
  const declarations = new WeakMap();
  const read = file => overlays.get(path.resolve(file))?.text ?? T.sys.readFile(file);
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
  function diagnosticRange(source, node) {
    const start = source.getLineAndCharacterOfPosition(node.getStart(source));
    const end = source.getLineAndCharacterOfPosition(node.end);
    return { start, end };
  }
  function flushChanges() {
    if (!pendingChanges.size) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
    const changes = [...pendingChanges]; pendingChanges.clear();
    if (changes.some(file => /^(tsconfig|jsconfig)\.json$/i.test(path.basename(file)))) {
      service?.dispose(); service = undefined; configKey = undefined;
    } else {
      service?.cleanupSemanticCache?.();
      for (const file of changes.filter(file => /\.ext\.tsx?$/.test(file) && inside(file))) {
        if (!extensionFiles.includes(file)) extensionFiles.push(file);
        if (!scriptNames.includes(file)) scriptNames.push(file);
      }
    }
    indexGeneration++;
  }
  function queueChange(changed) {
    const file = path.isAbsolute(changed) ? path.resolve(changed) : path.resolve(root, changed);
    if (!/\.(?:ts|tsx|json)$/i.test(file)) return;
    pendingChanges.add(file);
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(flushChanges, 75);
  }
  function inside(file) { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && !relative.split(path.sep).includes('node_modules'); }
  function refresh(file) {
    file = path.resolve(file);
    if (service) {
      if (!scriptNames.includes(file)) scriptNames.push(file);
      return service.getProgram();
    }
    projectScans++;
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
    if (key !== configKey) {
      service?.dispose(); service = T.createLanguageService(host); configKey = key;
      extensionFiles = scriptNames.filter(name => /\.ext\.tsx?$/.test(name) && inside(name));
      indexGeneration++;
    }
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
    if (!found) {
      // In incomplete code followed by another statement, TypeScript may attach
      // the missing property name to that following token. Recover from the
      // caret instead: find the access operator immediately before the typed
      // prefix, then locate the widest AST expression ending at the receiver.
      let prefixStart = at;
      while (prefixStart > 0 && /[\w$]/.test(source.text[prefixStart - 1])) prefixStart--;
      let dot = prefixStart;
      while (dot > 0 && /\s/.test(source.text[dot - 1])) dot--;
      if (!dot || source.text[dot - 1] !== '.') return null;
      dot--;
      let receiverEnd = dot;
      const optionalAccess = dot > 0 && source.text[dot - 1] === '?';
      if (optionalAccess) receiverEnd--;
      while (receiverEnd > 0 && /\s/.test(source.text[receiverEnd - 1])) receiverEnd--;
      let receiver;
      function findReceiver(node) {
        if (node.end < receiverEnd || node.getFullStart() > receiverEnd) return;
        if (node.end === receiverEnd && node.getStart(source) < receiverEnd &&
            (!receiver || node.getStart(source) < receiver.getStart(source))) receiver = node;
        T.forEachChild(node, findReceiver);
      }
      findReceiver(source);
      if (!receiver) return null;
      for (let node = receiver.parent; node; node = node.parent) {
        if (T.isTypeNode(node) || T.isImportDeclaration(node) || T.isExportDeclaration(node)) return null;
      }
      let end = at;
      while (end < source.text.length && /[\w$]/.test(source.text[end])) end++;
      return { start: receiver.getStart(source), end, receiver: receiver.getText(source), node: receiver,
        prefix: source.text.slice(prefixStart, at), optionalAccess, recovered: true };
    }
    for (let node = found.parent; node; node = node.parent) {
      if (T.isTypeNode(node) || T.isImportDeclaration(node) || T.isExportDeclaration(node)) return null;
    }
    const gap = source.text.slice(found.expression.end, found.name.getStart(source));
    const optionalAccess = /^\s*\?\.\s*$/.test(gap);
    if (!optionalAccess && !/^\s*\.\s*$/.test(gap)) return null;
    // The parser can attach trailing trivia to a missing name. Never complete there.
    const prefix = source.text.slice(found.name.getStart(source), at);
    if (prefix && !T.isIdentifierText(prefix, T.ScriptTarget.Latest)) return null;
    return { start: found.getStart(source), end: found.end, receiver: found.expression.getText(source), node: found,
      prefix, optionalAccess };
  }
  function receiverInfo(checker, fn) {
    const fail = problem => ({ problem, kind: 'ordinary' });
    if (!fn?.parameters) return fail('A callable implementation is required.');
    const thisParameter = fn.parameters.find(parameter => parameter.name.getText() === 'this');
    if (thisParameter && checker.typeToString(checker.getTypeAtLocation(thisParameter)) !== 'void') return fail('Functions requiring a bound this are not supported.');
    const first = fn.parameters.find(parameter => parameter.name.getText() !== 'this');
    if (!first) return fail('An explicitly typed first argument is required.');
    if (first.dotDotDotToken) return fail('A rest parameter cannot be the extension receiver.');
    if (!first.type) return fail('The first argument must have an explicit concrete type.');

    // `Error | unknown` reduces to `unknown` in the checker. Retain the source
    // declaration shape (including aliases), otherwise it is indistinguishable
    // from the unsupported standalone `unknown` receiver.
    const visitingAliases = new Set();
    function aliasTarget(node) {
      if (!T.isTypeReferenceNode(node)) return null;
      let symbol = checker.getSymbolAtLocation(node.typeName);
      if (symbol?.flags & T.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      return symbol?.declarations?.find(T.isTypeAliasDeclaration)?.type ?? null;
    }
    const visitingStandaloneAliases = new Set();
    function resolvesStandaloneUnknown(node) {
      if (T.isParenthesizedTypeNode(node)) return resolvesStandaloneUnknown(node.type);
      if (node.kind === T.SyntaxKind.UnknownKeyword) return true;
      const target = aliasTarget(node);
      if (!target || visitingStandaloneAliases.has(target.parent)) return false;
      visitingStandaloneAliases.add(target.parent);
      const result = resolvesStandaloneUnknown(target);
      visitingStandaloneAliases.delete(target.parent);
      return result;
    }
    function syntaxFacts(node) {
      if (!node) return { unknown: false, nestedUnknown: false, unknownUnion: false, any: false, typeParameter: false };
      if (T.isParenthesizedTypeNode(node)) return syntaxFacts(node.type);
      if (node.kind === T.SyntaxKind.UnknownKeyword) return { unknown: true, nestedUnknown: false, unknownUnion: false, any: false, typeParameter: false };
      if (node.kind === T.SyntaxKind.AnyKeyword) return { unknown: false, nestedUnknown: false, unknownUnion: false, any: true, typeParameter: false };
      if (T.isTypeReferenceNode(node)) {
        const symbol = checker.getSymbolAtLocation(node.typeName);
        const typeParameter = !!(symbol?.flags & T.SymbolFlags.TypeParameter) ||
          !!(checker.getTypeAtLocation(node).flags & T.TypeFlags.TypeParameter);
        const argumentsFacts = (node.typeArguments ?? []).map(syntaxFacts);
        const target = aliasTarget(node);
        let targetFacts = { unknown: false, nestedUnknown: false, unknownUnion: false, any: false, typeParameter: false };
        if (target) {
          const declaration = target.parent;
          if (!visitingAliases.has(declaration)) {
            visitingAliases.add(declaration);
            targetFacts = syntaxFacts(target);
            visitingAliases.delete(declaration);
          }
        }
        const all = [targetFacts, ...argumentsFacts];
        return { unknown: all.some(item => item.unknown), nestedUnknown: all.some(item => item.nestedUnknown),
          unknownUnion: targetFacts.unknownUnion, any: all.some(item => item.any),
          typeParameter: typeParameter || argumentsFacts.some(item => item.typeParameter) };
      }
      if (T.isUnionTypeNode(node)) {
        const parts = node.types.map(syntaxFacts);
        const directUnknown = node.types.some(resolvesStandaloneUnknown);
        const unknownUnion = node.types.length > 1 && (directUnknown || parts.some(part => part.unknownUnion));
        return { unknown: parts.some(item => item.unknown),
          nestedUnknown: parts.some(item => item.nestedUnknown) || parts.some((item, index) => item.unknown &&
            !item.unknownUnion && !resolvesStandaloneUnknown(node.types[index])),
          unknownUnion, any: parts.some(item => item.any), typeParameter: parts.some(item => item.typeParameter) };
      }
      const children = [];
      T.forEachChild(node, child => { children.push(syntaxFacts(child)); });
      return { unknown: children.some(item => item.unknown), nestedUnknown: children.some(item => item.unknown),
        unknownUnion: false, any: children.some(item => item.any), typeParameter: children.some(item => item.typeParameter) };
    }
    const facts = syntaxFacts(first.type);
    const seen = new Set();
    function nonConcrete(type) {
      if (!type || seen.has(type)) return false;
      seen.add(type);
      if (type.flags & (T.TypeFlags.TypeParameter | T.TypeFlags.Any)) return true;
      if (type.flags & T.TypeFlags.Unknown) return !facts.unknownUnion;
      if (type.isUnionOrIntersection?.() && type.types.some(nonConcrete)) return true;
      if (type.aliasTypeArguments?.some(nonConcrete) || type.typeArguments?.some(nonConcrete)) return true;
      const constraint = checker.getBaseConstraintOfType(type);
      return constraint && constraint !== type ? nonConcrete(constraint) : false;
    }
    if (facts.any || facts.typeParameter || facts.nestedUnknown || !facts.unknownUnion && facts.unknown || nonConcrete(checker.getTypeAtLocation(first.type))) {
      return fail('The first argument type must not contain type parameters, any, or standalone or nested unknown.');
    }
    return { problem: null, kind: facts.unknownUnion ? 'unknownUnion' : 'ordinary' };
  }
  function receiverProblem(checker, fn) { return receiverInfo(checker, fn).problem; }
  function singletonReceiverKind(type) {
    if (type.flags & T.TypeFlags.Never) return T.TypeFlags.Never;
    if (type.flags & T.TypeFlags.Null) return T.TypeFlags.Null;
    if (type.flags & T.TypeFlags.Undefined) return T.TypeFlags.Undefined;
    return 0;
  }
  function receiverCompatible(checker, receiverType, parameterType, receiverKind = 'ordinary') {
    // never is assignable to everything, while null/undefined are assignable to
    // every union containing them. Those rules are useful for type checking but
    // disastrous for extension discovery: a narrowed nullish/impossible value
    // would otherwise expose unrelated methods. Singleton receivers therefore
    // match only an extension declared for that exact singleton type.
    const singleton = singletonReceiverKind(receiverType);
    if (singleton) return singletonReceiverKind(parameterType) === singleton;
    if (receiverKind === 'unknownUnion') return !!(receiverType.flags & T.TypeFlags.Unknown);
    return checker.isTypeAssignableTo(receiverType, parameterType);
  }
  function supportsOptionalAccess(checker, receiverType, signature, declaration, location) {
    const parameter = declaration.parameters.find(item => item.name.getText() !== 'this');
    if (!parameter) return false;
    const symbol = signature.parameters.find(item => item.name !== 'this');
    if (!symbol) return false;
    const parameterType = checker.getTypeOfSymbolAtLocation(symbol, location);
    const receiverParts = receiverType.isUnion?.() ? receiverType.types : [receiverType];
    const parameterParts = parameterType.isUnion?.() ? parameterType.types : [parameterType];
    const receiverHasNull = receiverParts.some(part => part.flags & T.TypeFlags.Null);
    const receiverHasUndefined = receiverParts.some(part => part.flags & T.TypeFlags.Undefined);
    const parameterHasNull = parameterParts.some(part => part.flags & T.TypeFlags.Null);
    const parameterHasUndefined = parameter.questionToken || parameterParts.some(part => part.flags & T.TypeFlags.Undefined);
    return (!receiverHasNull || parameterHasNull) && (!receiverHasUndefined || parameterHasUndefined);
  }
  function declaredReceiverType(checker, node) {
    const symbolNode = T.isPropertyAccessExpression(node) ? node.name : node;
    let symbol = checker.getSymbolAtLocation(symbolNode);
    if (!symbol) return null;
    if (symbol.flags & T.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    return declaration ? checker.getTypeOfSymbolAtLocation(symbol, declaration) : null;
  }
  function eligibleExtensionSymbols(program) {
    const checker = program.getTypeChecker(), result = new Map();
    for (const extensionFile of extensionFiles) {
      const source = program.getSourceFile(extensionFile);
      if (!source || source.isDeclarationFile) continue;
      for (const declaration of sourceDeclarations(source)) {
        const symbol = canonical(checker, checker.getSymbolAtLocation(declaration.name));
        if (!symbol || result.has(symbol)) continue;
        if (T.isFunctionDeclaration(declaration.fn) && !symbol.declarations?.some(item => T.isFunctionDeclaration(item) && item.body)) continue;
        const signatures = checker.getTypeOfSymbolAtLocation(symbol, declaration.name).getCallSignatures();
        if (signatures.length !== 1 || receiverProblem(checker, signatures[0].getDeclaration())) continue;
        result.set(symbol, declaration);
      }
    }
    return result;
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
      if (T.isFunctionDeclaration(node) && node.name) result.push({ name: node.name, fn: node });
      if (T.isVariableDeclaration(node) && T.isIdentifier(node.name) && node.initializer &&
          (T.isArrowFunction(node.initializer) || T.isFunctionExpression(node.initializer))) {
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
  function compute(params) {
    flushChanges();
    for (const document of params.documents ?? []) {
      const documentFile = path.resolve(fileURLToPath(document.textDocument.uri));
      overlays.set(documentFile, { text: document.text, version: document.clientVersion });
      if (/\.ext\.tsx?$/.test(documentFile) && inside(documentFile) && !extensionFiles.includes(documentFile)) { extensionFiles.push(documentFile); scriptNames.push(documentFile); indexGeneration++; }
    }
    const file = path.resolve(fileURLToPath(params.textDocument.uri));
    if (params.text !== undefined) overlays.set(file, { text: params.text, version: params.clientVersion });
    const program = refresh(file), source = program.getSourceFile(file);
    if (!source) return { candidates: [] };
    const at = source.getPositionOfLineAndCharacter(params.position.line, params.position.character);
    const ctx = context(source, at);
    if (!ctx) return { candidates: [] };
    const checker = program.getTypeChecker();
    let receiverType = checker.getTypeAtLocation(ctx.node.expression ?? ctx.node);
    // A recovered incomplete optional chain can make TypeScript expose the
    // non-nullable property-lookup type for its receiver. Recover the declared
    // union so optional/nullish filtering still sees the original constituents.
    if (ctx.recovered && ctx.optionalAccess) receiverType = declaredReceiverType(checker, ctx.node) ?? receiverType;
    const snapshot = String(indexGeneration);
    const documents = extensionFiles.map(name => program.getSourceFile(name)).filter(Boolean)
      .map(item => ({ uri: pathToFileURL(item.fileName).href, expectedText: item.text.replace(/\r\n?/g, '\n') }));
    const discovered = [], seen = new Set();
    for (const extensionFile of extensionFiles) {
      const target = program.getSourceFile(extensionFile);
      if (!target || target.isDeclarationFile) continue;
      const exports = target.symbol ? checker.getExportsOfModule(target.symbol) : [];
      for (const declaration of sourceDeclarations(target)) {
        if (ctx.prefix && !declaration.name.text.toLowerCase().startsWith(ctx.prefix.toLowerCase())) continue;
        const symbol = canonical(checker, checker.getSymbolAtLocation(declaration.name));
        if (!symbol || seen.has(symbol)) continue;
        seen.add(symbol);
        if (T.isFunctionDeclaration(declaration.fn) && !symbol.declarations?.some(item => T.isFunctionDeclaration(item) && item.body)) continue;
        const signatures = checker.getTypeOfSymbolAtLocation(symbol, declaration.name).getCallSignatures();
        if (signatures.length !== 1) continue;
        const preview = signatures[0], signatureDeclaration = preview.getDeclaration();
        if (!signatureDeclaration) continue;
        const receiver = receiverInfo(checker, signatureDeclaration);
        if (receiver.problem) continue;
        if (ctx.optionalAccess && !supportsOptionalAccess(checker, receiverType, preview, signatureDeclaration, ctx.node)) continue;
        const receiverSymbol = preview.parameters.find(parameter => parameter.name !== 'this');
        if (!receiverSymbol || !receiverCompatible(checker, receiverType, checker.getTypeOfSymbolAtLocation(receiverSymbol, ctx.node), receiver.kind)) continue;
        const exported = exports.find(item => canonical(checker, item) === symbol);
        const reserved = new Set(checker.getSymbolsInScope(ctx.node, T.SymbolFlags.Value | T.SymbolFlags.Type | T.SymbolFlags.Alias).map(item => item.name));
        const access = binding(checker, source, ctx.node, symbol, target, exported?.name, reserved, declaration.name.text);
        if (!access) continue;
        discovered.push({ id: `${pathToFileURL(target.fileName).href}#${declaration.name.getStart(target)}`, name: declaration.name.text,
          sourceModule: path.relative(root, target.fileName).replaceAll('\\', '/'), sourceFile: target.fileName, access,
          signature: preview ? checker.signatureToString(preview) : '',
          remainingParameters: preview ? preview.parameters.slice(1).map(parameter => {
            const parameterDeclaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
            return `${parameterDeclaration?.dotDotDotToken ? '...' : ''}${parameter.name}${parameter.flags & T.SymbolFlags.Optional || parameterDeclaration?.initializer ? '?' : ''}: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(parameter, ctx.node))}`;
          }).join(', ') : '',
          returnType: checker.typeToString(checker.getReturnTypeOfSignature(preview)), preview });
      }
    }
    const candidates = [];
    for (const candidate of discovered) {
      const { expression, importEdit } = candidate.access;
      const required = requiredArguments(checker, candidate.preview, ctx.node) > 1;
      const newText = `${expression}(${ctx.receiver}${required ? ', ' : ''})`;
      const replacement = { start: ctx.start, end: ctx.end, expectedText: source.text.slice(ctx.start, ctx.end), newText };
      const finalEdits = [replacement, ...(importEdit ? [{ ...importEdit, expectedText: source.text.slice(importEdit.start, importEdit.end) }] : [])];
      const shift = importEdit && importEdit.start <= ctx.start ? importEdit.newText.length - (importEdit.end - importEdit.start) : 0;
      candidates.push({ id: candidate.id, name: candidate.name, sourceModule: candidate.sourceModule,
        signature: candidate.signature, remainingParameters: candidate.remainingParameters, returnType: candidate.returnType,
        plan: { snapshot, expectedText: source.text, edits: finalEdits, caretOffset: ctx.start + shift + newText.length - (required ? 1 : 0), parameterInfo: required } });
    }
    return { snapshot, expectedText: source.text, documents, candidates };
  }
  return {
    completions: compute,
    diagnostics() {
      flushChanges();
      const program = refresh(path.join(root, '__typebreeze__.ts'));
      const checker = program.getTypeChecker(), result = [];
      for (const extensionFile of extensionFiles) {
        const source = program.getSourceFile(extensionFile);
        if (!source || source.isDeclarationFile) { result.push({ uri: pathToFileURL(extensionFile).href, diagnostics: [] }); continue; }
        const diagnostics = [], seen = new Set();
        for (const declaration of sourceDeclarations(source)) {
          const symbol = canonical(checker, checker.getSymbolAtLocation(declaration.name));
          if (!symbol || seen.has(symbol)) continue;
          seen.add(symbol);
          const signatures = checker.getTypeOfSymbolAtLocation(symbol, declaration.name).getCallSignatures();
          let problem = signatures.length > 1 ? 'Overloaded functions are not supported.' :
            signatures.length === 1 ? receiverProblem(checker, signatures[0].getDeclaration()) : 'A callable implementation is required.';
          if (T.isFunctionDeclaration(declaration.fn) && !symbol.declarations?.some(item => T.isFunctionDeclaration(item) && item.body)) problem = 'A callable implementation is required.';
          if (problem) diagnostics.push({ range: diagnosticRange(source, declaration.name), severity: 2, source: 'TypeBreeze',
            message: `${problem} This function will not appear in TypeBreeze extension suggestions.` });
        }
        result.push({ uri: pathToFileURL(extensionFile).href, diagnostics });
      }
      return result;
    },
    documentExtensions(params) {
      flushChanges();
      const file = path.resolve(fileURLToPath(params.textDocument.uri));
      if (params.text !== undefined) overlays.set(file, { text: params.text, version: params.clientVersion });
      const program = refresh(file), source = program.getSourceFile(file);
      if (!source) return null;
      const checker = program.getTypeChecker(), symbols = eligibleExtensionSymbols(program), occurrences = [], seen = new Set();
      const add = (node, kind) => {
        const start = node.getStart(source), end = node.end, key = `${start}:${end}:${kind}`;
        if (!seen.has(key)) { seen.add(key); occurrences.push({ range: diagnosticRange(source, node), kind }); }
      };
      if (/\.ext\.tsx?$/.test(file)) {
        for (const declaration of sourceDeclarations(source)) {
          const symbol = canonical(checker, checker.getSymbolAtLocation(declaration.name));
          if (symbols.has(symbol)) add(declaration.name, 'declaration');
        }
      }
      function visit(node) {
        if (T.isCallExpression(node)) {
          const callee = T.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
          const symbol = canonical(checker, checker.getSymbolAtLocation(callee));
          if (symbols.has(symbol)) add(callee, 'call');
        }
        T.forEachChild(node, visit);
      }
      visit(source);
      return { clientVersion: params.clientVersion ?? null, generation: indexGeneration, occurrences };
    },
    update(file) {
      file = path.resolve(file); if (!scriptNames.includes(file)) scriptNames.push(file);
      if (/\.ext\.tsx?$/.test(file) && inside(file)) { if (!extensionFiles.includes(file)) extensionFiles.push(file); indexGeneration++; }
    },
    initialize() {
      refresh(path.join(root, '__typebreeze__.ts'));
      watcher ??= T.sys.watchDirectory?.(root, queueChange, true);
    },
    stats() { return { projectScans, extensionFiles: extensionFiles.length, generation: indexGeneration }; },
    dispose() { if (refreshTimer) clearTimeout(refreshTimer); watcher?.close(); service?.dispose(); },
  };
};
