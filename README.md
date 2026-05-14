# stream-shows (frontend)

Vanilla HTML/CSS/JS frontend for the stream-shows TMDB browser. Static site, no build step. Backend lives in a separate repo (`video-streaming-site-gh`, deployed to a Tailscale-only Docker container).

Live: https://sh-islam.github.io/stream-shows/

## How it finds the backend

`app.js` picks the API base from `window.STREAM_SHOWS_API_BASE`, then falls back to:

- `https://shad-server.elf-tarpon.ts.net` when the page is served from `*.github.io` (only reachable from devices on the tailnet)
- empty string (same-origin) otherwise — for local dev when the Flask backend serves the static files

Override at runtime in the browser console: `window.STREAM_SHOWS_API_BASE = "http://localhost:5000"`.

## Local dev

Run the backend (`python app.py` in the backend repo) at `http://localhost:5000`. It serves these static files too, so just open the backend URL.

To preview the static files without the backend, use any static server:

```bash
python -m http.server 8080
```

Then visit http://localhost:8080 — API calls will hit `localhost:8080` (no backend) and 404; for a real loop, run the backend.

## Deploy

Pushing to `main` on GitHub triggers GitHub Pages to rebuild from the repo root.
