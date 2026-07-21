"""
Databricks App entrypoint: MCP server for the ONS "Explore Local Statistics" (ELS) API.

Exposes tools that let an AI model answer questions like:
  - "What is the population of Birmingham?"
  - "What is the unemployment rate in Belfast, and how does it compare to
     Northern Ireland as a whole?"

Data source / API docs (unofficial, read-only, unauthenticated):
  https://github.com/ONSdigital/explore-local-statistics-app/wiki

IMPORTANT: the ELS wiki explicitly states this API is "not intended for use
by non-ONS web applications" and its structure may change without notice.
It is a public Cloudflare-cached endpoint with no auth, so it can be called
server-side, but this integration is unofficial and best-effort.

This is the Databricks Apps variant of els_mcp_server.py: it runs the same
FastMCP tools over Streamable HTTP transport (instead of stdio) so it is
reachable at https://<app-url>/mcp once deployed. Databricks Apps provides
the port to bind via the DATABRICKS_APP_PORT env var and expects the process
to listen on 0.0.0.0.
"""

import os
from functools import lru_cache
from typing import Any, Optional

import requests
from mcp.server.fastmcp import FastMCP

BASE_URL = "https://www.ons.gov.uk/explore-local-statistics/api/v1"

# Sensible "administrative area" levels for resolving a place name typed by a
# person (city / town / local authority / region / country). Excludes finer
# levels like parliamentary constituencies unless nothing else matches.
DEFAULT_PLACE_LEVELS = "ltla,utla,cauth,rgn,ctry"

# Databricks Apps assigns the listening port via DATABRICKS_APP_PORT and
# requires binding to 0.0.0.0. The Streamable HTTP MCP endpoint is served at
# the FastMCP default path: https://<app-url>/mcp
APP_PORT = int(os.environ.get("DATABRICKS_APP_PORT", 8000))

mcp = FastMCP("explore-local-statistics", host="0.0.0.0", port=APP_PORT)


def _get(path: str, **params: Any) -> Any:
    """GET a path under BASE_URL, dropping any None-valued params."""
    url = f"{BASE_URL}{path}"
    query = {k: v for k, v in params.items() if v is not None}
    resp = requests.get(url, params=query, timeout=30)
    resp.raise_for_status()
    return resp.json()


@lru_cache(maxsize=1)
def _all_indicators() -> tuple:
    """Cache the full indicator catalogue (100+ indicators, refreshed weekly by
    ONS). There is no server-side text-search for indicators, so free-text
    matching (search_indicators) is done client-side against this cache."""
    return tuple(_get("/metadata/indicators"))


# --------------------------------------------------------------------------
# Geography tools
# --------------------------------------------------------------------------

@mcp.tool()
def search_areas(query: str, geo_level: Optional[str] = DEFAULT_PLACE_LEVELS, limit: int = 10) -> list[dict]:
    """Look up UK geographic areas (countries, regions, local authorities, etc.) by name.

    Use this to convert a place name (e.g. "Birmingham", "Northern Ireland") into the
    GSS area code(s) needed by get_indicator_data. Returns candidate matches with
    their area code (areacd), name (areanm) and area type (type).

    Args:
        query: Place name or partial name to search for (e.g. "Norwich").
        geo_level: Comma-separated geography level(s) to restrict results to
            (e.g. "ltla", "rgn", "ctry"). Defaults to common administrative
            levels (local authority up to country). Pass None/"all" to search
            every level, including parliamentary constituencies etc.
        limit: Maximum number of results to return (default 10).
    """
    level = None if geo_level in (None, "all") else geo_level
    return _get(f"/geo/search/{query}", geoLevel=level, limit=limit).get("data", [])


@mcp.tool()
def resolve_area(query: str, geo_level: Optional[str] = DEFAULT_PLACE_LEVELS) -> dict:
    """Resolve a place name to its single best-matching area, with alternates.

    Prefers an exact (case-insensitive) name match; otherwise returns the top
    search result. Use this instead of search_areas when you just need one
    area code for a place, e.g. before calling get_indicator_data.

    Args:
        query: Place name to resolve (e.g. "Belfast").
        geo_level: See search_areas. Falls back to an unrestricted search if
            no results are found at the requested level(s).
    """
    results = search_areas(query, geo_level=geo_level)
    if not results:
        results = search_areas(query, geo_level=None)
    if not results:
        return {"match": None, "alternatives": []}
    exact = [r for r in results if r["areanm"].lower() == query.lower()]
    best = exact[0] if exact else results[0]
    return {"match": best, "alternatives": results}


