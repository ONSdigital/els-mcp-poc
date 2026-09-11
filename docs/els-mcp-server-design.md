# ELS MCP server — design notes

Distilled from a design conversation held alongside a documentation/correctness pass on the
Explore Local Statistics (ELS) API itself. This is **not** a copy of that API documentation —
it's the MCP-layer-specific knowledge that doesn't exist anywhere else: tool design decisions,
the gaps found by tracing real example prompts against the existing proof-of-concept
(`ONSdigital/els-mcp-poc`), and why each fix is shaped the way it is.

## Source of truth for API behaviour

**Don't duplicate this here.** `docs/api/` in `ONSdigital/explore-local-statistics-app`
(`README.md`, `data-endpoint.md`, `data-item-endpoint.md`, `data-formats.md`,
`geo-hierarchy.md`, `geo-search.md`, `geo-boundaries.md`, `metadata-endpoint.md`, and
`important-notes.md` for the sharp edges) is the maintained, continuously-verified reference for
every endpoint, parameter, response shape and error condition. Link to it, don't copy it — most
of its content (case-insensitivity, which `geoLevel` set applies to which route, parameter
validation rules) is exactly what a well-built tool layer should *absorb into code* so the
calling model never needs to know it was ever a concern.

**Caveat as of writing:** that documentation (and the API redesign it describes — see next
section) exists as uncommitted changes on the `api-improvements` branch of that repo. Confirm
it's been merged before treating links to it as stable.

## What changed in the API underneath this MCP server

The proof-of-concept was built against the *old* API shape. Three changes since then affect how
tools should be built now, not just how they were:

1. **The data endpoint split into two**: `/api/v1/data.{format}` (always returns data grouped by
   indicator, however many matched) and `/api/v1/data/{indicator}.{format}` (one named indicator,
   returned directly, no grouping). Previously this was one endpoint whose response shape
   depended on incidental match count — genuinely ambiguous to build against. The proof-of-concept
   already worked around the old ambiguity well (`query_data` always returns `{slug: [rows]}`
   regardless of count) — that principle should carry forward, just now backed by an API that
   actually guarantees it rather than a client-side workaround.
2. **Empty results are `200` now, not `400`.** A request that resolves fine but matches no
   observations returns a valid, empty-shaped response, not an error. Any code that used to catch
   "no data" via an HTTP error status needs to check for emptiness in the response body instead.
3. **`hasGeo=any` is the "no filter" value everywhere now** (previously inconsistent between
   endpoints) — only relevant if a tool ever exposes `hasGeo` directly, which the recommendations
   below deliberately avoid (see "Design principles," `hasGeo` note).

## Design principles

Principles first, because they explain *why* the tool list below looks the way it does, not just
what it contains.

- **Task-shaped tools, not a REST mirror.** The API has ~18 routes; the tool surface below has
  fewer, because tool selection is itself a place an LLM can go wrong — two tools that can each
  plausibly answer the same question is worse than one tool with a parameter. Where the
  proof-of-concept already did this well (`query_data` as one general-purpose data tool rather
  than N per-shape variants), keep it. Where it didn't (`query_data` /
  `rank_areas_by_indicator` / `compare_indicator` all wrapping the same underlying call with
  different framing, `search_areas` / `resolve_area` overlapping similarly), consolidate.
- **The tool layer absorbs the API's sharp edges; the model never sees them.** Don't expose
  `hasGeo` (three different value-kinds, a different "no filter" sentinel than most other
  parameters, genuinely hard to explain correctly in a tool description) as a primary parameter.
  Don't expose the single/multi-indicator endpoint split as a corresponding split in the tool
  surface — always call the multi-indicator endpoint internally (it's correct and fast for one
  indicator too now), and let a tool's own `indicators` parameter simply take one-or-many.
- **Never let an incomplete result look like a complete one.** This was the single biggest theme
  across every traced example prompt (see below) — surface *coverage* (what was asked for vs.
  what came back), not just whatever data happened to come back.
- **Push cross-indicator computation into code, not into the model's context.** Comparing or
  joining more than one indicator across more than a handful of areas is exactly the kind of
  exhaustive, numeric, easy-to-silently-get-wrong task LLMs are weak at doing reliably in-context.
  If a prompt needs a join, the tool should do the join.
- **Attach provenance to every data response, not just to a separate metadata call.** A model
  answering from `query_data` alone currently has no source, caveats, or units unless it
  separately called `get_indicator_metadata` — cheap to fix (the indicator catalogue is already
  cached in-process) and matters a lot for a statistics agency's chatbot specifically.

## Gaps found by tracing example prompts against the proof-of-concept

Each of these traces led to a specific tool-design decision below — noted inline.

