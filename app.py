"""
MCP server for the ONS "Explore Local Statistics" (ELS) API.

(Vibe coded with Databricks Genie Code and Claude.)

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

This mcp runs FastMCP tools over Streamable HTTP transport. It is
reachable at https://<app-url>/mcp once deployed.
"""

import os
from functools import lru_cache
from typing import Any, Optional

import requests

try:
    # Newer `mcp` releases expose the public package at this import path.
    from mcp.server.fastmcp import FastMCP
except ModuleNotFoundError:  # pragma: no cover - defensive compatibility
    # Some older or differently packaged builds surface the class one level
    # deeper; keep the app importable across both layouts.
    from mcp.server.fastmcp.server import FastMCP

BASE_URL = "https://local-statistics-git-develop-ons-visual.vercel.app/api/v1"

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


@lru_cache(maxsize=1)
def _geo_levels() -> tuple:
    """Cache the geography level catalogue (ctry, rgn, cauth, utla, ltla, ...).
    These are fixed area-type definitions and won't change during a server's
    runtime."""
    return tuple(_get("/geo/levels", includeAreas="false"))


# --------------------------------------------------------------------------
# Geography tools
# --------------------------------------------------------------------------

@mcp.tool()
def search_areas(query: str, geo_levels: Optional[str] = DEFAULT_PLACE_LEVELS, limit: int = 10) -> list[dict]:
    """Look up UK geographic areas (countries, regions, local authorities, etc.) by name.

    Use this to convert a place name (e.g. "Birmingham", "Northern Ireland") into the
    GSS area code(s) needed by query_data. Returns candidate matches with
    their area code (areacd), name (areanm) and area type (type).

    Args:
        query: Place name or partial name to search for (e.g. "Norwich").
        geo_levels: Comma-separated list of geography level(s) to restrict
            results to (e.g. "ltla,rgn,ctry"). Defaults to common
            administrative levels (local authority up to country). Pass
            None/"all" to search every level, including parliamentary
            constituencies etc. Note: this takes a LIST of levels to filter
            by, unlike the single geo_type used in query_data/
            rank_areas_by_indicator/get_related_areas, which names one area
            type to fetch every area of.
        limit: Maximum number of results to return (default 10).
    """
    level = None if geo_levels in (None, "all") else geo_levels
    return _get(f"/geo/search/{query}", geoLevel=level, limit=limit).get("data", [])


@mcp.tool()
def resolve_area(query: str, geo_levels: Optional[str] = DEFAULT_PLACE_LEVELS) -> dict:
    """Resolve a place name to its single best-matching area, with alternates.

    Prefers an exact (case-insensitive) name match; otherwise returns the top
    search result. Use this instead of search_areas when you just need one
    area code for a place, e.g. before calling query_data.

    Args:
        query: Place name to resolve (e.g. "Belfast").
        geo_levels: See search_areas. Falls back to an unrestricted search if
            no results are found at the requested level(s).
    """
    results = search_areas(query, geo_levels=geo_levels)
    if not results:
        results = search_areas(query, geo_levels=None)
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
def get_related_areas(area_code: str, relation: str = "parents", geo_type: Optional[str] = None) -> list[dict]:
    """Find areas related to a given area: its parents, children, siblings, or
    statistically similar areas. Useful for building comparisons, e.g. finding
    the region/country a local authority sits within.

    Args:
        area_code: GSS code of the area to find relations for.
        relation: One of "parents", "children", "siblings", "similar".
        geo_type: A single area-type code (e.g. "ltla" - see list_geo_levels).
            For "children", optionally request a lower-level grouping. For
            "siblings", optionally request siblings within a wider parent
            level via the same parameter.
    """
    if relation not in ("parents", "children", "siblings", "similar"):
        raise ValueError("relation must be one of: parents, children, siblings, similar")
    params = {}
    if relation == "children" and geo_type:
        params["geoLevel"] = geo_type
    if relation == "siblings" and geo_type:
        params["parentLevel"] = geo_type
    return _get(f"/geo/related/{area_code}/{relation}", **params)


@mcp.tool()
def list_geo_levels() -> list[dict]:
    """List the available geography level codes. Used as the single geo_type
    in query_data, rank_areas_by_indicator, and get_related_areas (one area
    type to fetch/group every area of), or as one entry within the
    comma-separated geo_levels filter in search_areas/resolve_area. Codes
    include: "ltla" (lower-tier/unitary authorities), "utla" (upper-tier/
    unitary authorities), "cauth" (combined authorities), "rgn" (English
    regions plus Wales/Scotland/Northern Ireland), "ctry" (countries, UK,
    Great Britain). Each entry gives the level's code and a human-readable
    description of what it covers.
    """
    return list(_geo_levels())


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

def _check_bulk_guard(indicator_slug: Optional[str], topic: Optional[str],
                       area_codes: Optional[list[str]], geo_type: Optional[str],
                       geo_extent: Optional[str], time: str) -> None:
    """Enforce the API's "at most one of {datasets, geography, time} may be
    unrestricted" rule. A topic filter or a geo_extent-bounded geo_type counts
    as bounding that dimension; explicit area_codes always bound geography
    regardless of geo_type/geo_extent."""
    datasets_unbounded = (indicator_slug in (None, "all")) and not topic
    geo_unbounded = (not area_codes) and (not geo_type or not geo_extent)
    time_unbounded = (time == "all")

    if sum([datasets_unbounded, geo_unbounded, time_unbounded]) >= 2:
        raise ValueError(
            "Too broad: at most one of indicator/topic, geography, or time can "
            "be unrestricted at once. Narrow with a topic, a geo_type + "
            "geo_extent (or specific area_codes), or a specific time period."
        )


