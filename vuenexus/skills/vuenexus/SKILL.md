---
name: vuenexus
description: "Use when exploring, debugging, refactoring, or reviewing Vue projects indexed by VueNexus. Best for component/render graphs, routes, Vuex/Pinia stores, composables, and change impact radius."
---

# VueNexus Vue Skill

## Purpose

Use the VueNexus graph before relying on memory or raw grep. The graph is meant to give an agent a project-level map: what imports what, what renders what, what calls what, which route reaches which component, which component uses which store, and where a change may propagate.

The graph is authoritative only for relations that were statically resolved. `UnresolvedReference` is not a normal result; it is a warning that a nearby relation may hide more impact.

## First Checks

For any indexed project, start with:

```bash
vuenexus stats --db .vuenexus/lbug
vuenexus query "<symbol, route, component, store, or feature>" --db .vuenexus/lbug
```

If the graph is missing or stale:

```bash
vuenexus analyze --root .
```

Use `--diagnostics` only when debugging parser/type compatibility. Diagnostics are skipped by default for speed and do not affect normal edge creation.

## Agent Workflow

1. Run `vuenexus_stats` to understand graph size and whether `UnresolvedReference` nodes exist.
2. Run `vuenexus_unresolved_report` early. Treat unresolved items as blockers only when they are near the files/symbols you are changing.
3. Use `vuenexus_query` to find candidate symbols. Prefer exact component/store/composable names over broad natural language.
4. For a refactor or method change, run `vuenexus_impact_radius` on the exact symbol or node id before editing.
5. Use `vuenexus_context` for direct incoming/outgoing edges, then `vuenexus_graph` for a wider local slice.
6. Use `vuenexus_call_chain` when tracing runtime-ish flow from an entry point such as a click handler, composable, route component, or store action.
7. Read the source files returned by the graph before changing code. The graph narrows the search; source remains the final proof.

## Impact Rules

When `vuenexus_impact_radius` returns `confidence: "complete"`, no unresolved blockers were found near the returned slice.

When it returns `confidence: "partial"`:

- Inspect `unresolvedBlockers` before saying a change is safe.
- Use `rg` and source reads around the blocker file/line.
- Do not conclude "no callers" or "no renderers" from a small result if unresolved blockers are attached to the same owner/file.

Unresolved references should be rare and actionable. Normal third-party packages are stored as `ExternalModule` nodes with `IMPORTS` or `RENDERS` edges; they should not be treated as graph gaps.

## Edge Semantics

- `DEFINES`: a file contains a symbol, route, inline component, or synthetic Vue option node.
- `IMPORTS`: static or dynamic import. Local assets and third-party packages are still linked.
- `CALLS`: TypeScript/Vue-aware function, method, constructor, composable, Vuex, or Pinia action call.
- `RENDERS`: Vue template renders a local component, inline component, or external component module.
- `HANDLES`: template expression references a script symbol, such as `@click`, `v-if`, `:prop`, or interpolation.
- `ROUTES_TO`: Vue Router route object points to a component or component module.
- `USES_STORE`: component/composable/method uses a Pinia or Vuex store.
- `MIXES_IN`: Vue 2 `mixins` or `extends` relation.
- `HAS_UNRESOLVED`: owner/file has an unresolved relation that may hide impact.

## MCP

Recommended MCP config:

```json
{
  "mcpServers": {
    "vuenexus": {
      "command": "npx",
      "args": ["-y", "--package", "vuenexus@latest", "vuenexus", "mcp", "--db", ".vuenexus/lbug"]
    }
  }
}
```

Prefer MCP tools in this order:

1. `vuenexus_stats`
2. `vuenexus_unresolved_report`
3. `vuenexus_query`
4. `vuenexus_impact_radius`
5. `vuenexus_context`
6. `vuenexus_call_chain`
7. `vuenexus_graph`
8. `vuenexus_cypher`

Use `vuenexus_export` only for small projects or explicit full-graph requests.

## Good Agent Answers

When answering architecture or impact questions, include the exact node names/files you relied on and mention whether unresolved blockers were present. If blockers exist, explain what you manually checked in source. Avoid claiming 100% impact coverage unless the graph slice is complete and the relevant source files agree.
