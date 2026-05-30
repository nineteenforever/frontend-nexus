// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
import { parse as parseSfc } from '@vue/compiler-sfc';
import { baseParse, NodeTypes } from '@vue/compiler-dom';

const FRONTEND_EXTS = new Set(['.vue', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const JAVASCRIPT_EXTS = new Set(['.js', '.mjs', '.cjs']);
const ASSET_EXTS = new Set(['.css', '.scss', '.sass', '.less', '.styl', '.json', '.gif', '.png', '.jpg', '.jpeg', '.svg', '.webp']);
const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.nuxt',
  '.output',
  'coverage',
  '.vuenexus',
]);
const STATIC_PUBLIC_DIRS = new Set(['public', 'static']);
const ANALYSIS_CACHE_VERSION = 1;
const GENERATED_JS_NAME_PATTERNS = [
  /\.min\.(?:js|mjs|cjs)$/i,
  /(?:^|[.-])jquery(?:[.-]|$)/i,
  /(?:^|[.-])bootstrap(?:[.-]|$)/i,
  /(?:^|[.-])lodash(?:[.-]|$)/i,
  /(?:^|[.-])echarts(?:[.-]|$)/i,
  /(?:^|[.-])monaco(?:[.-]|$)/i,
  /(?:^|[.-])(?:css|html|json|editor|typescript|ts)\.?worker(?:main)?(?:[.-]|$)/i,
  /(?:^|[.-])workermain(?:[.-]|$)/i,
  /(?:^|[.-])runtime(?:[.-][a-f0-9]{6,})?\.(?:js|mjs|cjs)$/i,
  /(?:^|[.-])vendor(?:[.-][a-f0-9]{6,})?\.(?:js|mjs|cjs)$/i,
  /(?:^|[.-])chunk(?:[.-][a-f0-9]{6,})?\.(?:js|mjs|cjs)$/i,
];

function slash(filePath) {
  return filePath.split(path.sep).join('/');
}

function rel(root, filePath) {
  return slash(path.relative(root, filePath));
}

function fileKey(filePath) {
  const normalized = slash(path.normalize(filePath));
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
}

function analysisCachePath(root) {
  return path.join(root, '.vuenexus', 'cache', 'analysis-cache.json');
}

function contentHash(content) {
  return crypto.createHash('sha1').update(content).digest('hex');
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

function generatedJsReason(filePath, stats) {
  const ext = path.extname(filePath).toLowerCase();
  if (!JAVASCRIPT_EXTS.has(ext)) return undefined;
  const baseName = path.basename(filePath);
  if (GENERATED_JS_NAME_PATTERNS.some((pattern) => pattern.test(baseName))) {
    return 'generated/minified filename';
  }
  if (stats.size < 128 * 1024) return undefined;
  let sample = '';
  try {
    const fd = fs.openSync(filePath, 'r');
    const bytes = Buffer.alloc(Math.min(stats.size, 256 * 1024));
    const read = fs.readSync(fd, bytes, 0, bytes.length, 0);
    fs.closeSync(fd);
    sample = bytes.subarray(0, read).toString('utf8');
  } catch {
    return undefined;
  }
  const lines = sample.split(/\r?\n/);
  const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const averageLineLength = sample.length / Math.max(1, lines.length);
  if (longestLine > 20000 || (stats.size > 256 * 1024 && averageLineLength > 800)) {
    return 'generated/minified content';
  }
  if (/sourceMappingURL=.*\.map/.test(sample) && longestLine > 8000) return 'generated bundle content';
  return undefined;
}

function walkFiles(root, options = {}) {
  const files = [];
  const skipped = [];
  const skipGenerated = options.skipGenerated !== false;
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipGenerated && STATIC_PUBLIC_DIRS.has(entry.name.toLowerCase())) {
          skipped.push({ filePath: rel(root, full), reason: 'static public directory', size: 0, directory: true });
          continue;
        }
        visit(full);
      } else if (FRONTEND_EXTS.has(path.extname(entry.name))) {
        if (skipGenerated) {
          const stats = fs.statSync(full);
          const reason = generatedJsReason(full, stats);
          if (reason) {
            skipped.push({ filePath: rel(root, full), reason, size: stats.size });
            continue;
          }
        }
        files.push(full);
      }
    }
  };
  visit(root);
  return { files: files.sort(), skipped: skipped.sort((a, b) => a.filePath.localeCompare(b.filePath)) };
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

function pascalToKebab(name) {
  return String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

const VUE_BUILT_IN_TAGS = new Set([
  'clientonly',
  'client-only',
  'component',
  'keep-alive',
  'router-link',
  'router-view',
  'slot',
  'suspense',
  'teleport',
  'template',
  'transition',
  'transition-group',
]);

function isVueComponentTag(tag) {
  if (VUE_BUILT_IN_TAGS.has(String(tag).toLowerCase())) return false;
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
  if (!template) return { components: [], expressions: [], errors: [] };
  let ast = template.ast;
  try {
    ast ??= baseParse(template.content, { comments: false });
  } catch (err) {
    return {
      components: [],
      expressions: [],
      errors: [{
        line: template.loc.start.line + (err?.loc?.start?.line ?? 1) - 1,
        message: `Vue template parse failed: ${err instanceof Error ? err.message : String(err)}`,
      }],
    };
  }
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
  return { components, expressions, errors: [] };
}

function extractVueScript(filePath, content) {
  const parsed = parseSfc(content, { filename: filePath });
  const { descriptor } = parsed;
  const chunks = [];
  const mappings = [];
  let scriptKind = ts.ScriptKind.TS;

  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block) continue;
    const lang = String(block.attrs?.lang ?? '').toLowerCase();
    if (lang === 'jsx' || lang === 'tsx') scriptKind = ts.ScriptKind.TSX;
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
  if (/\breturn\s*\(?\s*<[A-Za-z]/.test(userScript)) scriptKind = ts.ScriptKind.TSX;
  const hasDefaultExport = /\bexport\s+default\b/.test(userScript);
  const fallbackDefault = hasDefaultExport
    ? ''
    : '\ndeclare const __vue_sfc_default__: unknown;\nexport default __vue_sfc_default__;\n';
  const script = [userScript, fallbackDefault].filter(Boolean).join('\n\n');
  const imports = new Map();
  const template = collectTemplateRefs(descriptor.template);
  return { script, mappings, imports, template, errors: [...parsed.errors, ...template.errors], scriptKind };
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

function isExportedVariableDeclaration(node) {
  return Boolean(
    node?.parent &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.parent &&
      ts.isVariableStatement(node.parent.parent) &&
      isExported(node.parent.parent),
  );
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

function propertyNameText(node) {
  if (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) {
    return objectPropertyName(node.name);
  }
  return undefined;
}

function parentPropertyName(node) {
  const parent = node.parent;
  if (parent && ts.isPropertyAssignment(parent)) return objectPropertyName(parent.name);
  return undefined;
}

function objectLiteralSection(node) {
  let current = node;
  while (current) {
    if (
      current.parent &&
      ts.isObjectLiteralExpression(current.parent) &&
      current.parent.parent &&
      ts.isPropertyAssignment(current.parent.parent)
    ) {
      return objectPropertyName(current.parent.parent.name);
    }
    if (ts.isObjectLiteralExpression(current) && current.parent && ts.isPropertyAssignment(current.parent)) {
      return objectPropertyName(current.parent.name);
    }
    if (
      ts.isObjectLiteralExpression(current) &&
      current.parent &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      const variableName = current.parent.name.text;
      if (['actions', 'mutations', 'getters'].includes(variableName)) return variableName;
    }
    current = current.parent;
  }
  return undefined;
}

function expressionCalleeName(expr) {
  if (!expr) return '';
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return `${expressionCalleeName(expr.expression)}.${expr.name.text}`.replace(/^\./, '');
  return expr.getText();
}

function isStoreCreationExpression(expr) {
  if (!expr) return false;
  if (ts.isNewExpression(expr)) {
    const callee = expressionCalleeName(expr.expression);
    return callee === 'Vuex.Store' || callee.endsWith('.Store');
  }
  if (ts.isCallExpression(expr)) {
    const callee = expressionCalleeName(expr.expression);
    return callee === 'createStore' || callee.endsWith('.createStore');
  }
  return false;
}

function defineComponentOptions(expr) {
  if (!ts.isCallExpression(expr)) return undefined;
  const callee = expressionCalleeName(expr.expression);
  if (callee !== 'defineComponent' && !callee.endsWith('.defineComponent')) return undefined;
  const [options] = expr.arguments;
  return options && ts.isObjectLiteralExpression(options) ? options : undefined;
}

function isVueOptionsObject(objectLiteral) {
  const optionKeys = new Set([
    'components',
    'computed',
    'data',
    'directives',
    'extends',
    'filters',
    'componentName',
    'inheritAttrs',
    'methods',
    'name',
    'mixins',
    'props',
    'render',
    'setup',
    'template',
    'watch',
  ]);
  let hits = 0;
  for (const prop of objectLiteral.properties) {
    const name = propertyNameText(prop);
    if (name && optionKeys.has(name)) hits++;
  }
  if (!hits) return false;
  const parent = objectLiteral.parent;
  if (ts.isExportAssignment(parent)) return true;
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    const callee = expressionCalleeName(parent.expression);
    return ['defineComponent', 'defineOptions', 'Vue.extend', 'Vue.component', 'Vue'].some((name) => callee === name || callee.endsWith(`.${name}`));
  }
  return hits >= 2;
}

function functionReturnedObject(fn) {
  if (!fn) return undefined;
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isObjectLiteralExpression(fn.body)) return fn.body;
  const body = ts.isMethodDeclaration(fn) || ts.isFunctionLike(fn) ? fn.body : undefined;
  if (!body || !ts.isBlock(body)) return undefined;
  for (const statement of body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression && ts.isObjectLiteralExpression(statement.expression)) {
      return statement.expression;
    }
  }
  return undefined;
}

function stringLiteralNames(expr) {
  if (!expr) return [];
  if (ts.isStringLiteralLike(expr)) return [expr.text];
  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.filter(ts.isStringLiteralLike).map((element) => element.text);
  }
  if (ts.isObjectLiteralExpression(expr)) {
    return expr.properties.map(propertyNameText).filter(Boolean);
  }
  return [];
}