@mcp.tool()
def query_data(
    indicator_slug: Optional[str] = None,
    topic: Optional[str] = None,
    area_codes: Optional[list[str]] = None,
    geo_type: Optional[str] = None,
    geo_extent: Optional[str] = None,
    time: str = "latest",
) -> dict[str, list[dict]]:
    """Fetch observation values for one or many indicators across one or many
    areas - the general-purpose data tool. Covers everything from a single
    indicator/single area lookup to bulk pulls (e.g. every indicator in a
    topic, for every local authority in a region, at the latest period).

    CHOOSING area_codes vs geo_type/geo_extent:
    - For a specific area or list of specific areas (e.g. "Fareham", or
      "Fareham and Gosport"), use area_codes=["E07000087"]. This is also the
      correct choice for a SINGLE area even if you only have one code.
    - For every area of a given type (e.g. "every ltla in the South East"),
      use geo_type + geo_extent together: geo_type names the level to
      fetch, geo_extent is a PARENT area that bounds it.

    Args:
        indicator_slug: Indicator slug, e.g. "population-count" (from
            search_indicators). Omit or pass "all" to fetch every indicator
            (optionally narrowed by topic).
        topic: Topic or sub-topic slug (from list_topics) to filter which
            indicators are returned when indicator_slug is omitted/"all".
        area_codes: Specific area codes to fetch by GSS code, e.g. ["E08000025"].
            Not filtered by geo_extent - always returned as named.
        geo_type: Optional single area-type code (e.g. "ltla" - see
            list_geo_levels) to fetch every area of that type. Can combine with
            area_codes in the same request.
        geo_extent: Optional parent area GSS code that bounds geo_type to
            areas within it (e.g. all "ltla" within a region). Has no effect
            on area_codes.
        time: "latest" (default), "earliest", "all", a year "YYYY", or a
            range "YYYY,YYYY".

    Always returns a dict mapping each requested indicator's slug to a list of
    its observation rows, e.g. {"cigarette-smokers": [{areacd, areanm, period, value, ...}, ...]}
    - even for a single indicator, so the shape never changes based on how many
    indicators were requested. An indicator's list is empty if it has no data
    for the requested area(s) - this commonly happens when an area's country
    isn't covered by that indicator (check get_indicator_metadata's
    geography.countries, or use compare_indicator which surfaces this
    automatically with alternatives).

    Raises ValueError if the request is too broad: at most one of
    {indicator/topic, geography, time} may be left unrestricted ("all") at
    the same time - the underlying API cannot serve fully unbounded queries
    on more than one dimension.
    """
    _check_bulk_guard(indicator_slug, topic, area_codes, geo_type, geo_extent, time)

    geo_parts = list(area_codes or [])
    if geo_type:
        geo_parts.append(geo_type)
    geo = ",".join(geo_parts) if geo_parts else "all"

    data = _get(
        "/data.rows.json",
        indicator=indicator_slug or "all",
        topic=topic,
        geo=geo,
        geoExtent=geo_extent,
        includeNames="true",
        time=time,
        timeNearest="any",
    )
    if type(data) is list:
        return {indicator_slug: data}
    else:
        return data

@mcp.tool()
def rank_areas_by_indicator(
    indicator_slug: str,
    geo_type: str,
    geo_extent: Optional[str] = None,
    time: str = "latest",
    top_n: int = 10,
    order: str = "desc",
) -> list[dict]:
    """Rank areas by an indicator's value, e.g. "which local authority has the
    highest broadband coverage?" or "top 10 areas by unemployment rate in the
    South East". Fetches the indicator for every area of the given geo_type
    (optionally bounded to a parent area via geo_extent) and returns the
    top/bottom N sorted by value.

    Args:
        indicator_slug: Indicator slug (from search_indicators).
        geo_type: Area-type code to rank across, e.g. "ltla" (see
            list_geo_levels for valid codes).
        geo_extent: Optional parent area GSS code to bound the ranking to
            (e.g. only LTLAs within a specific region).
        time: "latest" (default) or a specific year "YYYY". "all" is not
            supported here since ranking needs one comparable value per area.
        top_n: Number of areas to return (default 10).
        order: "desc" (highest first, default) or "asc" (lowest first).
    """
    if time == "all":
        raise ValueError("time='all' is not supported for ranking; use 'latest' or a specific year.")
    if order not in ("asc", "desc"):
        raise ValueError("order must be 'asc' or 'desc'")

    data = query_data(indicator_slug, geo_type=geo_type, geo_extent=geo_extent, time=time)
    rows = data[indicator_slug]
    valid = [r for r in rows if r.get("value") is not None]
    valid.sort(key=lambda r: r["value"], reverse=(order == "desc"))
    return valid[:top_n]


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

    IMPORTANT SCOPE: this compares exactly the ONE OR TWO specific named
    areas resolved from area_query/compare_to_query - e.g.
    compare_to_query="South East" resolves to the single South East region
    as one aggregate figure, NOT every local authority within it. For
    "compare Fareham to every area in the South East" or similar region-wide/
    many-area comparisons, use query_data with geo_type + geo_extent (or
    rank_areas_by_indicator to rank them) instead.

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

    data = query_data(indicator["slug"], area_codes=codes, time=time) if len(warnings) < len(areas) else []
    rows = data[indicator["slug"]]

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
        "data": rows,
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
    return {"status": "ok", "els_api_reachable": api_reachable, "tool_count": 12}


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
