# Ollama Playground (`ollama-play`)

A small full-stack playground for [Ollama](https://ollama.com): an Express server proxies Ollama’s HTTP API, and a React (Vite) UI talks to that server for text chat, vision-style prompts with images, image generation, and a **Movie Shorts** tab that chains scene planning, image prompts, and generation.

## Stack

| Layer | Notes |
|-------|--------|
| **Web** | React 19, Vite 6, Tailwind CSS 4, TypeScript, `react-markdown` + GFM |
| **Server** | Express, Zod validation, SSE streaming to the browser |
| **Runtime** | Node.js 20+ recommended (matches React 19 expectations) |

## Prerequisites

- [Node.js](https://nodejs.org/) 20 or newer
- [Ollama](https://ollama.com/download) installed and running locally (default `http://127.0.0.1:11434`)

Pull any models you want from the Ollama CLI (for example `ollama pull llama3.2`).

## Setup

From the repository root:

```bash
npm install
cp env.example .env
```

Edit `.env` if your Ollama host or API port differ. See `env.example` for variables.

## Development

Starts the API on port `3001` (by default) and the Vite dev server on `5173`. Vite proxies `/api` and `/health` to the local server.

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Production build

```bash
npm run build
```

- **API:** `npm start` (runs `node dist/index.js` in the `server` workspace after `tsc`).
- **Web:** static assets are emitted under `web/dist`; serve them with any static host, or run `npm run preview` to preview the Vite build locally.

If the browser does not use the Vite proxy, set `VITE_API_URL` in `.env` to your deployed API origin (see `env.example`).

## Project layout

| Package   | Role |
|-----------|------|
| `server/` | Express app: validates requests, forwards to Ollama, streams SSE for chat and generate |
| `web/`    | React + Tailwind UI: model picker, text/vision/image tabs, Movie Shorts workflow |

## UI features

- **Text** — streaming chat with markdown rendering.
- **Vision** — same as text with optional image attachments (base64 via the proxy).
- **Image** — streaming generate flow with download-friendly filenames when the model returns image bytes.
- **Movie Shorts** — multi-step flow: LLM proposes scenes, derives image prompts, then calls generate per scene (with presets and progress in the UI).

## API (server)

All routes are relative to the server base URL (e.g. `http://127.0.0.1:3001`). JSON bodies are accepted up to **32MB** (for image payloads).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness check |
| GET | `/api/models` | Lists models (wraps Ollama tags/show for capabilities when available) |
| POST | `/api/chat` | Chat completion; supports streaming (SSE), optional images, optional Ollama `format` (e.g. JSON mode / schema) |
| POST | `/api/generate` | Generate (e.g. images); supports streaming (SSE) and optional `width`, `height`, `steps`, `images`, `options` |

The server reads `OLLAMA_HOST` and `PORT` from the environment (or `.env` via `dotenv`).

## License

Private project (`"private": true` in `package.json`). Add a license file if you open-source this repo.
