# stream-shows frontend

Vanilla HTML/CSS/JS frontend for a personal media browser. There is no build step.

Live: https://sh-islam.github.io/stream-shows/

## What this repo contains

- Login screen and authenticated app shell.
- Home, search, detail, season, episode, and favorites views.
- Client-side routing so browser Back/Forward works inside the app.
- Player UI, source selection, fullscreen controls, and episode navigation.
- Per-user favorites UI synced through the backend.
- Favorites page with backend-generated recommendations.
- Static assets for icons, fallback posters, and styling.

## Backend API

The frontend talks to the backend through these main route groups:

```text
GET  /api/session
POST /api/login
POST /api/logout

GET /api/home
GET /api/search
GET /api/movie/:id
GET /api/tv/:id
GET /api/tv/:id/season/:season

GET /api/providers
GET /api/embed-candidates

GET    /api/me/library
POST   /api/me/favorites
DELETE /api/me/favorites/:key
GET    /api/me/recommendations
```

## Client Routes

The app owns these browser routes:

```text
/
/search?q=...
/movie/:id
/tv/:id
/tv/:id/season/:season
/tv/:id/season/:season/episode/:episode
/favorites
```

`404.html` mirrors `index.html` so static hosting can reload deep links into the app.

## Backend Selection

`app.js` reads `window.STREAM_SHOWS_API_BASE` first. If that is not set, it uses the production backend when served from GitHub Pages, and same-origin otherwise.

Override during local/static testing:

```js
window.STREAM_SHOWS_API_BASE = "http://localhost:5000";
```

## Local Dev

Best local loop: run the backend from the backend repo, then open the backend URL. The backend serves these frontend files and API calls are same-origin.

```powershell
python app.py
```

Static-only preview is possible, but API calls need `window.STREAM_SHOWS_API_BASE` pointed at a running backend:

```bash
python -m http.server 8080
```

## Deploy

Pushing frontend `main` to GitHub triggers GitHub Pages to rebuild.
