# CLAUDE.md

Guidance for Claude Code (or a human) working in this repository.

**The Node/TypeScript rewrite described by this file has landed** — the Python/FastMCP
proof-of-concept that used to occupy this repo is gone from the working tree (still recoverable
from git history/earlier commits on this branch's history if old behaviour ever needs
cross-checking). This file now describes the actual code, not a plan for it — **keep it that way:
update this file whenever it diverges from reality**, the same discipline that applied while it
was still aspirational. Full reasoning behind the design lives in `docs/els-mcp-server-design.md`
(tool spec, gap analysis, why each decision was made) and `docs/els-mcp-server-next-steps.md`
(build order, verification checklist, both now executed) — this file doesn't repeat their content,
only the parts relevant to writing code day to day.

## Project overview

An MCP (Model Context Protocol) server exposing the ONS "Explore Local Statistics" (ELS) API to
LLM clients (Claude Desktop, etc.) as a set of tools — letting a chatbot answer questions like
"what's the unemployment rate in Belfast" by calling real, current UK local-statistics data rather
than relying on training-data recall. TypeScript/Node, Streamable HTTP transport, deployed to
Vercel.

## Current state: TypeScript/Node server

- `src/server.ts` exports `createServer()`, a **factory** (not a shared singleton) that builds one
  `McpServer` with every tool registered. It's a factory because the Streamable HTTP transport
  runs in **stateless mode** everywhere (`sessionIdGenerator: undefined`) — both `src/dev-server.ts`
  (local dev, plain Node `http.createServer`, port 8001) and `api/mcp.ts` (the Vercel Node
  function) create a fresh server + transport per request. This matches Vercel reality directly:
  each invocation can land on a different warm instance, so there is no shared in-memory session
  to keep a singleton correct for (see "Caching" below for the same constraint applied elsewhere).
  No ASGI-style path-rewrite shim is needed this time (unlike the old `api/index.py`) — the
  handler doesn't care what path Vercel invoked it at.
- `src/http-client.ts` is the single HTTP client wrapper every tool goes through: base URL
  (`ELS_API_BASE_URL`, read once in `src/config.ts` and **fails loudly at startup if unset**),
  GSS-code upper-casing (`upperGss`), and a typed `ElsApiError` for genuine 4xx/5xx failures. It
  deliberately does **not** try to be one `{rows, isEmpty}` shape for every endpoint — the ELS API
  itself doesn't have one shape (`/geo/search` returns `{data: [...]}`, `/geo/lookup` returns
  `{properties: {...}}`, the data endpoint returns an indicator-keyed object) — instead it exposes
  small, explicit emptiness predicates (`isEmptySearchResult`, `isEmptyRows`) that call sites use.
