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
function createLanguageService(diskOnly = false) {
  const T = loadTypeScript();
  const config = T.findConfigFile(root, T.sys.fileExists, 'tsconfig.json');
  let names, options;
  if (config) {
    const parsed = T.parseJsonConfigFileContent(T.readConfigFile(config, T.sys.readFile).config, T.sys, path.dirname(config));
    names = parsed.fileNames; options = parsed.options;
  } else { names = diskOnly ? [] : [...overlays.keys()]; options = { allowJs: false, jsx: T.JsxEmit.Preserve, moduleResolution: T.ModuleResolutionKind.Bundler }; }
  const host = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...new Set([...names, ...(diskOnly ? [] : overlays.keys())])],
    getScriptVersion: name => String((diskOnly ? undefined : overlays.get(path.resolve(name))?.version) ?? statVersion(name)),
    getScriptSnapshot: name => { const text=(diskOnly ? undefined : overlays.get(path.resolve(name))?.text) ?? T.sys.readFile(name);return text===undefined?undefined:T.ScriptSnapshot.fromString(text); },
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

function mappingDomainInfo(T,checker,parameter) {
  if(!parameter?.constraint)return{finite:false,typeText:''};
  const type=checker.getTypeFromTypeNode(parameter.constraint);const parts=type.isUnion()?type.types:[type];
  const finite=parts.length>0&&parts.every(part=>!!(part.flags&(T.TypeFlags.StringLiteral|T.TypeFlags.NumberLiteral|T.TypeFlags.EnumLiteral|T.TypeFlags.UniqueESSymbol)));
  return{finite,typeText:checker.typeToString(type,parameter.constraint,T.TypeFormatFlags.NoTruncation)};
}
function mappingTypeAt(params) {
  syncParams(params);
  const program=createProgram(); const T=loadTypeScript(); const checker=program.getTypeChecker();
  const file=path.resolve(fileURLToPath(params.textDocument.uri)); const source=program.getSourceFile(file); if(!source)return null;
  const at=offset(source,params.position); let declaration;
  const visit=node=>{if(at>=node.getStart(source)&&at<=node.getEnd()){if((T.isTypeAliasDeclaration(node)||T.isInterfaceDeclaration(node))&&node.name)declaration=node;T.forEachChild(node,visit);}}; visit(source);
  if(!declaration)return null;
  const typeParameters=declaration.typeParameters||[]; const expected=params.keyTypeParameter||'TKey';const expectedResult=params.resultTypeParameter||'TResult';
  let reason=null;
  if(!typeParameters.length)reason='The type must have at least one generic parameter.';
  else if(typeParameters[0].name.text!==expected)reason=`The first generic parameter must be named ${expected}.`;
  else if(!typeParameters[0].constraint)reason=`${expected} must have a PropertyKey-compatible constraint.`;
  else {
    const constraint=checker.getTypeFromTypeNode(typeParameters[0].constraint);
    const allowed=type=>!!(type.flags&(T.TypeFlags.StringLike|T.TypeFlags.NumberLike|T.TypeFlags.ESSymbolLike|T.TypeFlags.EnumLike|T.TypeFlags.TypeParameter));
    if(!(constraint.isUnion()?constraint.types:[constraint]).every(allowed))reason=`${expected} must be constrained to string, number, symbol, an enum, or a union of those types.`;
    const declared=checker.getTypeAtLocation(declaration.name);
    if(!reason&&!(declared.flags&T.TypeFlags.Object))reason='The selected type must resolve to an object type.';
  }
  const resultIndex=typeParameters.findIndex(parameter=>parameter.name.text===expectedResult);
  if(!reason&&resultIndex>=0&&resultIndex!==typeParameters.length-1)reason=`${expectedResult} must be the final generic parameter.`;
  if(!reason&&resultIndex>=0&&!typeParameters[resultIndex].default)reason=`${expectedResult} must have a default type.`;
  const domain=mappingDomainInfo(T,checker,typeParameters[0]);
  return {valid:!reason,reason,typeName:declaration.name.text,path:path.relative(root,file).replace(/\\/g,'/'),finiteKeyDomain:domain.finite,keyDomainType:domain.typeText};
}

