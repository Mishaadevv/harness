# Zeqou Harness

Premium desktop workspace for AI models and agents. Connect providers, orchestrate agents and keep project context in one focused place.

Part of the [Zeqou ecosystem](https://mishaadevv.github.io/zeqou/).

## Features

- Agent and model workspace on desktop
- Tools, memory and MCP support
- **Agent plan**: for multi-step jobs the agent plans its work with the `todo` tool — a quiet card at the end of the chat it was written for, with a progress line and `2/5` count, foldable, and **read-only**: no checkbox to tick, nothing to add or reorder, because the user did not write this plan. The agent marks steps doing and done as it works. If a run is stopped, fails or hits the step limit, the unfinished steps are dropped with it instead of being left behind as a stranded to-do list
- **A transcript that stays still**: while an answer streams, message nodes are updated in place instead of rebuilding the chat, and the view stops following the text the moment you scroll up — reading back through history no longer means waiting for the run to finish
- **Agent questions**: the `ask_user` tool lets the agent stop and ask instead of guessing — the question appears as a card in the chat, you answer by clicking one of its options or by typing (in the card or the composer), and the run continues with your answer
- **Tool nudges**: if a model answers with a question written as plain text, or does tool work without ever touching `todo`, the harness sends it back once per run with the expectation spelled out — small models otherwise silently drop both
- Works with OpenAI, Anthropic, Google, OpenRouter, Ollama and custom endpoints

## Develop

```bash
npm install
npm start        # run the Electron app
npm run dev      # run with --dev flag
npm run smoke    # boot the app, walk every page, exercise the todo tool and the question card
```

## Build

```bash
npm run pack     # unpacked build
npm run dist     # Windows installer (NSIS) + portable
```

The Windows installer is an assisted NSIS setup: it shows the PolyForm Strict
1.0.0 license before copying anything and lets you choose the installation
folder; the portable build needs no install.

## License

[PolyForm Strict 1.0.0](LICENSE) — viewing and personal use are allowed; copying, modification, redistribution and derivative works are not permitted without the author's permission.
