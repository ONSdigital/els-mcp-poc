# ELS MCP server — design notes

**Status: implemented.** This is the design record the TypeScript rewrite (`src/`, `api/`) was
built from — tool decisions, the reasoning behind each one, and the gaps traced against the old
Python proof-of-concept that motivated them. It's kept as architectural reference now that the
build exists, not a forward-looking plan: if you change how a tool works, **update this file so it
still matches `src/` — the same discipline CLAUDE.md follows for its own content, and for the same
reason** (a design doc that quietly drifts from the code is worse than no design doc). For what's
left to do — testing, refinement, improvement — see `docs/next-steps.md`; for a record of what the
original build actually did and verified, see `docs/build-history.md`.

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
| "Is Norwich's rate significantly different from Norfolk's?" | Confidence interval columns are already in the raw data when present; nothing surfaces or uses them. | Surface confidence intervals explicitly in data responses when present, and flag non-overlapping vs. overlapping intervals directly rather than leaving the interpretation entirely to the model. This is a property of every row `get_indicator_data` returns (see "Data" below), not tied to any one tool — it survived `compare_indicators_across_areas` being folded into `get_indicator_data` as the `pivot` param, since the row shape (and its CI field) is the same regardless of pivot. |
| "Tell me about Cornwall" | No "headline indicator set" concept — the model has to guess which handful of 110+ indicators constitute a sensible default profile, inconsistently, each time. | Add a curated default-indicators area-profile tool. |
| "Can I get this as a spreadsheet?" | The API now has clean single/multi-indicator XLSX/CSV endpoints; no tool bridges a conversational query into the equivalent download link. | Add a tool that takes the same query parameters already used and returns the matching download URL. |
| Any "all areas" / UK-wide query | The concrete, verified case: `employment-rate` and `employment-rate-ni` are two separate indicator slugs for essentially the same concept, split by country coverage (the GB one's own description notes "Northern Ireland national figure included," but Northern Ireland isn't broken down to local-authority level the way Great Britain is). Nothing tells the model a second, differently-named indicator might be relevant, or that a "UK-wide" result is quietly missing part of the UK. | General coverage-summary mechanism (below) — solves this without needing fragile indicator-name-pairing heuristics, and catches ordinary gaps (a year an authority didn't report, an indicator missing above/below a given level) the same way, not just the Northern Ireland case specifically. |

## Tool spec

### Geography

**`search_areas(query, levels?, limit?)`** — keep as-is; already reasonable. Tool description should
state plainly that "city" is not a geography level this API exposes (a ceremonial UK designation
with no corresponding level in the geography model) — a model asking for "cities" needs to know
that's unanswerable here, not silently get zero/wrong results.

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
coverage/dimensions, and the metadata endpoint's own `confidenceIntervals` boolean should be
passed straight through (not renamed or re-derived) — see "Data" below for why `get_indicator_data`
needs this same field.

**`list_topics()`** — keep as-is, and treat as the *primary* discovery path in tool descriptions
(browse by topic first, free-text search second) given how fragile keyword search is on its own.

### Data

**`get_indicator_data(indicators, areas?, geo_type?, geo_extent?, time?, dimensions?, pivot?,
download_format?)`** *(replaces `query_data`)* — the core data tool, and the **only** data tool
besides `rank_areas`/`rank_areas_by_change`/`get_area_profile`. Both `compare_indicators_across_areas`
and `get_download_link`, originally proposed as separate tools, turned out to be this same tool
with a different output framing — folded in here instead, per the "fewer tools, not more" principle
this doc leads with (an advisor review of this plan caught that the 12→17 tool count contradicted
that principle; see below).

- `indicators` is a list (fixes: no way to request an explicit set of named indicators together
  in the proof-of-concept — only one slug, or a topic filter).
- `dimensions` is an optional `{dimension: value}` map for breakdowns like age/sex on multivariate
  indicators (fixes: no way to filter by a dimension at all currently, despite the dimension keys
  being visible in metadata).
- `pivot` (optional, default `"indicator"`): `"indicator"` groups the response by indicator (the
  default, current shape); `"area"` pivots it to one row per area, one column per indicator —
  this *is* the former `compare_indicators_across_areas`, now just an output-orientation switch on
  the same fetch rather than a second tool the model has to know to reach for. **Each cell under
  `pivot: "area"` is `{ label, rows }`, not a bare row or a bare array** —
  - `rows` is an ARRAY, never a single row object: a multivariate indicator (e.g.
    population-by-age-and-sex, not narrowed by `dimensions`) or a multi-period `time` range both
    legitimately return more than one row for the same area/indicator, and an implementation that
    keeps "the row" (singular) per cell will silently keep only the last one seen with no error —
    this happened for real during the build (real-usage feedback from an LLM client, not a test
    here caught it: population-by-age-and-sex under `pivot: "area"` returned one arbitrary
    Male/85+ row per area, dropping the other 53). Always emitting an array — length 1 for the
    ordinary case — makes that shape impossible to misread as a single clean value; pair it with
    `indicatorsMeta[slug].isMultivariate`/`.hasTimeseries` (see `metadata` below) so a longer array
    isn't a surprise.
  - `label` is that indicator's human-readable name, duplicated at the cell **on top of** living
    in the shared top-level `indicatorsMeta` (below) — a second real-usage finding, distinct from
    the array one above: an agent given only slug-keyed cells (`"population-density": {...}`) and
    a separate `indicatorsMeta` block reported figures by slug ("population-density: 1555")
    rather than by label ("Population density: 1,555 people per km²"), because nothing at the
    point of consumption prompted it to look elsewhere for the citable name. `label` is cheap
    enough to repeat per cell; the rest of `metadata` (source/caveats/etc.) is not, and stays
    exclusively in `indicatorsMeta` — see the ATTRIBUTION note below.
- `download_format` (optional: `"csv"` | `"xlsx"`): when set, the response also includes a
  `downloadUrl` for the matching file — this *is* the former `get_download_link`, folded in
  because it always took "the same shape of parameters as `get_indicator_data`" per the original
  spec, so there was nothing left for a separate tool to do.
- Always calls the multi-indicator endpoint internally regardless of how many `indicators` were
  given — the single/multi split is invisible at this layer.
- **ATTRIBUTION is an explicit, imperative instruction in the tool description, not just a field
  that happens to exist** — the same pattern `coverage` already uses ("always check it..."), for
  the same reason: real usage showed that a field existing in the payload isn't enough on its own.
  An LLM client testing this tool made the call correctly, read `coverage` as instructed, but
  never looked at `indicatorsMeta` and reported figures by raw slug rather than by the indicator's
  actual name — its own diagnosis was that the docstring gave it a reason to check `coverage` and
  no equivalent reason to check `indicatorsMeta`. Fix: the description now states outright that
  every response carries `label`/`source`/`updated` per indicator and that a calling model must
  cite the `label` (never the slug) and the source/date when reporting a figure — worded as a
  requirement, not a passive mention that the field exists.
- Response shape: `{ coverage: {...}, indicators: { <slug>: { metadata: {...}, data: [...] } },
  downloadUrl? }` (or the area-pivoted equivalent when `pivot: "area"`).
  - `metadata` is **indicator-level, one per indicator, not per row**: `label`/`source`/`unit`/
    `caveats`/`updated` (when the underlying dataset was last refreshed), **`confidenceIntervals`**
    (boolean), **`isMultivariate`** and **`hasTimeseries`** (both booleans) — all pulled straight
    through from the metadata endpoint, which already exposes these exact fields, not inferred by
    sampling rows. All of it comes from the already-cached indicator catalogue, not a separate
    round trip. This answers "where did this number come from," "how current is the dataset as a
    whole," "does this indicator carry margins of error at all," and "should I expect more than
    one row per area/period for this indicator" up front, before any row is inspected — the last
    one exists specifically so `pivot: "area"`'s array-per-cell shape (above) is self-explanatory
    rather than something the calling model has to infer from row count alone.
  - `data` is the list of observation rows. Per `docs/api/data-formats.md` on the (still-unmerged,
    see caveat above) `api-improvements` branch, the underlying API's own field names are `areacd`,
    `areanm`, `period` (ISO 8601 interval, e.g. `"2023-01-01/P1Y"` for a one-year period — a range,
    not a single date, so don't collapse it to one), `value`, and — **only when
    `metadata.confidenceIntervals` is `true` for that indicator** — `lci_95`/`uci_95` for the 95%
    confidence bounds on every row. Confidence-interval presence is an **indicator-level** property,
    not a per-row one: it isn't something that can vary row to row within one indicator, so don't
    build any per-row "does this row happen to have CI" check — read `confidenceIntervals` off the
    indicator's own metadata once and branch on that. Pass the row fields through under their own
    names rather than inventing new ones (`ci: { lower, upper }` was this doc's placeholder before
    the field names were confirmed — use the real ones instead) — **re-confirm both the field names
    and the indicator-level-not-row-level behaviour against a live response during next-steps step
    1**, since this came from docs on an unmerged branch, not a verified call.
  - Because CI presence is known from `metadata.confidenceIntervals` before any data is fetched,
    the "flag non-overlapping intervals" behaviour is simple to gate correctly: when comparing two
    areas on an indicator where `confidenceIntervals` is `true`, compute and flag overlap; when
    it's `false`, say so explicitly (e.g. a `notes` string, or omit `lci_95`/`uci_95` from the row
    type entirely for that indicator) rather than silently saying nothing about it — a bare
    unmentioned comparison could misread as "measured, no notable difference" rather than "not
    measured at all." This applies equally under `pivot: "area"` — the pivoted shape doesn't get
    to drop period/CI just because indicators are now columns instead of an outer key.
  - The comparison only makes sense when there is **exactly one row per area** — two distinct
    area codes among a *larger* row set (a multivariate indicator, or `time` spanning more than
    one period) means there's no single well-defined pair of values to compare, and picking "the
    first row seen per area" would silently compare an arbitrary dimension/period slice rather
    than a deliberate one — the same class of bug as the `pivot: "area"` one above, and worth
    guarding against for the same reason. Skip the comparison with an explicit reason
    (`"N rows returned across 2 areas (expected 1 each)"`) in that case rather than guessing.
- **`coverage` shape** (needs to be settled here, not invented ad hoc per tool that returns it):
  ```json
  {
    "requested": { "indicators": ["employment-rate"], "areas": ["S12000036"], "countries": ["E","W","S","N"] },
    "returned":  { "indicators": ["employment-rate"], "areas": ["S12000036"], "countries": ["S"] },
    "missing":   [{ "type": "country", "value": "N", "reason": "not covered by employment-rate; try employment-rate-ni" }]
  }
  ```
  This is deliberately built around *what* is missing (a country, an area, a period) and *why*
  when known, not just a requested-vs-returned area count — a count alone wouldn't have surfaced
  the `employment-rate`/`employment-rate-ni` split that originally motivated this field (see
  "Gaps found," last row).
- The HTTP client wrapper (not each tool individually) is responsible for telling "no data" apart
  from an error: the ELS API returns `200` with an empty-shaped body for a request that resolves
  but matches nothing, so the wrapper's return type should make emptiness explicit (e.g.
  `{ rows, isEmpty }`) rather than leaving "check the array length" as a discipline every tool
  author has to remember. This is the same bug class already fixed once in the main ELS app's own
  frontend after this API change — worth not reintroducing it here by construction.
