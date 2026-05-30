# frontend-nexus

`frontend-nexus` 里有两个项目：

- `vuenexus`：CLI 包，负责 Vue 项目分析、LadybugDB 图谱存储、MCP server、opencode setup、`vuenexus serve` API。
- `vuenexus-web`：独立的 Vite + React + TypeScript 浏览器图谱 UI。它和 `vuenexus` 的关系，类似 `gitnexus-web` 和 `gitnexus`。

建议使用 Node.js `^20.19.0 || >=22.12.0`，内网环境优先用 Node 22 LTS。

## 内网快速开始

从这个仓库本地构建并全局安装 CLI：

```bash
cd vuenexus
npm install
npm run build
npm pack
npm uninstall -g vuenexus
npm install -g ./vuenexus-0.1.8.tgz
```

配置 opencode 的 MCP 和 VueNexus skill：

```bash
vuenexus setup
```

opencode 里期望写入的 MCP 配置是：

```json
{
  "mcp": {
    "vuenexus": {
      "type": "local",
      "command": ["vuenexus", "mcp"],
      "enabled": true
    }
  }
}
```

`vuenexus setup` 也会安装 skill 文件。Windows 上 opencode 配置和 skill 通常在：

```text
C:\Users\<you>\.config\opencode\
```

## 分析 Vue 项目

在任意 Vue 项目目录下运行：

```bash
cd /path/to/vue-project
vuenexus analyze
```

`vuenexus analyze` 默认使用 `--checker fast`。这是大 Vue 项目的推荐模式：它避免对每个调用表达式触发昂贵的 TypeScript 深度类型解析，防止卡在复杂泛型、依赖类型或生成类型里；同时仍通过 Vue 官方 parser、TypeScript AST、import/export 映射和局部符号表解析 Vue SFC、组件、路由、Pinia、Vuex、mixin、常见调用链等关系。

只有你明确需要更深的 TypeScript 调用目标解析，并且能接受更慢速度时，才使用：

```bash
vuenexus analyze --checker full
```

`vuenexus analyze` 默认开启增量分析缓存。缓存结构是：

```text
.vuenexus/cache/analysis-cache.json
.vuenexus/cache/files/
```

其中 `analysis-cache.json` 是小 manifest，每个文件的图谱切片放在 `.vuenexus/cache/files/` 下。下次分析时，未变化文件会复用缓存，变化文件以及 import 它们的文件会重新分析。

强制全量重新分析并刷新缓存：

```bash
vuenexus analyze -f
vuenexus analyze --force
```

忽略本次缓存：

```bash
vuenexus analyze --no-incremental
```

默认会跳过明显的生成产物和静态目录，包括：

- `.min.js`
- `jquery*.js`
- `cssWorkerMain.js`
- runtime/vendor/chunk bundle
- 很大的单行压缩 JS
- monorepo 任意层级下的 `public/` 和 `static/`

analyze 进度会打印跳过路径、原因和大小。确实想把这些文件也纳入图谱时使用：

```bash
vuenexus analyze --include-generated
```

分析结果会写到：

```text
/path/to/vue-project/.vuenexus/lbug
/path/to/vue-project/.vuenexus/meta.json
~/.vuenexus/registry.json
```

如果被分析项目根目录已有 `.gitignore`，`vuenexus analyze` 会自动追加一次：

```gitignore
.vuenexus/
```

这样图谱、缓存和 LadybugDB 文件不会出现在 Git changes 里。

常用检查命令：

```bash
vuenexus stats
vuenexus query "App"
vuenexus context --symbol App
vuenexus chain --from App --depth 5
vuenexus cypher "MATCH (a)-[r:CodeRelation]->(b) RETURN a.id, r.type, b.id LIMIT 20"
```

在已经分析过的项目目录里启动 opencode：

```bash
opencode .
```

opencode 会拉起 MCP 命令 `vuenexus mcp`。因为它从当前 Vue 项目目录启动，`vuenexus mcp` 会自动读取 `./.vuenexus/lbug`，通常不需要手写 `--db`。

## 向量化分析

embedding 是可选功能，不影响图谱精度。节点和边先由 Vue/TypeScript 解析生成，然后才把向量写进同一个 `.vuenexus/lbug`。

内网环境建议使用本地模型目录或内部 npm 模型包，不依赖网络下载。

显式指定本地模型目录：

```bash
cd /path/to/vue-project
vuenexus analyze --embedding --provider local --model /absolute/path/to/local/embedding-model
```

本地模型应该是 Transformers.js 的 feature-extraction 模型，通常类似：

```text
/absolute/path/to/local/embedding-model/config.json
/absolute/path/to/local/embedding-model/tokenizer.json
/absolute/path/to/local/embedding-model/onnx/model_quantized.onnx
```

如果模型已经打包在安装后的 `vuenexus` 包内 `models/embedding`，可以直接：

```bash
vuenexus analyze --embedding
vuenexus model-info
```

如果模型作为单独的内网 npm 包发布：

```bash
npm install -g vuenexus @your-scope/vuenexus-embedding-model --registry http://your-internal-npm/
vuenexus analyze --embedding --model-package @your-scope/vuenexus-embedding-model
```

也可以先正常 analyze，再给已有图谱补向量：

```bash
vuenexus analyze
vuenexus embed --provider local --model /absolute/path/to/local/embedding-model
```

测试语义搜索：

```bash
vuenexus semantic --query "用户登录表单" --limit 10
```

只做 smoke test 时，可以用确定性的 hash 向量：

```bash
vuenexus analyze --embedding --provider hash
vuenexus semantic --query "anything" --provider hash
```

`hash` 不代表语义搜索质量，只用于确认 embedding 写入和查询链路能跑通。

## 浏览器图谱 UI

启动 API server：

```bash
vuenexus serve --port 3000
```

启动本仓库里的 Web UI：

```bash
cd /path/to/frontend-nexus/vuenexus-web
npm install
npm run dev
```

打开：

```text
http://127.0.0.1:5173
```

在页面里填入 VueNexus server 地址：

```text
http://127.0.0.1:3000
```

`vuenexus serve` 会读取 `~/.vuenexus/registry.json`，因此 UI 可以列出多个已经 analyze 过的项目。

## 如何评估 VueNexus 是否好用

需要让 opencode 或其他 agent 对比源码和分析结果时，读这个评测流程：

[EVALUATION_GUIDE.md](./EVALUATION_GUIDE.md)

它是评测协议，不是安装到 agent 里的 skill。

## 目录结构

```text
frontend-nexus/
  vuenexus/        CLI 包，分析器，MCP，存储，serve API
  vuenexus-web/    浏览器 UI 项目
  other/           研究笔记和旧错误记录
```
