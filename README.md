# Zeqou Harness

Premium desktop workspace for AI models and agents. Connect providers, orchestrate agents and keep project context in one focused place.

Part of the [Zeqou ecosystem](https://mishaadevv.github.io/zeqou/).

## Features

- Agent and model workspace on desktop
- Tools, memory and MCP support
- **Agent todo list**: for multi-step jobs the agent plans its work with the `todo` tool — the Tasks panel shows the plan live, with pending/doing/done status you can also edit by hand
- Works with OpenAI, Anthropic, Google, OpenRouter, Ollama and custom endpoints

## Develop

```bash
npm install
npm start        # run the Electron app
npm run dev      # run with --dev flag
```

## Build

```bash
npm run pack     # unpacked build
npm run dist     # Windows installer (NSIS) + portable
```

## License

[PolyForm Strict 1.0.0](LICENSE) — viewing and personal use are allowed; copying, modification, redistribution and derivative works are not permitted without the author's permission.
