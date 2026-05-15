import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { parse as parseSfc } from '@vue/compiler-sfc';
import { baseParse, NodeTypes } from '@vue/compiler-dom';

const FRONTEND_EXTS = new Set(['.vue', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.nuxt',
  '.output',
  'coverage',
  '.gitnexus',
]);

function slash(filePath) {
  return filePath.split(path.sep).join('/');
}

function rel(root, filePath) {
  return slash(path.relative(root, filePath));
}

function stableId(...parts) {
  return parts.map((p) => String(p).replace(/\s+/g, ' ').trim()).join(':');
}

function lineOf(sourceFile, pos) {
  return sourceFile.getLineAndCharacterOfPosition(Math.max(0, pos)).line + 1;
}

function nodeText(sourceFile, node) {
  return sourceFile.text.slice(node.getStart(sourceFile), node.getEnd());
}

function walkFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (FRONTEND_EXTS.has(path.extname(entry.name))) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files.sort();
}

function lineOffsets(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) offsets.push(i + 1);
  }
  return offsets;
}

function posToLine(offsets, pos) {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= pos) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi + 1;
}

function kebabToPascal(name) {
  return name
    .split('-')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join('');
}

function isVueComponentTag(tag) {
  return /^[A-Z]/.test(tag) || tag.includes('-');
}

function isComposableName(name) {
  return /^use[A-Z0-9]/.test(name);
}

function isStoreFile(filePath) {
  return /(^|\/)(stores?|pinia)\//.test(slash(filePath));
}

function callName(expr) {
  if (!expr) return '';
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return expr.getText();
}

function collectTemplateRefs(template) {
  if (!template) return { components: [], expressions: [] };
  const ast = baseParse(template.content, { comments: false });
  const baseLine = template.loc.start.line - 1;
  const components = [];
  const expressions = [];

  const addExpression = (content, loc, reason) => {
    const text = String(content ?? '').trim();
    if (text) expressions.push({ text, line: baseLine + loc.start.line, reason });
  };

  const visit = (node) => {
    if (node.type === NodeTypes.ELEMENT) {
      if (isVueComponentTag(node.tag)) {
        components.push({
          name: node.tag,
          normalizedName: node.tag.includes('-') ? kebabToPascal(node.tag) : node.tag,
          line: baseLine + node.loc.start.line,
        });
      }
      for (const prop of node.props) {
        if (prop.type === NodeTypes.DIRECTIVE) {
          if (prop.exp) addExpression(prop.exp.content, prop.exp.loc, `template v-${prop.name}`);
        }
      }
    } else if (node.type === NodeTypes.INTERPOLATION) {
      addExpression(node.content.content, node.content.loc, 'template interpolation');
    }

    const children = node.children ?? [];
    for (const child of children) visit(child);
  };
  visit(ast);
  return { components, expressions };
}

function extractVueScript(filePath, content) {
  const parsed = parseSfc(content, { filename: filePath });
  const { descriptor } = parsed;
  const chunks = [];
  const mappings = [];

  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block) continue;
    const startLine = block.loc.start.line;
    const start = chunks.join('\n').length;
    chunks.push(block.content);
    mappings.push({
      virtualStartLine: posToLine(lineOffsets(chunks.join('\n')), start),
      realStartLine: startLine,
      lineCount: block.content.split('\n').length,
    });
  }

  const userScript = chunks.join('\n\n');
  const hasDefaultExport = /\bexport\s+default\b/.test(userScript);
  const fallbackDefault = hasDefaultExport
    ? ''
    : '\ndeclare const __vue_sfc_default__: unknown;\nexport default __vue_sfc_default__;\n';
  const script = [userScript, fallbackDefault].filter(Boolean).join('\n\n');
  const imports = new Map();
  const template = collectTemplateRefs(descriptor.template);
  return { script, mappings, imports, template, errors: parsed.errors };
}

function mapVueLine(virtual, virtualLine) {
  for (const mapping of virtual.mappings) {
    const delta = virtualLine - mapping.virtualStartLine;
    if (delta >= 0 && delta < mapping.lineCount) return mapping.realStartLine + delta;
  }
  return virtualLine;
}

function isExported(node) {
  return Boolean(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export);
}

function nameOfBindingName(name) {
  return ts.isIdentifier(name) ? name.text : undefined;
}

function bindingNames(name, out = []) {
  if (ts.isIdentifier(name)) {
    out.push({ name: name.text, node: name });
  } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) bindingNames(element.name, out);
    }
  }
  return out;
}

