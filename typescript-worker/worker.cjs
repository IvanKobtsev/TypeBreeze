const readline = require('readline');
const path = require('path');
const fs = require('fs');
const { pathToFileURL, fileURLToPath } = require('url');

let root = process.cwd();
const overlays = new Map();
let ts;
let languageService;

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
  return node ? resolveNode(program, source, node) : null;
}
function documentUnions(params) {
  syncParams(params);
  const program = createProgram(); const file = path.resolve(fileURLToPath(params.textDocument.uri));
  const source = program.getSourceFile(file); if (!source) return null;
  const literals = []; const T = loadTypeScript();
  const visit = node => { if (T.isStringLiteralLike(node)) { const item = declarationNode(program,source,node)||resolveNode(program, source, node); if (item) literals.push(item); } T.forEachChild(node, visit); };
  visit(source);markDeclarationUsages(program,literals);return { version: null, clientVersion: params.clientVersion ?? null, generation: Date.now(), literals };
}
function locationKey(location){const value=location.range;return `${location.uri}:${value.start.line}:${value.start.character}:${value.end.line}:${value.end.character}`;}
function sameLocation(left,right){return locationKey(left)===locationKey(right);}
function markDeclarationUsages(program,literals){
  const declarations=literals.filter(item=>item.kind==='declaration');if(!declarations.length)return;
  const wanted=new Map(declarations.map(item=>[`${locationKey(item.domain)}\0${item.currentValue}`,item]));
  const values=new Set(declarations.map(item=>item.currentValue));const simple=[...values].filter(value=>/^[\w .:/-]+$/.test(value));const T=loadTypeScript();
  for(const candidateSource of program.getSourceFiles()){if(candidateSource.isDeclarationFile||(simple.length===values.size&&!simple.some(value=>candidateSource.text.includes(value))))continue;const visit=child=>{if(T.isStringLiteralLike(child)&&values.has(child.text)){const usage=resolveNode(program,candidateSource,child);if(usage){const declaration=wanted.get(`${locationKey(usage.domain)}\0${usage.currentValue}`);if(declaration)declaration.hasUsages=true;}}T.forEachChild(child,visit);};visit(candidateSource);}
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
  if (message.method === 'initialize') { root = path.resolve(message.params.root); loadTypeScript(); languageService=createLanguageService(); return true; }
  if (message.method === 'update') { const file = path.resolve(fileURLToPath(message.uri)); overlays.set(file, { text: message.text, version: message.version }); return true; }
  if (message.method === 'documentUnions') return documentUnions(message.params);
  if (message.method === 'resolveLiteral') return resolve(message.params);
  if (message.method === 'navigationTargets') return navigationTargets(message.params);
  if (message.method === 'renamePlan') return renamePlan(message.params);
  return null;
}
readline.createInterface({ input: process.stdin }).on('line', async line => {
  let message; try { message = JSON.parse(line); const result = await handle(message); process.stdout.write(JSON.stringify({ id: message.id, result }) + '\n'); }
  catch (error) { process.stdout.write(JSON.stringify({ id: message?.id, error: String(error?.stack || error) }) + '\n'); }
});
