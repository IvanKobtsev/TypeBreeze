const readline = require('readline');
const path = require('path');
const fs = require('fs');
const { pathToFileURL, fileURLToPath } = require('url');

let root = process.cwd();
const overlays = new Map();
let ts;
let cachedProgram;
let dirty = true;

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
function createProgram() {
  if (!dirty && cachedProgram) return cachedProgram;
  const T = loadTypeScript();
  const config = T.findConfigFile(root, T.sys.fileExists, 'tsconfig.json');
  let names, options;
  if (config) {
    const parsed = T.parseJsonConfigFileContent(T.readConfigFile(config, T.sys.readFile).config, T.sys, path.dirname(config));
    names = parsed.fileNames; options = parsed.options;
  } else { names = [...overlays.keys()]; options = { allowJs: false, jsx: T.JsxEmit.Preserve, moduleResolution: T.ModuleResolutionKind.Bundler }; }
  for (const file of overlays.keys()) if (!names.includes(file)) names.push(file);
  const host = T.createCompilerHost(options, true);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, onError, fresh) => overlays.has(path.resolve(name))
    ? T.createSourceFile(name, overlays.get(path.resolve(name)).text, language, true)
    : original(name, language, onError, fresh);
  host.readFile = name => overlays.get(path.resolve(name))?.text ?? T.sys.readFile(name);
  host.fileExists = name => overlays.has(path.resolve(name)) || T.sys.fileExists(name);
  cachedProgram = T.createProgram(names, options, host, cachedProgram);
  dirty = false;
  return cachedProgram;
}
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
function resolveNode(program, source, node) {
  const T = loadTypeScript();
  if (node.parent && T.isLiteralTypeNode(node.parent)) return null;
  const checker = program.getTypeChecker();
  const contextual = checker.getContextualType(node);
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
  const members = values.map((value, index) => declared.find(x => x.value === value) || { value, declaration: domain, deprecated: false, declarationOrder: index });
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
  const program = createProgram(); const file = path.resolve(fileURLToPath(params.textDocument.uri));
  const source = program.getSourceFile(file); if (!source) return null;
  const node = enclosingString(loadTypeScript(), source, offset(source, params.position));
  return node ? resolveNode(program, source, node) : null;
}
function documentUnions(params) {
  const program = createProgram(); const file = path.resolve(fileURLToPath(params.textDocument.uri));
  const source = program.getSourceFile(file); if (!source) return null;
  const literals = []; const T = loadTypeScript();
  const visit = node => { if (T.isStringLiteralLike(node)) { const item = declarationNode(program,source,node)||resolveNode(program, source, node); if (item) literals.push(item); } T.forEachChild(node, visit); };
  visit(source); return { version: overlays.get(file)?.version ?? null, generation: Date.now(), literals };
}
function navigationTargets(params){
  const program=createProgram();const file=path.resolve(fileURLToPath(params.textDocument.uri));const source=program.getSourceFile(file);if(!source)return[];const T=loadTypeScript();const node=enclosingString(T,source,offset(source,params.position));if(!node)return[];
  const usage=resolveNode(program,source,node);if(usage){const member=usage.declaredMembers.find(item=>item.value===usage.currentValue);return member?[member.declaration]:[];}
  const declaration=declarationNode(program,source,node);if(!declaration)return[];const targets=[];
  const sameRange=(left,right)=>left.start.line===right.start.line&&left.start.character===right.start.character&&left.end.line===right.end.line&&left.end.character===right.end.character;
  for(const candidateSource of program.getSourceFiles()){if(candidateSource.isDeclarationFile)continue;const visit=child=>{if(T.isStringLiteralLike(child)){const item=resolveNode(program,candidateSource,child);if(item&&item.currentValue===declaration.currentValue&&item.domain.uri===declaration.domain.uri&&sameRange(item.domain.range,declaration.domain.range))targets.push({uri:uri(candidateSource.fileName),range:item.range});}T.forEachChild(child,visit);};visit(candidateSource);}
  return targets;
}
async function handle(message) {
  if (message.method === 'initialize') { root = path.resolve(message.params.root); loadTypeScript(); return true; }
  if (message.method === 'update') { const file = path.resolve(fileURLToPath(message.uri)); overlays.set(file, { text: message.text, version: message.version }); dirty = true; return true; }
  if (message.method === 'documentUnions') return documentUnions(message.params);
  if (message.method === 'resolveLiteral') return resolve(message.params);
  if (message.method === 'navigationTargets') return navigationTargets(message.params);
  return null;
}
readline.createInterface({ input: process.stdin }).on('line', async line => {
  let message; try { message = JSON.parse(line); const result = await handle(message); process.stdout.write(JSON.stringify({ id: message.id, result }) + '\n'); }
  catch (error) { process.stdout.write(JSON.stringify({ id: message?.id, error: String(error?.stack || error) }) + '\n'); }
});