- `src/cache.ts` — best-effort, in-process memoisation of the indicator catalogue and geo-levels
  list (5-minute TTL for indicators, no TTL for geo levels since they're effectively static).
  Every getter re-fetches on a miss; nothing in the tools may assume the cache is populated (a cold
  start on Vercel resets it — same constraint the Python version's `@lru_cache` didn't have to
  think about, since it assumed a long-lived process).
- `src/tools/{geography,metadata,data}.ts` — one module per domain group, matching the design
  doc's three groups, registering all 14 tools + `health`:
  - **geography**: `search_areas`, `resolve_area`, `get_area_details`, `get_related_areas`,
    `get_nearby_areas`, `list_geo_levels`, `lookup_area`.
  - **metadata**: `search_indicators`, `get_indicator_metadata`, `list_topics`.
  - **data**: `get_indicator_data` (the core tool — `pivot` and `download_format` params absorb
    what were originally proposed as two separate tools; see design doc), `rank_areas`,
    `rank_areas_by_change`, `get_area_profile`, `health`.
- `src/types.ts` — shared domain types (`Indicator`, `GeoLevel`, `DataRow`, `Coverage`), confirmed
  against live API responses during the build (see next-steps.md step 4 — every field name here
  was checked against a real response, not just the docs).
- `src/tool-helpers.ts` — `jsonResult`/`errorResult`, wrapping a tool's return value as MCP
  `CallToolResult` content (JSON-serialised text), used by every tool.

### Sharp edges discovered live during the build (not in any doc beforehand)

These were found by curling the `api-improvements` preview directly while building — worth
knowing before touching the affected code, and worth re-checking if the API changes underneath:

- **Geo-level keys in the `geo` query param are case-sensitive and must stay lower-case** —
  unlike GSS area codes in the same param, which really are case-insensitive. `geo=LTLA` silently
  returns zero rows where `geo=ltla` works. `fetchDataRows` in `src/tools/data.ts` upper-cases area
  codes individually (via `upperGss`, applied by callers before the geo string is built) but
  passes `geo_type` through untouched — don't "fix" this by blanket-uppercasing the joined geo
  string again (that regressed `rank_areas` during initial verification; see git history).
- **The `dimension_{code}` filter requires lower-case values even though the API's own rows return
  capitalised ones** (e.g. filter value `female` for a row where `sex: "Female"`). Absorbed in
  `fetchDataRows` — dimension values are lower-cased before being sent, so no tool caller has to
  know this.
- **Filtering by more than one `dimension_{code}` at once currently returns zero rows** — confirmed
  via a raw `curl` against the live API directly, so this is an upstream API limitation, not
  something absorbable at this tool layer. `get_indicator_data`'s `dimensions` param description
  flags it; `coverage.missing` has no way today to distinguish this from genuine "no data."
- **Pure word-overlap indicator search cannot bridge a query and a label sharing zero tokens** —
  e.g. "internet" vs. the actual indicator label "Gigabit capable broadband," whose text nowhere
  contains "internet." `src/tools/metadata.ts` has a small, deliberately narrow `SYNONYMS` map for
  cases actually traced to an example prompt (see design doc) rather than a general thesaurus —
  extend it only when a real query surfaces another same-concept/different-word gap.

### Bugs caught by real usage after the initial build, not by curling the API

These weren't sharp edges in the ELS API — they were wrong logic in this codebase, surfaced by an
LLM client actually using the tools (exactly the discipline next-steps.md step 5 describes, just
happening informally before step 5 was formally run):

- **`get_indicator_data` with `pivot: "area"` silently returned only the LAST row seen per
  (area, indicator), dropping the rest with no error or coverage flag.** For a univariate
  indicator with one row per area this is invisible; for a multivariate one (e.g.
  `population-by-age-and-sex`, one row per sex × age-band combination) or a multi-period `time`
  range, it silently kept one arbitrary row (a specific run returned "Male, 85+" for every area)
  and dropped the other 53+ — reading as a complete, correct single value rather than an
  arbitrary slice of a bigger result. Fixed by making every cell under `pivot: "area"` **always
  an array**, never a bare row object (`pivotByArea` in `src/tools/data.ts`), and by adding
  `isMultivariate`/`hasTimeseries` to the indicator metadata block so a longer array isn't a
  surprise. `buildComparisonNote` had the identical bug (picking an arbitrary row per area via
  `.find()` when more than one existed) — fixed by requiring exactly one row per area
  (`rows.length === 2`, not just 2 distinct area codes) before attempting a CI comparison, and
  explaining why otherwise. **The general lesson**: any code in this tool layer that assumes "one
  row per area/indicator" needs to justify that assumption explicitly (single period, non-
  multivariate, or `dimensions` fully narrowed) — the ELS API does not guarantee it, and silently
  keeping-the-last-one is worse than an error, because it looks like real data.

## The ELS API is documented elsewhere — don't re-derive its behaviour here