- **The indicator `metadata` block (`label`/`source`/`unit`/`caveats`/`updated`/
  `confidenceIntervals`/`isMultivariate`/`hasTimeseries`/`geography`) is built by ONE shared
  function, used by every data-returning tool** — `get_indicator_data`, `rank_areas`,
  `rank_areas_by_change`, and `get_area_profile` all return the exact same shape, not each
  tool's own partial subset. `rank_areas`/`rank_areas_by_change` originally returned only a bare
  `unit`/`label` pair, missing source/caveats/geography entirely — caught by real usage asking
  why a ranked result couldn't be cited the same way a `get_indicator_data` one could. The general
  principle this fixes: if a tool description tells a model to cite an indicator's `label` and
  `source` (see ATTRIBUTION above), every data-returning tool has to actually provide those
  fields in the same place, not just the one tool that happened to be built first.

**`rank_areas(indicator, geo_type, geo_extent?, time?, dimensions?, top_n?)`** *(replaces
`rank_areas_by_indicator`)* — returns **both ends** of the sorted list, not a `desc`/`asc`-selected
top N and not the full list either (a full sort of ~360 LTLAs with provenance attached is a large
payload for a tool called casually — the fix for the direction-guessing problem doesn't require
that much data). Response shape: `{ metadata: {...}, top: [...], bottom: [...], total_ranked: N,
direction_note }`, `top_n` (default e.g. 10) controlling how many of each end come back. `metadata`
is the same shared block `get_indicator_data` returns (see above) — this replaced an earlier bare
`unit`/`label` pair that real usage flagged as inconsistent with every other data tool. Removes
the failure mode where the model has to correctly guess ranking direction before calling — it can
read `metadata.unit`/`metadata.label` and `direction_note` in the same response and pick the
relevant end itself, rather than the tool silently returning the wrong end on a bad guess.