const packageNameCache = new Map();
const resolverCache = new Map();

function packageNameForRoot(root) {
  if (packageNameCache.has(root)) return packageNameCache.get(root);
  let name = '';
  try {
    name = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name ?? '';
  } catch {}
  packageNameCache.set(root, name);
  return name;
}

function rootConfigFiles(root) {
  const preferred = [
    'tsconfig.json',
    'jsconfig.json',
    'tsconfig.web.json',
    'tsconfig.app.json',
    'tsconfig.base.json',
  ];
  const seen = new Set();
  const files = [];
  for (const name of preferred) {
    const full = path.join(root, name);
    if (fs.existsSync(full)) {
      files.push(full);
      seen.add(name);
    }
  }
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || seen.has(entry.name)) continue;
      if (/^tsconfig\..+\.json$/.test(entry.name)) files.push(path.join(root, entry.name));
    }
  } catch {}
  return files;
}

function readParsedConfig(configPath) {
  try {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) return undefined;
    return ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  } catch {
    return undefined;
  }
}

function pathMappingTargets(pattern, targets, baseDir) {
  return (Array.isArray(targets) ? targets : [targets]).map((target) => ({
    pattern,
    target: String(target),
    baseDir,
    source: 'tsconfig-paths',
  }));
}

function aliasRule(pattern, target, baseDir, source) {
  if (!pattern || !target) return undefined;
  return {
    pattern: String(pattern),
    target: String(target),
    baseDir,
    source,
  };
}

function configAliasFiles(root) {
  const files = [];
  const visit = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
      } else if (
        /^(vite|webpack|vue)\.config\.[cm]?[jt]s$/.test(entry.name) ||
        (/^webpack\..+\.js$/.test(entry.name)) ||
        (['build', 'config'].includes(path.basename(dir)) && /\.[cm]?[jt]s$/.test(entry.name)) ||
        (entry.name === 'config.js' && ['build', 'config'].includes(path.basename(dir)))
      ) {
        files.push(full);
      }
    }
  };
  visit(root, 0);
  return files;
}

function scanBundlerAliasRules(root) {
  const rules = [];
  for (const configPath of configAliasFiles(root)) {
    let text = '';
    try {
      text = fs.readFileSync(configPath, 'utf8');
    } catch {
      continue;
    }
    const baseDir = path.dirname(configPath);
    const patterns = [
      /['"]([^'"]+)['"]\s*:\s*(?:path\.)?(?:resolve|join)\(__dirname,\s*['"]([^'"]+)['"]\s*\)/g,
      /([A-Za-z_$][\w$@-]*)\s*:\s*(?:path\.)?(?:resolve|join)\(__dirname,\s*['"]([^'"]+)['"]\s*\)/g,
      /['"]([^'"]+)['"]\s*:\s*resolve\(['"]([^'"]+)['"]\s*\)/g,
      /([A-Za-z_$][\w$@-]*)\s*:\s*resolve\(['"]([^'"]+)['"]\s*\)/g,
      /find\s*:\s*['"]([^'"]+)['"]\s*,\s*replacement\s*:\s*(?:path\.)?(?:resolve|join)\(__dirname,\s*['"]([^'"]+)['"]\s*\)/g,
      /find\s*:\s*['"]([^'"]+)['"]\s*,\s*replacement\s*:\s*`\$\{(?:path\.)?(?:resolve|join)\(__dirname,\s*['"]([^'"]+)['"]\s*\)\}\/?`/g,
      /find\s*:\s*['"]([^'"]+)['"]\s*,\s*replacement\s*:\s*['"]([^'"]+)['"]/g,
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const rule = aliasRule(match[1], match[2], baseDir, `bundler-alias:${rel(root, configPath)}`);
        if (rule) rules.push(rule);
      }
    }
  }
  return rules;
}

function importResolverForRoot(root) {
  if (resolverCache.has(root)) return resolverCache.get(root);
  const rules = [];
  for (const configPath of rootConfigFiles(root)) {
    const parsed = readParsedConfig(configPath);
    const paths = parsed?.options?.paths ?? {};
    const baseDir = parsed?.options?.baseUrl
      ? path.resolve(parsed.options.baseUrl)
      : path.dirname(configPath);
    for (const [pattern, targets] of Object.entries(paths)) {
      rules.push(...pathMappingTargets(pattern, targets, baseDir));
    }
  }
  rules.push(...scanBundlerAliasRules(root));
  const unique = [];
  const seen = new Set();
  for (const rule of rules) {
    const key = `${rule.pattern}|${rule.target}|${rule.baseDir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(rule);
  }
  const resolver = { rules: unique };
  resolverCache.set(root, resolver);
  return resolver;
}

function basesFromAliasRule(rule, spec) {
  const pattern = rule.pattern.replace(/\$$/, '');
  if (pattern.includes('*')) {
    const [prefix, suffix = ''] = pattern.split('*');
    if (!spec.startsWith(prefix) || (suffix && !spec.endsWith(suffix))) return [];
    const matched = spec.slice(prefix.length, spec.length - suffix.length);
    return [path.resolve(rule.baseDir, rule.target.replace('*', matched))];
  }
  if (spec === pattern) return [path.resolve(rule.baseDir, rule.target)];
  if (pattern.endsWith('/') && spec.startsWith(pattern)) {
    return [path.resolve(rule.baseDir, rule.target, spec.slice(pattern.length))];
  }
  if (spec.startsWith(`${pattern}/`)) {
    return [path.resolve(rule.baseDir, rule.target, spec.slice(pattern.length + 1))];
  }
  return [];
}

function configuredImportBases(root, spec) {
  const resolver = importResolverForRoot(root);
  return resolver.rules.flatMap((rule) => basesFromAliasRule(rule, spec));
}

function srcDirectoryBase(root, spec) {
  if (spec.startsWith('.') || spec.startsWith('/') || !spec.includes('/')) return undefined;
  const [first] = spec.split('/');
  const base = path.join(root, 'src', first);
  try {
    if (fs.statSync(base).isDirectory()) return path.join(root, 'src', spec);
  } catch {}
  return undefined;
}

function srcDirectoryIndexBase(root, spec) {
  if (spec.startsWith('.') || spec.startsWith('/') || !spec.includes('/')) return undefined;
  const [first, second] = spec.split('/');
  if (!first || !second) return undefined;
  const normalizedFirst = kebabToPascal(first);
  if (second !== normalizedFirst && second !== first) return undefined;
  const base = path.join(root, 'src', first);
  try {
    if (fs.statSync(base).isDirectory()) return base;
  } catch {}
  return undefined;
}

function resolveCandidate(base, allRealFiles, virtualByVueFile) {
  const files = allRealFiles instanceof Set ? allRealFiles : new Set(allRealFiles ?? []);
  const basename = path.basename(base);
  const kebabBase = pascalToKebab(basename);
  const kebabPath = kebabBase && kebabBase !== basename
    ? path.join(path.dirname(base), kebabBase)
    : undefined;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.vue`,
    `${base}.json`,
    path.join(base, 'index.vue'),
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx'),
    path.join(base, 'index.mjs'),
    path.join(base, 'index.json'),
    ...(kebabPath
      ? [
        kebabPath,
        `${kebabPath}.ts`,
        `${kebabPath}.tsx`,
        `${kebabPath}.js`,
        `${kebabPath}.jsx`,
        `${kebabPath}.vue`,
      ]
      : []),
  ];
  for (const candidate of candidates) {
    const normalized = path.normalize(candidate);
    if (files.has(normalized)) return normalized;
    if (virtualByVueFile.has(normalized)) return normalized;
    if (ASSET_EXTS.has(path.extname(normalized)) && fs.existsSync(normalized)) return normalized;
  }
  return null;
}

function resolveImportTarget(root, sourceFile, spec, allRealFiles, virtualByVueFile) {
  let base;
  const packageName = packageNameForRoot(root);
  for (const configuredBase of configuredImportBases(root, spec)) {
    const resolved = resolveCandidate(configuredBase, allRealFiles, virtualByVueFile);
    if (resolved) return resolved;
  }
  if (spec.startsWith('@/')) {
    base = path.join(root, 'src', spec.slice(2));
  } else if (spec.startsWith('~/')) {
    base = path.join(root, spec.slice(2));
  } else if (packageName && spec === packageName) {
    base = path.join(root, 'src');
  } else if (packageName && spec.startsWith(`${packageName}/`)) {
    const rest = spec.slice(packageName.length + 1);
    base = rest.startsWith('es/') || rest.startsWith('lib/')
      ? path.join(root, 'packages', rest.slice(3))
      : path.join(root, rest);
  } else if (spec.startsWith('main/')) {
    base = path.join(root, 'src', spec.slice('main/'.length));
  } else if (/^(src|packages|examples|docs)\//.test(spec)) {
    base = path.join(root, spec);
  } else if (srcDirectoryBase(root, spec)) {
    base = srcDirectoryBase(root, spec);
  } else if (spec.startsWith('/')) {
    base = path.join(root, spec);
  } else if (spec.startsWith('.')) {
    base = path.resolve(path.dirname(sourceFile.realPath), spec);
  } else {
    return null;
  }
  return (
    resolveCandidate(base, allRealFiles, virtualByVueFile) ??
    (srcDirectoryIndexBase(root, spec)
      ? resolveCandidate(srcDirectoryIndexBase(root, spec), allRealFiles, virtualByVueFile)
      : null)
  );
}