@mcp.tool()
def get_area_details(area_code: str) -> dict:
    """Get metadata for a single area by its GSS code: full name, area type,
    parent areas, and immediate child areas (large lists of small-area codes
    like output areas are omitted to keep the response compact).

    Args:
        area_code: GSS area code, e.g. "E08000025" for Birmingham.
    """
    data = _get(f"/geo/lookup/{area_code}")
    props = dict(data.get("properties", {}))
    for bulky_field in ("oa21cds", "lsoa21cds", "msoa21cds"):
        props.pop(bulky_field, None)
    return props


@mcp.tool()
def get_related_areas(area_code: str, relation: str = "parents", geo_level: Optional[str] = None) -> list[dict]:
    """Find areas related to a given area: its parents, children, siblings, or
    statistically similar areas. Useful for building comparisons, e.g. finding
    the region/country a local authority sits within.

    Args:
        area_code: GSS code of the area to find relations for.
        relation: One of "parents", "children", "siblings", "similar".
        geo_level: For "children", optionally request a lower-level grouping
            (e.g. "ltla"). For "siblings", optionally request siblings within a
            wider parent level via the same parameter.
    """
    if relation not in ("parents", "children", "siblings", "similar"):
        raise ValueError("relation must be one of: parents, children, siblings, similar")
    params = {}
    if relation == "children" and geo_level:
        params["geoLevel"] = geo_level
    if relation == "siblings" and geo_level:
        params["parentLevel"] = geo_level
    return _get(f"/geo/related/{area_code}/{relation}", **params)


# --------------------------------------------------------------------------
# Indicator / metadata tools
# --------------------------------------------------------------------------

@mcp.tool()
def search_indicators(query: str, limit: int = 10) -> list[dict]:
    """Find indicators (datasets) by free-text topic, e.g. "unemployment", "life
    expectancy", "population". Matches against each indicator's label,
    subtitle and description. Returns compact summaries (slug, label, topic,
    unit, and the countries/geography levels it covers) - use
    get_indicator_metadata for full detail on a specific one.

    Args:
        query: Free-text search term.
        limit: Maximum number of results to return (default 10).
    """
    q = query.lower()
    scored = []
    for ind in _all_indicators():
        text = " ".join([ind["label"], ind.get("subtitle") or "", ind.get("description") or ""]).lower()
        score = 3 if q in ind["label"].lower() else (1 if q in text else 0)
        if score:
            scored.append((score, ind))
    scored.sort(key=lambda x: -x[0])
    return [
        {
            "slug": i["slug"],
            "label": i["label"],
            "topic": i["topic"],
            "subTopic": i["subTopic"],
            "unit": i.get("unit"),
            "subtitle": i.get("subtitle"),
            "countries_covered": i["geography"]["countries"],
            "geography_levels": i["geography"]["levels"],
        }
        for _, i in scored[:limit]
    ]


@mcp.tool()
def get_indicator_metadata(indicator_slug: str) -> dict:
    """Get full metadata for a single indicator by its slug (from
    search_indicators): description, units, update frequency, geography
    coverage, value/period domain, dimensions and caveats.

    Args:
        indicator_slug: Indicator slug, e.g. "population-count".
    """
    return _get(f"/metadata/indicators/{indicator_slug}")


@mcp.tool()
def list_topics() -> Any:
    """List the full topic/sub-topic taxonomy of available indicators (nested by
    topic). Use this to browse what data is available if search_indicators
    doesn't find a good match."""
    return _get("/metadata/taxonomy")


# --------------------------------------------------------------------------
# Data retrieval tools
# --------------------------------------------------------------------------

