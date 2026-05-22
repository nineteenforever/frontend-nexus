# frontend-nexus

This repository is split into two maintainable projects:

- `vuenexus`: CLI, analyzer, LadybugDB storage, MCP server, setup command, and API server. Run `npm pack` from this directory when you want to create the installable `vuenexus` package.
- `vuenexus-web`: TypeScript browser UI for graph exploration. It consumes the GitNexus-compatible APIs exposed by `vuenexus serve`.

Typical local workflow:

```bash
cd vuenexus
npm install
npm run build
npm pack
```

```bash
cd ../vuenexus-web
npm install
npm run build
```

Then, inside an analyzed project:

```bash
vuenexus serve --port 3000
vuenexus ui --server http://127.0.0.1:3000 --ui-dir /path/to/frontend-nexus/vuenexus-web/dist
```
