const readline = require('readline');
const path = require('path');
const fs = require('fs');
const { pathToFileURL, fileURLToPath } = require('url');

let root = process.cwd();
const overlays = new Map();
let ts;
let languageService;
let extensionService;

function loadTypeScript() {
  if (ts) return ts;
  const candidates = [root, process.cwd(), __dirname, ...(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)];
  ts = require(require.resolve('typescript', { paths: candidates }));
  return ts;
}
function position(source, offset) {
  const point = source.getLineAndCharacterOfPosition(offset);
  return { line: point.line, character: point.character };
}
function range(source, start, end) { return { start: position(source, start), end: position(source, end) }; }
function offset(source, point) { return source.getPositionOfLineAndCharacter(point.line, point.character); }
function uri(file) { return pathToFileURL(path.resolve(file)).href; }
function createLanguageService() {
  const T = loadTypeScript();
  const config = T.findConfigFile(root, T.sys.fileExists, 'tsconfig.json');
  let names, options;
  if (config) {
    const parsed = T.parseJsonConfigFileContent(T.readConfigFile(config, T.sys.readFile).config, T.sys, path.dirname(config));
    names = parsed.fileNames; options = parsed.options;
  } else { names = [...overlays.keys()]; options = { allowJs: false, jsx: T.JsxEmit.Preserve, moduleResolution: T.ModuleResolutionKind.Bundler }; }
  const host = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...new Set([...names, ...overlays.keys()])],
    getScriptVersion: name => String(overlays.get(path.resolve(name))?.version ?? statVersion(name)),
    getScriptSnapshot: name => { const text=overlays.get(path.resolve(name))?.text ?? T.sys.readFile(name);return text===undefined?undefined:T.ScriptSnapshot.fromString(text); },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: value => T.getDefaultLibFilePath(value),
    fileExists: T.sys.fileExists,
    readFile: T.sys.readFile,
    readDirectory: T.sys.readDirectory,
    directoryExists: T.sys.directoryExists,
    getDirectories: T.sys.getDirectories,
    realpath: T.sys.realpath,
    useCaseSensitiveFileNames: () => T.sys.useCaseSensitiveFileNames,
    getNewLine: () => T.sys.newLine,
  };
  return T.createLanguageService(host, T.createDocumentRegistry());
}
function statVersion(name) { try { return fs.statSync(name).mtimeMs; } catch { return 0; } }
function createProgram() { if(!languageService)languageService=createLanguageService();return languageService.getProgram(); }
function syncParams(params){if(params.text===undefined)return;const file=path.resolve(fileURLToPath(params.textDocument.uri));const version=params.clientVersion??params.version??0;const old=overlays.get(file);if(!old||old.version!==version||old.text!==params.text)overlays.set(file,{text:params.text,version});}
function enclosingString(T, source, at) {
  let found;
  function visit(node) { if (at >= node.getStart(source) && at <= node.getEnd()) { if (T.isStringLiteralLike(node)) found = node; T.forEachChild(node, visit); } }
  visit(source); return found;
}
function declarationLocation(T, symbol, fallbackSource, fallbackNode) {
  const declaration = symbol?.declarations?.[0];
  if (!declaration) return { uri: uri(fallbackSource.fileName), range: range(fallbackSource, fallbackNode.getStart(fallbackSource), fallbackNode.getEnd()) };
  const source = declaration.getSourceFile();
  return { uri: uri(source.fileName), range: range(source, declaration.getStart(source), declaration.getEnd()) };
}
function canonicalSymbol(T, checker, symbol) {
  const seen=new Set();let current=symbol;
  while(current&&(current.flags&T.SymbolFlags.Alias)&&!seen.has(current)){seen.add(current);const next=checker.getAliasedSymbol(current);if(!next||next===current)break;current=next;}
  return current;
}
function finiteParts(T,type){const parts=type?(type.isUnion()?type.types:[type]):[];const strings=parts.filter(item=>item.flags&T.TypeFlags.StringLiteral);const invalid=parts.filter(item=>!(item.flags&T.TypeFlags.StringLiteral)&&!(item.flags&(T.TypeFlags.Undefined|T.TypeFlags.Null)));return{parts,strings,valid:strings.length>=2&&strings.length<=100&&!invalid.length};}
function contextualTypeForLiteral(T,checker,node){
  let contextual=checker.getContextualType(node);if(finiteParts(T,contextual).valid)return contextual;
  // Inference specializes `T extends DomainType` to this one literal. Recover
  // the declared constraint from the selected signature, not unrelated overloads.
  if (T.isCallExpression(node.parent) && !node.parent.typeArguments?.length) {
    const call = node.parent;
    const index = call.arguments.indexOf(node);
    const parameter = checker.getResolvedSignature(call)?.getDeclaration()?.parameters[index];
    if (parameter?.type && !parameter.dotDotDotToken) {
      const declared = checker.getTypeFromTypeNode(parameter.type);
      if (declared.flags & T.TypeFlags.TypeParameter) {
        const constraint = checker.getBaseConstraintOfType(declared);
        if (finiteParts(T, constraint).valid) return constraint;
      }
    }
  }
  if(T.isPropertyAssignment(node.parent)){const object=node.parent.parent;const objectTypes=[checker.getContextualType(object)];if(T.isCallExpression(object.parent)){const argumentIndex=object.parent.arguments.indexOf(object);const signature=checker.getResolvedSignature(object.parent);const parameter=signature?.parameters[Math.min(argumentIndex,signature.parameters.length-1)];if(parameter){objectTypes.push(checker.getTypeOfSymbolAtLocation(parameter,object));const declaration=parameter.declarations?.find(item=>item.type);if(declaration?.type)objectTypes.push(checker.getTypeFromTypeNode(declaration.type));}}for(let objectType of objectTypes){if(objectType?.flags&T.TypeFlags.TypeParameter)objectType=checker.getBaseConstraintOfType(objectType);const property=objectType?.getProperty(node.parent.name.getText(node.getSourceFile()));if(property){const propertyType=checker.getTypeOfSymbolAtLocation(property,node);if(finiteParts(T,propertyType).valid)return propertyType;}}}
  if(T.isBinaryExpression(node.parent)&&[T.SyntaxKind.EqualsEqualsEqualsToken,T.SyntaxKind.ExclamationEqualsEqualsToken,T.SyntaxKind.EqualsEqualsToken,T.SyntaxKind.ExclamationEqualsToken].includes(node.parent.operatorToken.kind)){const other=node.parent.left===node?node.parent.right:node.parent.left;const symbol=checker.getSymbolAtLocation(other);let otherType=symbol?.valueDeclaration?checker.getTypeOfSymbolAtLocation(symbol,symbol.valueDeclaration):checker.getTypeAtLocation(other);if(otherType?.flags&T.TypeFlags.TypeParameter)otherType=checker.getBaseConstraintOfType(otherType);if(finiteParts(T,otherType).valid)return otherType;}
  return contextual;
}
function resolveNode(program, source, node) {
  const T = loadTypeScript();
  if (node.parent && T.isLiteralTypeNode(node.parent)) return null;
  const checker = program.getTypeChecker();
  const contextual = contextualTypeForLiteral(T,checker,node);
  if (!contextual) return null;
  const parts = contextual.isUnion() ? contextual.types : [contextual];
  const stringParts = parts.filter(type => type.flags & T.TypeFlags.StringLiteral);
  const invalid = parts.filter(type => !(type.flags & T.TypeFlags.StringLiteral) && !(type.flags & (T.TypeFlags.Undefined | T.TypeFlags.Null)));
  if (stringParts.length < 2 || stringParts.length > 100 || invalid.length) return null;
  const values = []; const seen = new Set();
  for (const type of stringParts) if (!seen.has(type.value)) { seen.add(type.value); values.push(type.value); }
  if (!values.includes(node.text)) return null;
  let alias = contextual.aliasSymbol || contextual.getSymbol?.();
  if (!alias && T.isPropertyAssignment(node.parent)) {
    const objectType = checker.getContextualType(node.parent.parent);
    const property = objectType?.getProperty(node.parent.name.getText(source));
    const declaration = property?.declarations?.find(item => item.type);
    if (declaration?.type && T.isTypeReferenceNode(declaration.type)) alias = checker.getSymbolAtLocation(declaration.type.typeName);
  }
  alias=canonicalSymbol(T,checker,alias);
  const rendered = checker.typeToString(contextual);
  const inferredName = rendered.split('|').map(x => x.trim()).find(x => /^[A-Za-z_$][\w$]*$/.test(x) && x !== 'undefined' && x !== 'null');
  if (!alias && inferredName) {
    for (const candidateSource of program.getSourceFiles()) {
      const visit = candidate => {
        if (alias || !T.isTypeAliasDeclaration(candidate) || candidate.name.text !== inferredName) return T.forEachChild(candidate, visit);
        const candidateType = checker.getTypeFromTypeNode(candidate.type); const candidateParts = candidateType.isUnion() ? candidateType.types : [candidateType];
        const candidateValues = candidateParts.filter(type => type.flags & T.TypeFlags.StringLiteral).map(type => type.value);
        if (candidateValues.length === values.length && candidateValues.every(value => values.includes(value))) alias = checker.getSymbolAtLocation(candidate.name);
      };
      visit(candidateSource);
      if (alias) break;
    }
  }
  const typeName = alias?.getName?.() || inferredName || rendered;
  const domain = declarationLocation(T, alias, source, node);
  const declaration = alias?.declarations?.find(T.isTypeAliasDeclaration);
  const declared = [];
  if (declaration) {
    let order = 0;
    const visit = child => { if (T.isLiteralTypeNode(child) && T.isStringLiteralLike(child.literal) && values.includes(child.literal.text)) declared.push({ value: child.literal.text, declaration: { uri: uri(child.getSourceFile().fileName), range: range(child.getSourceFile(), child.literal.getStart(), child.literal.getEnd()) }, deprecated: false, declarationOrder: order++ }); else T.forEachChild(child, visit); };
    visit(declaration.type);
  }
  const members = [...declared];
  for (const value of values) if (!members.some(member => member.value === value)) members.push({ value, declaration: domain, deprecated: false, declarationOrder: members.length });
  return { range: range(source, node.getStart(source), node.getEnd()), kind: 'usage', currentValue: node.text, contextualTypeName: typeName, domain, declaredMembers: members, assignableMembers: members };
}
function declarationNode(program, source, node) {
  const T=loadTypeScript();if(!node.parent||!T.isLiteralTypeNode(node.parent))return null;let alias=node.parent.parent;while(alias&&!T.isTypeAliasDeclaration(alias))alias=alias.parent;if(!alias)return null;
  const checker=program.getTypeChecker();const type=checker.getTypeFromTypeNode(alias.type);const parts=type.isUnion()?type.types:[type];if(parts.length<2||parts.length>100||parts.some(item=>!(item.flags&T.TypeFlags.StringLiteral)))return null;
  const symbol=checker.getSymbolAtLocation(alias.name);const domain=declarationLocation(T,symbol,source,alias);const values=[];const declarations=[];let order=0;
  const visit=child=>{if(T.isLiteralTypeNode(child)&&T.isStringLiteralLike(child.literal)&&!values.includes(child.literal.text)){values.push(child.literal.text);declarations.push({value:child.literal.text,declaration:{uri:uri(source.fileName),range:range(source,child.literal.getStart(source),child.literal.getEnd())},deprecated:false,declarationOrder:order++});}else T.forEachChild(child,visit);};visit(alias.type);
  if(!values.includes(node.text))return null;return{range:range(source,node.getStart(source),node.getEnd()),kind:'declaration',currentValue:node.text,contextualTypeName:alias.name.text,domain,declaredMembers:declarations,assignableMembers:[]};
}
function resolve(params) {
  syncParams(params);
  const program = createProgram(); const file = path.resolve(fileURLToPath(params.textDocument.uri));
  const source = program.getSourceFile(file); if (!source) return null;
  const node = enclosingString(loadTypeScript(), source, offset(source, params.position));
  return node ? declarationNode(program, source, node) || resolveNode(program, source, node) : null;
}
function documentUnions(params) {
  syncParams(params);
  const program = createProgram(); const file = path.resolve(fileURLToPath(params.textDocument.uri));
  const source = program.getSourceFile(file); if (!source) return null;
  const literals = []; const T = loadTypeScript();
  const visit = node => { if (T.isStringLiteralLike(node)) { const item = declarationNode(program,source,node)||resolveNode(program, source, node); if (item) literals.push(item); } T.forEachChild(node, visit); };
  visit(source);
  if (params.includeUsages !== false) markDeclarationUsages(program,literals);
  return { version: null, clientVersion: params.clientVersion ?? null, generation: Date.now(), literals };
}
function locationKey(location){const value=location.range;return `${location.uri}:${value.start.line}:${value.start.character}:${value.end.line}:${value.end.character}`;}
function sameLocation(left,right){return locationKey(left)===locationKey(right);}
function markDeclarationUsages(program,literals){
  const declarations=literals.filter(item=>item.kind==='declaration');if(!declarations.length)return;
  for(const declaration of declarations)declaration.usageLocations=[];
  const wanted=new Map(declarations.map(item=>[`${locationKey(item.domain)}\0${item.currentValue}`,item]));
  const values=new Set(declarations.map(item=>item.currentValue));const simple=[...values].filter(value=>/^[\w .:/-]+$/.test(value));const T=loadTypeScript();
  for(const candidateSource of program.getSourceFiles()){if(candidateSource.isDeclarationFile||(simple.length===values.size&&!simple.some(value=>candidateSource.text.includes(value))))continue;const visit=child=>{if(T.isStringLiteralLike(child)&&values.has(child.text)){const usage=resolveNode(program,candidateSource,child);if(usage){const declaration=wanted.get(`${locationKey(usage.domain)}\0${usage.currentValue}`);if(declaration){declaration.hasUsages=true;const location={uri:uri(candidateSource.fileName),range:usage.range};if(!declaration.usageLocations.some(existing=>sameLocation(existing,location)))declaration.usageLocations.push(location);}}}T.forEachChild(child,visit);};visit(candidateSource);}
  for(const declaration of declarations)declaration.hasUsages=declaration.hasUsages===true;
}
function navigationTargets(params){
  syncParams(params);
  const program=createProgram();const file=path.resolve(fileURLToPath(params.textDocument.uri));const source=program.getSourceFile(file);if(!source)return[];const T=loadTypeScript();const node=enclosingString(T,source,offset(source,params.position));if(!node)return[];
  const usage=resolveNode(program,source,node);if(usage){const member=usage.declaredMembers.find(item=>item.value===usage.currentValue);return member?[member.declaration]:[];}
  const declaration=declarationNode(program,source,node);if(!declaration)return[];const targets=[];
  const sameRange=(left,right)=>left.start.line===right.start.line&&left.start.character===right.start.character&&left.end.line===right.end.line&&left.end.character===right.end.character;
  const canPrefilter=/^[\w .:/-]+$/.test(declaration.currentValue);
  for(const candidateSource of program.getSourceFiles()){if(candidateSource.isDeclarationFile||(canPrefilter&&!candidateSource.text.includes(declaration.currentValue)))continue;const visit=child=>{if(T.isStringLiteralLike(child)&&child.text===declaration.currentValue){const item=resolveNode(program,candidateSource,child);if(item&&item.domain.uri===declaration.domain.uri&&sameRange(item.domain.range,declaration.domain.range))targets.push({uri:uri(candidateSource.fileName),range:item.range});}T.forEachChild(child,visit);};visit(candidateSource);}
  return targets;
}
function renamePlan(params){
  syncParams(params);const program=createProgram();const file=path.resolve(fileURLToPath(params.textDocument.uri));const source=program.getSourceFile(file);if(!source)return null;const T=loadTypeScript();const node=enclosingString(T,source,offset(source,params.position));if(!node)return null;
  const selected=resolveNode(program,source,node)||declarationNode(program,source,node);if(!selected)return null;const oldValue=selected.currentValue;if(params.newValue===oldValue||selected.declaredMembers.some(member=>member.value===params.newValue))return null;
  const declaration=selected.declaredMembers.find(member=>member.value===oldValue)?.declaration;if(!declaration)return null;const declarationFile=path.resolve(fileURLToPath(declaration.uri));const relative=path.relative(root,declarationFile);if(relative.startsWith('..')||path.isAbsolute(relative))return null;
  const targets=[];const seen=new Set();const add=(candidateSource,candidateRange)=>{const location={uri:uri(candidateSource.fileName),range:candidateRange};const key=locationKey(location);if(!seen.has(key)){seen.add(key);const start=offset(candidateSource,candidateRange.start);const end=offset(candidateSource,candidateRange.end);targets.push({...location,expectedText:candidateSource.text.slice(start,end)});}};
  const declarationSource=program.getSourceFile(declarationFile);if(!declarationSource)return null;const declarationStart=offset(declarationSource,declaration.range.start);const declarationEnd=offset(declarationSource,declaration.range.end);const declarationNodeAtRange=enclosingString(T,declarationSource,declarationStart+1);if(!declarationNodeAtRange||declarationNodeAtRange.text!==oldValue||declarationNodeAtRange.getStart(declarationSource)!==declarationStart||declarationNodeAtRange.getEnd()!==declarationEnd)return null;add(declarationSource,declaration.range);
  const canPrefilter=/^[\w .:/-]+$/.test(oldValue);
  for(const candidateSource of program.getSourceFiles()){if(candidateSource.isDeclarationFile||(canPrefilter&&!candidateSource.text.includes(oldValue)))continue;const visit=child=>{if(T.isStringLiteralLike(child)&&child.text===oldValue){const usage=resolveNode(program,candidateSource,child);if(usage&&sameLocation(usage.domain,selected.domain))add(candidateSource,usage.range);}T.forEachChild(child,visit);};visit(candidateSource);}
  return{oldValue,contextualTypeName:selected.contextualTypeName,targets};
}
async function handle(message) {
  if (message.method === 'extensionCompletions') {
    extensionService ??= require('./extensions.cjs')(loadTypeScript(), root, overlays);
    return extensionService.completions(message.params);
  }
  if (message.method === 'extensionDiagnostics') return extensionService?.diagnostics() ?? [];
  if (message.method === 'documentExtensions') return extensionService?.documentExtensions(message.params) ?? null;
  if (message.method === 'initialize') { root = path.resolve(message.params.root); loadTypeScript(); languageService=createLanguageService();if(message.params.extensions!==false){extensionService=require('./extensions.cjs')(ts,root,overlays);extensionService.initialize();}return true; }
  if (message.method === 'update') { const file = path.resolve(fileURLToPath(message.params.uri)); overlays.set(file, { text: message.params.text, version: message.params.version }); extensionService?.update(file); return true; }
  if (message.method === 'close') { overlays.delete(path.resolve(fileURLToPath(message.params.uri))); return true; }
  if (message.method === 'documentUnions') return documentUnions(message.params);
  if (message.method === 'resolveLiteral') return resolve(message.params);
  if (message.method === 'navigationTargets') return navigationTargets(message.params);
  if (message.method === 'renamePlan') return renamePlan(message.params);
  if (message.method === 'enumToUnionPlan') return enumToUnionPlan(message.params);
  return null;
}
readline.createInterface({ input: process.stdin }).on('line', async line => {
  let message; try { message = JSON.parse(line); const result = await handle(message); process.stdout.write(JSON.stringify({ id: message.id, result }) + '\n'); }
  catch (error) { process.stdout.write(JSON.stringify({ id: message?.id, error: String(error?.stack || error) }) + '\n'); }
});

