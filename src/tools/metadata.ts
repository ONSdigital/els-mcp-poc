/**
 * Indicator/metadata tools — discovering and describing indicators. See
 * docs/design.md "Metadata".
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { elsGet } from "../http-client.js";
import { getAllIndicators, getIndicatorBySlug } from "../cache.js";
import type { Indicator } from "../types.js";
import { errorResult, jsonResult } from "../tool-helpers.js";

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "for",
  "and",
  "or",
  "to",
  "is",
  "are",
  "by",
  "with",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** Pure word-overlap scoring cannot bridge a query and a label that share zero tokens — e.g.
 * "internet" vs. the actual indicator label "Gigabit capable broadband", whose text nowhere
 * contains the word "internet" (confirmed against the live catalogue). That was this repo's own
 * worked example for why search needed improving (see design doc's "Gaps found"), and
 * word-overlap alone does not actually solve it — only a synonym still can. This list is
 * intentionally small and specific to gaps actually traced against example prompts, not a
 * general thesaurus; extend it when a real query surfaces another same-concept/different-word
 * gap, and lean on list_topics as the honest fallback for everything else. */
const SYNONYMS: Record<string, string[]> = {
  internet: ["broadband"],
  broadband: ["internet"],
  jobs: ["employment"],
  jobless: ["unemployment", "unemployed"],
  wages: ["earnings", "income"],
  earnings: ["wages", "income"],
  income: ["earnings", "wages"],
  elderly: ["older"],
  crime: ["offences", "offence"],
};

function expandWithSynonyms(tokens: string[]): string[] {
  const expanded = new Set(tokens);
  for (const t of tokens) for (const syn of SYNONYMS[t] ?? []) expanded.add(syn);
  return [...expanded];
}

/** Word-overlap scoring against label + subtitle + description, replacing the proof-of-concept's
 * raw substring match — plus a small synonym expansion (above) for the specific cases token
 * overlap alone can't reach. Scores: label token match > subtitle/description token match, with
 * a substring bonus to keep exact-phrase queries ranking first. */
function scoreIndicator(indicator: Indicator, queryTokens: string[]): number {
  const labelTokens = new Set(tokenize(indicator.label));
  const bodyTokens = new Set(
    tokenize([indicator.subtitle, indicator.description].filter(Boolean).join(" ")),
  );
  const expandedTokens = expandWithSynonyms(queryTokens);
  let score = 0;
  for (const qt of expandedTokens) {
    const isOriginal = queryTokens.includes(qt);
    if (labelTokens.has(qt)) score += isOriginal ? 3 : 2;
    else if (bodyTokens.has(qt)) score += isOriginal ? 1 : 1;
  }
  const haystack =
    `${indicator.label} ${indicator.subtitle ?? ""} ${indicator.description ?? ""}`.toLowerCase();
  if (queryTokens.length > 0 && haystack.includes(queryTokens.join(" "))) score += 2;
  return score;
}

function summarise(indicator: Indicator) {
  return {
    slug: indicator.slug,
    label: indicator.label,
    topic: indicator.topic,
    subTopic: indicator.subTopic,
    unit: indicator.unit,
    subtitle: indicator.subtitle,
    confidenceIntervals: indicator.confidenceIntervals ?? false,
    countries_covered: indicator.geography.countries,
    geography_levels: indicator.geography.levels,
  };
}

export function registerMetadataTools(server: McpServer): void {
  server.registerTool(
    "search_indicators",
    {
      title: "Search indicators",
      description:
        'Find indicators (datasets) by free-text topic, e.g. "unemployment", "life expectancy", ' +
        '"population". Matches by word overlap against each indicator\'s label, subtitle and ' +
        "description (not just exact substrings), so related terms have a real chance of " +
        'matching (e.g. "internet" can match an indicator titled "broadband"). Returns compact ' +
        "summaries (slug, label, topic, unit, whether it carries confidence intervals, and the " +
        "countries/geography levels it covers) — use get_indicator_metadata for full detail on " +
        "a specific one. If this returns nothing useful, try list_topics to browse instead — " +
        "keyword search is inherently fragile for an unfamiliar or unusually-named topic.",
      inputSchema: {
        query: z.string().describe("Free-text search term."),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("Maximum results (default 10)."),
      },
    },
    async ({ query, limit }) => {
      const indicators = await getAllIndicators();
      const queryTokens = tokenize(query);
      const scored = indicators
        .map((i) => ({ score: scoreIndicator(i, queryTokens), indicator: i }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score);
      if (scored.length === 0) {
        return jsonResult({
          results: [],
          note:
            `No indicator matched "${query}". Try list_topics to browse the full taxonomy — ` +
            "keyword search can miss indicators that use different wording for the same concept.",
        });
      }
      return jsonResult({
        results: scored.slice(0, limit ?? 10).map((s) => summarise(s.indicator)),
      });
    },
  );

  server.registerTool(
    "get_indicator_metadata",
    {
      title: "Get indicator metadata",
      description:
        "Get full metadata for a single indicator by its slug (from search_indicators): " +
        "description, units, update frequency, geography coverage, value/period domain, " +
        "dimensions, caveats, source, and whether it carries 95% confidence intervals " +
        "(confidenceIntervals) — check this before expecting lci_95/uci_95 on its data rows.",
      inputSchema: {
        indicator_slug: z.string().describe('Indicator slug, e.g. "population-count".'),
      },
    },
    async ({ indicator_slug }) => {
      const cached = await getIndicatorBySlug(indicator_slug);
      if (cached) return jsonResult(cached);
      // Fall back to a direct lookup in case the cache is stale relative to a slug that exists
      // live but wasn't in the last cached catalogue fetch.
      const data = await elsGet<Indicator>(
        `/metadata/indicators/${encodeURIComponent(indicator_slug)}`,
      ).catch(() => null);
      if (!data) return errorResult(`No indicator found with slug "${indicator_slug}".`);
      return jsonResult(data);
    },
  );

  server.registerTool(
    "list_topics",
    {
      title: "List topics",
      description:
        "List the full topic/sub-topic taxonomy of available indicators (nested by topic). " +
        "Prefer this as the PRIMARY way to discover indicators — browse by topic first, and " +
        "fall back to search_indicators' free-text search second — since keyword search is " +
        "fragile for topics phrased differently than an indicator's own label.",
      inputSchema: {},
    },
    async () => jsonResult(await elsGet("/metadata/taxonomy")),
  );
}