async function formatMappingPlans(plans) {
  let prettier;
  try { prettier=require(require.resolve('prettier',{paths:[root]})); } catch { return plans; }
  try { await prettier.clearConfigCache?.(); } catch {}
  return Promise.all(plans.map(async plan=>{
    const filePath=path.resolve(root,plan.path);
    try {
      const options=await prettier.resolveConfig?.(filePath) || {};
      const content=await prettier.format(plan.content,{...options,filepath:filePath,parser:options.parser||'typescript'});
      return {...plan,content};
    } catch { return plan; }
  }));
}

async function mappingGeneration(params={}) {
  const T=loadTypeScript();const requested=typeof params.configFilePath==='string'?params.configFilePath:'mappings.brz.json';const configLabel=requested.replace(/\\/g,'/');const resolvedConfig=path.resolve(root,requested);const relativeConfig=path.relative(root,resolvedConfig);const diagnostics=[],occurrences=[],documentDiagnostics=new Map();
  if(!requested.trim()||path.isAbsolute(requested)||relativeConfig==='..'||relativeConfig.startsWith(`..${path.sep}`)||path.isAbsolute(relativeConfig))return{files:[],diagnostics:[{path:configLabel||'mappings.brz.json',message:'Config file path must remain inside the workspace.'}],occurrences:[],diagnosticDocuments:[]};
  const configPath=resolvedConfig;
  const addDocumentDiagnostic=(source,node,message)=>{const fileUri=uri(source.fileName);const list=documentDiagnostics.get(fileUri)||[];list.push({range:range(source,node.getStart(source),node.getEnd()),severity:1,source:'TypeBreeze',message});documentDiagnostics.set(fileUri,list);};
  let config; try{config=JSON.parse(fs.readFileSync(configPath,'utf8'));}catch(error){return{files:[],diagnostics:[{path:configLabel,message:`Cannot read ${configLabel}: ${error.message}`} ]};}
  const output=config.outputDirectory; const keyName=config.keyTypeParameter||'TKey';const resultName=config.resultTypeParameter||'TResult'; const mappings=config.mappings;
  if(typeof output!=='string'||!output||!mappings||typeof mappings!=='object'||Array.isArray(mappings))return{files:[],diagnostics:[{path:configLabel,message:'Configuration requires outputDirectory and a mappings object.'}]};
  const outputRoot=path.resolve(root,output); const relOutput=path.relative(root,outputRoot); if(relOutput.startsWith('..')||path.isAbsolute(relOutput))return{files:[],diagnostics:[{path:configLabel,message:'outputDirectory must remain inside the workspace.'}]};
  const mappingService=createLanguageService(true);const program=mappingService.getProgram();if(!program)return{files:[],diagnostics:[{path:configLabel,message:'The TypeScript project could not be loaded.'}],occurrences:[],diagnosticDocuments:[]};const checker=program.getTypeChecker(); const parsedOptions=program.getCompilerOptions();
  const sourceFiles=program.getSourceFiles().filter(file=>!file.isDeclarationFile&&path.resolve(file.fileName).startsWith(root));
  const canonical=s=>canonicalSymbol(T,checker,s);
  const stripExtension=value=>value.replace(/(\.d)?\.[cm]?[jt]sx?$/i,'').replace(/\/index$/,'');
  function moduleSpecifier(from,to){
    const clean=path.resolve(to); const base=parsedOptions.baseUrl&&path.resolve(parsedOptions.baseUrl); const candidates=[]; let order=0;
    const dependency=clean.replace(/\\/g,'/').match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)(\/.*)?$/);if(dependency)return stripExtension(dependency[1]+(dependency[2]||''));
    for(const [alias,targets] of Object.entries(parsedOptions.paths||{}))for(const target of targets){const absolute=path.resolve(base||root,target);const star=absolute.indexOf('*');let capture=null;if(star<0&&stripExtension(absolute)===stripExtension(clean))capture='';else if(star>=0){const pre=absolute.slice(0,star),post=absolute.slice(star+1);if(clean.startsWith(pre)&&clean.endsWith(post))capture=clean.slice(pre.length,clean.length-post.length);}if(capture!==null){const value=alias.includes('*')?alias.replace('*',stripExtension(capture).replace(/\\/g,'/')):alias;candidates.push({value,specificity:target.replace('*','').length,order:order++});}}
    if(candidates.length)return candidates.sort((a,b)=>b.specificity-a.specificity||a.value.length-b.value.length||a.order-b.order)[0].value;
    if(base){const relative=path.relative(base,clean);if(!relative.startsWith('..')&&!path.isAbsolute(relative))return stripExtension(relative.replace(/\\/g,'/'));}
    let relative=stripExtension(path.relative(path.dirname(from),clean).replace(/\\/g,'/'));return relative.startsWith('.')?relative:`./${relative}`;
  }
  function findType(entry){const wanted=path.resolve(root,entry.path||'');const source=program.getSourceFile(wanted);if(!source)return{};let declaration;for(const statement of source.statements)if((T.isTypeAliasDeclaration(statement)||T.isInterfaceDeclaration(statement))&&statement.name.text===entry.type)declaration=statement;return{source,declaration,symbol:declaration&&canonical(checker.getSymbolAtLocation(declaration.name))};}
  function finiteDomain(parameter){if(!parameter?.constraint)return null;const type=checker.getTypeFromTypeNode(parameter.constraint);const parts=type.isUnion()?type.types:[type];const result=[];for(const part of parts){if(part.flags&T.TypeFlags.EnumLiteral){const symbol=part.getSymbol?.();if(!symbol)return null;result.push(symbol.parent?`${checker.symbolToString(symbol.parent)}.${symbol.name}`:symbol.name);}else if(part.flags&T.TypeFlags.UniqueESSymbol){const symbol=part.getSymbol?.();if(!symbol)return null;result.push(symbol.name);}else if(part.flags&T.TypeFlags.StringLiteral)result.push(JSON.stringify(part.value));else if(part.flags&T.TypeFlags.NumberLiteral)result.push(String(part.value));else return null;}return result;}
  function keyExpression(type,node){
    if(type.flags&T.TypeFlags.EnumLiteral){const symbol=type.getSymbol?.();if(symbol){const parent=symbol.parent;return parent?`${checker.symbolToString(parent)}.${symbol.name}`:symbol.name;}}
    if(type.flags&T.TypeFlags.StringLiteral)return JSON.stringify(type.value); if(type.flags&T.TypeFlags.NumberLiteral)return String(type.value);
    if(type.flags&T.TypeFlags.UniqueESSymbol){const symbol=type.getSymbol?.();if(symbol)return symbol.name;}
    return null;
  }
  const outputs=new Map(); const plans=[];
  for(const [mappingName,entry] of Object.entries(mappings)){
    if(!T.isIdentifierText(mappingName,T.ScriptTarget.Latest)||!entry||typeof entry!=='object'){diagnostics.push({path:configLabel,message:`Invalid mapping name or entry: ${mappingName}`});continue;}
    const info=findType(entry); if(!info.declaration){diagnostics.push({path:entry.path||configLabel,message:`Cannot find type ${entry.type||''}.`});continue;}
    const validation=mappingTypeAt({textDocument:{uri:uri(info.source.fileName)},position:position(info.source,info.declaration.name.getStart(info.source)),text:info.source.text,clientVersion:0,keyTypeParameter:keyName,resultTypeParameter:resultName});
    if(!validation?.valid){diagnostics.push({path:entry.path,message:validation?.reason||'Invalid mapping type.'});continue;}
    const target=path.join(outputRoot,`${entry.type}.map.ts`); const collision=outputs.get(target);if(collision){diagnostics.push({path:configLabel,message:`Mappings ${collision} and ${mappingName} target the same generated file.`});continue;}outputs.set(target,mappingName);
    const generatedUri=uri(target);occurrences.push({uri:uri(info.source.fileName),range:range(info.source,info.declaration.name.getStart(info.source),info.declaration.name.getEnd()),kind:'connector',mappingName,targetUri:generatedUri,reason:null});
    const rows=[];const baseProblem='This type acts as a mapping connector and can only be used by components and other functions with exactly one required, non-rest parameter and a named export.';
    for(const source of sourceFiles){
      const moduleSymbol=checker.getSymbolAtLocation(source);const moduleExports=moduleSymbol?checker.getExportsOfModule(moduleSymbol):[];
      for(const statement of source.statements){let name,node,parameters,symbol;
        if(T.isFunctionDeclaration(statement)){name=statement.name?.text;node=statement.name||statement;parameters=statement.parameters;symbol=statement.name&&checker.getSymbolAtLocation(statement.name);}
        else if(T.isVariableStatement(statement)&&statement.declarationList.declarations.length===1){const decl=statement.declarationList.declarations[0];if(T.isIdentifier(decl.name)&&decl.initializer&&(T.isArrowFunction(decl.initializer)||T.isFunctionExpression(decl.initializer))){name=decl.name.text;node=decl.name;parameters=decl.initializer.parameters;symbol=checker.getSymbolAtLocation(decl.name);}}
        else if(T.isExportAssignment(statement)&&(T.isArrowFunction(statement.expression)||T.isFunctionExpression(statement.expression))){node=statement.expression;parameters=statement.expression.parameters;}
        if(!parameters)continue;
        const connectorParameters=parameters.filter(param=>{if(!param.type)return false;const type=checker.getTypeFromTypeNode(param.type);return canonical(type.aliasSymbol||type.getSymbol?.())===info.symbol;});if(!connectorParameters.length)continue;
        const targetSymbol=canonical(symbol);const exports=targetSymbol?moduleExports.filter(item=>canonical(item)===targetSymbol):[];const isDefault=T.isExportAssignment(statement)||statement.modifiers?.some(m=>m.kind===T.SyntaxKind.DefaultKeyword)||exports.some(item=>item.name==='default');const isNamed=!!name&&exports.some(item=>item.name!=='default');
        let problem=null;if(isDefault)problem='Default exports are not supported.';else if(!isNamed)problem='The function is not a named export.';else if(parameters.length!==1)problem=`${parameters.length} parameters were found.`;else if(parameters[0].questionToken)problem='The connector parameter must be required.';else if(parameters[0].dotDotDotToken)problem='Rest parameters are not supported.';
        const param=connectorParameters[0];const parameterType=checker.getTypeFromTypeNode(param.type);const referenceArgs=checker.getTypeArguments?.(parameterType)||[];const args=referenceArgs.length?referenceArgs:(parameterType.aliasTypeArguments||[]);const expression=args.length?keyExpression(args[0],param.type):null;if(!problem&&!expression)problem='The mapping key is not concrete or cannot be emitted.';
        const reason=problem?`${baseProblem} ${problem}`:null;occurrences.push({uri:uri(source.fileName),range:range(source,node.getStart(source),node.getEnd()),kind:'component',mappingName,targetUri:generatedUri,reason});if(reason)addDocumentDiagnostic(source,node,reason);
        else rows.push({expression,name,file:source.fileName,node,keyType:args[0],key:checker.typeToString(args[0]),parameterTypeNode:param.type});
      }
    }
    const duplicates=[...new Set(rows.filter((row,index)=>rows.findIndex(other=>other.key===row.key)!==index).map(row=>row.key))];if(duplicates.length){diagnostics.push({path:entry.path,message:`Duplicate mapping keys: ${duplicates.join(', ')}.`});continue;}
    const domain=finiteDomain(info.declaration.typeParameters?.[0]);const exhaustive=entry.requireAllKeys===true&&domain!==null;
    const imports=new Map(),used=new Map([[mappingName,'mapping']]);
    const addImport=(file,name)=>{const spec=moduleSpecifier(target,file);const names=imports.get(spec)||new Map();if(names.has(name))return names.get(name);let local=name,index=2;while(used.has(local)&&used.get(local)!==`${spec}\0${name}`)local=`${name}_${index++}`;used.set(local,`${spec}\0${name}`);names.set(name,local);imports.set(spec,names);return local;};
    const renderTypeNode=(node,source)=>{if(!node)return null;const original=node.getText(source),replacements=[];const visit=child=>{if(T.isIdentifier(child)){const symbol=canonical(checker.getSymbolAtLocation(child));const declaration=symbol?.declarations?.find(item=>!item.getSourceFile().isDeclarationFile);if(declaration&&declaration.getSourceFile().fileName!==target&&symbol?.name&&symbol.name!=='__type'&&(symbol.flags&(T.SymbolFlags.Type|T.SymbolFlags.Alias))&&!(symbol.flags&T.SymbolFlags.TypeParameter)){const local=addImport(declaration.getSourceFile().fileName,symbol.name);replacements.push({start:child.getStart(source)-node.getStart(source),end:child.getEnd()-node.getStart(source),text:local});}}T.forEachChild(child,visit);};visit(node);let text=original;for(const replacement of replacements.sort((a,b)=>b.start-a.start))text=text.slice(0,replacement.start)+replacement.text+text.slice(replacement.end);return text;};
    rows.sort((a,b)=>a.expression.localeCompare(b.expression)||a.file.localeCompare(b.file)||a.name.localeCompare(b.name));for(const row of rows)row.localName=addImport(row.file,row.name);
    for(const row of rows){const first=row.expression.split('.')[0];if(first!==row.expression){const member=row.keyType.getSymbol?.();const symbol=canonical(member?.parent||checker.resolveName(first,row.node,T.SymbolFlags.Value,false));const declaration=symbol?.declarations?.[0];if(declaration){const exported=symbol.name||first;const local=addImport(declaration.getSourceFile().fileName,exported);row.expression=local+row.expression.slice(first.length);}}else if(row.keyType.flags&T.TypeFlags.UniqueESSymbol){const symbol=canonical(row.keyType.getSymbol?.());const declaration=symbol?.declarations?.[0];if(declaration)row.expression=addImport(declaration.getSourceFile().fileName,symbol.name);}}
    let domainText=validation.keyDomainType;if(exhaustive&&info.declaration.typeParameters?.[0]?.constraint){const constraint=info.declaration.typeParameters[0].constraint;const original=constraint.getText(info.source),replacements=[];const visitDomain=node=>{if(T.isIdentifier(node)){const symbol=canonical(checker.getSymbolAtLocation(node));const declaration=symbol?.declarations?.find(item=>!item.getSourceFile().isDeclarationFile);if(declaration&&symbol?.name&&symbol.name!=='__type'){const local=addImport(declaration.getSourceFile().fileName,symbol.name);replacements.push({start:node.getStart(info.source)-constraint.getStart(info.source),end:node.getEnd()-constraint.getStart(info.source),text:local});}}T.forEachChild(node,visitDomain);};visitDomain(constraint);domainText=original;for(const replacement of replacements.sort((a,b)=>b.start-a.start))domainText=domainText.slice(0,replacement.start)+replacement.text+domainText.slice(replacement.end);}
    const typeParameters=info.declaration.typeParameters||[];const resultIndex=typeParameters.findIndex(parameter=>parameter.name.text===resultName);const defaultResultNode=resultIndex>=0?typeParameters[resultIndex].default:null;
    for(const row of rows){const reference=T.isTypeReferenceNode(row.parameterTypeNode)?row.parameterTypeNode:null;const explicit=reference?.typeArguments?.[resultIndex];row.resultText=resultIndex>=0?renderTypeNode(explicit||defaultResultNode,explicit?row.parameterTypeNode.getSourceFile():info.source):null;}
    const knownResults=rows.map(row=>row.resultText).filter(Boolean);const distinctResults=[...new Set(knownResults)];const hasKnownResult=resultIndex>=0&&!!defaultResultNode;
    const header='//----------------------\n// <auto-generated>\n//     Generated using the TypeBreeze IDE plugin.\n//     Can be adjusted manually, but only if you don\'t have the plugin installed.\n// </auto-generated>\n//----------------------';
    const body=rows.map(row=>`  [${row.expression}]: ${row.localName},`).join('\n');let satisfies='';
    if(hasKnownResult&&distinctResults.length<=1)satisfies=` satisfies Record<${exhaustive?domainText:'PropertyKey'}, (...args: never[]) => ${distinctResults[0]||renderTypeNode(defaultResultNode,info.source)}>`;
    else if(hasKnownResult&&distinctResults.length>1){const contracts=new Map(rows.map(row=>[row.expression,row.resultText]));if(exhaustive)for(const expression of domain)if(!contracts.has(expression))contracts.set(expression,renderTypeNode(defaultResultNode,info.source));const properties=[...contracts].map(([expression,result])=>`  [${expression}]: (...args: never[]) => ${result};`).join('\n');satisfies=` satisfies {\n${properties}\n}`;}
    else if(exhaustive)satisfies=` satisfies Record<${domainText}, unknown>`;
    const finalImportText=[...imports.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([spec,names])=>{const list=[...names.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([name,local])=>name===local?name:`${name} as ${local}`);return list.length===1?`import { ${list[0]} } from ${JSON.stringify(spec)};`:`import {\n${list.map(name=>`  ${name},`).join('\n')}\n} from ${JSON.stringify(spec)};`;}).join('\n');
    plans.push({path:path.relative(root,target).replace(/\\/g,'/'),content:`${header}\n\n${finalImportText}${finalImportText?'\n\n':''}export const ${mappingName} = {\n${body}${body?'\n':''}} as const${satisfies};\n`});
  }
  return {files:await formatMappingPlans(plans),diagnostics,occurrences,diagnosticDocuments:[...documentDiagnostics].map(([uri,diagnostics])=>({uri,diagnostics}))};
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
  if (message.method === 'mappingTypeAt') return mappingTypeAt(message.params);
  if (message.method === 'mappingGeneration') return mappingGeneration(message.params);
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