function createGraph(root, options = {}) {
  const nodes = new Map();
  const edges = new Map();
  const byDeclaration = new Map();
  const localSymbols = new Map();
  const componentNames = new Map();
  const storeVars = new Map();
  const checkerFailures = [];

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
  const addUnresolved = (entry) => {
    const filePath = entry.filePath ?? '';
    const line = entry.line ?? 0;
    const text = entry.text ?? entry.name ?? '';
    const id = stableId('UnresolvedReference', filePath, entry.kind, line, text);
    const ownerId = entry.ownerId || (filePath ? stableId('File', filePath) : '');
    addNode({
      id,
      type: 'UnresolvedReference',
      name: `${entry.kind}:${text}`,
      filePath,
      startLine: line,
      endLine: line,
      exported: false,
      content: text,
      meta: {
        kind: entry.kind,
        text,
        ownerId,
        reason: entry.reason ?? '',
        attemptedResolvers: entry.attemptedResolvers ?? [],
        candidates: entry.candidates ?? [],
      },
    });
    if (ownerId && nodes.has(ownerId)) {
      addEdge({
        type: 'HAS_UNRESOLVED',
        source: ownerId,
        target: id,
        reason: entry.reason ?? '',
        sourceFilePath: nodes.get(ownerId)?.filePath ?? filePath,
        targetFilePath: filePath,
        line,
        confidence: 1,
      });
    }
    return id;
  };

  return {
    root,
    checkerMode: options.checkerMode ?? 'fast',
    slowCheckerThresholdMs: options.slowCheckerThresholdMs ?? 2000,
    nodes,
    edges,
    byDeclaration,
    localSymbols,
    componentNames,
    storeVars,
    checkerFailures,
    typeCheckerDisabled: false,
    addNode,
    addEdge,
    addUnresolved,
  };
}

function componentAliasNames(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return [];
  const pascal = raw.includes('-') ? kebabToPascal(raw) : raw;
  const kebab = pascalToKebab(pascal);
  return [...new Set([raw, pascal, kebab])].filter(Boolean);
}

function registerComponentAlias(graph, name, componentId) {
  if (!name || !componentId) return;
  for (const alias of componentAliasNames(name)) graph.componentNames.set(alias, componentId);
}

function modulePackageName(spec) {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0] ?? spec;
}