// Plans edits against a snapshot; temporary transformed programs never escape this request.
function enumToUnionPlan(params) {
  const T = loadTypeScript();
  for (const document of params.documents || []) syncParams(document);
  syncParams(params);
  const program = createProgram();
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(path.resolve(fileURLToPath(params.textDocument.uri)));
  const fail = (reason, node) => ({ reason, location: node ? { uri: uri(node.getSourceFile().fileName), range: range(node.getSourceFile(), node.getStart(), node.getEnd()) } : null, edits: [], documents: [] });
  if (!source) return fail('The enum file is not part of the active TypeScript project.');
  const at = offset(source, params.position);
  let declaration;
  const find = node => { if (node.getStart(source) <= at && at < node.getEnd()) { if (T.isEnumDeclaration(node)) declaration = node; T.forEachChild(node, find); } };
  find(source);
  if (!declaration) return fail('Place the caret on an enum declaration.');
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (!symbol || symbol.declarations?.length !== 1) return fail('Merged enum or namespace declarations cannot be converted safely.', declaration);
  if (source.isDeclarationFile || (T.getCombinedModifierFlags(declaration) & T.ModifierFlags.Ambient)) return fail('Ambient enums cannot be replaced with an initialized object.', declaration);
  const editable = file => { const relative = path.relative(root, path.resolve(file)); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && !relative.split(path.sep).includes('node_modules'); };
  if (!editable(source.fileName)) return fail('The enum is outside the editable workspace.', declaration);
  const canonical = node => canonicalSymbol(T, checker, checker.getSymbolAtLocation(node));
  const members = new Map();
  const quote = value => "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + "'";
  for (const member of declaration.members) {
    if (!T.isIdentifier(member.name) && !T.isStringLiteral(member.name)) return fail('This enum member name cannot be represented as a string union.', member);
    members.set(checker.getSymbolAtLocation(member.name), member.name.text);
  }
  let needsObject = false;
  let problem;
  const edits = [];
  const add = (node, newText, start = node.getStart(), end = node.getEnd()) => {
    const file = node.getSourceFile();
    if (!editable(file.fileName) || file.isDeclarationFile) { problem = fail('A reference is outside the editable workspace or in a declaration file.', node); return; }
    edits.push({ file, start, end, newText });
  };
  const isWrite = node => {
    let current = node;
    while (T.isParenthesizedExpression(current.parent)) current = current.parent;
    const parent = current.parent;
    return (T.isBinaryExpression(parent) && parent.left === current && parent.operatorToken.kind >= T.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= T.SyntaxKind.LastAssignment) ||
      T.isDeleteExpression(parent) || ((T.isPrefixUnaryExpression(parent) || T.isPostfixUnaryExpression(parent)) && [T.SyntaxKind.PlusPlusToken, T.SyntaxKind.MinusMinusToken].includes(parent.operator));
  };
  const isTypeReference = node => {
    let current = node;
    while (T.isQualifiedName(current.parent)) current = current.parent;
    return T.isTypeReferenceNode(current.parent) || T.isExpressionWithTypeArguments(current.parent) || T.isExportSpecifier(current.parent);
  };
  const imports = [];
  const exports = [];
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile && !editable(file.fileName)) continue;
    const visit = node => {
      if (node === declaration || problem) return;
      if (T.isImportDeclaration(node)) { imports.push(node); return; }
      if (T.isExportDeclaration(node)) { exports.push(node); return; }
      if (T.isImportEqualsDeclaration(node) && canonical(node.name) === symbol) {
        problem = fail('Import-equals aliases of this enum need manual conversion.', node); return;
      }
      const access = T.isPropertyAccessExpression(node) || T.isElementAccessExpression(node) || T.isQualifiedName(node);
      if (access) {
        const memberSymbol = canonical(T.isQualifiedName(node) ? node.right : T.isPropertyAccessExpression(node) ? node.name : node);
        const base = T.isQualifiedName(node) ? node.left : node.expression;
        let memberName = members.get(memberSymbol);
        if (T.isElementAccessExpression(node) && canonical(base) === symbol && T.isStringLiteralLike(node.argumentExpression) && [...members.values()].includes(node.argumentExpression.text)) memberName = node.argumentExpression.text;
        if (memberName !== undefined) {
          if (isWrite(node)) { problem = fail('Enum member writes cannot be converted to string literals.', node); return; }
          let target = node;
          if (T.isTypeReferenceNode(node.parent) || T.isTypeQueryNode(node.parent)) target = node.parent;
          if (T.isComputedPropertyName(node.parent) && T.isObjectLiteralExpression(node.parent.parent.parent)) {
            const key = memberName === '__proto__' ? `[${quote(memberName)}]` : T.isIdentifierText(memberName, T.ScriptTarget.Latest) ? memberName : quote(memberName);
            add(node.parent, key);
          } else add(target, quote(memberName));
          return;
        }
        if (T.isElementAccessExpression(node) && canonical(base) === symbol) {
          const type = checker.getTypeAtLocation(node.argumentExpression);
          if ((type.isUnion() ? type.types : [type]).some(part => part.flags & (T.TypeFlags.NumberLike | T.TypeFlags.Any | T.TypeFlags.Unknown))) {
            problem = fail('Numeric reverse lookups or unknown enum indexes cannot be preserved by a name-based object.', node); return;
          }
        }
      }
      if ((T.isIdentifier(node) || access) && canonical(node) === symbol) {
        if (isWrite(node)) { problem = fail('Writes to the enum object cannot be converted safely.', node); return; }
        if (!isTypeReference(node)) needsObject = true;
        // A qualified enum name must be classified once, not again by its right identifier.
        if (access) return;
      }
      T.forEachChild(node, visit);
    };
    visit(file);
  }
  if (problem) return problem;

  // Clean up only imports affected by this conversion, preserving other bindings.
  const printer = T.createPrinter({ removeComments: true, newLine: source.text.includes('\r\n') ? T.NewLineKind.CarriageReturnLineFeed : T.NewLineKind.LineFeed });
  const commentTokens = text => {
    const scanner = T.createScanner(T.ScriptTarget.Latest, false, T.LanguageVariant.Standard, text);
    const result = [];
    for (let token = scanner.scan(); token !== T.SyntaxKind.EndOfFileToken; token = scanner.scan()) if (token === T.SyntaxKind.SingleLineCommentTrivia || token === T.SyntaxKind.MultiLineCommentTrivia) result.push(scanner.getTokenText());
    return result;
  };
  const printImportExport = (original, updated) => {
    // The surrounding comments are outside our replacement range. Keep only
    // comments inside the declaration here, including comments on removed bindings.
    const comments = commentTokens(original.getText());
    return [...comments, updated ? printer.printNode(T.EmitHint.Unspecified, updated, original.getSourceFile()) : ''].join('\n');
  };
  if (!needsObject) for (const exported of exports) {
    if (exported.isTypeOnly || !exported.exportClause || !T.isNamedExports(exported.exportClause)) continue;
    let changed = false;
    const elements = exported.exportClause.elements.map(item => {
      if (canonical(item.name) !== symbol && (!item.propertyName || canonical(item.propertyName) !== symbol)) return item;
      changed = true;
      return T.factory.updateExportSpecifier(item, true, item.propertyName, item.name);
    });
    if (changed) add(exported, printImportExport(exported, T.factory.updateExportDeclaration(exported, exported.modifiers, false, T.factory.updateNamedExports(exported.exportClause, elements), exported.moduleSpecifier, exported.attributes)));
  }
  for (const imported of imports) {
    const clause = imported.importClause;
    if (!clause) continue;
    const bindings = [...(clause.name ? [clause.name] : []), ...(clause.namedBindings ? T.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : [clause.namedBindings] : [])];
    const removed = new Set();
    const typeOnly = new Set();
    for (const binding of bindings) {
      const name = T.isIdentifier(binding) ? binding : binding.name;
      const bindingSymbol = checker.getSymbolAtLocation(name);
      const direct = canonical(name) === symbol;
      const fileEdits = edits.filter(edit => edit.file === imported.getSourceFile());
      const references = [];
      const collect = node => {
        if (node === imported) return;
        if (T.isIdentifier(node) && checker.getSymbolAtLocation(node) === bindingSymbol) references.push(node);
        T.forEachChild(node, collect);
      };
      collect(imported.getSourceFile());
      const remaining = references.filter(node => !fileEdits.some(edit => edit.start <= node.getStart() && edit.end >= node.getEnd()));
      const affected = direct || remaining.length !== references.length;
      if (affected && !remaining.length) removed.add(binding);
      else if (direct && !needsObject && remaining.every(isTypeReference)) typeOnly.add(binding);
    }
    if (!removed.size && !typeOnly.size) continue;
    const name = clause.name && !removed.has(clause.name) ? clause.name : undefined;
    let named = clause.namedBindings;
    if (named && T.isNamedImports(named)) {
      const elements = named.elements.filter(item => !removed.has(item)).map(item => T.factory.updateImportSpecifier(item, item.isTypeOnly || (!clause.isTypeOnly && typeOnly.has(item)), item.propertyName, item.name));
      named = elements.length ? T.factory.updateNamedImports(named, elements) : undefined;
    } else if (named && removed.has(named)) named = undefined;
    if (!name && !named) {
      // An import whose final binding was removed is removed altogether.
      // Independently authored side-effect imports never enter this path.
      add(imported, printImportExport(imported, undefined));
    } else {
      const updated = T.factory.updateImportDeclaration(imported, imported.modifiers, T.factory.updateImportClause(clause, clause.isTypeOnly || (!!name && !named && typeOnly.has(clause.name)), name, named), imported.moduleSpecifier, imported.attributes);
      add(imported, printImportExport(imported, updated));
    }
  }
  if (problem) return problem;
  const comments = (start, end) => commentTokens(source.text.slice(start, end));
  const newline = source.text.includes('\r\n') ? '\r\n' : '\n';
  const exported = declaration.modifiers?.some(item => item.kind === T.SyntaxKind.ExportKeyword) ? 'export ' : '';
  const name = declaration.name.text;
  const values = [...members.values()];
  const memberText = declaration.members.map(member => [...comments(member.getFullStart(), member.getEnd()), quote(member.name.text)].join(newline));
  const leftover = comments(declaration.members.length ? declaration.members[declaration.members.length - 1].getEnd() : declaration.name.getEnd(), declaration.getEnd());
  const prefixComments = declaration.members.length ? comments(declaration.getStart(), declaration.members[0].getFullStart()) : comments(declaration.getStart(), declaration.name.getEnd());
  let replacement = [...prefixComments, `${exported}type ${name} = ${memberText.length ? memberText.join(` |${newline}`) : 'never'};`, ...leftover].join(newline);
  if (needsObject) replacement += `${newline}${exported}const ${name} = {${newline}${values.map(value => `  ${value === '__proto__' ? `[${quote(value)}]` : T.isIdentifierText(value, T.ScriptTarget.Latest) ? value : quote(value)}: ${quote(value)},`).join(newline)}${newline}} as const satisfies { [K in ${name}]: K; };`;
  add(declaration, replacement);
  if (problem) return problem;
  const grouped = new Map();
  for (const edit of edits) { const list = grouped.get(edit.file) || []; list.push(edit); grouped.set(edit.file, list); }
  for (const list of grouped.values()) {
    list.sort((a, b) => a.start - b.start);
    if (list.some((edit, index) => index && list[index - 1].end > edit.start)) return fail('Overlapping references prevent a safe conversion.');
  }
  const diagnostics = p => T.getPreEmitDiagnostics(p).filter(item => item.category === T.DiagnosticCategory.Error);
  const diagnosticKey = diagnostic => `${diagnostic.file?.fileName || ''}:${diagnostic.code}:${T.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
  const baseline = new Map();
  for (const diagnostic of diagnostics(program)) { const key = diagnosticKey(diagnostic); baseline.set(key, (baseline.get(key) || 0) + 1); }
  const saved = new Map(overlays);
  try {
    for (const [file, list] of grouped) {
      let text = file.text;
      for (const edit of [...list].reverse()) text = text.slice(0, edit.start) + edit.newText + text.slice(edit.end);
      overlays.set(path.resolve(file.fileName), { text, version: `enum-preview-${Date.now()}` });
    }
    const transformed = createProgram();
    for (const diagnostic of diagnostics(transformed)) {
      const key = diagnosticKey(diagnostic);
      if (baseline.get(key)) baseline.set(key, baseline.get(key) - 1);
      else {
        const result = fail(`Conversion would introduce TypeScript error TS${diagnostic.code}: ${T.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`, declaration);
        const original = diagnostic.file && program.getSourceFile(diagnostic.file.fileName);
        if (original && diagnostic.start !== undefined) {
          let delta = 0;
          let start = diagnostic.start;
          for (const edit of grouped.get(original) || []) {
            const transformedStart = edit.start + delta;
            if (diagnostic.start < transformedStart) break;
            if (diagnostic.start < transformedStart + edit.newText.length) { start = edit.start; delta = 0; break; }
            delta += edit.newText.length - (edit.end - edit.start);
          }
          start = Math.max(0, Math.min(original.text.length, start - delta));
          result.location = { uri: uri(original.fileName), range: range(original, start, start) };
        }
        return result;
      }
    }
  } finally {
    overlays.clear(); for (const [file, overlay] of saved) overlays.set(file, overlay);
  }
  return {
    enumName: name, needsObject, reason: null,
    // Full source snapshots also catch changes outside an individual edit range.
    documents: [...grouped.keys()].map(file => ({ uri: uri(file.fileName), expectedText: file.text })),
    edits: edits.map(edit => ({ uri: uri(edit.file.fileName), range: range(edit.file, edit.start, edit.end), expectedText: edit.file.text.slice(edit.start, edit.end), newText: edit.newText })),
  };
}
