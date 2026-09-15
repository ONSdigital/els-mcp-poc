# ELS MCP server — next steps

**Status: the rebuild is complete.** All 14 tools + `health` are built, registered, and have each
been checked against the live `api-improvements` preview API at least once (see
`docs/build-history.md`). This document is what's actually left: testing the built server more
rigorously than the ad hoc real-usage rounds that shaped it so far, refining what those rounds
already found needs refining, and improving on decisions that were reasonable at build time but
are now worth revisiting with the whole system in front of you instead of one tool at a time.

Read `docs/design.md` for why a tool works the way it does, and `docs/build-history.md` for what
was actually done and verified during the build — this document doesn't repeat either.

## Testing

### 1. Run the original example-prompt eval as one real pass, not in pieces

`docs/build-history.md` §5 lists eleven example prompts this rewrite was designed against, meant
to be run end-to-end through a connected LLM client. That never happened as a single, deliberate
pass — instead, real feedback arrived organically across several rounds of ad hoc testing after
the build, which is how every entry in CLAUDE.md's "Bugs caught by real usage" was found. That's
a real result, but it's not the same as actually working through the original list — some of
those eleven prompts may never have been tried. Do that pass properly: connect a client, ask each
prompt, and check both *which tool gets picked* and *whether the final answer is right*, not just
whether a tool call succeeded.

### 2. Add regression prompts for every bug already found, so they can't come back quietly

The original eleven prompts predate the build; they don't specifically probe the failure modes
that turned out to matter. Add prompts that would have caught each one on day one, and re-run
them after any change to the affected code:

- **Multivariate + `pivot: "area"`**: "Compare the age and sex breakdown of the population in
  Norwich and Broadland" — checks that `pivotByArea` still returns every row per cell, not just
  the last one (the original bug: see CLAUDE.md).
- **A multi-period `time` range under either `pivot` value**: "How has employment changed in
  Manchester from 2018 to 2023?" — same underlying risk, different trigger (a time series instead
  of a dimension breakdown).
- **A genuine CI comparison**: "Is the employment rate significantly different between Norwich and
  Norfolk?" — checks `buildComparisonNote` actually computes overlap, not just that it returns
  something.
- **A CI comparison on a non-CI indicator**: same question, but for an indicator with
  `confidenceIntervals: false` — checks the response says so explicitly rather than silently
  saying nothing (which reads as "no difference," not "not measured").
- **A genuine coverage gap**: "What's the employment rate in Belfast?" — Belfast is a Northern
  Ireland LTLA that `employment-rate` doesn't cover at local-authority level despite nominally
  listing `N` as a covered country; checks `coverage.missing` actually explains the gap rather
  than the model presenting an empty result as "no employment in Belfast."
- **Attribution, unprompted**: ask for a single figure from each of the four data tools
  (`get_indicator_data` under both `pivot` values, `rank_areas`, `rank_areas_by_change`,
  `get_area_profile`) and check the answer cites the indicator's `label` and `source`/`updated`
  without being told to. This is a response-*quality* check, not a data-correctness one — the
  JSON can be perfectly correct and still not get used properly (see CLAUDE.md's "Bugs caught by
  real usage" for the two separate times this happened).
- **A "city" question**: "Which UK cities have the youngest population?" — checks `search_areas`'s
  description actually stops the model from treating a ceremonial city as a resolvable geography
  level, rather than silently returning nothing or the wrong area.
- **`get_nearby_areas` at a wide scope**: ask for areas near somewhere in a large, cauth-less
  region (e.g. a rural area with no combined authority) to exercise the parent-fallback logic and
  the 200-candidate cap — confirm the `note` field actually appears if the cap bites, rather than
  silently returning a wrong-but-plausible-looking "nearest" list.

### 3. `download_format` has never actually been exercised

`get_indicator_data`'s `download_format` param builds a CSV/XLSX URL (`buildDownloadUrl` in
`src/tools/data.ts`) but that URL has not been fetched and checked during this build — only the
`.rows.json` path has real verification behind it. Confirm the built URL actually resolves to a
working file for at least one CSV and one XLSX case, with the same params as the JSON call that
produced it, before trusting a model that says "here's the download link" to a user.

### 4. Re-confirm the Vercel deploy path after the platform-collision fix

The first two real Vercel deploys both failed, neither for anything this document originally
anticipated (the env var, the handler signature) — both from Vercel's zero-config Express/Node
detection colliding with this project's file layout, in two stages: first `src/server.ts` got
grabbed as a bogus entrypoint (renamed to `src/mcp-server.ts`), then removing that file exposed
that the project had already been detected as a zero-config Node/Express app at the project level
and needed `"framework": null` in `vercel.json` to actually force "Other" (see CLAUDE.md's
"Vercel platform gotchas" for the full story). Both are fixed, but **neither fix has been
re-verified against an actual successful deploy yet** — do that next: push, let it build, then
repeat the `initialize` + `tools/call health` check against the real
`https://<deployed-url>/mcp` endpoint. Remember `ELS_API_BASE_URL` has to be set in the Vercel
project's environment variables too, not just `.env` locally, or the deploy 500s at startup for an
unrelated reason (see `src/config.ts`) — both failure modes produce the same generic
`FUNCTION_INVOCATION_FAILED` page, so the real Function Logs are the only way to tell them apart
if this happens again.

