const API_BASE = (window.STREAM_SHOWS_API_BASE
  || (location.hostname.endsWith(".github.io")
    ? "https://shad-server.elf-tarpon.ts.net:8443"
    : ""));

const view = document.getElementById("view");
const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
const typeFilter = document.getElementById("type-filter");
const yearFilter = document.getElementById("year-filter");
const homeLink = document.getElementById("home-link");
const logoutLink = document.getElementById("logout-link");

let providersCache = null;
let currentProviderName = "";
let currentMedia = null;

homeLink.addEventListener("click", () => {
  searchInput.value = "";
  renderHome();
});
logoutLink.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" });
  renderLogin();
});

async function api(path, options = {}) {
  const r = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    ...options,
  });
  if (r.status === 401 && path !== "/api/login") {
    renderLogin();
    throw new Error("__login_required__");
  }
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${r.status}: ${text}`);
  }
  return r.status === 204 ? null : r.json();
}

async function loadProviders(force = false) {
  if (providersCache && !force) return providersCache;
  providersCache = await api("/api/providers");
  currentProviderName ||= providersCache.default;
  return providersCache;
}

function showError(err) {
  if (err?.message === "__login_required__") return;
  view.innerHTML = `<div class="error">${err.message || err}</div>`;
}

function setAppVisible(visible) {
  document.body.classList.toggle("logged-out", !visible);
}

function renderLogin(message = "") {
  setAppVisible(false);
  view.innerHTML = `
    <section class="login-panel">
      <form id="login-form">
        <h2>Login</h2>
        ${message ? `<p class="login-message">${message}</p>` : ""}
        <label>Username
          <input id="login-username" type="text" autocomplete="username" required />
        </label>
        <label>Password
          <input id="login-password" type="password" autocomplete="current-password" required />
        </label>
        <button type="submit">Login</button>
      </form>
    </section>`;

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/login", {
        method: "POST",
        body: JSON.stringify({
          username: document.getElementById("login-username").value,
          password: document.getElementById("login-password").value,
        }),
      });
      await bootApp();
    } catch {
      renderLogin("Invalid username or password.");
    }
  });
}

async function renderHome() {
  setAppVisible(true);
  view.innerHTML = `<div class="empty">Loading...</div>`;
  try {
    const data = await api("/api/home");
    renderHomeContent(data);
  } catch (err) {
    showError(err);
  }
}

function renderHomeContent(data) {
  const heroHtml = data.hero ? renderHero(data.hero) : "";
  const railsHtml = (data.rails || [])
    .filter((rail) => rail.items?.length)
    .map((rail) => relatedSection(rail.label, rail.items))
    .join("");
  view.innerHTML = heroHtml + railsHtml || `
    <section class="empty">
      <h2>Search for a movie or TV show.</h2>
      <p>Pick a result, choose a provider, then play it here.</p>
    </section>`;
  hydrateRelatedCards();
  const heroView = document.getElementById("hero-view");
  if (heroView) {
    heroView.addEventListener("click", () =>
      openDetail(heroView.dataset.type, heroView.dataset.id),
    );
  }
}

function renderHero(h) {
  const bg = h.backdrop ? `style="background-image:url('${h.backdrop}')"` : "";
  const safeTitle = escapeAttr(h.title || "");
  const overview = escapeAttr(h.overview || "");
  return `
    <section class="detail-hero home-hero" ${bg}>
      <div class="detail-flex">
        ${h.poster ? `<img class="detail-poster" src="${h.poster}" alt="" />` : ""}
        <div class="detail-meta">
          <h2>${safeTitle}</h2>
          <div class="pills">
            ${h.year ? `<span class="pill">${escapeAttr(h.year)}</span>` : ""}
            ${typeof h.vote === "number" ? `<span class="pill">Star ${h.vote.toFixed(1)}</span>` : ""}
            <span class="pill">${h.media_type === "tv" ? "TV" : "Movie"}</span>
          </div>
          <p class="overview">${overview}</p>
          <div class="actions">
            <button id="hero-view" data-type="${escapeAttr(h.media_type)}" data-id="${escapeAttr(h.id)}">View</button>
          </div>
        </div>
      </div>
    </section>`;
}

function titleMeta(item) {
  return `${item.media_type === "tv" ? "TV" : "Movie"}${item.year ? " - " + item.year : ""}`;
}

function makeTitleCard(item) {
  const card = document.createElement("article");
  card.className = "card";
  card.innerHTML = `
    <img class="card-poster" alt="" src="${item.poster || ""}" />
    <div class="card-body">
      <h3 class="card-title"></h3>
      <p class="card-meta"></p>
    </div>`;
  card.querySelector(".card-title").textContent = item.title || "(untitled)";
  card.querySelector(".card-meta").textContent = titleMeta(item);
  card.addEventListener("click", () => openDetail(item.media_type, item.id || item.tmdb_id));
  return card;
}

function renderTitleGrid(items, emptyText = "No results.") {
  if (!items.length) {
    view.innerHTML = `<div class="empty">${emptyText}</div>`;
    return;
  }
  const grid = document.createElement("div");
  grid.className = "grid";
  items.forEach((item) => grid.appendChild(makeTitleCard(item)));
  view.innerHTML = "";
  view.appendChild(grid);
}

searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (!q) return;
  const params = new URLSearchParams({ q });
  if (typeFilter.value) params.set("type", typeFilter.value);
  if (yearFilter.value.trim()) params.set("year", yearFilter.value.trim());
  view.innerHTML = `<div class="empty">Searching...</div>`;
  try {
    const data = await api(`/api/search?${params}`);
    renderTitleGrid(data.results);
  } catch (err) {
    showError(err);
  }
});

async function openDetail(mediaType, id) {
  view.innerHTML = `<div class="empty">Loading...</div>`;
  try {
    const data = await api(`/api/${mediaType}/${id}`);
    if (mediaType === "movie") renderMovieDetail(data);
    else renderTvDetail(data);
  } catch (err) {
    showError(err);
  }
}

function detailHero(d) {
  const bg = d.backdrop ? `style="background-image:url('${d.backdrop}')"` : "";
  const cast = (d.cast || []).map((c) => c.name).join(" - ");
  return `
    <section class="detail-hero" ${bg}>
      <div class="detail-flex">
        ${d.poster ? `<img class="detail-poster" src="${d.poster}" alt="" />` : ""}
        <div class="detail-meta">
          <h2></h2>
          ${d.tagline ? `<p class="tagline"></p>` : ""}
          <div class="pills">
            ${d.year ? `<span class="pill">${d.year}</span>` : ""}
            ${d.runtime ? `<span class="pill">${d.runtime} min</span>` : ""}
            ${d.number_of_seasons ? `<span class="pill">${d.number_of_seasons} seasons</span>` : ""}
            ${typeof d.vote === "number" ? `<span class="pill">Star ${d.vote.toFixed(1)}</span>` : ""}
            ${(d.genres || []).map((g) => `<span class="pill">${g}</span>`).join("")}
          </div>
          <p class="overview"></p>
          ${cast ? `<p class="cast-line"><small>${cast}</small></p>` : ""}
          <div class="actions" id="actions"></div>
        </div>
      </div>
    </section>`;
}

function fillHeroText(d) {
  view.querySelector(".detail-meta h2").textContent = d.title || "";
  const tag = view.querySelector(".tagline");
  if (tag) tag.textContent = d.tagline || "";
  view.querySelector(".overview").textContent = d.overview || "";
}

function addFavoriteButton(d) {
}

function addTrailerButton(d) {
  if (!d.trailer?.url) return;
  const btn = document.createElement("button");
  btn.className = "secondary";
  btn.textContent = "Trailer";
  btn.addEventListener("click", () => renderIframePlayer({
    url: d.trailer.url,
    label: "YouTube Trailer",
    openUrl: d.trailer.url,
  }));
  document.getElementById("actions").appendChild(btn);
}

function renderMovieDetail(d) {
  view.innerHTML = detailHero(d) + `
    <div id="player-slot"></div>
    ${relatedSection("Recommended", d.recommendations)}
    ${relatedSection("Similar", d.similar)}`;
  fillHeroText(d);
  const playBtn = document.createElement("button");
  playBtn.textContent = "Play";
  playBtn.addEventListener("click", () => playMedia({
    media_type: "movie",
    type: "movie",
    tmdb_id: d.id,
    imdb_id: d.imdb_id || "",
    title: d.title,
    poster: d.poster,
  }));
  document.getElementById("actions").appendChild(playBtn);
  addTrailerButton(d);
  hydrateRelatedCards();
}

function renderTvDetail(d) {
  view.innerHTML = detailHero(d) + `
    <h3 class="section-title">Seasons</h3>
    <div class="season-tabs" id="season-tabs"></div>
    <div id="episodes-slot"></div>
    <div id="player-slot"></div>
    ${relatedSection("Recommended", d.recommendations)}
    ${relatedSection("Similar", d.similar)}`;
  fillHeroText(d);
  addTrailerButton(d);

  const tabs = document.getElementById("season-tabs");
  const seasons = (d.seasons || []).filter((s) => s.season_number >= 1);
  for (const s of seasons) {
    const tab = document.createElement("button");
    tab.className = "season-tab";
    tab.textContent = s.name || `Season ${s.season_number}`;
    tab.addEventListener("click", () => {
      tabs.querySelectorAll(".season-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      loadEpisodes(d, s.season_number);
    });
    tabs.appendChild(tab);
  }
  if (seasons.length) tabs.firstChild.click();
  hydrateRelatedCards();
}

function relatedSection(title, items = []) {
  if (!items.length) return "";
  return `
    <h3 class="section-title">${title}</h3>
    <div class="rail">
      ${items.map((item) => `
        <button class="mini-card" data-type="${item.media_type}" data-id="${item.id}">
          <img alt="" src="${item.poster || ""}" />
          <span>${item.title || "(untitled)"}</span>
        </button>`).join("")}
    </div>`;
}

function hydrateRelatedCards() {
  view.querySelectorAll(".mini-card").forEach((card) => {
    card.addEventListener("click", () => openDetail(card.dataset.type, card.dataset.id));
  });
}

async function loadEpisodes(show, seasonNumber) {
  const slot = document.getElementById("episodes-slot");
  slot.innerHTML = `<div class="empty">Loading episodes...</div>`;
  try {
    const data = await api(`/api/tv/${show.id}/season/${seasonNumber}`);
    const grid = document.createElement("div");
    grid.className = "episodes";
    for (const ep of data.episodes) {
      const card = document.createElement("button");
      card.className = "episode";
      card.innerHTML = `
        <img src="${ep.still || ""}" alt="" />
        <div class="episode-body">
          <h4></h4>
          <p></p>
        </div>`;
      card.querySelector("h4").textContent = `${ep.episode_number}. ${ep.name || ""}`;
      card.querySelector("p").textContent = ep.overview || "";
      card.addEventListener("click", () => playMedia({
        media_type: "tv",
        type: "tv",
        tmdb_id: show.id,
        imdb_id: show.imdb_id || "",
        season: seasonNumber,
        episode: ep.episode_number,
        title: `${show.title} S${seasonNumber} E${ep.episode_number}`,
        poster: ep.still || show.poster,
      }));
      grid.appendChild(card);
    }
    slot.innerHTML = "";
    slot.appendChild(grid);
  } catch (err) {
    showError(err);
  }
}

async function playMedia(media, providerName = "") {
  await loadProviders(true);
  currentMedia = media;
  const selected = providerName || currentProviderName || providersCache.default;
  currentProviderName = selected;
  const qs = new URLSearchParams({
    provider: selected,
    type: media.type,
    tmdb_id: media.tmdb_id,
    imdb_id: media.imdb_id || "",
    season: media.season || "",
    episode: media.episode || "",
  });
  try {
    const { candidates } = await api(`/api/embed-candidates?${qs}`);
    if (!candidates.length) throw new Error("No enabled provider supports this title type.");
    startFallbackPlayer(candidates, media, 0, selected);
  } catch (err) {
    showError(err);
  }
}

function startFallbackPlayer(candidates, media, index, selectedProvider = "") {
  const current = candidates[index];
  currentProviderName = current.provider || selectedProvider || currentProviderName;
  renderIframePlayer({
    url: current.url,
    label: current.label,
    openUrl: current.url,
    iframeOptions: current.iframe || {},
    media,
    activeProvider: current.provider,
    onFail: index + 1 < candidates.length ? () => startFallbackPlayer(candidates, media, index + 1) : null,
    fallbackLabel: candidates[index + 1]?.label,
  });
}

function providerPickerHtml(media, activeProvider) {
  if (!media || !providersCache?.providers?.length) return "";
  const options = providersCache.providers
    .filter((p) => p.enabled !== false && p.supports?.[media.type])
    .map((p) => `<option value="${p.name}" ${p.name === activeProvider ? "selected" : ""}>${p.label || p.name}</option>`)
    .join("");
  if (!options) return "";
  return `
    <label class="player-provider">Provider
      <select id="player-provider-select">${options}</select>
    </label>`;
}

function escapeAttr(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderIframePlayer({
  url,
  label,
  openUrl,
  iframeOptions = {},
  media = null,
  activeProvider = "",
  onFail = null,
  fallbackLabel = "",
}) {
  const slot = document.getElementById("player-slot") || view;
  const allow = iframeOptions.allow || "autoplay; encrypted-media; fullscreen; picture-in-picture";
  const referrerPolicy = iframeOptions.referrer_policy || "strict-origin-when-cross-origin";
  const sandbox = iframeOptions.sandbox || "";
  const scrolling = iframeOptions.scrolling || "no";
  const frameborder = iframeOptions.frameborder || "0";
  const allowFullscreen = iframeOptions.allowfullscreen !== false;
  const safeUrl = escapeAttr(url);
  const safeOpenUrl = escapeAttr(openUrl);
  const safeLabel = escapeAttr(label);
  const safeFallbackLabel = escapeAttr(fallbackLabel);
  const sandboxAttr = sandbox ? `sandbox="${escapeAttr(sandbox)}"` : "";
  const referrerAttr = referrerPolicy ? `referrerpolicy="${escapeAttr(referrerPolicy)}"` : "";
  const allowFullscreenAttr = allowFullscreen ? "allowfullscreen" : "";
  slot.innerHTML = `
    <div class="player-heading">
      <h3 class="section-title">Player</h3>
      ${providerPickerHtml(media, activeProvider)}
    </div>
    <p class="player-info">Loaded: <b>${safeLabel}</b> - <a href="${safeOpenUrl}" target="_blank" rel="noreferrer">open in new tab</a></p>
    <div class="player-tools">
      <button id="reload-player" class="secondary" type="button">Reload</button>
      <a class="button-link" href="${safeOpenUrl}" target="_blank" rel="noreferrer">Open outside iframe</a>
      ${onFail ? `<button id="try-next" class="secondary">Try ${safeFallbackLabel}</button>` : ""}
    </div>
    <div id="player-wrap">
      <iframe
        src="${safeUrl}"
        ${referrerAttr}
        ${sandboxAttr}
        frameborder="${escapeAttr(frameborder)}"
        scrolling="${escapeAttr(scrolling)}"
        ${allowFullscreenAttr}
        allow="${escapeAttr(allow)}">
      </iframe>
    </div>`;

  const iframe = slot.querySelector("iframe");
  const reloadPlayer = slot.querySelector("#reload-player");
  if (reloadPlayer) {
    reloadPlayer.addEventListener("click", () => {
      iframe.dataset.loaded = "";
      iframe.src = url;
    });
  }
  iframe.addEventListener("load", () => {
    iframe.dataset.loaded = "true";
  });
  const tryNext = slot.querySelector("#try-next");
  if (tryNext && onFail) tryNext.addEventListener("click", onFail);
  const picker = slot.querySelector("#player-provider-select");
  if (picker && media) {
    picker.addEventListener("change", () => playMedia(media, picker.value));
  }
  slot.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function bootApp() {
  setAppVisible(true);
  try {
    await loadProviders(true);
  } catch (err) {
    showError(err);
  }
  renderHome();
}

(async () => {
  try {
    const session = await api("/api/session");
    if (session.authenticated) await bootApp();
    else renderLogin();
  } catch {
    renderLogin();
  }
})();