| Example prompt | What breaks | Fix |
| --- | --- | --- |
| "Which local authority in Wales has the fastest internet?" | `search_indicators("internet")` may return nothing — naive substring match against label/subtitle/description, no synonyms or stemming. "Fastest" assumes a ranking direction the model has to infer correctly with no help. | Improve indicator search (word-overlap scoring, not substring); push `list_topics` browsing as the primary discovery path; ranking tool returns both ends of the sorted list rather than requiring the caller to correctly guess direction up front. |
| "Which cities in the UK have a young, educated population and unemployment?" | No "city" concept exists anywhere in the geography model (a ceremonial UK designation, unrelated to any exposed level) — unfixable at the tool layer, worth just documenting as a known limitation. Needs three indicators joined by area; nothing does that join. | Document the "city" gap plainly in the relevant tool's description so the model doesn't assume it's possible. Build a cross-indicator table/pivot tool (below). |
| "Comparison between local authorities in the North East across economic indicators" | Best-supported by the existing design (topic + geo_type/geo_extent bounding already works) — but the response is grouped by indicator, not by area, so the model has to reconstruct the requested area-by-area table itself. | Same pivot tool as above. |
| "How has unemployment in Manchester changed since 2010?" / "which areas grew fastest?" | Single-area trends are fine; ranking by *rate of change* across many areas has no tool — same in-context-join problem as multi-indicator comparison, just along the time axis. | Add a rank-by-change tool alongside rank-by-value. |
| "What's it like where I live, NR2 1AA?" | No postcode or coordinate lookup exposed at all, despite the underlying API having both. Not a routing failure — completely unanswerable. | Add postcode/coordinate → area lookup tool(s). |
| "Compare Norwich to nearby areas" | Three different, conflated notions of "related": administrative siblings, statistical similarity, and geographic proximity — only the first two are exposed, neither is genuine "nearby." | Either add real distance-based nearby lookup (derivable from area centroids already in the data) or make the existing tool's documentation explicit that "siblings"/"similar" are not spatial proximity, so the model doesn't default to the wrong one silently. |
| "What's the unemployment rate in Poole?" (pre-2019, now merged into a different authority) | Area search is hard-wired to "latest," even though the underlying API supports year-aware lookup — a historical name may resolve to nothing, or silently the wrong thing, with no signal either way. | Expose a year/`as_of` parameter on area search, defaulting to latest but allowing historical lookups. |
| "Female employment rate in Norwich vs. male" | Worse than a clean failure: the model gets an answer (the unbroken-down overall rate) and may present it as if it answered the sex-specific question, since nothing flags that a breakdown was possible. Dimension keys are visible in indicator metadata, but there's no way to filter by them. | Add dimension filtering to the core data tool. |
| "Is Norwich's rate significantly different from Norfolk's?" | Confidence interval columns are already in the raw data when present; nothing surfaces or uses them. | Surface confidence intervals explicitly in data responses when present, and consider flagging non-overlapping vs. overlapping intervals directly rather than leaving the interpretation entirely to the model. |
| "Tell me about Cornwall" | No "headline indicator set" concept — the model has to guess which handful of 110+ indicators constitute a sensible default profile, inconsistently, each time. | Add a curated default-indicators area-profile tool. |
| "Can I get this as a spreadsheet?" | The API now has clean single/multi-indicator XLSX/CSV endpoints; no tool bridges a conversational query into the equivalent download link. | Add a tool that takes the same query parameters already used and returns the matching download URL. |
| Any "all areas" / UK-wide query | The concrete, verified case: `employment-rate` and `employment-rate-ni` are two separate indicator slugs for essentially the same concept, split by country coverage (the GB one's own description notes "Northern Ireland national figure included," but Northern Ireland isn't broken down to local-authority level the way Great Britain is). Nothing tells the model a second, differently-named indicator might be relevant, or that a "UK-wide" result is quietly missing part of the UK. | General coverage-summary mechanism (below) — solves this without needing fragile indicator-name-pairing heuristics, and catches ordinary gaps (a year an authority didn't report, an indicator missing above/below a given level) the same way, not just the Northern Ireland case specifically. |

## Tool spec

### Geography

**`search_areas(query, levels?, limit?)`** — keep as-is; already reasonable.

**`resolve_area(query, levels?, as_of_year?)`** — keep, add `as_of_year` (default latest) so a
historical/pre-reorganisation name can still resolve, with the result flagging when a match was
found only at a non-latest year.

**`get_area_details(area_code)`** — keep as-is.

**`get_related_areas(area_code, relation, geo_type?)`** — keep, but sharpen the tool description
so `parents`/`children`/`siblings` are unambiguously "administrative hierarchy" and `similar` is
unambiguously "statistical similarity, not geography" — neither should read as "nearby."

**`get_nearby_areas(area_code, count?)`** *(new)* — genuine spatial proximity, computed from the
centroids already present in area lookups. Closes the "nearby" gap directly rather than relying
on a model correctly avoiding `siblings`/`similar` for this purpose.

**`list_geo_levels()`** — keep as-is.

**`lookup_area(postcode?, lat?, lng?)`** *(new)* — one location-lookup tool accepting either a
postcode or coordinates (mirrors the two lookup mechanisms the underlying API already has).
Closes the "what's it like where I live" gap.

### Metadata

**`search_indicators(query, limit?)`** — keep the shape, fix the matching: word-overlap/token
scoring against label + subtitle + description rather than raw substring matching, so a query
like "internet" has a real chance of matching an indicator titled "broadband." When it returns
nothing, say so explicitly and suggest `list_topics` as a fallback, rather than returning a
silent empty list.

**`get_indicator_metadata(slug)`** — keep as-is; already returns source/caveats/geography
coverage/dimensions.

**`list_topics()`** — keep as-is, and treat as the *primary* discovery path in tool descriptions
(browse by topic first, free-text search second) given how fragile keyword search is on its own.

### Data

**`get_indicator_data(indicators, areas?, geo_type?, geo_extent?, time?, dimensions?)`**
*(replaces `query_data`)* — the core data tool.

- `indicators` is a list (fixes: no way to request an explicit set of named indicators together
  in the proof-of-concept — only one slug, or a topic filter).
- `dimensions` is an optional `{dimension: value}` map for breakdowns like age/sex on multivariate
  indicators (fixes: no way to filter by a dimension at all currently, despite the dimension keys
  being visible in metadata).
- Always calls the multi-indicator endpoint internally regardless of how many `indicators` were
  given — the single/multi split is invisible at this layer.
- Response shape: `{ coverage: {...}, indicators: { <slug>: { metadata: {...}, data: [...] } } }`
  — `coverage` states what was requested vs. what actually came back (area count requested vs.
  returned, per indicator); `metadata` is `label`/`source`/`unit`/`caveats`/`updated`, pulled from
  the already-cached indicator catalogue, not a separate round trip.

**`compare_indicators_across_areas(indicators, areas | geo_type + geo_extent, time?)`** *(new)* —
the pivot tool: one row per area, one column per indicator, built server-side. Directly answers
"compare these local authorities across these indicators" without asking the model to reconstruct
the table from an indicator-grouped response itself. Same `coverage` block as above.

**`rank_areas(indicator, geo_type, geo_extent?, time?, dimensions?)`** *(replaces
`rank_areas_by_indicator`)* — returns the **full** sorted list (or explicitly both the top and
bottom N), not just a `desc`/`asc`-selected top N. Removes the failure mode where the model has
to correctly guess ranking direction before calling — it can read the indicator's own unit/label
in the same response and pick the relevant end itself, rather than the tool silently returning
the wrong end on a bad guess.

**`rank_areas_by_change(indicator, geo_type, geo_extent?, start_time, end_time)`** *(new)* —
same shape as `rank_areas`, ranked by change between two periods rather than a point value.
Closes the "fastest-growing" gap.

**`get_area_profile(area_code, indicators?)`** *(new)* — a curated default set of headline
indicators (population, median age, employment rate, and a small fixed list beyond that) for one
area, with an optional override list. Gives "tell me about X" a consistent, cheap answer instead
of ad hoc guessing across 110+ indicators each time.

**`get_download_link(indicators, areas?, geo_type?, geo_extent?, time?, format)`** *(new)* —
takes the same shape of parameters as `get_indicator_data` and returns the matching XLSX/CSV
download URL, so a conversational exploration can end with "here's the file."

**`health()`** — keep as-is.

**Retire `compare_indicator`.** Its country-coverage-warning logic becomes redundant once
`coverage` is a standard part of every data response rather than a bespoke feature of one tool —
and its "resolve two place names, fetch, compare" pattern is just `get_indicator_data` or
`compare_indicators_across_areas` plus `resolve_area`, composed by the model rather than
hard-coded as its own tool. One fewer overlapping tool for the model to choose between.

## Net tool count

12 → 17: `search_areas`, `resolve_area`, `get_area_details`, `get_related_areas`,
`get_nearby_areas` (new), `list_geo_levels`, `lookup_area` (new), `search_indicators`,
`get_indicator_metadata`, `list_topics`, `get_indicator_data` (replaces `query_data`),
`compare_indicators_across_areas` (new), `rank_areas` (replaces `rank_areas_by_indicator`),
`rank_areas_by_change` (new), `get_area_profile` (new), `get_download_link` (new), `health`.
Six additions, one retirement (`compare_indicator`), two renamed/reworked in place. Most of the
growth closes a real gap traced against a concrete prompt above, not speculative coverage — worth
re-checking against real usage once built rather than treating this count as final.
