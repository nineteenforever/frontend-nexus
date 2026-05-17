import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function hasAny(dir, names) {
  return names.some((name) => fs.existsSync(path.join(dir, name)));
}

function modelDirLooksUsable(dir) {
  if (!isDir(dir)) return false;
  return (
    fs.existsSync(path.join(dir, 'config.json')) &&
    hasAny(dir, ['tokenizer.json', 'tokenizer_config.json']) &&
    (hasAny(path.join(dir, 'onnx'), ['model.onnx', 'model_quantized.onnx']) ||
      hasAny(dir, ['model.onnx', 'model_quantized.onnx']))
  );
}

function resolveExistingModelPath(spec) {
  const candidates = [
    path.resolve(process.cwd(), spec),
    path.resolve(packageRoot, spec),
  ];
  for (const candidate of candidates) {
    if (modelDirLooksUsable(candidate)) return candidate;
  }
  return undefined;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function resolvePackageRoot(packageName) {
  try {
    return path.dirname(require.resolve(`${packageName}/package.json`, {
      paths: [process.cwd(), packageRoot],
    }));
  } catch {
    return undefined;
  }
}

function resolveModelPackage(packageName) {
  const root = resolvePackageRoot(packageName);
  if (!root) return undefined;
  const pkg = readJson(path.join(root, 'package.json'));
  const configured =
    pkg.gitnexus?.embeddingModelPath ??
    pkg.frontendNexus?.embeddingModelPath ??
    pkg.embeddingModelPath;
  const candidates = [
    configured && path.join(root, configured),
    path.join(root, 'models', 'embedding'),
    path.join(root, 'model'),
    path.join(root, 'embedding-model'),
  ].filter(Boolean);
  const modelPath = candidates.find(modelDirLooksUsable);
  return modelPath
    ? {
      model: modelPath,
      source: 'package',
      packageName,
      packageRoot: root,
    }
    : undefined;
}

function bundledModelCandidates() {
  return [
    path.join(packageRoot, 'models', 'embedding'),
    path.join(packageRoot, 'model'),
    path.join(packageRoot, 'embedding-model'),
  ];
}

function resolveBundledModel() {
  const model = bundledModelCandidates().find(modelDirLooksUsable);
  return model
    ? {
      model,
      source: 'bundled',
      packageRoot,
    }
    : undefined;
}

function defaultModelPackages() {
  return [
    '@frontend-nexus/embedding-model',
    '@gitnexus/embedding-model',
    'frontend-nexus-embedding-model',
  ].filter(Boolean);
}

export function resolveLocalEmbeddingModel(options = {}) {
  const explicit =
    options.model ??
    process.env.GITNEXUS_LOCAL_EMBEDDING_MODEL ??
    process.env.GITNEXUS_EMBEDDING_MODEL;

  if (explicit) {
    const modelPath = resolveExistingModelPath(explicit);
    if (modelPath) return { model: modelPath, source: 'path' };
    const packageModel = resolveModelPackage(explicit);
    if (packageModel) return packageModel;
    return { model: explicit, source: 'explicit' };
  }

  const bundled = resolveBundledModel();
  if (bundled) return bundled;

  for (const packageName of [
    options.modelPackage,
    process.env.GITNEXUS_LOCAL_EMBEDDING_MODEL_PACKAGE,
    ...defaultModelPackages(),
  ].filter(Boolean)) {
    const packageModel = resolveModelPackage(packageName);
    if (packageModel) return packageModel;
  }

  throw new Error(
    [
      'Local embedding model was not found.',
      'Provide --model /absolute/model/dir, set GITNEXUS_LOCAL_EMBEDDING_MODEL,',
      'publish this package with a Transformers.js model in models/embedding,',
      'or install/set GITNEXUS_LOCAL_EMBEDDING_MODEL_PACKAGE to a model package.',
    ].join(' '),
  );
}

export function localEmbeddingModelInfo(options = {}) {
  const resolved = resolveLocalEmbeddingModel(options);
  return {
    ...resolved,
    usable: !path.isAbsolute(resolved.model) || modelDirLooksUsable(resolved.model),
  };
}
