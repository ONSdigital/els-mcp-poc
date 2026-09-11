# ELS MCP server — implementation checklist

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
- Drop `els-mcp-server-design.md` into the new repo now, e.g. as `docs/design.md`, so it travels
  with the code from the start rather than living only on the Desktop. Once `docs/api/` is
  actually merged in `explore-local-statistics-app`, update the link in that doc and remove the
  "not yet merged" caveat.

## 3. Build order

Bottom-up, since later tools depend on earlier ones resolving names to codes/slugs:

1. `health`, `list_geo_levels`, `list_topics` — no dependencies, easiest to verify, confirms the
   transport/deployment plumbing works end to end first.
2. `search_areas` / `resolve_area` / `lookup_area` (postcode/coordinate) — area resolution,
   needed by nearly everything downstream.
3. `search_indicators` / `get_indicator_metadata` — indicator resolution, same reasoning. This is
   also where the search-quality fix (word-overlap scoring instead of substring matching) belongs
   — worth getting right early since it's upstream of most other tools' reliability.
4. `get_area_details`, `get_related_areas`, `get_nearby_areas` — geography detail, no
   data-endpoint dependency.
5. `get_indicator_data` — the core data tool; everything else in this group builds on it.
6. `compare_indicators_across_areas`, `rank_areas`, `rank_areas_by_change`, `get_area_profile`,
   `get_download_link` — the compound/derived tools, built on top of 5.

## 4. Verify each tool against the live API

Same discipline as the underlying API documentation/correctness work: for each tool, a handful of
real calls against the live ELS API (not mocked), checked by hand, before moving to the next one.
Given the specific failure modes already found, each tool's verification should specifically
include:

- A populated case and a genuinely empty case (confirm the empty case is handled as "no data,"
  not as an error — this is the exact bug class just fixed in the main app's own frontend, worth
  checking for here too).
- For `get_indicator_data` / `compare_indicators_across_areas`: a case where coverage is
  genuinely incomplete (e.g. a Great-Britain-only indicator requested across UK-wide areas),
  confirming the `coverage` field actually reflects the gap.
- For `rank_areas`: confirm it returns enough of the sorted list (or explicitly both ends) that a
  bad direction-guess doesn't silently return the wrong answer.

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