function addExternalModuleNode(graph, spec, meta = {}) {
  const packageName = modulePackageName(spec);
  const id = stableId('ExternalModule', spec);
  graph.addNode({
    id,
    type: 'ExternalModule',
    name: spec,
    filePath: '',
    startLine: 0,
    endLine: 0,
    exported: true,
    content: spec,
    meta: {
      packageName,
      modulePath: spec.slice(packageName.length).replace(/^\//, ''),
      external: true,
      ...meta,
    },
  });
  return id;
}

function addExternalImportEdge(graph, root, sourceFile, anchor, spec, meta = {}) {
  const target = addExternalModuleNode(graph, spec, meta);
  graph.addEdge({
    type: 'IMPORTS',
    source: stableId('File', rel(root, sourceFile.realPath)),
    target,
    reason: spec,
    sourceFilePath: rel(root, sourceFile.realPath),
    targetFilePath: '',
    line: sourceLine(sourceFile, anchor),
    confidence: 1,
    meta,
  });
  return target;
}

function isConfiguredAliasSpecifier(root, spec) {
  return configuredImportBases(root, spec).length > 0;
}

function isLocalLikeSpecifier(root, spec) {
  const packageName = packageNameForRoot(root);
  return (
    spec.startsWith('.') ||
    spec.startsWith('/') ||
    spec.startsWith('@/') ||
    spec.startsWith('~/') ||
    /^(src|packages|examples|docs|main)\//.test(spec) ||
    Boolean(srcDirectoryBase(root, spec)) ||
    (packageName && (spec === packageName || spec.startsWith(`${packageName}/`))) ||
    isConfiguredAliasSpecifier(root, spec)
  );
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

function ensureGraphFileNode(graph, root, realPath) {
  const id = stableId('File', rel(root, realPath));
  if (graph.nodes.has(id)) return id;
  let content = '';
  try {
    content = fs.readFileSync(realPath, 'utf8');
  } catch {}
  return graphFileNode(graph, root, realPath, content);
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

function sourceLine(sourceFile, node) {
  const lineRaw = lineOf(sourceFile, node.getStart(sourceFile));
  return sourceFile.vueVirtual ? mapVueLine(sourceFile.vueVirtual, lineRaw) : lineRaw;
}

function recordUnresolved(graph, root, sourceFile, node, kind, text, reason, extras = {}) {
  const line = sourceLine(sourceFile, node);
  return graph.addUnresolved({
    kind,
    text,
    reason,
    filePath: rel(root, sourceFile.realPath),
    line,
    ownerId: extras.ownerId ?? nearestOwner(graph, sourceFile, node),
    attemptedResolvers: extras.attemptedResolvers,
    candidates: extras.candidates,
  });
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

function isRecoverableTypeCheckerError(err) {
  return (
    err instanceof RangeError ||
    /Maximum call stack size exceeded|call stack/i.test(String(err?.message ?? err))
  );
}

function safeCheckerCall(graph, sourceFile, node, operation, fn) {
  if (graph.checkerMode !== 'full') return undefined;
  if (graph.typeCheckerDisabled) return undefined;
  const started = Date.now();
  try {
    const value = fn();
    const durationMs = Date.now() - started;
    if (durationMs > graph.slowCheckerThresholdMs) {
      graph.checkerFailures.push({
        file: rel(graph.root, sourceFile.realPath ?? sourceFile.fileName),
        line: node ? sourceLine(sourceFile, node) : 0,
        message: `TypeScript checker was slow during ${operation}: ${durationMs}ms. Use the default --checker fast mode if analyze is too slow.`,
      });
    }
    return value;
  } catch (err) {
    if (!isRecoverableTypeCheckerError(err)) throw err;
    graph.typeCheckerDisabled = true;
    graph.checkerFailures.push({
      file: rel(graph.root, sourceFile.realPath ?? sourceFile.fileName),
      line: node ? sourceLine(sourceFile, node) : 0,
      message: `TypeScript checker failed during ${operation}: ${err instanceof Error ? err.message : String(err)}. Falling back to AST-only resolution for the rest of analyze.`,
    });
    return undefined;
  }
}

function safeAliasedSymbol(graph, sourceFile, node, checker, symbol, operation) {
  if (!symbol || !(symbol.flags & ts.SymbolFlags.Alias)) return symbol;
  return safeCheckerCall(graph, sourceFile, node, `${operation}: getAliasedSymbol`, () =>
    checker.getAliasedSymbol(symbol),
  );
}

function localCalleeTarget(graph, sourceFile, callee) {
  if (ts.isIdentifier(callee)) {
    const local = localSymbolMap(graph, sourceFile).get(callee.text);
    if (local && graph.nodes.has(local)) return local;
  }
  return undefined;
}

function resolvedCallTarget(graph, checker, expr) {
  const callee = ts.isCallExpression(expr) || ts.isNewExpression(expr) ? expr.expression : expr.tag;
  const localThisTarget = thisMemberTarget(graph, expr.getSourceFile(), callee);
  const localTarget = localCalleeTarget(graph, expr.getSourceFile(), callee);
  if (localTarget) return localTarget;
  if (graph.checkerMode !== 'full') return localThisTarget;
  const sig = safeCheckerCall(graph, expr.getSourceFile(), expr, 'call signature resolution', () =>
    checker.getResolvedSignature(expr),
  );
  const decl = sig?.declaration;
  if (decl) {
    const target = declarationTarget(graph, decl);
    const targetNode = target ? graph.nodes.get(target) : undefined;
    if (targetNode?.type === 'Interface') return undefined;
    if (localThisTarget && (!targetNode || targetNode.type === 'Class')) return localThisTarget;
    if (target) return target;
  }
  const symbol = safeCheckerCall(graph, expr.getSourceFile(), callee, 'call symbol resolution', () =>
    checker.getSymbolAtLocation(callee),
  );
  const aliased = safeAliasedSymbol(graph, expr.getSourceFile(), callee, checker, symbol, 'call symbol resolution');
  const declarations = [
    ...(symbol?.getDeclarations() ?? []),
    ...(aliased && aliased !== symbol ? aliased.getDeclarations() ?? [] : []),
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

function importLocalIdentifiers(importClause) {
  if (!importClause) return [];
  const names = [];
  if (importClause.name) names.push(importClause.name);
  const bindings = importClause.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) names.push(element.name);
  }
  return names;
}

function importLocalIdentifierBindings(importClause) {
  if (!importClause) return [];
  const bindings = [];
  if (importClause.name) bindings.push({ local: importClause.name, importedName: 'default', isDefault: true });
  const namedBindings = importClause.namedBindings;
  if (namedBindings && ts.isNamedImports(namedBindings)) {
    for (const element of namedBindings.elements) {
      bindings.push({
        local: element.name,
        importedName: (element.propertyName ?? element.name).text,
        isDefault: false,
      });
    }
  }
  return bindings;
}

function defaultExportNodeForFile(graph, root, target) {
  const targetPath = rel(root, target);
  const baseName = path.basename(target, path.extname(target));
  const defaults = [...graph.nodes.values()].filter(
    (node) =>
      node.filePath === targetPath &&
      ['default-export-object', 'vue-options-default-export', 'vue-component-default-export'].includes(node.meta?.kind),
  );
  return (
    defaults.find((node) => node.name === baseName)?.id ??
    (defaults.length === 1 ? defaults[0].id : undefined)
  );
}

function exportedNodeForFileAndName(graph, root, target, exportName) {
  if (exportName === 'default') return defaultExportNodeForFile(graph, root, target);
  const targetPath = rel(root, target);
  const matches = [...graph.nodes.values()].filter(
    (node) =>
      node.filePath === targetPath &&
      node.name === exportName &&
      (node.exported || node.meta?.exported || node.meta?.kind === 'vue-component-default-export'),
  );
  return matches.length === 1 ? matches[0].id : undefined;
}

function barrelExportTarget(graph, root, sourceFile, target, exportName, allRealFiles, virtualByVueFile) {
  let content = '';
  try {
    content = fs.readFileSync(target, 'utf8');
  } catch {
    return undefined;
  }
  const exportPattern = new RegExp(
    `export\\s*\\{[^}]*default\\s+as\\s+${exportName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`,
  );
  const match = content.match(exportPattern);
  if (!match) return undefined;
  const barrelSource = { realPath: target };
  const resolved = resolveImportTarget(root, barrelSource, match[1], allRealFiles, virtualByVueFile);
  if (!resolved) return undefined;
  ensureGraphFileNode(graph, root, resolved);
  if (resolved.endsWith('.vue')) {
    const componentId = stableId('Component', rel(root, resolved), path.basename(resolved, '.vue'), 1);
    return graph.nodes.has(componentId) ? componentId : undefined;
  }
  return defaultExportNodeForFile(graph, root, resolved) ?? stableId('File', rel(root, resolved));
}

function classifyVariable(sourceFile, node, name) {
  const filePath = slash(sourceFile.realPath);
  const init = node.initializer;
  if (init && ts.isCallExpression(init)) {
    const callee = callName(init.expression);
    if (callee === 'defineStore') return 'Store';
    if (callee === 'createRouter') return 'Router';
  }
  if (init && isStoreCreationExpression(init)) return 'Store';
  if (isComposableName(name)) return 'Composable';
  if (isStoreFile(filePath) && /^use[A-Z0-9].*Store$/.test(name)) return 'Store';
  return 'Variable';
}

function addSyntheticDeclaration(graph, root, sourceFile, anchor, type, name, fileLocal, meta = {}) {
  const id = addDeclarationNode(graph, root, sourceFile, anchor, type, name, false, meta);
  fileLocal?.set(name, id);
  return id;
}

function collectVueOptionsDeclarations(graph, root, sourceFile, objectLiteral, fileLocal) {
  if (!isVueOptionsObject(objectLiteral)) return;
  if (sourceFile.realPath.endsWith('.vue')) {
    const componentName =
      staticStringValue(sourceFile, initializerProperty(objectLiteral, 'name')) ??
      staticStringValue(sourceFile, initializerProperty(objectLiteral, 'componentName'));
    if (componentName) {
      const componentId = stableId(
        'Component',
        rel(root, sourceFile.realPath),
        path.basename(sourceFile.realPath, '.vue'),
        1,
      );
      if (graph.nodes.has(componentId)) registerComponentAlias(graph, componentName, componentId);
    }
  }
  for (const prop of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(prop) && !ts.isMethodDeclaration(prop)) continue;
    const section = objectPropertyName(prop.name);
    if (section === 'props') {
      if (!ts.isPropertyAssignment(prop)) continue;
      for (const name of stringLiteralNames(prop.initializer)) {
        addSyntheticDeclaration(graph, root, sourceFile, prop.initializer, 'Variable', name, fileLocal, {
          kind: 'vue-prop',
          framework: 'vue',
        });
      }
    }
    if (section === 'data') {
      const returned = functionReturnedObject(ts.isPropertyAssignment(prop) ? prop.initializer : prop);
      if (!returned) continue;
      for (const dataProp of returned.properties) {
        const name = propertyNameText(dataProp);
        if (!name) continue;
        addSyntheticDeclaration(graph, root, sourceFile, dataProp, 'Variable', name, fileLocal, {
          kind: 'vue-data',
          framework: 'vue',
        });
      }
    }
  }
}

function vuexStatePathFromMapper(expr) {
  if (!expr || (!ts.isArrowFunction(expr) && !ts.isFunctionExpression(expr))) return undefined;
  const body = ts.isBlock(expr.body)
    ? expr.body.statements.find((statement) => ts.isReturnStatement(statement))?.expression
    : expr.body;
  if (!body || !ts.isPropertyAccessExpression(body)) return undefined;
  const parts = [];
  let current = body;
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text);
    current = current.expression;
  }
  if (!ts.isIdentifier(current) || current.text !== 'state' || parts.length < 2) return undefined;
  return parts.join('/');
}

function mapHelperNames(call) {
  if (!ts.isCallExpression(call)) return [];
  const helper = callName(call.expression);
  if (!/^map(State|Getters|Mutations|Actions)$/.test(helper)) return [];
  const namespace =
    call.arguments.length > 1 && ts.isStringLiteralLike(call.arguments[0])
      ? call.arguments[0].text.replace(/\/$/, '')
      : '';
  const arg = call.arguments[namespace ? 1 : 0];
  if (!arg) return [];
  if (ts.isArrayLiteralExpression(arg)) {
    return arg.elements.filter(ts.isStringLiteralLike).map((element) => ({
      name: element.text,
      targetName: namespace ? `${namespace}/${element.text}` : element.text,
      helper,
      anchor: element,
    }));
  }
  if (ts.isObjectLiteralExpression(arg)) {
    return arg.properties.map((prop) => {
      const name = propertyNameText(prop);
      let targetName = name;
      if (ts.isPropertyAssignment(prop) && ts.isStringLiteralLike(prop.initializer)) {
        targetName = prop.initializer.text;
      } else if (helper === 'mapState' && ts.isPropertyAssignment(prop)) {
        targetName = vuexStatePathFromMapper(prop.initializer) ?? targetName;
      }
      if (namespace && targetName) targetName = `${namespace}/${targetName}`;
      return name ? { name, targetName, helper, anchor: prop } : undefined;
    }).filter(Boolean);
  }
  return [];
}

function collectDeclarations(graph, root, sourceFile) {
  const fileLocal = new Map();
  localSymbolMap(graph, sourceFile).clear();

  visit(sourceFile, (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      collectVueOptionsDeclarations(graph, root, sourceFile, node, fileLocal);
    }

    if (ts.isExportAssignment(node) && isStoreCreationExpression(node.expression)) {
      const id = addDeclarationNode(graph, root, sourceFile, node, 'Store', 'defaultStore', true, {
        kind: 'vuex-store',
        framework: 'vuex',
      });
      fileLocal.set('defaultStore', id);
    }

    if (
      ts.isExportAssignment(node) &&
      !sourceFile.realPath.endsWith('.vue') &&
      defineComponentOptions(node.expression)
    ) {
      const options = defineComponentOptions(node.expression);
      const componentName =
        staticStringValue(sourceFile, initializerProperty(options, 'name')) ??
        staticStringValue(sourceFile, initializerProperty(options, 'componentName')) ??
        path.basename(sourceFile.realPath, path.extname(sourceFile.realPath));
      const id = addDeclarationNode(graph, root, sourceFile, node, 'Component', componentName, true, {
        kind: 'vue-component-default-export',
        framework: 'vue',
      });
      fileLocal.set('default', id);
      fileLocal.set(componentName, id);
    }

    if (
      ts.isExportAssignment(node) &&
      !sourceFile.realPath.endsWith('.vue') &&
      ts.isObjectLiteralExpression(node.expression) &&
      !isStoreCreationExpression(node.expression)
    ) {
      const name = path.basename(sourceFile.realPath, path.extname(sourceFile.realPath));
      const id = addDeclarationNode(graph, root, sourceFile, node, 'Variable', name, true, {
        kind: isVueOptionsObject(node.expression) ? 'vue-options-default-export' : 'default-export-object',
      });
      fileLocal.set('default', id);
      fileLocal.set(name, id);
    }

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
      const exported = isExportedVariableDeclaration(node);
      const name = nameOfBindingName(node.name);
      if (!name) {
        const names = bindingNames(node.name);
        let firstId;
        for (const binding of names) {
          const id = addDeclarationNode(graph, root, sourceFile, binding.node, 'Variable', binding.name, exported, {
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
        const id = addDeclarationNode(graph, root, sourceFile, node, type, name, exported, {
          kind: 'variable-function',
        });
        fileLocal.set(name, id);
      } else {
        const type = classifyVariable(sourceFile, node, name);
        const id = addDeclarationNode(graph, root, sourceFile, node, type, name, exported, {
          kind: 'variable',
        });
        fileLocal.set(name, id);
        if (name === 'state' && node.initializer && ts.isObjectLiteralExpression(node.initializer) && isStoreFile(sourceFile.realPath)) {
          for (const stateProp of node.initializer.properties) {
            const stateName = propertyNameText(stateProp);
            if (!stateName) continue;
            addSyntheticDeclaration(graph, root, sourceFile, stateProp, 'Variable', stateName, fileLocal, {
              kind: 'vuex-state',
              framework: 'vuex',
              section: 'state',
            });
          }
        }
      }
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const id = addDeclarationNode(graph, root, sourceFile, node, 'Class', node.name.text, isExported(node));
      fileLocal.set(node.name.text, id);
    }

    if (ts.isMethodDeclaration(node)) {
      const name = objectPropertyName(node.name);
      if (name) {
        const section = objectLiteralSection(node);
        const id = addDeclarationNode(graph, root, sourceFile, node, 'Method', name, false, {
          ...(section ? { section } : {}),
          ...(section && ['actions', 'mutations', 'getters'].includes(section)
            ? { framework: 'vuex', kind: `vuex-${section.slice(0, -1) || section}` }
            : {}),
        });
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
        const section = objectLiteralSection(node);
        const id = addDeclarationNode(graph, root, sourceFile, node, 'Method', name, false, {
          kind: 'object-method',
          ...(section ? { section } : {}),
          ...(section && ['actions', 'mutations', 'getters'].includes(section)
            ? { framework: 'vuex', kind: `vuex-${section.slice(0, -1) || section}` }
            : {}),
        });
        fileLocal.set(name, id);
      }
    }

    if (ts.isSpreadAssignment(node) && ts.isCallExpression(node.expression)) {
      const section = parentPropertyName(node.parent);
      if (!['computed', 'methods'].includes(section ?? '')) return;
      for (const mapped of mapHelperNames(node.expression)) {
        const type = mapped.helper === 'mapState' || mapped.helper === 'mapGetters' ? 'Variable' : 'Method';
        const id = addDeclarationNode(graph, root, sourceFile, mapped.anchor, type, mapped.name, false, {
          kind: 'vuex-map-helper',
          helper: mapped.helper,
          section,
          framework: 'vuex',
        });
        fileLocal.set(mapped.name, id);
      }
    }

    if (ts.isInterfaceDeclaration(node)) {
      const id = addDeclarationNode(graph, root, sourceFile, node, 'Interface', node.name.text, isExported(node));
      fileLocal.set(node.name.text, id);
    }
  });

  graph.localSymbols.set(fileKey(sourceFile.fileName), fileLocal);
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

function staticStringValue(sourceFile, expr) {
  if (!expr) return undefined;
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (!ts.isIdentifier(expr)) return undefined;
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === expr.text &&
        declaration.initializer &&
        ts.isStringLiteralLike(declaration.initializer)
      ) {
        return declaration.initializer.text;
      }
    }
  }
  return undefined;
}

