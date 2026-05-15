# ollama-test

A small full-stack playground for [Ollama](https://ollama.com): an Express server proxies Ollama’s HTTP API, and a React (Vite) UI talks to that server for chat, vision-style prompts with images, and image generation.

## Prerequisites

- [Node.js](https://nodejs.org/) (recent LTS is fine)
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

- Server: `npm run start -w server` (runs `node dist/index.js` after `tsc`).
- Web: static assets are emitted under `web/dist`; serve them with any static host, or use `npm run preview -w web` to preview the build.

If the browser does not use the Vite proxy, set `VITE_API_URL` in `.env` to your deployed API origin (see `env.example`).

## Project layout

| Package   | Role |
|-----------|------|
| `server/` | Express app: validates requests, forwards to Ollama, streams SSE for chat and generate |
| `web/`    | React + Tailwind UI: model picker, text chat, image-in-chat, image generation |

## API (server)

All routes are relative to the server base URL (e.g. `http://127.0.0.1:3001`).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness check |
| GET | `/api/models` | Lists models (`GET /api/tags` on Ollama) |
| POST | `/api/chat` | Chat completion; supports streaming (SSE) and optional image inputs |
| POST | `/api/generate` | Generate (e.g. images); supports streaming (SSE) and optional dimensions/steps |

The server reads `OLLAMA_HOST` and `PORT` from the environment (or `.env` via `dotenv`).

## License

Private project (`"private": true` in `package.json`). Add a license file if you open-source this repo.
