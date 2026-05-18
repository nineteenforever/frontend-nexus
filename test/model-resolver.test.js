import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { localEmbeddingModelInfo } from '../dist/model-resolver.js';

function fakeModel(dir) {
  fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'tokenizer.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'onnx', 'model_quantized.onnx'), '');
}

test('resolves an explicit local embedding model directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vuenexus-model-'));
  fakeModel(root);
  const info = localEmbeddingModelInfo({ model: root });
  assert.equal(info.model, root);
  assert.equal(info.source, 'path');
  assert.equal(info.usable, true);
});

test('resolves a configured npm model package', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vuenexus-model-pkg-'));
  const packageRoot = path.join(root, 'node_modules', '@scope', 'model');
  const modelRoot = path.join(packageRoot, 'models', 'embedding');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@scope/model',
      version: '1.0.0',
      vuenexus: { embeddingModelPath: 'models/embedding' },
    }),
  );
  fakeModel(modelRoot);

  const previous = process.cwd();
  process.chdir(root);
  try {
    const info = localEmbeddingModelInfo({ modelPackage: '@scope/model' });
    assert.equal(fs.realpathSync(info.model), fs.realpathSync(modelRoot));
    assert.equal(info.source, 'package');
    assert.equal(info.packageName, '@scope/model');
  } finally {
    process.chdir(previous);
  }
});