`docs/api/` in `ONSdigital/explore-local-statistics-app` (same org) is the maintained, verified
reference for every endpoint, parameter, response shape and error condition this server calls
into — particularly `important-notes.md` for sharp edges. Read it before writing or modifying a
tool that touches a new part of the API, rather than guessing from this server's own behaviour or
from first principles. **Caveat:** as of the last check during this rewrite, that documentation
still existed only on the `api-improvements` branch (confirmed absent from `main` — 404) — confirm
it's merged before treating links to it as stable.

**API base URL:** `ELS_API_BASE_URL` (env var, read once in `src/config.ts`, fails loudly at
startup if unset — see `.env.example`) currently points at
`https://local-statistics-git-api-improvements-ons-visual.vercel.app/api/v1`, a Vercel branch
preview of that same `api-improvements` branch, **not the production ELS API**. Repointing it at
the production base URL once that branch merges is a one-line config change (locally: `.env`;
deployed: the Vercel project's environment variables) — and re-run tool verification after that
repoint, since a preview and production can drift.

A few facts worth keeping in working memory anyway, because they directly shaped this server's
design (not just the underlying HTTP API's):

- **A request that resolves but matches no data returns `200` with an empty-shaped body, not an
  error.** Confirmed live for both the data endpoint (`{}` or `{slug: []}`) and search (`{data:
  []}`) — a genuinely bad identifier (unknown area code, unknown indicator slug) is a real `404`
  instead, also confirmed live. `src/http-client.ts`'s `isEmptySearchResult`/`isEmptyRows` exist
  because of this distinction.
- **The same underlying concept sometimes has two separate indicator slugs split by country
  coverage** (e.g. `employment-rate` vs. `employment-rate-ni`) — nothing in the API itself points
  one at the other, and country-level coverage in `geography.countries` can itself be misleading
  (`employment-rate` lists `N` as a covered country but its `geography.types` doesn't include
  `N09`, meaning it covers Northern Ireland only nationally, not at local-authority level —
  confirmed live, and exactly the kind of gap `get_indicator_data`'s `coverage.missing` is built to
  catch). This is *why* every data-returning tool attaches a `coverage` summary rather than just
  passing through whatever rows came back — see `docs/els-mcp-server-design.md`.
- **GSS codes are case-insensitive on every endpoint** (confirmed live: lower-case input,
  upper-case `areacd` in the response) and the geography-level vocabulary differs by route (a
  5-level statistical set vs. a wider navigation set vs. the boundary map's own set) — this tool
  layer exposes one consistent 5-level vocabulary (`ctry`/`rgn`/`cauth`/`utla`/`ltla`, matching
  indicator data's own granularity, via `list_geo_levels`) and normalises case internally
  (`upperGss`), so no tool description needs to explain either quirk to the calling model.

## Design principles (see `docs/els-mcp-server-design.md` for the full reasoning)

- **Task-shaped tools, not a REST mirror.** Fewer tools with parameters beats more tools with
  overlapping purposes — tool *selection* is itself a place an LLM goes wrong. This is why
  `get_indicator_data` has `pivot`/`download_format` params instead of two more tools sitting next
  to it (an earlier draft of the design proposed those as separate tools — an advisor review
  caught that this pushed the tool count in the wrong direction relative to this exact principle,
  see design doc's "Data" section).
- **This layer absorbs the API's sharp edges; the model calling it never sees them.** Don't expose
  `hasGeo` as a primary parameter. Don't expose the underlying single-indicator/multi-indicator
  endpoint split as a corresponding split in the tool surface — always call the multi-indicator
  endpoint internally (`/data.rows.json`) and let a tool's own parameter accept one-or-many. See
  also the "sharp edges discovered live" list above — same principle, applied to quirks that only
  showed up once real requests were made.
- **Never let an incomplete result look like a complete one.** Every data-returning tool response
  needs a `coverage` field (requested vs. returned vs. missing-with-reason), not just whatever rows
  happened to come back.
- **Cross-indicator/cross-area computation happens in this code, not in the calling model's
  context.** If a tool's job is naturally a join or a pivot (compare N indicators across M areas,
  rank by change over time), do that server-side — don't return raw material and expect the
  calling model to reconstruct it reliably.
- **Attach provenance to every data response**, not only to a separate metadata call — source,
  unit, caveats, `updated`, `confidenceIntervals`, pulled from the already-cached indicator
  catalogue.

## Caching

The indicator catalogue and geo-levels list are memoised in-process (`src/cache.ts`) — both are
read often and change rarely. **This is a latency optimisation only, never a correctness
dependency**: on Vercel's serverless Node runtime, module-level state persists only across a warm
function instance, not reliably across every invocation — a cold start resets it. Every getter
re-fetches on a miss, so nothing may assume the cache is populated.

## Commands

- `npm run dev` — local dev server (Streamable HTTP) at `http://localhost:8001/mcp`, matching
  `.vscode/mcp.json`'s `els-mcp-test` entry. Requires `.env` (copy `.env.example`).
- `npm run build` — `tsc` production build to `dist/`.
- `npm run start` — run the built `dist/dev-server.js` (loads `.env`).
- `npm run lint` — eslint (flat config, `eslint.config.js`).
- `npm run format` / `npm run format:check` — prettier (`.prettierrc.json`; `.prettierignore`
  excludes `*.md` and `.vscode/` to keep doc/editor-config diffs out of code-formatting passes).
- No `npm run test` yet — see "Verification" below for what actually needs covering, which has so
  far been done directly against the live preview API per tool rather than through a test runner
  (vitest is installed as a devDependency for whenever automated tests are added).

## Verification

Every tool needs to be checked against the **live** ELS API before being considered done, not
just type-checked — this was the working discipline for the entire API documentation/redesign
effort this server is built on, and it's what caught every real bug found while building this
version (the geo-level-key casing regression, the wrong default slugs in `get_area_profile`, the
word-overlap search gap, the multi-dimension-filter API limitation — none of these would have
been caught by type-checking alone). At minimum, per tool: one populated case, one genuinely empty
case (confirm it's handled as "no data" and not mistaken for an error), and for anything returning
a `coverage` field, one case with real incomplete coverage to confirm the gap is actually surfaced.
All 14 tools + `health` have been exercised this way at least once against the live preview API as
of this rewrite — re-run this discipline for any new tool or any change to an existing one.

Once a real LLM client is wired up, re-run the example prompts in
`docs/els-mcp-server-next-steps.md` end-to-end, not just as isolated tool calls — checking both
which tool gets selected and whether the final answer is right catches problems neither a
docstring review nor a per-tool test will. This hasn't been done yet as of this rewrite landing.

**`api/mcp.ts` itself has only been smoke-tested indirectly, not through an actual Vercel
deploy.** Deployment for this project is via Vercel's GitHub integration (push/merge triggers a
build), not the `vercel` CLI, so the CLI's own `vercel dev`/`vercel deploy` were never the
intended path here anyway — noted below only so the *coverage gap* is clear, not as a suggestion
to use the CLI. What *has* been verified: `api/mcp.ts`'s exported `handler` (not
`dev-server.ts`'s separate implementation) executes correctly end-to-end — including the
`../src/server.js` cross-directory import — when driven directly through a plain Node
`http.createServer` in the same way Vercel's Node.js Serverless Function runtime would invoke it.
What that *doesn't* confirm: that Vercel's own build step resolves the `api/` → `../src/` import
the same way when building the function for a real deploy, and that the project's runtime config
actually selects the classic `(req, res)` Node handler signature rather than a Web-standard one
(no `export const config = { runtime: "edge" }` is set, so it shouldn't — Edge Runtime requires
opting in — but this hasn't been confirmed against a real deploy). **After the first GitHub-triggered
deploy, repeat the `initialize`/`tools/call health` checks against `https://<the deployed
url>/mcp` before treating the deployment cutover (next-steps step 6) as done** — remember
`ELS_API_BASE_URL` must also be set in the Vercel project's environment variables, not just
locally, or that first deploy 500s.
