# CLAUDE.md

Guidance for Claude Code (or a human) working in this repository.

**Status: this file is written ahead of the code it describes.** The repo is being rewritten from
a Python/FastMCP proof-of-concept to TypeScript/Node — at the time of writing, none of the
structure below exists yet. Treat every section as the intended design until the corresponding
code lands, and **update this file once it diverges from reality** rather than letting it drift.
Full reasoning behind the design lives in `docs/design.md` (tool spec, gap analysis, why each
decision was made) and `docs/next-steps.md` (build order, verification checklist) — both should be
copied into this repo from the Desktop before starting. This file doesn't repeat their content,
only the parts relevant to writing code day to day.

## Project overview

An MCP (Model Context Protocol) server exposing the ONS "Explore Local Statistics" (ELS) API to
LLM clients (Claude Desktop, etc.) as a set of tools — letting a chatbot answer questions like
"what's the unemployment rate in Belfast" by calling real, current UK local-statistics data rather
than relying on training-data recall. Runs over Streamable HTTP, deployed to Vercel.

Previous version (Python, `mcp`/FastMCP, `requests`) is being replaced for three reasons: Vercel's
Python ASGI runtime needed a path-rewriting compatibility shim that Node doesn't; the maintainer
reads/reviews TypeScript more fluently; and the tool design itself needed rework (see
`docs/design.md`), not just a language port. The old implementation should stay on a branch/tag
for reference, not deleted outright, in case behaviour needs cross-checking mid-rewrite.

## The ELS API is documented elsewhere — don't re-derive its behaviour here

`docs/api/` in `ONSdigital/explore-local-statistics-app` (same org) is the maintained, verified
reference for every endpoint, parameter, response shape and error condition this server calls
into — particularly `important-notes.md` for sharp edges. Read it before writing or modifying a
tool that touches a new part of the API, rather than guessing from the Python version's behaviour
or from first principles. **Caveat:** as of the design conversation this repo's rewrite is based
on, that documentation existed only as uncommitted changes on an `api-improvements` branch —
confirm it's merged before treating links to it as stable.

A few facts worth keeping in working memory anyway, because they directly shaped this server's
design (not just the underlying HTTP API's):

- **A request that resolves but matches no data returns `200` with an empty-shaped body, not an
  error.** Any "did this fail" check in this codebase needs to test for emptiness in the response,
  not HTTP status — this is the exact bug class that had to be fixed in the main ELS app's own
  frontend after this same API change, and it's an easy one to reintroduce here.
- **The same underlying concept sometimes has two separate indicator slugs split by country
  coverage** (e.g. `employment-rate` vs. `employment-rate-ni`) — nothing in the API itself points
  one at the other. This is *why* every data-returning tool here must attach a `coverage` summary
  (requested vs. returned) rather than just passing through whatever rows came back — see
  `docs/design.md`.
- **GSS codes are case-insensitive on every endpoint** and the geography-level vocabulary differs
  by route (a 5-level statistical set vs. a wider 14-level navigation set vs. the boundary map's
  own set) — this tool layer should pick one consistent level vocabulary to expose (the 5-level
  set: `ctry`/`rgn`/`cauth`/`utla`/`ltla`, matching indicator data's own granularity) and normalise
  case internally, so no tool description ever needs to explain either quirk to the calling model.

## Design principles (see `docs/design.md` for the full reasoning)

- **Task-shaped tools, not a REST mirror.** Fewer tools with parameters beats more tools with
  overlapping purposes — tool *selection* is itself a place an LLM goes wrong.
- **This layer absorbs the API's sharp edges; the model calling it never sees them.** Don't expose
  `hasGeo` as a primary parameter. Don't expose the underlying single-indicator/multi-indicator
  endpoint split as a corresponding split in the tool surface — always call the multi-indicator
  endpoint internally and let a tool's own parameter accept one-or-many.
- **Never let an incomplete result look like a complete one.** Every data-returning tool response
  needs a `coverage` field (requested vs. returned), not just whatever rows happened to come back.
- **Cross-indicator/cross-area computation happens in this code, not in the calling model's
  context.** If a tool's job is naturally a join or a pivot (compare N indicators across M areas,
  rank by change over time), do that server-side — don't return raw material and expect the
  calling model to reconstruct it reliably.
- **Attach provenance to every data response**, not only to a separate metadata call — source,
  unit, caveats, `updated`, pulled from the already-resolved indicator lookup.

## Architecture (intended — update once real code exists)

- Tool definitions grouped by domain, matching `docs/design.md`'s three groups: geography,
  metadata, data. One module per group, not one file per tool and not one large file.
- A single HTTP client wrapper around the ELS API (base URL, GSS-code upper-casing, JSON parsing)
  that every tool goes through — this is where the "absorb the sharp edges" principle actually
  gets implemented, once, rather than per-tool.
- **Caching**: the Python version used `@lru_cache` on the indicator catalogue and geo-levels list,
  assuming a long-lived process. On Vercel's serverless Node runtime, module-level state persists
  only across a warm function instance, not reliably across every invocation — a cold start resets
  it. Any equivalent cache here should be treated as a best-effort latency optimisation, not a
  correctness dependency; don't build logic that assumes the cache is always populated.

## Commands (proposed — replace with real ones once `package.json` exists)

- `npm run dev` — local server (Streamable HTTP), for use with a locally-configured MCP client.
- `npm run build` — production build for Vercel.
- `npm run test` — whatever test approach is chosen; see "Verification" below for what actually
  needs covering, which matters more than the test *tooling* choice.
- `npm run lint` / `npm run format` — match whatever convention gets picked; no strong reason to
  diverge from `explore-local-statistics-app`'s own (`prettier` + `eslint`) given the maintainer's
  familiarity with that setup already.

## Verification

Every tool needs to be checked against the **live** ELS API before being considered done, not
just type-checked or unit-tested against a mock — this was the working discipline for the entire
API documentation/redesign effort this server is built on, and it's what caught every real bug
found during that work. At minimum, per tool: one populated case, one genuinely empty case
(confirm it's handled as "no data" and not mistaken for an error), and for anything returning a
`coverage` field, one case with real incomplete coverage to confirm the gap is actually surfaced.

Once enough tools exist, re-run the example prompts in `docs/next-steps.md` end-to-end through an
actual LLM client, not just as isolated tool calls — checking both which tool gets selected and
whether the final answer is right catches problems neither a docstring review nor a per-tool test
will.