@mcp.tool()
def get_indicator_data(indicator_slug: str, area_codes: list[str], time: str = "latest") -> list[dict]:
    """Fetch observation values for an indicator across one or more areas.

    Args:
        indicator_slug: Indicator slug, e.g. "population-count" (from search_indicators).
        area_codes: One or more GSS area codes to fetch values for, e.g.
            ["E08000025"] or ["N09000003", "N92000002"] (from resolve_area/search_areas).
        time: "latest" (default), "earliest", "all", a year "YYYY", or a
            range "YYYY,YYYY".

    Returns a list of rows: {areacd, areanm, period, value, ...}. Returns an
    empty list if the indicator has no data for the requested area(s) - this
    commonly happens when an area's country isn't covered by that indicator
    (check get_indicator_metadata's geography.countries, or use
    compare_indicator which surfaces this automatically with alternatives).
    """
    geo = ",".join(area_codes)
    return _get(
        "/data.rows.json",
        indicator=indicator_slug,
        geo=geo,
        includeNames="true",
        time=time,
        timeNearest="any",
    )


@mcp.tool()
def compare_indicator(
    indicator_query: str,
    area_query: str,
    compare_to_query: Optional[str] = None,
    time: str = "latest",
) -> dict:
    """High-level, end-to-end helper: resolve a free-text indicator and one or
    two free-text place names, fetch the observation value(s), and flag any
    country-coverage gap (e.g. Northern Ireland is often not covered by the
    same indicator as Great Britain) with suggested alternative indicators.

    This is the best first tool to try for a question like "what is the
    population of Birmingham?" or "what is the unemployment rate in Belfast,
    and how does it compare to Northern Ireland as a whole?" - pass
    indicator_query="unemployment", area_query="Belfast",
    compare_to_query="Northern Ireland".

    Args:
        indicator_query: Free-text indicator topic, e.g. "population", "unemployment rate".
        area_query: Primary place name, e.g. "Birmingham".
        compare_to_query: Optional second place name to compare against, e.g. "Northern Ireland".
        time: "latest" (default), "earliest", "all", a year, or a year range.
    """
    candidates = search_indicators(indicator_query, limit=10)
    if not candidates:
        return {"error": f"No indicator found matching '{indicator_query}'"}
    indicator_summary = candidates[0]
    indicator = get_indicator_metadata(indicator_summary["slug"])

    area_result = resolve_area(area_query)
    area = area_result["match"]
    if not area:
        return {"error": f"No area found matching '{area_query}'"}

    areas = [area]
    compare_area = None
    if compare_to_query:
        compare_result = resolve_area(compare_to_query)
        compare_area = compare_result["match"]
        if compare_area:
            areas.append(compare_area)

    codes = [a["areacd"] for a in areas]
    covered_countries = indicator["geography"]["countries"]
    warnings: list[str] = []
    alt_suggestions: list[str] = []
    for a in areas:
        country_prefix = a["areacd"][0]  # E, W, S, N (country) or K (UK-wide)
        if country_prefix != "K" and country_prefix not in covered_countries:
            warnings.append(
                f"'{indicator['label']}' does not cover {a['areanm']} "
                "(data will be missing for this area)."
            )
            alts = [
                f"{i['slug']} ({i['label']})"
                for i in search_indicators(indicator_query, limit=10)
                if country_prefix in i["countries_covered"]
            ]
            alt_suggestions.extend(alts[:5])

    data = get_indicator_data(indicator["slug"], codes, time=time) if len(warnings) < len(areas) else []

    return {
        "indicator": {
            "slug": indicator["slug"],
            "label": indicator["label"],
            "unit": indicator.get("unit"),
            "subtitle": indicator.get("subtitle"),
        },
        "areas_resolved": [
            {"query": q, "matched": a["areanm"], "code": a["areacd"]}
            for q, a in zip([area_query, compare_to_query], areas)
        ],
        "data": data,
        "warnings": warnings,
        "alternative_indicators_for_uncovered_area": list(dict.fromkeys(alt_suggestions)),
    }


@mcp.tool()
def health() -> dict:
    """Diagnostic tool confirming the MCP server is up and can reach the ELS API."""
    try:
        _get("/metadata/taxonomy")
        api_reachable = True
    except Exception as exc:  # noqa: BLE001
        api_reachable = False
    return {"status": "ok", "els_api_reachable": api_reachable, "tool_count": 9}


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