### 5. Test with more than one model/client

Two different LLM clients testing this server caught two genuinely different classes of problem —
one found a data-correctness bug (silent row-dropping), the other found a response-*usability*
gap (missing attribution) that the first one's testing never surfaced. That's not a coincidence to
route around; it's a reason to keep testing with more than one model going forward, since
different models attend to tool descriptions differently and a docstring that works for one may
still under-instruct another.

### 6. Consider a small automated regression suite

`vitest` is already an installed devDependency and currently unused (`npm run test` has nothing to
run). None of the verification so far is automated — every check has been a manual `curl` or a
live LLM tool call, re-run by hand whenever something changes. A handful of recorded-fixture tests
covering the cases already known to be fragile (multivariate `pivot: "area"`, a genuine coverage
gap, a CI comparison, the geo-level-key casing rule) would catch a regression on the next code
change without needing a human or an LLM to notice. This doesn't replace live verification — the
live API is still the source of truth, and a fixture can drift from it — but it closes the gap
where a refactor silently reintroduces something already fixed once.

## Refining

### 7. Audit every tool description for the same "field exists, no instruction" pattern

Three separate times during and after the build, a tool returned genuinely correct data that
still didn't get used properly, because nothing in the description told a model to use it that
way (see CLAUDE.md's "Bugs caught by real usage" — `coverage` worked because it says "always
check it"; `indicatorsMeta`, then the ranking tools' metadata, didn't, until each was fixed in
turn). That fix has now been applied to the four data tools. It has **not** been deliberately
checked against the other eleven tools (geography + metadata) — go through each one and ask: does
every field in the response that a model needs to *act on* (not just read) have an explicit
instruction telling it to? `get_related_areas`' `similar`-vs-`nearby` distinction and
`search_areas`' "no city concept" note are two that already got this treatment during the build;
the rest haven't been deliberately re-checked since.

### 8. Look for the same "assumes one X per Y" bug class elsewhere

The `pivot: "area"` data-loss bug and the `buildComparisonNote` bug were both instances of code
assuming exactly one row per (area, indicator) when the API doesn't guarantee that. Nothing else
in the codebase has been deliberately audited for the same shape of assumption. `get_nearby_areas`
is the next most likely candidate — it assumes a parent's `children` list at a given `geoLevel` is
a reasonable, non-huge candidate set, which is true for the cases tested (a region's LTLAs) but
unverified for every geo_type/parent combination the tool actually accepts.

### 9. Re-verify the multi-dimension-filter API limitation periodically

Filtering `get_indicator_data` by more than one `dimension_{code}` at once currently returns zero
rows — confirmed as a live API limitation, not a bug in this codebase (see CLAUDE.md). This is
exactly the kind of thing that could get fixed upstream without any signal here. Periodically
re-run the two-dimension-filter case from `docs/build-history.md` §4 and drop the workaround
caveat from `get_indicator_data`'s description once it's confirmed fixed.

### 10. Re-confirm field names and behaviour once `api-improvements` merges

Several details in `src/types.ts` and the design doc (`period`'s ISO-interval format, the
`lci_95`/`uci_95` field names, `confidenceIntervals` appearing on the list endpoint) were sourced
from `docs/api/data-formats.md` on the still-unmerged `api-improvements` branch, then separately
confirmed against live `curl` responses during the build — so they're verified against the
*preview*, not necessarily final. Once that branch merges (see CLAUDE.md's caveat — still 404 on
`main` as of the last check), re-verify against the merged docs and repoint `ELS_API_BASE_URL` at
production, then re-run the full verification pass in `docs/build-history.md` §4, since a preview
and production can drift.

### 11. Watch tool description length as more instructions get added

`get_indicator_data`'s description has grown with each fix — CHOOSING, pivot, ATTRIBUTION, and
the bulk-guard error text are all in there now. Each addition was individually justified (a real
gap, a real instruction that changed behaviour), but the tool-list payload every client pays on
`tools/list` grows with it. If more instructions keep landing here, consider moving some detail
out of the static description and into the response itself (a `note` field a model reads only
when relevant) rather than lengthening the docstring indefinitely — the same tension the "light
version of #2" reasoning behind the `pivot: "area"` label duplication already weighed once.

## Improving

### 12. Client-side workaround for the multi-dimension-filter limitation, if it doesn't get fixed

If §9 keeps confirming the limitation is still live months from now, consider a client-side
workaround in `fetchDataRows`: issue one request per requested dimension value and merge results,
rather than relying on the API to filter by more than one dimension at once. This multiplies
request count, so it's worth only if the limitation turns out to be long-lived rather than a
transient bug.

### 13. A bulk area/centroid lookup, if the API ever adds one

`get_nearby_areas` currently does up to ~200 sequential `/geo/lookup` calls per invocation to get
candidate centroids, because there's no bulk endpoint for "give me these N areas' centroids in one
call." If `docs/api/` ever documents one, switch to it — it would remove both the latency cost and
the 200-candidate cap (§8) in one change.

### 14. A lint or test that checks tool descriptions for the attribution pattern

Given the same instruction gap has now been fixed independently three times (§7), a cheap
guardrail worth considering: a small script or vitest case that checks every data-returning tool's
description contains something like "cite" + "label" + "source" — not a full behavioural test, just
a trip-wire so a new data tool can't ship without at least the same instruction the others already
learned to need.
