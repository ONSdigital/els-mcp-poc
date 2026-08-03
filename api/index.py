from app import mcp


class _VercelRouteCompat:
    """Normalize the request path that Vercel hands to the serverless ASGI app.

    Vercel serves the Python function at /api, but the FastMCP route table is
    registered at /mcp. The rewrite in vercel.json forwards the public /mcp
    request into the lambda, so the app must translate /api back to /mcp to
    let the underlying Starlette router resolve the correct MCP endpoint.
    """

    def __init__(self, asgi_app):
        self._asgi_app = asgi_app

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http":
            path = scope.get("path", "")
            if path == "/api" or path == "/api/":
                scope["path"] = "/mcp"
            elif path.startswith("/api"):
                scope["path"] = "/mcp"
        await self._asgi_app(scope, receive, send)


# Vercel's Python runtime expects an ASGI-compatible object named "app".
app = _VercelRouteCompat(mcp.streamable_http_app())