function localSymbolStringValue(graph, sourceFile, expr) {
  if (!expr || !ts.isIdentifier(expr)) return undefined;
  const target = localSymbolMap(graph, sourceFile).get(expr.text);
  const node = target ? graph.nodes.get(target) : undefined;
  const match = node?.content?.match(/['"]([^'"]+)['"]/);
  return match?.[1];
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
    } else {
      recordUnresolved(
        graph,
        root,
        sourceFile,
        componentInit,
        'route-component',
        componentInit.text,
        `route path ${routePath} component identifier was not resolved`,
        { ownerId: routeId },
      );
    }
    return;
  }

  if (componentInit && ts.isStringLiteralLike(componentInit)) {
    const target = resolveImportTarget(root, sourceFile, componentInit.text, graph.allRealFiles ?? [], graph.virtualByVueFile ?? new Map());
    if (target?.endsWith('.vue')) {
      ensureGraphFileNode(graph, root, target);
      const componentName = path.basename(target, '.vue');
      const targetId = stableId('Component', rel(root, target), componentName, 1);
      if (graph.nodes.has(targetId)) {
        graph.addEdge({
          type: 'ROUTES_TO',
          source: routeId,
          target: targetId,
          reason: `route path ${routePath} string component ${componentInit.text}`,
          sourceFilePath: rel(root, sourceFile.realPath),
          targetFilePath: rel(root, target),
          line,
          confidence: 0.86,
        });
        return;
      }
    } else if (target) {
      ensureGraphFileNode(graph, root, target);
      const targetId = stableId('File', rel(root, target));
      if (graph.nodes.has(targetId)) {
        graph.addEdge({
          type: 'ROUTES_TO',
          source: routeId,
          target: targetId,
          reason: `route path ${routePath} string component module ${componentInit.text}`,
          sourceFilePath: rel(root, sourceFile.realPath),
          targetFilePath: rel(root, target),
          line,
          confidence: 0.72,
        });
        return;
      }
    }
    recordUnresolved(
      graph,
      root,
      sourceFile,
      componentInit,
      'route-component',
      componentInit.text,
      `route path ${routePath} string component was not resolved`,
      {
        ownerId: routeId,
        attemptedResolvers: ['configured aliases', 'src directory names', 'relative', '@/', '~/', 'package-name'],
      },
    );
    return;
  }

  const dynamicSpecifier = dynamicImportSpecifier(componentInit);
  if (dynamicSpecifier) {
    const target = resolveImportTarget(root, sourceFile, dynamicSpecifier, graph.allRealFiles ?? [], graph.virtualByVueFile ?? new Map());
    if (target?.endsWith('.vue')) {
      ensureGraphFileNode(graph, root, target);
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
    } else if (target) {
      ensureGraphFileNode(graph, root, target);
      const targetId = stableId('File', rel(root, target));
      if (graph.nodes.has(targetId)) {
        graph.addEdge({
          type: 'ROUTES_TO',
          source: routeId,
          target: targetId,
          reason: `route path ${routePath} lazy component module ${dynamicSpecifier}`,
          sourceFilePath: rel(root, sourceFile.realPath),
          targetFilePath: rel(root, target),
          line,
          confidence: 0.72,
        });
      }
    } else {
      recordUnresolved(
        graph,
        root,
        sourceFile,
        componentInit,
        'route-component',
        dynamicSpecifier,
        `route path ${routePath} lazy component import was not resolved`,
        {
          ownerId: routeId,
          attemptedResolvers: ['relative', '@/', '~/', 'package-name', 'main/', 'src/', 'packages/'],
        },
      );
    }
  } else if (componentInit) {
    recordUnresolved(
      graph,
      root,
      sourceFile,
      componentInit,
      'route-component',
      componentInit.getText(sourceFile),
      `route path ${routePath} component expression is dynamic`,
      { ownerId: routeId },
    );
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
  const key = fileKey(sourceFile.fileName);
  let map = graph.localSymbols.get(key);
  if (!map) {
    map = new Map();
    graph.localSymbols.set(key, map);
  }
  return map;
}

function localStoreVarMap(graph, sourceFile) {
  const key = fileKey(sourceFile.fileName);
  let map = graph.storeVars.get(key);
  if (!map) {
    map = new Map();
    graph.storeVars.set(key, map);
  }
  return map;
}

function storeActionTarget(graph, storeId, actionName) {
  const store = graph.nodes.get(storeId);
  if (!store) return undefined;
  for (const node of graph.nodes.values()) {
    if (node.filePath === store.filePath && node.type === 'Method' && node.name === actionName) return node.id;
  }
  for (const node of graph.nodes.values()) {
    if (
      node.filePath === store.filePath &&
      ['Function', 'Variable'].includes(node.type) &&
      node.name === actionName
    ) {
      return node.id;
    }
  }
  return undefined;
}

function firstStringArg(call) {
  const arg = call.arguments?.[0];
  return arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
}

