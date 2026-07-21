from app import mcp

# Vercel's Python runtime expects an ASGI-compatible object named "app".
app = mcp.streamable_http_app()
