# VueNexus Evaluation Guide

This document is a practical evaluation protocol for humans or agents. It is not an installed skill. Use it to judge whether `vuenexus analyze` produced a useful and accurate graph for a Vue project.

## Goal

Evaluate three things:

- correctness: graph relations match the source code
- completeness: important frontend paths are not missing
- usefulness: MCP/CLI results help an agent understand architecture faster than raw search alone

Do not treat the graph as correct just because commands return data. Always compare representative graph results against source files.

## Setup

From the target Vue repository:

```bash
vuenexus analyze
vuenexus stats
```

Confirm that these files exist:

```text
.vuenexus/lbug
.vuenexus/meta.json
```

Start MCP through opencode if available:

```bash
opencode .
```

The expected MCP config is:

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

## Baseline Commands

Run:

```bash
vuenexus stats
vuenexus query "App"
vuenexus cypher "MATCH (a)-[r:CodeRelation]->(b) RETURN r.type, count(*) AS count ORDER BY count DESC"
```

Record:

- total nodes
- total edges
- node counts by type
- edge counts by type
- unresolved reference count

If `UnresolvedReference` is high, inspect:

```bash
vuenexus cypher "MATCH (n:UnresolvedReference) RETURN n.kind, n.name, n.filePath, n.startLine, n.reason LIMIT 50"
```

High unresolved counts do not automatically mean failure, but unresolved items near evaluated files reduce confidence.

## Source-To-Graph Checks

Pick 5 to 10 representative source files:

- root app component
- router file
- one route-level page
- one deeply nested component
- one composable
- one Pinia or Vuex store
- one file using dynamic import
- one Vue 2 Options API file if the project has Vue 2 patterns

For each file, manually read imports, template tags, handlers, route objects, and store calls. Then verify with graph commands.

Useful commands:

```bash
vuenexus query "ComponentName"
vuenexus context --symbol ComponentName
vuenexus graph --symbol ComponentName --limit 120
vuenexus chain --from ComponentName --depth 6 --limit 300
```

For MCP, use:

- `vuenexus_stats`
- `vuenexus_query`
- `vuenexus_context`
- `vuenexus_graph`
- `vuenexus_call_chain`
- `vuenexus_unresolved_report`
- `vuenexus_impact_radius`

## Relation Checklist

Verify these relation types against source:

- `DEFINES`: each sampled file defines its real component/functions/classes/store/actions
- `IMPORTS`: local imports, alias imports, `.vue` imports, dynamic imports, and external packages are represented
- `RENDERS`: template component tags point to the rendered component or external component module
- `HANDLES`: `@click`, `v-if`, `v-for`, `:prop`, `v-model`, and interpolation expressions point back to script symbols when resolvable
- `CALLS`: functions, composables, methods, constructors, and store actions point to real targets
- `ROUTES_TO`: route objects point to route components, including lazy imports
- `USES_STORE`: components/composables using Pinia or Vuex stores connect to store nodes/actions
- `MIXES_IN`: Vue 2 `mixins` and `extends` are represented when present
- `HAS_UNRESOLVED`: unresolved edges are attached to the owner/file that needs manual checking

For each sampled file, mark:

```text
file:
expected relations:
graph relations:
missing:
wrong:
unresolved nearby:
confidence: high | medium | low
```

## Long Call Chain Evaluation

Choose one real user flow, such as:

- route -> page component -> child component -> click handler -> composable -> API helper/store action
- route -> page component -> store action -> helper function
- component template event -> method -> composable -> store

Find the source chain manually first. Use `rg` and source reads:

```bash
rg "ComponentName|handlerName|storeAction|useSomething" src
```

Then compare:

```bash
vuenexus chain --from ComponentName --depth 8 --limit 500
vuenexus context --symbol handlerName
vuenexus graph --symbol handlerName --limit 120
```

Use Cypher for focused checks:

```bash
vuenexus cypher "MATCH (a)-[r:CodeRelation]->(b) WHERE a.id CONTAINS 'handlerName' OR b.id CONTAINS 'handlerName' RETURN a.id, r.type, b.id, r.step LIMIT 100"
```

Expected outcome:

- every manually confirmed major step appears as an edge
- no edge points to an obviously wrong file or same-name unrelated symbol
- unresolved blockers are reported if the chain cannot be statically resolved

## False Positive Checks

Look for wrong relations, not only missing relations.

Check:

- same-name functions in different files
- `this.method()` in Options API or classes
- route-like objects that are not router definitions
- type-only imports or interface signatures that should not become runtime `CALLS`
- external packages that should be `ExternalModule`, not `UnresolvedReference`
- barrel exports and aliases

Wrong edges are more dangerous than missing edges. Record every wrong edge with source evidence.

## Pass Criteria

A project-level result is good enough for agent use when:

- sampled component render edges match source
- sampled route edges match source
- sampled store/composable calls match source
- no critical wrong edges were found in sampled flows
- missing edges are either rare or clearly represented as unresolved blockers
- `vuenexus_impact_radius` does not claim complete confidence when nearby unresolved blockers exist

Use this judgment:

- `excellent`: no wrong edges found, only minor missing edges, unresolved blockers are useful
- `usable`: a few missing edges, no dangerous wrong impact claims
- `needs work`: wrong edges or missing common Vue patterns
- `unsafe`: graph frequently points to incorrect targets or hides unresolved impact

## Report Template

```text
Repository:
Vue version / framework:
Analyze command:
Node count:
Edge count:
Unresolved count:

Sampled files:

Longest checked flow:

Correct relations:

Missing relations:

Wrong relations:

Unresolved blockers:

Overall rating:

Recommended analyzer improvements:
```