function objectPropertyName(name) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function resolveImportTarget(root, sourceFile, spec, allRealFiles, virtualByVueFile) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  const base = spec.startsWith('/')
    ? path.join(root, spec)
    : path.resolve(path.dirname(sourceFile.realPath), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.vue`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
    path.join(base, 'index.vue'),
  ];
  for (const candidate of candidates) {
    const normalized = path.normalize(candidate);
    if (allRealFiles.has(normalized)) return normalized;
    if (virtualByVueFile.has(normalized)) return normalized;
  }
  return null;
}

function createGraph(root) {
  const nodes = new Map();
  const edges = new Map();
  const byDeclaration = new Map();
  const localSymbols = new Map();
  const componentNames = new Map();
  const storeVars = new Map();

  const addNode = (node) => {
    nodes.set(node.id, { meta: {}, ...node });
    return node.id;
  };
  const addEdge = (edge) => {
    if (edge.source === edge.target && edge.type === 'CALLS') return;
    const id =
      edge.id ??
      stableId(edge.type, edge.source, edge.target, edge.line ?? 0, edge.reason ?? '');
    edges.set(id, {
      id,
      confidence: 1,
      reason: '',
      sourceFilePath: '',
      targetFilePath: '',
      line: 0,
      meta: {},
      ...edge,
    });
  };

  return { root, nodes, edges, byDeclaration, localSymbols, componentNames, storeVars, addNode, addEdge };
}

function graphFileNode(graph, root, realPath, content) {
  const id = stableId('File', rel(root, realPath));
  graph.addNode({
    id,
    type: 'File',
    name: path.basename(realPath),
    filePath: rel(root, realPath),
    startLine: 1,
    endLine: Math.max(1, content.split('\n').length),
    exported: false,
    content,
  });
  return id;
}

function addDeclarationNode(graph, root, sourceFile, decl, type, name, exported = false, meta = {}) {
  const realPath = sourceFile.realPath;
  const startLineRaw = lineOf(sourceFile, decl.getStart(sourceFile));
  const endLineRaw = lineOf(sourceFile, decl.getEnd());
  const startLine = sourceFile.vueVirtual ? mapVueLine(sourceFile.vueVirtual, startLineRaw) : startLineRaw;
  const endLine = sourceFile.vueVirtual ? mapVueLine(sourceFile.vueVirtual, endLineRaw) : endLineRaw;
  const id = stableId(type, rel(root, realPath), name, startLine);
  graph.addNode({
    id,
    type,
    name,
    filePath: rel(root, realPath),
    startLine,
    endLine,
    exported,
    content: nodeText(sourceFile, decl),
    meta,
  });
  graph.byDeclaration.set(decl, id);
  const fileId = stableId('File', rel(root, realPath));
  graph.addEdge({
    type: 'DEFINES',
    source: fileId,
    target: id,
    reason: 'file contains declaration',
    sourceFilePath: rel(root, realPath),
    targetFilePath: rel(root, realPath),
    line: startLine,
  });
  return id;
}

function visit(node, cb) {
  cb(node);
  ts.forEachChild(node, (child) => visit(child, cb));
}

function nearestOwner(graph, sourceFile, node) {
  let current = node;
  while (current) {
    if (ts.isVariableDeclaration(current) && graph.byDeclaration.has(current)) {
      if (
        current.initializer &&
        (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
      ) {
        return graph.byDeclaration.get(current);
      }
      const parent = current.parent?.parent;
      if (parent && !ts.isSourceFile(parent)) {
        current = parent;
        continue;
      }
    }
    const id = graph.byDeclaration.get(current);
    if (id) return id;
    current = current.parent;
  }
  return stableId('File', rel(graph.root, sourceFile.realPath));
}

function initializerVariableOwner(graph, node) {
  let current = node.parent;
  while (current) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer) {
      const id = graph.byDeclaration.get(current);
      if (id) return id;
    }
    if (
      ts.isFunctionLike(current) ||
      ts.isSourceFile(current) ||
      ts.isClassLike(current)
    ) {
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

function declarationTarget(graph, declaration) {
  let current = declaration;
  while (current) {
    const id = graph.byDeclaration.get(current);
    if (id) return id;
    current = current.parent;
  }
  return undefined;
}

function thisMemberTarget(graph, sourceFile, callee) {
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  if (callee.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
  const name = callee.name.text;
  const local = localSymbolMap(graph, sourceFile).get(name);
  const node = local ? graph.nodes.get(local) : undefined;
  if (node && ['Method', 'Function', 'Variable'].includes(node.type)) return local;
  for (const candidate of graph.nodes.values()) {
    if (
      candidate.filePath === rel(graph.root, sourceFile.realPath) &&
      candidate.name === name &&
      ['Method', 'Function', 'Variable'].includes(candidate.type)
    ) {
      return candidate.id;
    }
  }
  return undefined;
}

function resolvedCallTarget(graph, checker, expr) {
  const callee = ts.isCallExpression(expr) || ts.isNewExpression(expr) ? expr.expression : expr.tag;
  const localThisTarget = thisMemberTarget(graph, expr.getSourceFile(), callee);
  const sig = checker.getResolvedSignature(expr);
  const decl = sig?.declaration;
  if (decl) {
    const target = declarationTarget(graph, decl);
    const targetNode = target ? graph.nodes.get(target) : undefined;
    if (targetNode?.type === 'Interface') return undefined;
    if (localThisTarget && (!targetNode || targetNode.type === 'Class')) return localThisTarget;
    if (target) return target;
  }
  const symbol = checker.getSymbolAtLocation(callee);
  const declarations = [
    ...(symbol?.getDeclarations() ?? []),
    ...(symbol && (symbol.flags & ts.SymbolFlags.Alias)
      ? checker.getAliasedSymbol(symbol).getDeclarations() ?? []
      : []),
  ];
  for (const declaration of declarations) {
    const target = declarationTarget(graph, declaration);
    const targetNode = target ? graph.nodes.get(target) : undefined;
    if (targetNode?.type === 'Interface') continue;
    if (localThisTarget && (!targetNode || targetNode.type === 'Class')) return localThisTarget;
    if (target) return target;
  }
  if (localThisTarget) return localThisTarget;
  return undefined;
}

function importLocalNames(importClause) {
  if (!importClause) return [];
  const names = [];
  if (importClause.name) names.push(importClause.name.text);
  const bindings = importClause.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) names.push(element.name.text);
  }
  return names;
}

function classifyVariable(sourceFile, node, name) {
  const filePath = slash(sourceFile.realPath);
  const init = node.initializer;
  if (init && ts.isCallExpression(init)) {
    const callee = callName(init.expression);
    if (callee === 'defineStore') return 'Store';
    if (callee === 'createRouter') return 'Router';
  }
  if (isComposableName(name)) return 'Composable';
  if (isStoreFile(filePath) && /^use[A-Z0-9].*Store$/.test(name)) return 'Store';
  return 'Variable';
}

function collectDeclarations(graph, root, sourceFile) {
  const fileLocal = new Map();
  localSymbolMap(graph, sourceFile).clear();

  visit(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const type = isComposableName(node.name.text) ? 'Composable' : 'Function';
      const id = addDeclarationNode(
        graph,
        root,
        sourceFile,
        node,
        type,
        node.name.text,
        isExported(node),
      );
      fileLocal.set(node.name.text, id);
    }

    if (ts.isVariableDeclaration(node)) {
      const name = nameOfBindingName(node.name);
      if (!name) {
        const names = bindingNames(node.name);
        let firstId;
        for (const binding of names) {
          const id = addDeclarationNode(graph, root, sourceFile, binding.node, 'Variable', binding.name, false, {
            kind: 'destructured-variable',
          });
          firstId ??= id;
          fileLocal.set(binding.name, id);
        }
        if (firstId) graph.byDeclaration.set(node, firstId);
        return;
      }
      if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        const type = isComposableName(name) ? 'Composable' : 'Function';
        const id = addDeclarationNode(graph, root, sourceFile, node, type, name, false, {
          kind: 'variable-function',
        });
        fileLocal.set(name, id);
      } else {
        const type = classifyVariable(sourceFile, node, name);
        const id = addDeclarationNode(graph, root, sourceFile, node, type, name, false, {
          kind: 'variable',
        });
        fileLocal.set(name, id);
      }
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const id = addDeclarationNode(graph, root, sourceFile, node, 'Class', node.name.text, isExported(node));
      fileLocal.set(node.name.text, id);
    }

    if (ts.isMethodDeclaration(node)) {
      const name = objectPropertyName(node.name);
      if (name) {
        const id = addDeclarationNode(graph, root, sourceFile, node, 'Method', name, false);
        fileLocal.set(name, id);
      }
    }

    if (ts.isPropertyDeclaration(node)) {
      const name = objectPropertyName(node.name);
      const init = node.initializer;
      if (name && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        const id = addDeclarationNode(graph, root, sourceFile, node, 'Method', name, false, {
          kind: 'class-property-method',
        });
        fileLocal.set(name, id);
      }
    }

    if (ts.isPropertyAssignment(node)) {
      const name = objectPropertyName(node.name);
      const init = node.initializer;
      if (name && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        const id = addDeclarationNode(graph, root, sourceFile, node, 'Method', name, false, {
          kind: 'object-method',
        });
        fileLocal.set(name, id);
      }
    }

    if (ts.isInterfaceDeclaration(node)) {
      const id = addDeclarationNode(graph, root, sourceFile, node, 'Interface', node.name.text, isExported(node));
      fileLocal.set(node.name.text, id);
    }
  });

  graph.localSymbols.set(sourceFile.fileName, fileLocal);
}

function stringProperty(objectLiteral, key) {
  const prop = objectLiteral.properties.find(
    (p) => ts.isPropertyAssignment(p) && objectPropertyName(p.name) === key,
  );
  if (!prop || !ts.isPropertyAssignment(prop)) return undefined;
  return ts.isStringLiteralLike(prop.initializer) ? prop.initializer.text : undefined;
}

function initializerProperty(objectLiteral, key) {
  const prop = objectLiteral.properties.find(
    (p) => ts.isPropertyAssignment(p) && objectPropertyName(p.name) === key,
  );
  return prop && ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
}

function dynamicImportSpecifier(node) {
  if (!node) return undefined;
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return node.arguments[0].text;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (ts.isBlock(node.body)) {
      const ret = node.body.statements.find((statement) => ts.isReturnStatement(statement));
      return ret && ts.isReturnStatement(ret) ? dynamicImportSpecifier(ret.expression) : undefined;
    }
    return dynamicImportSpecifier(node.body);
  }
  return undefined;
}

function isRouteContext(objectLiteral) {
  let current = objectLiteral.parent;
  while (current) {
    if (ts.isPropertyAssignment(current) && objectPropertyName(current.name) === 'routes') return true;
    if (ts.isVariableDeclaration(current)) {
      const name = nameOfBindingName(current.name);
      if (name && /routes?/i.test(name)) return true;
    }
    current = current.parent;
  }
  return false;
}

function collectRouteEdges(graph, root, sourceFile, objectLiteral) {
  const routePath = stringProperty(objectLiteral, 'path');
  if (!routePath) return;
  const hasRouteShape =
    initializerProperty(objectLiteral, 'component') ||
    initializerProperty(objectLiteral, 'redirect') ||
    initializerProperty(objectLiteral, 'children') ||
    stringProperty(objectLiteral, 'name');
  if (!hasRouteShape || !isRouteContext(objectLiteral)) return;
  const componentInit = initializerProperty(objectLiteral, 'component');
  const name = stringProperty(objectLiteral, 'name') ?? routePath;
  const lineRaw = lineOf(sourceFile, objectLiteral.getStart(sourceFile));
  const line = sourceFile.vueVirtual ? mapVueLine(sourceFile.vueVirtual, lineRaw) : lineRaw;
  const routeId = stableId('Route', rel(root, sourceFile.realPath), name, line);
  graph.addNode({
    id: routeId,
    type: 'Route',
    name,
    filePath: rel(root, sourceFile.realPath),
    startLine: line,
    endLine: sourceFile.vueVirtual
      ? mapVueLine(sourceFile.vueVirtual, lineOf(sourceFile, objectLiteral.getEnd()))
      : lineOf(sourceFile, objectLiteral.getEnd()),
    exported: false,
    content: nodeText(sourceFile, objectLiteral),
    meta: { path: routePath },
  });
  graph.addEdge({
    type: 'DEFINES',
    source: stableId('File', rel(root, sourceFile.realPath)),
    target: routeId,
    reason: 'route object with path',
    sourceFilePath: rel(root, sourceFile.realPath),
    targetFilePath: rel(root, sourceFile.realPath),
    line,
  });

  if (componentInit && ts.isIdentifier(componentInit)) {
    const targetId = localSymbolMap(graph, sourceFile).get(componentInit.text);
    if (targetId && graph.nodes.has(targetId)) {
      graph.addEdge({
        type: 'ROUTES_TO',
        source: routeId,
        target: targetId,
        reason: `route path ${routePath} component ${componentInit.text}`,
        sourceFilePath: rel(root, sourceFile.realPath),
        targetFilePath: graph.nodes.get(targetId)?.filePath ?? '',
        line,
      });
    }
    return;
  }

  const dynamicSpecifier = dynamicImportSpecifier(componentInit);
  if (dynamicSpecifier) {
    const target = resolveImportTarget(root, sourceFile, dynamicSpecifier, graph.allRealFiles ?? [], graph.virtualByVueFile ?? new Map());
    if (target?.endsWith('.vue')) {
      const componentName = path.basename(target, '.vue');
      const targetId = stableId('Component', rel(root, target), componentName, 1);
      if (graph.nodes.has(targetId)) {
        graph.addEdge({
          type: 'ROUTES_TO',
          source: routeId,
          target: targetId,
          reason: `route path ${routePath} lazy component ${componentName}`,
          sourceFilePath: rel(root, sourceFile.realPath),
          targetFilePath: rel(root, target),
          line,
        });
      }
    }
  }
}

function collectStoreUsage(graph, root, sourceFile, node, source, target) {
  const targetNode = graph.nodes.get(target);
  if (!targetNode || targetNode.type !== 'Store') return;
  graph.addEdge({
    type: 'USES_STORE',
    source,
    target,
    reason: 'store composable call resolved by TypeScript',
    sourceFilePath: rel(root, sourceFile.realPath),
    targetFilePath: targetNode.filePath,
    line: sourceFile.vueVirtual
      ? mapVueLine(sourceFile.vueVirtual, lineOf(sourceFile, node.getStart(sourceFile)))
      : lineOf(sourceFile, node.getStart(sourceFile)),
  });
}

function localSymbolMap(graph, sourceFile) {
  let map = graph.localSymbols.get(sourceFile.fileName);
  if (!map) {
    map = new Map();
    graph.localSymbols.set(sourceFile.fileName, map);
  }
  return map;
}

function localStoreVarMap(graph, sourceFile) {
  let map = graph.storeVars.get(sourceFile.fileName);
  if (!map) {
    map = new Map();
    graph.storeVars.set(sourceFile.fileName, map);
  }
  return map;
}

function storeActionTarget(graph, storeId, actionName) {
  const store = graph.nodes.get(storeId);
  if (!store) return undefined;
  for (const node of graph.nodes.values()) {
    if (node.filePath === store.filePath && node.type === 'Method' && node.name === actionName) return node.id;
  }
  return undefined;
}

function collectStoreActionCall(graph, root, sourceFile, node, checker) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const receiver = node.expression.expression;
  if (!ts.isIdentifier(receiver)) return false;
  const storeId = localStoreVarMap(graph, sourceFile).get(receiver.text);
  if (!storeId) return false;
  const target = storeActionTarget(graph, storeId, node.expression.name.text);
  if (!target) return false;
  const source = nearestOwner(graph, sourceFile, node);
  const lineRaw = lineOf(sourceFile, node.getStart(sourceFile));
  const line = sourceFile.vueVirtual ? mapVueLine(sourceFile.vueVirtual, lineRaw) : lineRaw;
  graph.addEdge({
    type: 'CALLS',
    source,
    target,
    reason: 'Pinia store action call resolved by store variable',
    sourceFilePath: rel(root, sourceFile.realPath),
    targetFilePath: graph.nodes.get(target)?.filePath ?? '',
    line,
  });
  collectStoreUsage(graph, root, sourceFile, node, source, storeId);
  return true;
}

function collectImportsAndCalls(graph, root, checker, sourceFile, allRealFiles, virtualByVueFile) {
  visit(sourceFile, (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const target = resolveImportTarget(
        root,
        sourceFile,
        node.moduleSpecifier.text,
        allRealFiles,
        virtualByVueFile,
      );
      if (target) {
        const localMap = localSymbolMap(graph, sourceFile);
        if (target.endsWith('.vue')) {
          const componentName = path.basename(target, '.vue');
          const componentId = stableId('Component', rel(root, target), componentName, 1);
          for (const localName of importLocalNames(node.importClause)) localMap.set(localName, componentId);
        }
        graph.addEdge({
          type: 'IMPORTS',
          source: stableId('File', rel(root, sourceFile.realPath)),
          target: stableId('File', rel(root, target)),
          reason: node.moduleSpecifier.text,
          sourceFilePath: rel(root, sourceFile.realPath),
          targetFilePath: rel(root, target),
          line: sourceFile.vueVirtual
            ? mapVueLine(sourceFile.vueVirtual, lineOf(sourceFile, node.getStart(sourceFile)))
            : lineOf(sourceFile, node.getStart(sourceFile)),
        });
      }
    }

    if (ts.isCallExpression(node)) {
      const specifier = dynamicImportSpecifier(node);
      if (specifier) {
        const target = resolveImportTarget(root, sourceFile, specifier, allRealFiles, virtualByVueFile);
        if (target) {
          graph.addEdge({
            type: 'IMPORTS',
            source: stableId('File', rel(root, sourceFile.realPath)),
            target: stableId('File', rel(root, target)),
            reason: specifier,
            sourceFilePath: rel(root, sourceFile.realPath),
            targetFilePath: rel(root, target),
            line: sourceFile.vueVirtual
              ? mapVueLine(sourceFile.vueVirtual, lineOf(sourceFile, node.getStart(sourceFile)))
              : lineOf(sourceFile, node.getStart(sourceFile)),
            meta: { dynamic: true },
          });
        }
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      collectRouteEdges(graph, root, sourceFile, node);
    }

    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      if (collectStoreActionCall(graph, root, sourceFile, node, checker)) return;
      const target = resolvedCallTarget(graph, checker, node);
      if (!target) return;
      if (ts.isCallExpression(node) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
        const targetNode = graph.nodes.get(target);
        if (targetNode?.type === 'Store') localStoreVarMap(graph, sourceFile).set(node.parent.name.text, target);
      }
      const source = nearestOwner(graph, sourceFile, node);
      const lineRaw = lineOf(sourceFile, node.getStart(sourceFile));
      const line = sourceFile.vueVirtual ? mapVueLine(sourceFile.vueVirtual, lineRaw) : lineRaw;
      graph.addEdge({
        type: 'CALLS',
        source,
        target,
        reason: ts.isNewExpression(node) ? 'new expression resolved by TypeScript' : 'call resolved by TypeScript',
        sourceFilePath: rel(root, sourceFile.realPath),
        targetFilePath: graph.nodes.get(target)?.filePath ?? '',
        line,
      });
      const initializerSource = initializerVariableOwner(graph, node);
      if (initializerSource && initializerSource !== source) {
        graph.addEdge({
          type: 'CALLS',
          source: initializerSource,
          target,
          reason: 'variable initializer call resolved by TypeScript',
          sourceFilePath: rel(root, sourceFile.realPath),
          targetFilePath: graph.nodes.get(target)?.filePath ?? '',
          line,
          confidence: 0.98,
        });
      }
      collectStoreUsage(graph, root, sourceFile, node, source, target);
    }
  });
}

function addVueTemplateEdges(graph, root, vueInfoByRealPath) {
  for (const [vuePath, info] of vueInfoByRealPath) {
    const componentId = stableId('Component', rel(root, vuePath), path.basename(vuePath, '.vue'), 1);
    const locals = graph.localSymbols.get(info.virtualFileName) ?? new Map();

    for (const component of info.template.components) {
      const target =
        locals.get(component.normalizedName) ??
        locals.get(component.name) ??
        graph.componentNames.get(component.normalizedName) ??
        graph.componentNames.get(component.name) ??
        stableId(
          'Component',
          rel(root, path.resolve(path.dirname(vuePath), `${component.normalizedName}.vue`)),
          component.normalizedName,
          1,
        );
      const targetId = typeof target === 'string' && graph.nodes.has(target) ? target : undefined;
      if (!targetId) continue;
      graph.addEdge({
        type: 'RENDERS',
        source: componentId,
        target: targetId,
        reason: `template component <${component.name}>`,
        sourceFilePath: rel(root, vuePath),
        targetFilePath: graph.nodes.get(targetId)?.filePath ?? '',
        line: component.line,
      });
    }

    for (const expression of info.template.expressions) {
      for (const name of expression.text.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []) {
        const target = locals.get(name);
        if (!target) continue;
        graph.addEdge({
          type: 'HANDLES',
          source: componentId,
          target,
          reason: expression.reason,
          sourceFilePath: rel(root, vuePath),
          targetFilePath: graph.nodes.get(target)?.filePath ?? '',
          line: expression.line,
          confidence: 0.96,
          meta: { expression: expression.text },
        });
      }
    }
  }
}

function compilerOptionsFromTsconfig(root) {
  const configPath = path.join(root, 'tsconfig.json');
  if (!fs.existsSync(configPath)) {
    return {
      allowJs: true,
      checkJs: false,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      strict: false,
      skipLibCheck: true,
    };
  }
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  return parsed.options;
}

function createProgram(root, realFiles, virtualFiles, virtualByVueFile) {
  const options = compilerOptionsFromTsconfig(root);
  options.allowJs = true;
  options.checkJs = false;
  options.noEmit = true;
  options.skipLibCheck = true;
  options.moduleResolution ??= ts.ModuleResolutionKind.Bundler;
  if (Array.isArray(options.types)) {
    options.types = options.types.filter((typeName) => typeName !== 'vite/client');
  }

  const shimFile = path.normalize(path.join(root, '.gitnexus-vue-shim.d.ts'));
  virtualFiles.set(shimFile, {
    realPath: shimFile,
    virtualFileName: shimFile,
    mappings: [],
    template: { components: [], expressions: [] },
    content: [
      "declare module 'vue' {",
      '  export type Component = any;',
      '  export type ComponentPublicInstance = any;',
      '  export type CSSProperties = Record<string, string | number>;',
      '  export type HtmlHTMLAttributes = Record<string, any>;',
      '  export type RendererElement = any;',
      '  export type SetupContext = any;',
      '  export interface Ref<T = any> { value: T }',
      '  export interface ComputedRef<T = any> extends Ref<T> {}',
      '  export type PropType<T = any> = any;',
      '  export function defineComponent<T>(options: T): T;',
      '  export function createApp(...args: any[]): any;',
      '  export function h(...args: any[]): any;',
      '  export function ref<T>(value: T): Ref<T>;',
      '  export function shallowRef<T>(value: T): Ref<T>;',
      '  export function computed<T>(getter: () => T): ComputedRef<T>;',
      '  export function reactive<T extends object>(value: T): T;',
      '  export function readonly<T extends object>(value: T): T;',
      '  export function isReactive(value: unknown): boolean;',
      '  export function isRef(value: unknown): boolean;',
      '  export function toRaw<T>(value: T): T;',
      '  export function toRef(...args: any[]): Ref;',
      '  export function toRefs<T extends object>(value: T): any;',
      '  export function unref<T>(value: T | Ref<T>): T;',
      '  export function useTemplateRef<T = any>(key: string): Ref<T | null>;',
      '  export function watch(...args: any[]): any;',
      '  export function watchEffect(...args: any[]): any;',
      '  export function onMounted(fn: () => void): void;',
      '  export function onUnmounted(fn: () => void): void;',
      '  export function onBeforeMount(fn: () => void): void;',
      '  export function onBeforeUnmount(fn: () => void): void;',
      '  export function provide(...args: any[]): any;',
      '  export function inject(...args: any[]): any;',
      '  export function getCurrentInstance(): any;',
      '  export function useAttrs(): Record<string, unknown>;',
      '  export function useSlots(): Record<string, unknown>;',
      '  export function nextTick(fn?: () => void): Promise<void>;',
      '}',
      "declare module 'vue-router' {",
      '  export const RouterView: unknown;',
      '  export const RouterLink: unknown;',
      '  export type RouteRecordRaw = any;',
      '  export type RouteLocationNormalized = any;',
      '  export type RouteLocationNormalizedLoaded = any;',
      '  export function createRouter<T>(options: T): T;',
      '  export function createWebHistory(...args: any[]): unknown;',
      '  export function createWebHashHistory(...args: any[]): unknown;',
      '  export function useRoute(): any;',
      '  export function useRouter(): any;',
      '  export function onBeforeRouteUpdate(...args: any[]): void;',
      '  export function onBeforeRouteLeave(...args: any[]): void;',
      '}',
      "declare module 'pinia' {",
      '  export function defineStore<T extends string, O>(id: T, options: O): () => any;',
      '  export function createPinia(): any;',
      '  export function storeToRefs<T>(store: T): any;',
      '}',
      "declare module 'vite/client' {}",
      'declare function defineProps<T = Record<string, unknown>>(...args: any[]): T;',
      'declare function defineEmits<T = unknown>(...args: any[]): (...args: any[]) => void;',
      'declare function withDefaults<T, D>(props: T, defaults: D): T & D;',
      'declare function defineOptions<T = Record<string, unknown>>(options: T): void;',
      'declare function defineExpose<T = Record<string, unknown>>(exposed?: T): void;',
      'declare function defineSlots<T = Record<string, unknown>>(...args: any[]): T;',
      'declare function defineModel<T = unknown>(...args: any[]): Ref<T>;',
    ].join('\n'),
  });

  const allFileNames = [
    ...realFiles.filter((file) => path.extname(file) !== '.vue'),
    ...virtualFiles.keys(),
  ];
  const defaultHost = ts.createCompilerHost(options, true);
  const host = {
    ...defaultHost,
    fileExists(fileName) {
      return virtualFiles.has(path.normalize(fileName)) || defaultHost.fileExists(fileName);
    },
    readFile(fileName) {
      const normalized = path.normalize(fileName);
      return virtualFiles.get(normalized)?.content ?? defaultHost.readFile(fileName);
    },
    getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) {
      const normalized = path.normalize(fileName);
      const virtual = virtualFiles.get(normalized);
      if (virtual) {
        const sf = ts.createSourceFile(normalized, virtual.content, languageVersion, true, ts.ScriptKind.TS);
        sf.realPath = virtual.realPath;
        sf.vueVirtual = virtual;
        return sf;
      }
      const sf = defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
      if (sf) sf.realPath = path.normalize(fileName);
      return sf;
    },
    resolveModuleNames(moduleNames, containingFile) {
      return moduleNames.map((moduleName) => {
        if (moduleName.endsWith('.vue')) {
          const base = path.resolve(path.dirname(containingFile), moduleName);
          const realVue = path.normalize(base);
          const virtual = virtualByVueFile.get(realVue);
          if (virtual) {
            return {
              resolvedFileName: virtual.virtualFileName,
              extension: ts.Extension.Ts,
            };
          }
        }
        return ts.resolveModuleName(moduleName, containingFile, options, host).resolvedModule;
      });
    },
  };
  return ts.createProgram(allFileNames, options, host);
}

export function indexFrontendProject(root) {
  root = path.resolve(root);
  const files = walkFiles(root);
  const allRealFiles = new Set(files.map((file) => path.normalize(file)));
  const virtualFiles = new Map();
  const virtualByVueFile = new Map();
  const vueInfoByRealPath = new Map();
  const graph = createGraph(root);
  graph.allRealFiles = allRealFiles;
  graph.virtualByVueFile = virtualByVueFile;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    graphFileNode(graph, root, file, content);

    if (path.extname(file) === '.vue') {
      const componentName = path.basename(file, '.vue');
      const componentId = stableId('Component', rel(root, file), componentName, 1);
      graph.componentNames.set(componentName, componentId);
      graph.componentNames.set(kebabToPascal(componentName), componentId);
      graph.addNode({
        id: componentId,
        type: 'Component',
        name: componentName,
        filePath: rel(root, file),
        startLine: 1,
        endLine: Math.max(1, content.split('\n').length),
        exported: true,
        content,
        meta: { framework: 'vue' },
      });
      graph.addEdge({
        type: 'DEFINES',
        source: stableId('File', rel(root, file)),
        target: componentId,
        reason: 'Vue SFC component',
        sourceFilePath: rel(root, file),
        targetFilePath: rel(root, file),
        line: 1,
      });

      const virtual = extractVueScript(file, content);
      const virtualFileName = path.normalize(`${file}.ts`);
      const info = {
        ...virtual,
        realPath: path.normalize(file),
        virtualFileName,
        content: virtual.script || 'export default {}',
      };
      virtualFiles.set(virtualFileName, info);
      virtualByVueFile.set(path.normalize(file), info);
      vueInfoByRealPath.set(path.normalize(file), info);
    }
  }

  const program = createProgram(root, files, virtualFiles, virtualByVueFile);
  const checker = program.getTypeChecker();
  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && sf.realPath && sf.realPath.startsWith(root));

  for (const sourceFile of sourceFiles) collectDeclarations(graph, root, sourceFile);
  for (const sourceFile of sourceFiles) {
    collectImportsAndCalls(graph, root, checker, sourceFile, allRealFiles, virtualByVueFile);
  }
  addVueTemplateEdges(graph, root, vueInfoByRealPath);

  return {
    root,
    files: files.length,
    nodes: graph.nodes,
    edges: graph.edges,
    diagnostics: ts.getPreEmitDiagnostics(program).map((d) => ({
      file: d.file?.fileName,
      line: d.file ? lineOf(d.file, d.start ?? 0) : 0,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    })),
  };
}