**`rank_areas_by_change(indicator, geo_type, geo_extent?, start_time, end_time, top_n?)`** *(new)* —
same response shape as `rank_areas` (top/bottom, `metadata`, not a full list), ranked by change
between two periods rather than a point value. This one earns being a separate tool from
`rank_areas`: it's a genuinely different computation (a delta between two fetches), not an
output-framing choice on the same fetch the way the two data-tool merges above were.

**`get_area_profile(area_code, indicators?)`** *(new)* — a curated default set of headline
indicators for one area, with an optional override list. One indicator per topic — population,
economy, housing, education and skills, health and wellbeing (three: obesity, life satisfaction,
healthy life expectancy split by sex), environment, connectivity (`AREA_HEADLINE_INDICATORS` in
`src/tools/data.ts`) — not an arbitrary sample, each slug confirmed against the live catalogue
before landing there. Gives "tell me about X" a consistent, cheap answer instead of ad hoc
guessing across 110+ indicators each time. Response shape mirrors
`get_indicator_data`'s indicator-grouped shape: each requested indicator gets its own
`{ metadata: {...}, data: [...] }`.

**`health()`** — keep as-is.

**Retire `compare_indicator`.** Its country-coverage-warning logic becomes redundant once
`coverage` is a standard part of every data response rather than a bespoke feature of one tool —
and its "resolve two place names, fetch, compare" pattern is just `get_indicator_data` (with
`pivot: "area"` for more than one area) plus `resolve_area`, composed by the model rather than
hard-coded as its own tool. One fewer overlapping tool for the model to choose between.

## Net tool count

12 → 14: `search_areas`, `resolve_area`, `get_area_details`, `get_related_areas`,
`get_nearby_areas` (new), `list_geo_levels`, `lookup_area` (new), `search_indicators`,
`get_indicator_metadata`, `list_topics`, `get_indicator_data` (replaces `query_data`; absorbs the
originally-proposed `compare_indicators_across_areas` and `get_download_link` as parameters —
see "Data" above), `rank_areas` (replaces `rank_areas_by_indicator`), `rank_areas_by_change`
(new), `get_area_profile` (new), `health`.

Four additions (`get_nearby_areas`, `lookup_area`, `rank_areas_by_change`, `get_area_profile`),
one retirement (`compare_indicator`), two renamed/reworked in place, two originally-proposed new
tools absorbed as parameters on `get_indicator_data` rather than built. This growth closes a real
gap traced against a concrete prompt above, not speculative coverage, and now actually holds to
the "fewer tools, not more" principle this doc opens with — worth re-checking against real usage
once built rather than treating this count as final.
