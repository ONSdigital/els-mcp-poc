# ELS MCP server — implementation checklist

**Status: steps 1-4 are done** — the Node/TypeScript scaffold exists, all 14 tools + `health` are
built and registered, and each has been exercised at least once against the live
`api-improvements` preview API per the verification discipline in step 4 (see CLAUDE.md's "Sharp
edges discovered live" for what that verification actually caught). Steps 5-6 (a real end-to-end
LLM client eval, deployment cutover) are still outstanding.

Practical next steps for building the redesigned MCP server. Companion to
`els-mcp-server-design.md` (the tool spec and the reasoning behind it) — this document is the
"what to actually do" checklist; that one is the "what to build and why."

## 1. Repo decision

Given the Python → Node switch, almost every file changes regardless of which repo is used —
`app.py`, `api/index.py`, `requirements.txt`, `runtime.txt` all go, and `vercel.json` needs
rewriting for a Node runtime. So the "keep vs. new repo" choice mostly comes down to whether to
keep `els-mcp-poc`'s history, stars, and existing Vercel project linkage.

**Recommendation:** reuse the same repo (clear it out on a branch, or just replace file-by-file on
`main`) rather than start fresh elsewhere — there's no real cost to keeping it and it avoids
re-doing the Vercel project setup from scratch.

## 2. Scaffold the Node project

- `@modelcontextprotocol/sdk` (the TypeScript SDK), same Streamable HTTP transport already in use.
- TypeScript + a bundler/runner suited to Vercel's Node functions (`explore-local-statistics-app`
  already uses the Vercel + TypeScript combination, so there's a working reference for that part
  of the stack specifically).
- No ASGI compat shim needed this time — that whole problem (`_VercelRouteCompat` in the old
  `api/index.py`) was Python-runtime-specific and doesn't recur on Node.
- **API base URL as an env var from the first commit** (`ELS_API_BASE_URL`), not a hardcoded
  constant like the Python version's `BASE_URL`. For now this points at a Vercel branch preview of
  `api-improvements` (`https://local-statistics-git-api-improvements-ons-visual.vercel.app/api/v1`
  — see CLAUDE.md), which moves or disappears with that branch; swapping to the production URL
  once it merges should be a one-line config change, not a code edit.
- `els-mcp-server-design.md` and `els-mcp-server-next-steps.md` already live in this repo under
  `docs/` — no copying needed. Once `docs/api/` is actually merged in
  `explore-local-statistics-app`, update the links in the design doc and remove its "not yet
  merged" caveat.

## 3. Build order

Bottom-up, since later tools depend on earlier ones resolving names to codes/slugs:

1. `health`, `list_geo_levels`, `list_topics` — no dependencies, easiest to verify, confirms the
   transport/deployment plumbing works end to end first. This is also the cheapest point to
   confirm the `api-improvements` preview URL is actually up and that its response shapes match
   `docs/api/` — do this before writing any other tool, since everything downstream assumes both.
2. `search_areas` / `resolve_area` / `lookup_area` (postcode/coordinate) — area resolution,
   needed by nearly everything downstream.
3. `search_indicators` / `get_indicator_metadata` — indicator resolution, same reasoning. This is
   also where the search-quality fix (word-overlap scoring instead of substring matching) belongs
   — worth getting right early since it's upstream of most other tools' reliability.
4. `get_area_details`, `get_related_areas`, `get_nearby_areas` — geography detail, no
   data-endpoint dependency.
5. `get_indicator_data` — the core data tool, including its `pivot` and `download_format` options
   (the former `compare_indicators_across_areas` and `get_download_link` tools — see design doc's
   "Data" section for why these ended up as parameters, not separate tools); everything else in
   this group builds on it.
6. `rank_areas`, `rank_areas_by_change`, `get_area_profile` — the compound/derived tools, built on
   top of 5.

## 4. Verify each tool against the live API

Same discipline as the underlying API documentation/correctness work: for each tool, a handful of
real calls against the live ELS API (not mocked), checked by hand, before moving to the next one.
Given the specific failure modes already found, each tool's verification should specifically
include:

- A populated case and a genuinely empty case (confirm the empty case is handled as "no data,"
  not as an error — this is the exact bug class just fixed in the main app's own frontend, worth
  checking for here too).
- For `get_indicator_data` (both `pivot` values): a case where coverage is genuinely incomplete
  (e.g. a Great-Britain-only indicator requested across UK-wide areas), confirming the `coverage`
  field actually reflects the gap using the shape specified in the design doc (requested/returned/
  missing, not just an area count).