function isThisStoreMethodCall(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
  const method = node.expression.name.text;
  if (method !== 'dispatch' && method !== 'commit') return undefined;
  const receiver = node.expression.expression;
  if (!ts.isPropertyAccessExpression(receiver)) return undefined;
  if (receiver.name.text !== '$store') return undefined;
  if (receiver.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
  const action = firstStringArg(node);
  return action ? { method, action } : undefined;
}

function vuexTargetForName(graph, name, method = 'dispatch') {
  const preferredSection = method === 'commit' ? 'mutations' : 'actions';
  const fallbackSection = method === 'commit' ? 'actions' : 'mutations';
  const rawName = String(name ?? '');
  const parts = rawName.split('/').filter(Boolean);
  const localName = parts.at(-1) ?? rawName;
  const namespace = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  const sameName = [...graph.nodes.values()].filter(
    (node) => node.type === 'Method' && (node.name === rawName || node.name === localName),
  );
  const sectionMatches = sameName.filter((node) => node.meta?.section === preferredSection);
  const vuexMatches = sectionMatches.length
    ? sectionMatches
    : sameName.filter((node) => node.meta?.framework === 'vuex' && node.meta?.section === fallbackSection);
  const scoped = namespace
    ? vuexMatches.filter((node) => {
      const normalizedFile = slash(node.filePath);
      return normalizedFile.includes(`/${namespace}/`) || normalizedFile.includes(`/${namespace}.`);
    })
    : [];
  if (scoped.length === 1) return scoped[0].id;
  if (vuexMatches.length === 1) return vuexMatches[0].id;
  const storeScoped = namespace
    ? sameName.filter((node) => {
      const normalizedFile = slash(node.filePath);
      return (
        normalizedFile.includes('/store/') &&
        (normalizedFile.includes(`/${namespace}/`) || normalizedFile.includes(`/${namespace}.`))
      );
    })
    : [];
  if (storeScoped.length === 1) return storeScoped[0].id;
  const storeMatches = sameName.filter((node) => slash(node.filePath).includes('/store/'));
  if (!namespace && storeMatches.length === 1) return storeMatches[0].id;
  return undefined;
}

function vuexDataTargetForName(graph, name, section) {
  const rawName = String(name ?? '');
  const parts = rawName.split('/').filter(Boolean);
  const localName = parts.at(-1) ?? rawName;
  const namespace = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  const candidates = [...graph.nodes.values()].filter(
    (node) => node.name === localName && node.meta?.framework === 'vuex' && node.meta?.section === section,
  );
  const scoped = namespace
    ? candidates.filter((node) => {
      const normalizedFile = slash(node.filePath);
      return normalizedFile.includes(`/${namespace}/`) || normalizedFile.includes(`/${namespace}.`);
    })
    : [];
  if (scoped.length === 1) return scoped[0].id;
  if (candidates.length === 1) return candidates[0].id;
  return undefined;
}

function vuexStoreForTarget(graph, target) {
  const targetNode = graph.nodes.get(target);
  if (!targetNode) return undefined;
  return [...graph.nodes.values()].find(
    (node) => node.type === 'Store' && node.filePath === targetNode.filePath,
  )?.id;
}

function collectVuexStoreCall(graph, root, sourceFile, node) {
  const info = isThisStoreMethodCall(node);
  if (!info) return false;
  const target = vuexTargetForName(graph, info.action, info.method);
  const source = nearestOwner(graph, sourceFile, node);
  const lineRaw = lineOf(sourceFile, node.getStart(sourceFile));
  const line = sourceFile.vueVirtual ? mapVueLine(sourceFile.vueVirtual, lineRaw) : lineRaw;
  if (!target) {
    graph.addUnresolved({
      kind: 'store-call',
      text: `${info.method}:${info.action}`,
      reason: `Vuex this.$store.${info.method}('${info.action}') target was not resolved`,
      filePath: rel(root, sourceFile.realPath),
      line,
      ownerId: source,
      attemptedResolvers: ['vuex actions', 'vuex mutations'],
    });
    return true;
  }
  graph.addEdge({
    type: 'CALLS',
    source,
    target,
    reason: `Vuex this.$store.${info.method}('${info.action}')`,
    sourceFilePath: rel(root, sourceFile.realPath),
    targetFilePath: graph.nodes.get(target)?.filePath ?? '',
    line,
    confidence: 0.94,
  });
  const storeId = vuexStoreForTarget(graph, target);
  if (storeId) {
    graph.addEdge({
      type: 'USES_STORE',
      source,
      target: storeId,
      reason: `Vuex this.$store.${info.method}('${info.action}')`,
      sourceFilePath: rel(root, sourceFile.realPath),
      targetFilePath: graph.nodes.get(storeId)?.filePath ?? '',
      line,
      confidence: 0.92,
    });
  }
  return true;
}

function collectVuexMapHelperEdges(graph, root, sourceFile, node) {
  if (!ts.isSpreadAssignment(node) || !ts.isCallExpression(node.expression)) return;
  for (const mapped of mapHelperNames(node.expression)) {
    const source = localSymbolMap(graph, sourceFile).get(mapped.name);
    if (!source) continue;
    const targetName = mapped.targetName ?? mapped.name;
    const target = mapped.helper === 'mapState'
      ? vuexDataTargetForName(graph, targetName, 'state')
      : mapped.helper === 'mapGetters'
        ? vuexDataTargetForName(graph, targetName, 'getters')
        : vuexTargetForName(
          graph,
          targetName,
          mapped.helper === 'mapMutations' ? 'commit' : 'dispatch',
        );
    const lineRaw = lineOf(sourceFile, mapped.anchor.getStart(sourceFile));
    const line = sourceFile.vueVirtual ? mapVueLine(sourceFile.vueVirtual, lineRaw) : lineRaw;
    if (!target) {
      graph.addUnresolved({
        kind: 'store-call',
        text: `${mapped.helper}:${mapped.targetName ?? mapped.name}`,
        reason: `${mapped.helper} target was not resolved`,
        filePath: rel(root, sourceFile.realPath),
        line,
        ownerId: source,
        attemptedResolvers: ['vuex mapState', 'vuex mapGetters', 'vuex mapMutations', 'vuex mapActions'],
      });
      continue;
    }
    graph.addEdge({
      type: 'CALLS',
      source,
      target,
      reason: `${mapped.helper} maps ${mapped.name} to Vuex store`,
      sourceFilePath: rel(root, sourceFile.realPath),
      targetFilePath: graph.nodes.get(target)?.filePath ?? '',
      line,
      confidence: 0.9,
    });
  }
}

function collectVueComponentRegistration(graph, root, sourceFile, objectLiteral) {
  if (!isVueOptionsObject(objectLiteral)) return;
  if (sourceFile.realPath.endsWith('.vue')) {
    const componentName =
      staticStringValue(sourceFile, initializerProperty(objectLiteral, 'name')) ??
      localSymbolStringValue(graph, sourceFile, initializerProperty(objectLiteral, 'name')) ??
      staticStringValue(sourceFile, initializerProperty(objectLiteral, 'componentName')) ??
      localSymbolStringValue(graph, sourceFile, initializerProperty(objectLiteral, 'componentName'));
    if (componentName) {
      const componentId = stableId(
        'Component',
        rel(root, sourceFile.realPath),
        path.basename(sourceFile.realPath, '.vue'),
        1,
      );
      if (graph.nodes.has(componentId)) registerComponentAlias(graph, componentName, componentId);
    }
  }
  const components = initializerProperty(objectLiteral, 'components');
  if (!components || !ts.isObjectLiteralExpression(components)) return;
  const locals = localSymbolMap(graph, sourceFile);
  for (const prop of components.properties) {
    let registeredName;
    let localName;
    if (ts.isShorthandPropertyAssignment(prop)) {
      registeredName = prop.name.text;
      localName = prop.name.text;
    } else if (ts.isPropertyAssignment(prop)) {
      registeredName = objectPropertyName(prop.name);
      if (ts.isIdentifier(prop.initializer)) localName = prop.initializer.text;
      if (registeredName && ts.isObjectLiteralExpression(prop.initializer)) {
        const inlineId = addDeclarationNode(
          graph,
          root,
          sourceFile,
          prop.initializer,
          'Component',
          registeredName,
          false,
          { kind: 'vue-inline-component', framework: 'vue' },
        );
        for (const alias of componentAliasNames(registeredName)) locals.set(alias, inlineId);
        continue;
      }
    }
    if (!registeredName || !localName) continue;
    const target = locals.get(localName);
    if (!target || !graph.nodes.has(target)) continue;
    locals.set(registeredName, target);
    for (const alias of componentAliasNames(registeredName)) locals.set(alias, target);
  }
}

function collectGlobalComponentRegistration(graph, sourceFile, node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
  if (node.expression.name.text !== 'component') return;
  const [nameArg, valueArg] = node.arguments;
  if (!nameArg || !ts.isStringLiteralLike(nameArg) || !valueArg || !ts.isIdentifier(valueArg)) return;
  const target = localSymbolMap(graph, sourceFile).get(valueArg.text);
  if (!target || !graph.nodes.has(target)) return;
  registerComponentAlias(graph, nameArg.text, target);
}

function componentOwnerForFile(graph, root, sourceFile) {
  if (sourceFile.realPath.endsWith('.vue')) {
    const componentId = stableId(
      'Component',
      rel(root, sourceFile.realPath),
      path.basename(sourceFile.realPath, '.vue'),
      1,
    );
    if (graph.nodes.has(componentId)) return componentId;
  }
  return stableId('File', rel(root, sourceFile.realPath));
}

function collectVueMixinEdges(graph, root, sourceFile, objectLiteral) {
  if (!isVueOptionsObject(objectLiteral)) return;
  const locals = localSymbolMap(graph, sourceFile);
  const source = componentOwnerForFile(graph, root, sourceFile);
  const addMixinEdge = (target, anchor, reason) => {
    const lineRaw = lineOf(sourceFile, anchor.getStart(sourceFile));
    const line = sourceFile.vueVirtual ? mapVueLine(sourceFile.vueVirtual, lineRaw) : lineRaw;
    if (!target || !graph.nodes.has(target)) {
      graph.addUnresolved({
        kind: 'mixin',
        text: anchor.getText(sourceFile),
        reason: `${reason} was not resolved`,
        filePath: rel(root, sourceFile.realPath),
        line,
        ownerId: source,
        attemptedResolvers: ['local imports', 'TypeScript alias symbols'],
      });
      return;
    }
    graph.addEdge({
      type: 'MIXES_IN',
      source,
      target,
      reason,
      sourceFilePath: rel(root, sourceFile.realPath),
      targetFilePath: graph.nodes.get(target)?.filePath ?? '',
      line,
      confidence: 0.9,
    });
  };

  const mixins = initializerProperty(objectLiteral, 'mixins');
  if (mixins && ts.isArrayLiteralExpression(mixins)) {
    for (const item of mixins.elements) {
      if (ts.isIdentifier(item)) addMixinEdge(locals.get(item.text), item, `Vue mixins includes ${item.text}`);
    }
  }
  const extension = initializerProperty(objectLiteral, 'extends');
  if (extension && ts.isIdentifier(extension)) {
    addMixinEdge(locals.get(extension.text), extension, `Vue extends ${extension.text}`);
  }
}

function collectStoreActionCall(graph, root, sourceFile, node, checker) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const receiver = node.expression.expression;
  if (!ts.isIdentifier(receiver)) return false;
  const storeId = localStoreVarMap(graph, sourceFile).get(receiver.text);
  if (!storeId) return false;
  const target = storeActionTarget(graph, storeId, node.expression.name.text);
  const source = nearestOwner(graph, sourceFile, node);
  const lineRaw = lineOf(sourceFile, node.getStart(sourceFile));
  const line = sourceFile.vueVirtual ? mapVueLine(sourceFile.vueVirtual, lineRaw) : lineRaw;
  if (!target) {
    graph.addUnresolved({
      kind: 'store-call',
      text: `${receiver.text}.${node.expression.name.text}`,
      reason: 'Pinia store action call target was not resolved',
      filePath: rel(root, sourceFile.realPath),
      line,
      ownerId: source,
      attemptedResolvers: ['Pinia store action methods'],
    });
    collectStoreUsage(graph, root, sourceFile, node, source, storeId);
    return true;
  }
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
        ensureGraphFileNode(graph, root, target);
        const localMap = localSymbolMap(graph, sourceFile);
        if (target.endsWith('.vue')) {
          const componentName = path.basename(target, '.vue');
          const componentId = stableId('Component', rel(root, target), componentName, 1);
          for (const localName of importLocalNames(node.importClause)) localMap.set(localName, componentId);
        } else {
          for (const binding of importLocalIdentifierBindings(node.importClause)) {
            const localName = binding.local;
            const directTarget = exportedNodeForFileAndName(graph, root, target, binding.importedName);
            if (directTarget) {
              localMap.set(localName.text, directTarget);
              continue;
            }
            const symbol = safeCheckerCall(graph, sourceFile, localName, 'import symbol resolution', () =>
              checker.getSymbolAtLocation(localName),
            );
            const aliased = safeAliasedSymbol(graph, sourceFile, localName, checker, symbol, 'import symbol resolution');
            let mapped = false;
            for (const declaration of aliased?.getDeclarations() ?? []) {
              const targetId = declarationTarget(graph, declaration);
              if (targetId) {
                localMap.set(localName.text, targetId);
                mapped = true;
                break;
              }
            }
            if (!mapped && binding.isDefault) {
              const defaultTarget = defaultExportNodeForFile(graph, root, target);
              if (defaultTarget) localMap.set(localName.text, defaultTarget);
            } else if (!mapped) {
              const barrelTarget = barrelExportTarget(
                graph,
                root,
                sourceFile,
                target,
                binding.importedName,
                allRealFiles,
                virtualByVueFile,
              );
              if (barrelTarget) localMap.set(localName.text, barrelTarget);
            }
          }
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
      } else if (isLocalLikeSpecifier(root, node.moduleSpecifier.text)) {
        recordUnresolved(
          graph,
          root,
          sourceFile,
          node,
          'import',
          node.moduleSpecifier.text,
          'import target was not resolved',
          {
            ownerId: stableId('File', rel(root, sourceFile.realPath)),
            attemptedResolvers: ['relative', 'configured aliases', 'tsconfig/jsconfig paths', '@/', '~/', 'package-name', 'main/', 'src/', 'packages/'],
          },
        );
      } else {
        const externalId = addExternalImportEdge(graph, root, sourceFile, node, node.moduleSpecifier.text, {
          kind: 'external-import',
        });
        const localMap = localSymbolMap(graph, sourceFile);
        for (const localName of importLocalNames(node.importClause)) localMap.set(localName, externalId);
      }
    }

    if (ts.isCallExpression(node)) {
      const specifier = dynamicImportSpecifier(node);
      if (specifier) {
        const target = resolveImportTarget(root, sourceFile, specifier, allRealFiles, virtualByVueFile);
        if (target) {
          ensureGraphFileNode(graph, root, target);
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
        } else if (isLocalLikeSpecifier(root, specifier)) {
          recordUnresolved(
            graph,
            root,
            sourceFile,
            node,
            'dynamic-import',
            specifier,
            'dynamic import target was not resolved',
            {
              ownerId: nearestOwner(graph, sourceFile, node),
              attemptedResolvers: ['literal dynamic import', 'configured aliases', 'relative', '@/', '~/', 'package-name'],
            },
          );
        } else {
          addExternalImportEdge(graph, root, sourceFile, node, specifier, {
            kind: 'external-dynamic-import',
            dynamic: true,
          });
        }
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      collectRouteEdges(graph, root, sourceFile, node);
      collectVueComponentRegistration(graph, root, sourceFile, node);
      collectVueMixinEdges(graph, root, sourceFile, node);
    }

    if (ts.isSpreadAssignment(node)) {
      collectVuexMapHelperEdges(graph, root, sourceFile, node);
    }

    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      if (ts.isCallExpression(node)) collectGlobalComponentRegistration(graph, sourceFile, node);
      if (ts.isCallExpression(node) && collectVuexStoreCall(graph, root, sourceFile, node)) return;
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

const EXTERNAL_TEMPLATE_PREFIXES = new Set([
  'a',
  'ant',
  'b',
  'el',
  'i',
  'n',
  'nut',
  'q',
  't',
  'u',
  'uni',
  'van',
  'v',
  'wd',
]);

function templateExternalSpec(tag) {
  const lower = String(tag ?? '').toLowerCase();
  if (!lower.includes('-')) return undefined;
  const prefix = lower.split('-')[0];
  if (!EXTERNAL_TEMPLATE_PREFIXES.has(prefix)) return undefined;
  return `template:${lower}`;
}

function sameDirectoryComponentTarget(graph, root, vuePath, component) {
  const dir = path.dirname(vuePath);
  const candidates = [
    path.join(dir, `${component.name}.vue`),
    path.join(dir, `${component.normalizedName}.vue`),
    path.join(dir, `${pascalToKebab(component.normalizedName)}.vue`),
    path.join(dir, component.name, 'index.vue'),
    path.join(dir, component.normalizedName, 'index.vue'),
    path.join(dir, pascalToKebab(component.normalizedName), 'index.vue'),
  ];
  for (const candidate of candidates) {
    const normalized = path.normalize(candidate);
    const componentId = stableId('Component', rel(root, normalized), path.basename(normalized, '.vue'), 1);
    if (graph.nodes.has(componentId)) return componentId;
  }
  return undefined;
}

function addVueTemplateEdges(graph, root, vueInfoByRealPath) {
  for (const [vuePath, info] of vueInfoByRealPath) {
    const componentId = stableId('Component', rel(root, vuePath), path.basename(vuePath, '.vue'), 1);
    const locals =
      graph.localSymbols.get(fileKey(info.virtualFileName)) ??
      graph.localSymbols.get(info.virtualFileName) ??
      new Map();

    for (const component of info.template.components) {
      const target =
        locals.get(component.normalizedName) ??
        locals.get(component.name) ??
        graph.componentNames.get(component.normalizedName) ??
        graph.componentNames.get(component.name) ??
        graph.componentNames.get(pascalToKebab(component.normalizedName)) ??
        sameDirectoryComponentTarget(graph, root, vuePath, component);
      const targetId = typeof target === 'string' && graph.nodes.has(target) ? target : undefined;
      if (!targetId) {
        const externalSpec = templateExternalSpec(component.name);
        if (externalSpec) {
          const externalId = addExternalModuleNode(graph, externalSpec, {
            kind: 'external-template-component',
            tag: component.name,
          });
          graph.addEdge({
            type: 'RENDERS',
            source: componentId,
            target: externalId,
            reason: `template external component <${component.name}>`,
            sourceFilePath: rel(root, vuePath),
            targetFilePath: '',
            line: component.line,
            confidence: 0.62,
          });
          continue;
        }
        graph.addUnresolved({
          kind: 'template-component',
          text: component.name,
          reason: `template component <${component.name}> was not resolved`,
          filePath: rel(root, vuePath),
          line: component.line,
          ownerId: componentId,
          attemptedResolvers: ['script imports', 'known SFC component names', 'same-directory SFC'],
          candidates: [component.normalizedName, component.name].filter(Boolean),
        });
        continue;
      }
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
  const tsconfigPath = path.join(root, 'tsconfig.json');
  const jsconfigPath = path.join(root, 'jsconfig.json');
  const configPath = fs.existsSync(tsconfigPath) ? tsconfigPath : jsconfigPath;
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
  return readParsedConfig(configPath)?.options ?? {};
}

function createProgram(root, realFiles, virtualFiles, virtualByVueFile) {
  const options = compilerOptionsFromTsconfig(root);
  const allRealFiles = new Set(realFiles.map((file) => path.normalize(file)));
  options.allowJs = true;
  options.checkJs = false;
  options.noEmit = true;
  delete options.baseUrl;
  delete options.paths;
  options.skipLibCheck = true;
  options.moduleResolution ??= ts.ModuleResolutionKind.Bundler;
  if (
    options.moduleResolution === ts.ModuleResolutionKind.Bundler &&
    (!options.module || options.module < ts.ModuleKind.ES2015)
  ) {
    options.module = ts.ModuleKind.ESNext;
  }
  if (!options.target || options.target < ts.ScriptTarget.ES2017) options.target = ts.ScriptTarget.ES2022;
  if (Array.isArray(options.types)) {
    options.types = options.types.filter((typeName) => typeName !== 'vite/client');
  }

  const shimFile = path.normalize(path.join(root, '.vuenexus-vue-shim.d.ts'));
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
      "declare module 'vuex' {",
      '  const Vuex: any;',
      '  export default Vuex;',
      '  export class Store<T = any> { constructor(options: any); dispatch(type: string, payload?: any): any; commit(type: string, payload?: any): any; }',
      '  export function createStore<T = any>(options: any): any;',
      '  export function mapState(...args: any[]): any;',
      '  export function mapGetters(...args: any[]): any;',
      '  export function mapActions(...args: any[]): any;',
      '  export function mapMutations(...args: any[]): any;',
      '}',
      "declare module 'vite/client' {}",
      'declare function defineProps<T = Record<string, unknown>>(...args: any[]): T;',
      'declare function defineEmits<T = unknown>(...args: any[]): (...args: any[]) => void;',
      'declare function withDefaults<T, D>(props: T, defaults: D): T & D;',
      'declare function defineOptions<T = Record<string, unknown>>(options: T): void;',
      'declare function defineExpose<T = Record<string, unknown>>(exposed?: T): void;',
      'declare function defineSlots<T = Record<string, unknown>>(...args: any[]): T;',
      'declare function defineModel<T = unknown>(...args: any[]): Ref<T>;',
      'declare namespace JSX { interface IntrinsicElements { [name: string]: any } }',
    ].join('\n'),
  });

  const allFileNames = [
    ...realFiles.filter((file) => !['.vue', '.json'].includes(path.extname(file))),
    ...virtualFiles.keys(),
  ];
  const defaultHost = ts.createCompilerHost(options, true);
  const tsExtensionForFile = (fileName) => {
    const ext = path.extname(fileName);
    if (ext === '.tsx') return ts.Extension.Tsx;
    if (ext === '.jsx') return ts.Extension.Jsx;
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ts.Extension.Js;
    return ts.Extension.Ts;
  };
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
        const sf = ts.createSourceFile(normalized, virtual.content, languageVersion, true, virtual.scriptKind ?? ts.ScriptKind.TS);
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
        const containingSource = { realPath: path.normalize(containingFile) };
        const resolvedTarget = resolveImportTarget(root, containingSource, moduleName, allRealFiles, virtualByVueFile);
        if (resolvedTarget) {
          if (ASSET_EXTS.has(path.extname(resolvedTarget))) return undefined;
          const virtual = virtualByVueFile.get(path.normalize(resolvedTarget));
          return {
            resolvedFileName: virtual?.virtualFileName ?? resolvedTarget,
            extension: virtual ? ts.Extension.Ts : tsExtensionForFile(resolvedTarget),
          };
        }
        return ts.resolveModuleName(moduleName, containingFile, options, host).resolvedModule;
      });
    },
  };
  return ts.createProgram(allFileNames, options, host);
}

