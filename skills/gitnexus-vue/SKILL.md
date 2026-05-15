---
name: gitnexus-vue
description: "Use when exploring, debugging, refactoring, or reviewing Vue frontend projects indexed by GitNexus Frontend. Focuses on components, templates, composables, stores, routes, and frontend call chains."
---

# GitNexus Vue Skill

## When To Use

Use this skill for Vue frontend code questions:

- "What renders this component?"
- "What happens when this button is clicked?"
- "Where is this store used?"
- "Trace this route to the component and composables it touches."
- "What frontend code changes if I refactor this composable?"

## First Checks

Run these before answering from memory:

```bash
gitnexus stats --db .gitnexus/lbug
gitnexus query "<feature or symbol>" --db .gitnexus/lbug
```

If no index exists or the graph is stale, index the project:

```bash
gitnexus analyze --root .
```

Embedding does not affect graph precision. Prefer graph search first:

```bash
gitnexus analyze --embedding
gitnexus query "checkout component store flow" --db .gitnexus/lbug
```

## Exploration Workflow

1. `gitnexus query` for the user-facing feature, component, composable, route, or store name.
2. `gitnexus context --symbol <name>` to inspect direct incoming and outgoing edges.
3. `gitnexus chain --from <name> --depth 5` to trace runtime-ish frontend flow.
4. Read the source files for the returned nodes before making code changes.

## Edge Semantics

- `RENDERS`: Vue template component usage.
- `HANDLES`: template interpolation, `v-bind`, `v-on`, or other directive expression linked to script symbols.
- `CALLS`: TypeScript checker resolved function/method/composable calls.
- `USES_STORE`: a store composable call resolved to a `Store` node.
- `ROUTES_TO`: router route object points to a Vue component.
- `IMPORTS`: static import path relation.
- `DEFINES`: file contains symbol.

## MCP

For agents using MCP, configure:

```json
{
  "mcpServers": {
    "gitnexus": {
      "command": "npx",
      "args": ["-y", "--package", "frontend-nexus@latest", "gitnexus", "mcp", "--db", ".gitnexus/lbug"]
    }
  }
}
```

Prefer MCP tools in this order:

1. `gitnexus_stats`
2. `gitnexus_query`
3. `gitnexus_context`
4. `gitnexus_call_chain`
5. `gitnexus_graph`
6. `gitnexus_cypher`

Use `gitnexus_export` only when the project is small or the user explicitly needs a full graph dump.
