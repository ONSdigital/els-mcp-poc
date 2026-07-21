# ELS MCP server

This is a proof-of-concept Model Context Protocol (MCP) server that allows LLM agents (eg. chatbots like Claude, ChatGPT, Gemini or Copilot) to make meaningful use of the data provided by the [Explore Local Statistics API](https://github.com/ONSdigital/explore-local-statistics-app/wiki).

This code in this repo was created with the use of LLMs (Genie Code and Github Copilot). It is not intended for production use.

## Run the server locally

To run this app locally, you need Python installed on your machine. You also need to install an LLM client (eg. Claude Desktop) in order to actually use it. (When run locally, the MCP server can't be accessed by web-based apps!)

### Run the server

Set up a Python environment and install the dependencies (the first command may start `python` instead of `python3` on your machine):

```bash
python3 -m venv .mcpenv
source .mcpenv/bin/activate
pip install -r requirements.txt
```

Run the MCP server (you need to do this every time you want to use it):

```bash
source .mcpenv/bin/activate
python3 -m uvicorn api.index:app --host 127.0.0.1 --port 8001
```

### Connect it to your LLM

To use this local MCSP server, you'll need to install your favourite LLM chatbot on your machine and then configure it. The example below is specific to [Claude Desktop](https://claude.com/download), but should be similar for other services.

Open the `Settings` dialog and then click the `Developer` tab and `Edit config` button. This should open a JSON configuration file that you need to edit and save manually.

Add the following lines towards the bottom of the file:

```json5
{
  ...EXISTING CONFIG ABOVE...
  "mcpServers": {
    "els-mcp-server": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:8001/mcp"]
    }
  }
}
```

Save the file, make sure your MCP server is running, and then restart the Claude Desktop app.

### Start using it

Check that your chatbot is connected to the server by asking:

```txt
Are you able to connect to els-mcp-server?
```

Once connected, if you ask questions that can be answered with data on Explore Local Statistics, your chatbot should automatically make use of the API to give you an answer, eg:

```txt
Which local authority in Wales has the highest employment rate?
```

## Deploy to Vercel

This app has the configuration files necessary to deploy it to Vercel. This is not intended to be a solution for use in production, but allows the MCP server to be tested by other people without having to run it locally on their machine.

### Deployment steps

1. Fork this repo to your own Github account.
2. In Vercel, create a new project from that repo.
3. Set the Root Directory to the project folder if needed.
4. Vercel will auto-detect Python and install from requirements.txt.
5. Deploy.

### Use it with your LLM

Once set up on Vercel, you can add the MCP server to your local LLM chatbot. If you're using Claude Desktop, the steps are as follows:

1. Go to **Settings (Customize) → Connectors**
2. Click +, then **Add custom connector**
3. Paste in the URL: `https://<your-app>.vercel.app/mcp`
4. Click **Add**, then **Connect**