function progressTicker(progress, root, label, total, intervalMs = 5000) {
  let last = Date.now();
  return (index, sourceFile) => {
    const now = Date.now();
    if (index !== 0 && index !== total - 1 && now - last < intervalMs) return;
    last = now;
    const filePath = sourceFile?.realPath ? rel(root, sourceFile.realPath) : sourceFile?.fileName ?? '';
    progress(`${label}: ${index + 1}/${total}${filePath ? ` ${filePath}` : ''}`);
  };
}

function sourceFileRelPath(root, sourceFile) {
  return rel(root, sourceFile.realPath ?? sourceFile.fileName);
}

function sourceFileSymbolKey(sourceFile) {
  return fileKey(sourceFile.fileName);
}

function collectSourceFileImports(root, sourceFile, allRealFiles, virtualByVueFile) {
  const imports = new Set();
  visit(sourceFile, (node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const target = resolveImportTarget(root, sourceFile, node.moduleSpecifier.text, allRealFiles, virtualByVueFile);
    if (target) imports.add(rel(root, target));
  });
  return [...imports].sort();
}

function cacheCompatible(cache, checkerMode) {
  return cache?.version === ANALYSIS_CACHE_VERSION && cache.checkerMode === checkerMode && cache.files;
}

function changedCacheFiles(root, files, fileContents, cache) {
  const current = new Set(files.map((file) => rel(root, file)));
  const changed = new Set();
  for (const file of files) {
    const filePath = rel(root, file);
    const entry = cache?.files?.[filePath];
    if (!entry || entry.hash !== contentHash(fileContents.get(file))) changed.add(filePath);
  }
  for (const filePath of Object.keys(cache?.files ?? {})) {
    if (!current.has(filePath)) changed.add(filePath);
  }
  return changed;
}

