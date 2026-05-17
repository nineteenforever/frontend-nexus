# VueNexus Design

## Core Contract

VueNexus focuses on the graph contract rather than broad language coverage:

- typed graph nodes
- one relationship table with `type`, `confidence`, and `reason`
- separate embedding storage keyed by graph node id
- MCP tools that return compact graph slices rather than raw database internals

It keeps the graph surface compact and avoids multi-language ingestion, heritage, MRO, and generalized resolver layers that add noise for Vue architecture analysis.

## What Was Removed

- Tree-sitter language registry
- per-language import/call/field/heritage extractors
- cross-language scope resolution
- community/process enrichment
- route/tool/markdown indexing
- LadybugDB-specific graph DDL

Those are powerful in a general indexer, but they add noise for a Vue project graph.

## Parser Strategy

Vue is parsed with official Vue packages:

- `@vue/compiler-sfc` for `.vue` SFC blocks
- `@vue/compiler-dom` for template AST

Script code is resolved with TypeScript:

- real `.ts/.tsx/.js/.jsx/.mjs/.cjs` files are added to one TypeScript program
- each `.vue` file becomes a virtual `.vue.ts` source file
- TypeScript checker resolves call signatures and import targets

This makes call edges evidence-based:

- `CALLS`: produced only when TypeScript resolves the callee to a known declaration
- `IMPORTS`: produced by static import path resolution
- `RENDERS`: Vue template component tag linked to a script import or known SFC component
- `HANDLES`: Vue template expression references linked to local script declarations
- `DEFINES`: file-to-symbol containment

## Precision Rules

1. Prefer TypeScript checker declarations over name matching.
2. Use name matching only for Vue template expressions, because template expressions are not TypeScript source files in this minimal version.
3. Every non-checker edge carries a specific `reason` and slightly lower confidence where appropriate.
4. Vue line numbers are mapped back from virtual `.vue.ts` to the original SFC block line.
5. File paths are stored relative to the indexed root for stable ids.

## Known V1 Limits

- Template expression resolution is lexical and local; it does not yet type-check expressions against generated Vue render context.
- Vue macros are parsed, but `compileScript` binding metadata is not yet used.
- Pinia/Vue Router/Vite aliases are handled only when TypeScript config can resolve them.
- Dynamic imports and computed component names are intentionally not guessed.

The next precision upgrade should use `compileScript(...).bindings` to tighten template identifier classification without adding much code.
