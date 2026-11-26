<img src="assets/icon.svg" width="64" height="64" alt="">

# SmartyPrompts

A desktop agent app, its interface modeled on Grok Bot's, where each bot can run on a different model
backend: Claude, OpenAI-compatible APIs (OpenAI, xAI, OpenRouter), local models (Ollama, LM Studio) or Gemini.

Created in [T3 Code](https://t3.codes).

## Repository layout

| Path | Contents |
|---|---|
| `design/GrokBot-Clone.figcraft` | Native FigCraft design file: 37 screens across the App, Modals, Settings and Onboarding pages |
| `design/source/` | The pipeline that generated those screens (`screens.html` → `run.mjs` → `dom2svg.js` → SVG → FigCraft import) |
| `design/previews/` | PNG previews of every screen |
| `reference/BEHAVIOR.md` | Teardown of how Grok Bot works: processes, sign-in, cloud box, conversation loop, remote-control bridge, feature map |
| `reference/screens/`, `reference/dom/` | Screenshots and computed-style captures of the real app, used as the visual reference |
| `reference/raw/` | Decoded protobuf message schemas and the list of renderer-to-main RPC methods |
| `server/` | Agent gateway: HTTP/SSE API, transcript store, approvals, and provider adapters (Claude, plus a fake for tests) |
| `docs/FUTURE_FEATURES.md` | Features deferred for later: routines, connectors, vault, voice, multiple bots and group chats |

## Status

- [x] UI/UX reverse-engineered and designed
- [x] Behavior teardown
- [x] Backend: agent gateway with a provider interface and the Claude adapter ([`server/`](server/README.md))
- [ ] Backend: Codex and Cursor adapters
- [ ] Bot's computer in a container (WSL or Docker, plus noVNC live view)
- [ ] Desktop client wired to the backend
- [ ] [Future features](docs/FUTURE_FEATURES.md)

## Notes

Reference material was captured from a locally installed copy of Grok Bot for design reference only.
This project does not use Grok Bot's or Cursor's private APIs, and anything shipped should use its own
name, mascot and copy.

## Development

```bash
npm install && npm --prefix server install
npm run verify   # lint, format check, typecheck, tests
```

Work follows the [software factory process](docs/factory/PROCESS.md), and the coding standards are in
[`CLAUDE.md`](CLAUDE.md).