function impactedCacheFiles(cache, changed, currentFilePaths = []) {
  const reverseImports = new Map();
  for (const [filePath, entry] of Object.entries(cache?.files ?? {})) {
    for (const imported of entry.imports ?? []) {
      if (!reverseImports.has(imported)) reverseImports.set(imported, new Set());
      reverseImports.get(imported).add(filePath);
    }
  }
  const impacted = new Set(changed);
  const queue = [...changed];
  while (queue.length) {
    const filePath = queue.shift();
    for (const importer of reverseImports.get(filePath) ?? []) {
      if (impacted.has(importer)) continue;
      impacted.add(importer);
      queue.push(importer);
    }
  }
  if ([...changed].some((filePath) => filePath.endsWith('.vue'))) {
    for (const filePath of currentFilePaths) {
      if (filePath.endsWith('.vue')) impacted.add(filePath);
    }
  }
  return impacted;
}

function restoreCachedFileSlice(graph, entry) {
  for (const node of entry.nodes ?? []) graph.addNode(node);
  for (const edge of entry.edges ?? []) graph.addEdge(edge);
  if (entry.localSymbolsKey && Array.isArray(entry.localSymbols)) {
    graph.localSymbols.set(entry.localSymbolsKey, new Map(entry.localSymbols));
  }
}

function writeAnalysisCache(root, graph, files, fileContents, sourceFiles, importsByFile, checkerMode) {
  const entries = {};
  const sourceKeyByRel = new Map(sourceFiles.map((sourceFile) => [sourceFileRelPath(root, sourceFile), sourceFileSymbolKey(sourceFile)]));
  const externalNodes = [...graph.nodes.values()].filter((node) => !node.filePath);
  for (const file of files) {
    const filePath = rel(root, file);
    const sourceKey = sourceKeyByRel.get(filePath);
    const nodeIds = new Set();
    const nodes = [
      ...externalNodes,
      ...[...graph.nodes.values()].filter((node) => node.filePath === filePath),
    ];
    for (const node of nodes) nodeIds.add(node.id);
    const edges = [...graph.edges.values()].filter(
      (edge) =>
        edge.sourceFilePath === filePath ||
        edge.targetFilePath === filePath ||
        nodeIds.has(edge.source) ||
        nodeIds.has(edge.target),
    );
    entries[filePath] = {
      hash: contentHash(fileContents.get(file) ?? ''),
      imports: importsByFile.get(filePath) ?? [],
      localSymbolsKey: sourceKey,
      localSymbols: sourceKey ? [...(graph.localSymbols.get(sourceKey) ?? new Map()).entries()] : [],
      nodes,
      edges,
    };
  }
  writeJsonFile(analysisCachePath(root), {
    version: ANALYSIS_CACHE_VERSION,
    checkerMode,
    generatedAt: new Date().toISOString(),
    files: entries,
  });
}

function prettyBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function indexFrontendProject(root, options = {}) {
  root = path.resolve(root);
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const checkerMode = ['off', 'fast', 'full'].includes(options.checkerMode) ? options.checkerMode : 'fast';
  const canUseIncrementalCache = options.incremental !== false && !options.diagnostics && checkerMode !== 'full';
  const canWriteIncrementalCache = !options.diagnostics && checkerMode !== 'full';
  progress('Scanning frontend files');
  const { files, skipped } = walkFiles(root, { skipGenerated: options.skipGenerated });
  progress(`Found ${files.length} frontend files`);
  if (skipped.length) {
    progress(`Skipped ${skipped.length} generated/static entries`);
    const previewLimit = 30;
    for (const item of skipped.slice(0, previewLimit)) {
      progress(
        item.directory
          ? `Skipped static directory: ${item.filePath} (${item.reason})`
          : `Skipped generated JS: ${item.filePath} (${item.reason}, ${prettyBytes(item.size)})`,
      );
    }
    if (skipped.length > previewLimit) {
      progress(`Skipped generated/static entries: ${skipped.length - previewLimit} more not shown`);
    }
  }
  const fileContents = new Map();
  const allRealFiles = new Set(files.map((file) => path.normalize(file)));
  const virtualFiles = new Map();
  const virtualByVueFile = new Map();
  const vueInfoByRealPath = new Map();
  const graph = createGraph(root, { checkerMode });
  graph.allRealFiles = allRealFiles;
  graph.virtualByVueFile = virtualByVueFile;

  progress('Parsing Vue SFC files and creating graph file nodes');
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    fileContents.set(file, content);
    graphFileNode(graph, root, file, content);

    if (path.extname(file) === '.vue') {
      const componentName = path.basename(file, '.vue');
      const componentId = stableId('Component', rel(root, file), componentName, 1);
      registerComponentAlias(graph, componentName, componentId);
      if (componentName.toLowerCase() === 'index') {
        registerComponentAlias(graph, path.basename(path.dirname(file)), componentId);
      }
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
  progress(`Prepared ${vueInfoByRealPath.size} Vue SFC virtual files`);

  progress('Creating TypeScript program');
  const program = createProgram(root, files, virtualFiles, virtualByVueFile);
  progress(`TypeScript checker mode: ${checkerMode}`);
  const checker = checkerMode === 'full' ? program.getTypeChecker() : undefined;
  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && sf.realPath && sf.realPath.startsWith(root));
  progress(`TypeScript program ready with ${sourceFiles.length} project source files`);

  const cachePath = analysisCachePath(root);
  const cache = canUseIncrementalCache ? readJsonFile(cachePath) : undefined;
  const usableCache = cacheCompatible(cache, checkerMode) ? cache : undefined;
  const changedFiles = usableCache ? changedCacheFiles(root, files, fileContents, usableCache) : new Set(files.map((file) => rel(root, file)));
  const currentFilePaths = files.map((file) => rel(root, file));
  const impactedFiles = usableCache ? impactedCacheFiles(usableCache, changedFiles, currentFilePaths) : changedFiles;
  const sourceFileByRel = new Map(sourceFiles.map((sourceFile) => [sourceFileRelPath(root, sourceFile), sourceFile]));
  let cacheHitFiles = 0;
  if (usableCache) {
    for (const [filePath, entry] of Object.entries(usableCache.files ?? {})) {
      if (!sourceFileByRel.has(filePath) || impactedFiles.has(filePath)) continue;
      restoreCachedFileSlice(graph, entry);
      cacheHitFiles++;
    }
    progress(`Incremental cache: ${cacheHitFiles} reused, ${sourceFiles.length - cacheHitFiles} analyzed, ${impactedFiles.size} impacted`);
  } else if (canUseIncrementalCache) {
    progress('Incremental cache: cold or incompatible; analyzing all files');
  } else {
    progress('Incremental cache: disabled for this run');
  }

  progress('Collecting declarations');
  const declarationProgress = progressTicker(progress, root, 'Collecting declarations', sourceFiles.length);
  for (const [index, sourceFile] of sourceFiles.entries()) {
    declarationProgress(index, sourceFile);
    if (usableCache && !impactedFiles.has(sourceFileRelPath(root, sourceFile))) continue;
    collectDeclarations(graph, root, sourceFile);
  }
  progress(`Collected declarations: ${graph.nodes.size} nodes`);
  progress('Collecting imports and calls');
  const callProgress = progressTicker(progress, root, 'Collecting imports and calls', sourceFiles.length);
  for (const [index, sourceFile] of sourceFiles.entries()) {
    callProgress(index, sourceFile);
    if (usableCache && !impactedFiles.has(sourceFileRelPath(root, sourceFile))) continue;
    collectImportsAndCalls(graph, root, checker, sourceFile, allRealFiles, virtualByVueFile);
  }
  progress(`Collected imports and calls: ${graph.edges.size} edges`);
  progress('Resolving Vue template edges');
  addVueTemplateEdges(graph, root, vueInfoByRealPath);
  progress(`Vue template edges resolved: ${graph.edges.size} edges`);
  const vueDiagnostics = [];
  for (const [vuePath, info] of vueInfoByRealPath) {
    for (const err of info.errors ?? []) {
      const message = err instanceof Error ? err.message : String(err.message ?? err);
      vueDiagnostics.push({
        file: vuePath,
        line: err.line ?? 0,
        message,
      });
    }
  }

  let tsDiagnostics = [];
  if (options.diagnostics) {
    progress('Collecting TypeScript diagnostics');
    try {
      tsDiagnostics = ts.getPreEmitDiagnostics(program)
        .filter((d) => {
          const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
          return !(d.file?.vueVirtual && /^Property '.+' does not exist on type /.test(message));
        })
        .map((d) => ({
          file: d.file?.fileName,
          line: d.file ? lineOf(d.file, d.start ?? 0) : 0,
          message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        }));
    } catch (err) {
      if (!isRecoverableTypeCheckerError(err)) throw err;
      graph.checkerFailures.push({
        file: '',
        line: 0,
        message: `TypeScript diagnostics failed: ${err instanceof Error ? err.message : String(err)}. Graph indexing completed without semantic diagnostics.`,
      });
    }
    progress(`Collected diagnostics: ${vueDiagnostics.length + graph.checkerFailures.length + tsDiagnostics.length}`);
  }

  const importsByFile = new Map();
  for (const sourceFile of sourceFiles) {
    importsByFile.set(sourceFileRelPath(root, sourceFile), collectSourceFileImports(root, sourceFile, allRealFiles, virtualByVueFile));
  }
  if (canWriteIncrementalCache) {
    progress('Writing incremental analysis cache');
    writeAnalysisCache(root, graph, files, fileContents, sourceFiles, importsByFile, checkerMode);
  }

  return {
    root,
    files: files.length,
    skippedFiles: skipped,
    nodes: graph.nodes,
    edges: graph.edges,
    cache: {
      enabled: canUseIncrementalCache,
      path: cachePath,
      hitFiles: cacheHitFiles,
      analyzedFiles: usableCache ? sourceFiles.length - cacheHitFiles : sourceFiles.length,
      impactedFiles: impactedFiles.size,
    },
    diagnostics: [
      ...vueDiagnostics,
      ...graph.checkerFailures,
      ...tsDiagnostics,
    ],
  };
}
