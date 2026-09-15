# ELS MCP server

An MCP (Model Context Protocol) server that lets LLM agents (e.g. chatbots like Claude) make
meaningful use of the data provided by the
[Explore Local Statistics API](https://github.com/ONSdigital/explore-local-statistics-app/wiki).

TypeScript/Node, served over Streamable HTTP. See `CLAUDE.md` and `docs/` for the design
reasoning behind the tool set. A previous Python/FastMCP proof-of-concept lives earlier in this
repo's git history if old behaviour ever needs cross-checking.

_Note: It is not possible to add custom MCP servers to some LLM chatbots, like M365 Copilot._

## Run the server locally

Requires Node.js 20+.

```bash
npm install
cp .env.example .env   # then edit ELS_API_BASE_URL if needed
npm run dev
```

This starts the server at `http://localhost:8001/mcp`.

### Connect it to your LLM

The example below is specific to [Claude Desktop](https://claude.com/download), but should be
similar for other MCP-capable clients.

Open the `Settings` dialog, then the `Developer` tab, then `Edit config`. This opens a JSON
configuration file — add:

```json5
{
  // ...EXISTING CONFIG ABOVE...
  "mcpServers": {
    "els-mcp-server": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:8001/mcp"]
    }
  }
}
```

Save the file, make sure `npm run dev` is running, and restart Claude Desktop.

### Start using it

Check that your chatbot is connected by asking:

```txt
Are you able to connect to els-mcp-server?
```

Once connected, if you ask questions that can be answered with data on Explore Local Statistics,
your chatbot should automatically call this server to give you an answer, e.g.:

```txt
Which local authority in Wales has the highest employment rate?
```

## Other commands

```bash
npm run build         # production build (tsc -> dist/)
npm run lint           # eslint
npm run format          # prettier --write
npm run format:check    # prettier --check
```

## Deploy to Vercel

1. [Fork this repo](https://github.com/bothness/els-mcp-poc/fork) to your own GitHub account.
2. In **Vercel**, create a new project from that repo. Vercel auto-detects the Node function in
   `api/`.
3. Set the `ELS_API_BASE_URL` environment variable in the Vercel project settings (see
   `.env.example`) — the app fails to start without it.
4. Deploy.

### Use it with your LLM

Once deployed, add the MCP server to your favourite LLM chatbot. For Claude (web or desktop):

1. Go to **Settings (Customize) → Connectors**
2. Click +, then **Add custom connector**
3. Paste in the URL: `https://<your-app>.vercel.app/mcp`
4. Click **Add**, then **Connect**
