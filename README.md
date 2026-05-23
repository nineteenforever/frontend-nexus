# frontend-nexus

This repository is split into two maintainable projects:

- `vuenexus`: CLI, analyzer, LadybugDB storage, MCP server, setup command, and API server. Run `npm pack` from this directory when you want to create the installable `vuenexus` package.
- `vuenexus-web`: independent Vite + React + TypeScript browser UI, equivalent in relationship to `gitnexus-web` and `gitnexus`. It consumes the GitNexus-compatible APIs exposed by `vuenexus serve`.

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
npm run dev
```

Then, inside an analyzed project or a project where `vuenexus` is globally installed:

```bash
vuenexus analyze --root /path/to/vue-project
vuenexus serve --port 3000
```

Open the `vuenexus-web` dev URL, usually `http://127.0.0.1:5173`, and enter `http://127.0.0.1:3000` as the VueNexus server.