- For `get_indicator_data`: confirm `metadata.source`/`updated` come through per indicator, and
  that each row's `period` (ISO 8601 interval, e.g. `"2023-01-01/P1Y"`) round-trips from the live
  API with that exact field name — the design doc sourced these from `docs/api/data-formats.md`
  on the unmerged `api-improvements` branch, not a verified live call, so this is the first real
  check of whether that's accurate. Check this under `pivot: "area"` too, not just the default
  indicator-grouped shape.
- For `get_indicator_data` with `pivot: "area"`: a case using a **multivariate** indicator (e.g.
  `population-by-age-and-sex`) without narrowing `dimensions`, and a case with `time` spanning
  more than one period — confirm every row survives (each cell an array of the expected length,
  e.g. sex-count × age-band-count for the multivariate case) rather than silently keeping only
  one. This is not a hypothetical: an earlier version of `pivotByArea` kept only the last row
  seen per (area, indicator) with no error, caught by real usage rather than by this checklist
  (see CLAUDE.md's "Bugs caught by real usage"). Any future change to `pivotByArea` or
  `buildComparisonNote` needs this case re-run, not just the single-row cases above.
- Not just data correctness — check the response is actually *usable* the way a calling model
  will use it: ask an LLM client to report a figure from a `get_indicator_data` call (both
  `pivot` values) and confirm it cites the indicator's `label` (not the raw slug) and a
  source/date, without being told to. This caught a real gap once already (label buried in a
  separate `indicatorsMeta` block under `pivot: "area"`, and no instruction anywhere telling a
  model to use it) that no amount of checking the JSON shape by hand would have caught — the data
  was correct, it just wasn't being read.
- Confidence intervals need **two** cases, not one, since `confidenceIntervals` is a per-indicator
  property (the metadata endpoint already exposes it as a boolean — not something to infer by
  sampling rows): (a) an indicator with `confidenceIntervals: true`, confirming `lci_95`/`uci_95`
  actually round-trip on every row and the non-overlap flagging fires when comparing two areas;
  (b) an indicator with `confidenceIntervals: false`, confirming the response says so explicitly
  rather than silently omitting any comment about it — a silent omission would misread as
  "measured and no difference" instead of "not measured at all." Also confirm
  `get_indicator_metadata` surfaces `confidenceIntervals` correctly for both cases, since
  `get_indicator_data`'s own gating depends on reading it from there rather than checking rows.
- For `rank_areas`: confirm the `top`/`bottom` response actually gives both ends (not just one
  `desc`/`asc`-selected end) so a bad direction-guess doesn't silently return the wrong answer.
- Verification against the `api-improvements` preview URL has a shelf life: once that branch
  merges and `ELS_API_BASE_URL` is repointed at production, re-run the populated/empty/coverage
  checks for any tool verified beforehand — a preview and production can drift.

## 5. Re-run the example prompts as an actual eval, not just a thought experiment

Once enough tools exist, connect a real LLM client (Claude Desktop, same as the existing README's
instructions) and literally ask it the traced example prompts:

- "Which local authority in Wales has the fastest internet?"
- "Which cities in the UK have a young, educated population and unemployment?"
- "Show me a comparison between local authorities in the North East across economic indicators."
- "How has unemployment in Manchester changed since 2010?" / "which areas grew fastest?"
- "What's it like where I live, NR2 1AA?"
- "Compare Norwich to nearby areas."
- "What's the unemployment rate in Poole?" (pre-2019 authority name)
- "Female employment rate in Norwich vs. male."
- "Is Norwich's rate significantly different from Norfolk's?"
- "Tell me about Cornwall."
- "Can I get this as a spreadsheet?"

Check both *which tools the model reaches for* and *whether the answer is actually right*, not
just whether a tool call succeeded. This is the step most likely to surface a gap the design
missed, the same way tracing these prompts against the old proof-of-concept surfaced gaps the
original tool list alone didn't reveal.

## 6. Deployment cutover

- Update the Vercel project's runtime settings for Node (or just let Vercel auto-detect, same as
  it did for Python).
- Update the README's local-run and Claude Desktop / connector setup instructions for the new
  stack (the `mcp-remote` bridge command should be unaffected, since it's transport-level, not
  language-level).
- Decide what happens to the Python implementation — keep it on a branch or tag rather than
  delete outright, in case anything about the old behaviour needs cross-checking mid-rewrite.
