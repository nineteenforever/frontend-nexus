# VueNexus Web

VueNexus Web is the standalone browser UI for `vuenexus serve`. Its role mirrors `gitnexus-web` in the GitNexus project: the CLI/analyzer stores and serves graph data, while this app renders the graph in the browser.

## Development

Use Node.js 20.19+ or 22.12+.

```bash
npm install
npm run dev
```

Then run the VueNexus API server from any analyzed project:

```bash
vuenexus analyze --root /path/to/vue-project
vuenexus serve --port 3000
```

Open the dev server, usually:

```text
http://127.0.0.1:5173
```

Enter the API server URL:

```text
http://127.0.0.1:3000
```

## Build

```bash
npm run build
npm run preview
```

The production build is written to `dist/`. It can also be served by `vuenexus ui --ui-dir /path/to/vuenexus-web/dist`, but normal development should use `npm run dev`.

## API Contract

The app currently consumes the endpoints exposed by `vuenexus serve`:

- `GET /api/repos`
- `GET /api/graph?repo=<repo>&stream=true`
- `GET /api/repo?repo=<repo>`
- `POST /api/search`
- `POST /api/query`
- `GET /api/file?repo=<repo>&path=<path>`
