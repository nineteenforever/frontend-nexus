# Bundled Embedding Model

For an internal npm release that should work offline after `npm install`, place a Transformers.js compatible
feature-extraction model in:

```text
models/embedding/
```

The directory must contain at least:

```text
models/embedding/config.json
models/embedding/tokenizer.json
models/embedding/onnx/model_quantized.onnx
```

`vuenexus analyze --embedding` and `vuenexus embed` will auto-detect this directory when `provider=local`.

Recommended internal model choices are small code/text embedding models exported for Transformers.js ONNX
runtime. Keep the model license and npm registry package-size limits in mind before publishing.
