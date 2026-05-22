const API_BASE = (window.STREAM_SHOWS_API_BASE
  || (location.hostname.endsWith(".github.io")
    ? "https://shad-server.elf-tarpon.ts.net:8443"
    : ""));
const AUTH_TOKEN_KEY = "streamEmbedderToken";
const APP_BASE = location.hostname.endsWith(".github.io")
  ? `/${location.pathname.split("/").filter(Boolean)[0] || "stream-shows"}`
  : "";

const view = document.getElementById("view");
const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
const typeFilter = document.getElementById("type-filter");
const yearFilter = document.getElementById("year-filter");
const homeLink = document.getElementById("home-link");
const favoritesLink = document.getElementById("favorites-link");
const userLabel = document.getElementById("user-label");
const logoutLink = document.getElementById("logout-link");
const MISSING_IMAGE_SRC = "broken_image.png";

let providersCache = null;
let currentProviderName = "";
let currentMedia = null;
let viewController = null;
let fullscreenSyncController = null;
let searchDebounceTimer = null;
let currentUser = "";
let libraryCache = { favorites: [], resume: {} };
let recommendationsCache = [];

function routePath() {
  let path = location.pathname;
  if (APP_BASE && path.startsWith(APP_BASE)) path = path.slice(APP_BASE.length) || "/";
  return path || "/";
}

function appUrl(path, params = null) {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const query = params instanceof URLSearchParams && params.toString() ? `?${params}` : "";
  return `${APP_BASE}${cleanPath}${query}`;
}

function setRoute(path, { replace = false, params = null } = {}) {
  const url = appUrl(path, params);
  if (`${location.pathname}${location.search}` === url) return;
  history[replace ? "replaceState" : "pushState"]({}, "", url);
}

function navigate(path, options = {}) {
  setRoute(path, options);
  renderCurrentRoute();
}

function newViewSignal() {
  if (viewController) viewController.abort();
  viewController = new AbortController();
  return viewController.signal;
}

function isAbortError(err) {
  return err?.name === "AbortError" || /aborted/i.test(err?.message || "");
}

function loadingHtml(text = "Loading") {
  return `<div class="loading"><div class="spinner"></div><span>${text}</span></div>`;
}

function imageSrc(src) {
  return src || MISSING_IMAGE_SRC;
}

function bindImageFallbacks(root = document) {
  root.querySelectorAll("img").forEach((img) => {
    if (img.dataset.fallbackBound) return;
    img.dataset.fallbackBound = "true";
    img.addEventListener("error", () => {
      if (!img.src.endsWith(MISSING_IMAGE_SRC)) img.src = MISSING_IMAGE_SRC;
    });
  });
}

homeLink.addEventListener("click", () => {
  searchInput.value = "";
  typeFilter.value = "";
  yearFilter.value = "";
  navigate("/");
});
favoritesLink.addEventListener("click", () => navigate("/favorites"));
logoutLink.addEventListener("click", async () => {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  currentUser = "";
  libraryCache = { favorites: [], resume: {} };
  await api("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
  renderLogin();
});

async function api(path, options = {}) {
  const { signal, ...rest } = options;
  const headers = { ...(rest.headers || {}) };
  if (rest.body) headers["Content-Type"] = "application/json";
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers,
    signal,
    ...rest,
  });
  if (r.status === 401 && path !== "/api/login") {
    localStorage.removeItem(AUTH_TOKEN_KEY);
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
  if (isAbortError(err)) return;
  view.innerHTML = `<div class="error">${err.message || err}</div>`;
}

function syncSearchInputs(params) {
  searchInput.value = params.get("q") || "";
  typeFilter.value = params.get("type") || "";
  yearFilter.value = params.get("year") || "";
}

function searchParamsFromInputs() {
  const params = new URLSearchParams();
  const q = searchInput.value.trim();
  if (q) params.set("q", q);
  if (typeFilter.value) params.set("type", typeFilter.value);
  if (yearFilter.value.trim()) params.set("year", yearFilter.value.trim());
  return params;
}

function setCurrentUser(username = "") {
  currentUser = username;
  userLabel.textContent = username ? username : "";
}

async function loadLibrary() {
  libraryCache = await api("/api/me/library");
  libraryCache.favorites ||= [];
  libraryCache.resume ||= {};
  refreshFavoriteButtons();
  return libraryCache;
}

function favoriteKey(item) {
  const type = item?.type || item?.media_type;
  const id = item?.tmdb_id || item?.id;
  if (!type || !id) return "";
  return `${type}:${id}`;
}

function itemFromDataset(el) {
  return {
    type: el.dataset.type,
    media_type: el.dataset.type,
    tmdb_id: el.dataset.tmdbId,
    id: el.dataset.tmdbId,
    title: el.dataset.title || "",
    poster: el.dataset.poster || "",
    year: el.dataset.year || "",
  };
}

function favoritePayload(item) {
  const type = item?.type || item?.media_type;
  const id = item?.tmdb_id || item?.id;
  return {
    type,
    media_type: type,
    tmdb_id: id,
    id,
    title: item?.title || "",
    poster: item?.poster || "",
    year: item?.year || "",
  };
}

function isFavorite(item) {
  const key = favoriteKey(item);
  return Boolean(key && libraryCache.favorites?.some((fav) => fav.key === key || favoriteKey(fav) === key));
}

function tvResumeKey(showOrId) {
  const id = typeof showOrId === "object" ? showOrId?.tmdb_id || showOrId?.id : showOrId;
  return id ? `tv:${id}` : "";
}

function resumeForShow(showOrId) {
  const key = tvResumeKey(showOrId);
  return key ? libraryCache.resume?.[key] : null;
}

function favoriteButtonHtml(item, extraClass = "") {
  const payload = favoritePayload(item);
  if (!payload.type || !payload.tmdb_id) return "";
  const active = isFavorite(payload);
  return `
    <button
      class="favorite-toggle ${extraClass} ${active ? "active" : ""}"
      type="button"
      aria-label="${active ? "Remove from favorites" : "Add to favorites"}"
      aria-pressed="${active ? "true" : "false"}"
      data-type="${escapeAttr(payload.type)}"
      data-tmdb-id="${escapeAttr(payload.tmdb_id)}"
      data-title="${escapeAttr(payload.title)}"
      data-poster="${escapeAttr(payload.poster)}"
      data-year="${escapeAttr(payload.year)}">
      ${active ? "&#9829;" : "&#9825;"}
    </button>`;
}

function refreshFavoriteButtons(root = document) {
  root.querySelectorAll(".favorite-toggle").forEach((button) => {
    const item = itemFromDataset(button);
    const active = isFavorite(item);
    button.classList.toggle("active", active);
    button.innerHTML = active ? "&#9829;" : "&#9825;";
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.setAttribute("aria-label", active ? "Remove from favorites" : "Add to favorites");
  });
}

function bindFavoriteButtons(root = document) {
  root.querySelectorAll(".favorite-toggle:not([data-bound='true'])").forEach((button) => {
    button.dataset.bound = "true";
    button.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const item = itemFromDataset(button);
      const key = favoriteKey(item);
      if (!key) return;
      button.disabled = true;
      try {
        if (isFavorite(item)) {
          const data = await api(`/api/me/favorites/${encodeURIComponent(key)}`, { method: "DELETE" });
          libraryCache.favorites = data.favorites || [];
        } else {
          const data = await api("/api/me/favorites", {
            method: "POST",
            body: JSON.stringify(favoritePayload(item)),
          });
          libraryCache.favorites = data.favorites || [];
        }
        refreshFavoriteButtons();
        if (routePath() === "/favorites") {
          recommendationsCache = [];
          renderFavoritesPage();
        }
      } catch (err) {
        showError(err);
      } finally {
        button.disabled = false;
      }
    });
  });
  refreshFavoriteButtons(root);
}

function setAppVisible(visible) {
  document.body.classList.toggle("logged-out", !visible);
}

function renderLogin(message = "") {
  setAppVisible(false);
  view.innerHTML = `
    <section class="login-panel">
      <form id="login-form">
        <div class="login-brand">
          <img src="icon.png" alt="" />
        </div>
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
      const login = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({
          username: document.getElementById("login-username").value,
          password: document.getElementById("login-password").value,
        }),
      });
      if (login.token) localStorage.setItem(AUTH_TOKEN_KEY, login.token);
      await bootApp(login);
    } catch {
      renderLogin("Invalid username or password.");
    }
  });
}

async function renderHome() {
  setAppVisible(true);
  const signal = newViewSignal();
  view.innerHTML = loadingHtml();
  window.scrollTo({ top: 0, behavior: "instant" });
  try {
    const data = await api("/api/home", { signal });
    if (signal.aborted) return;
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
  bindImageFallbacks(view);
  bindFavoriteButtons(view);
  hydrateRelatedCards();
  const heroView = document.getElementById("hero-view");
  if (heroView) {
    heroView.addEventListener("click", () =>
      navigate(`/${heroView.dataset.type}/${heroView.dataset.id}`),
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
        <div class="poster-shell">
          <img class="detail-poster" src="${imageSrc(h.poster)}" alt="" />
          ${favoriteButtonHtml({
            type: h.media_type,
            media_type: h.media_type,
            tmdb_id: h.id,
            id: h.id,
            title: h.title,
            poster: h.poster,
            year: h.year,
          }, "poster-favorite")}
        </div>
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
    <div class="poster-shell">
      <img class="card-poster" alt="" src="${imageSrc(item.poster)}" />
      ${favoriteButtonHtml(item, "poster-favorite")}
    </div>
    <div class="card-body">
      <h3 class="card-title"></h3>
      <p class="card-meta"></p>
    </div>`;
  card.querySelector(".card-title").textContent = item.title || "(untitled)";
  card.querySelector(".card-meta").textContent = titleMeta(item);
  card.addEventListener("click", () => navigate(`/${item.media_type}/${item.id || item.tmdb_id}`));
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
  bindImageFallbacks(view);
  bindFavoriteButtons(view);
}

function libraryItemMeta(item) {
  if (item.type === "tv" && item.season && item.episode) {
    return `TV - S${item.season} E${item.episode}${item.episode_name ? " - " + item.episode_name : ""}`;
  }
  return `${item.type === "tv" ? "TV" : "Movie"}${item.year ? " - " + item.year : ""}`;
}

function makeLibraryCard(item, { showHeart = true } = {}) {
  const card = document.createElement("article");
  card.className = "card";
  card.innerHTML = `
    <div class="poster-shell">
      <img class="card-poster" alt="" src="${imageSrc(item.poster)}" />
      ${showHeart ? favoriteButtonHtml(item, "poster-favorite") : ""}
    </div>
    <div class="card-body">
      <h3 class="card-title"></h3>
      <p class="card-meta"></p>
    </div>`;
  card.querySelector(".card-title").textContent = item.title || "(untitled)";
  card.querySelector(".card-meta").textContent = libraryItemMeta(item);
  card.addEventListener("click", () => {
    if (item.type === "tv" && item.season && item.episode) {
      navigate(`/tv/${item.tmdb_id}/season/${item.season}/episode/${item.episode}`);
    } else {
      navigate(`/${item.type}/${item.tmdb_id}`);
    }
  });
  return card;
}

function renderLibraryGrid(title, items, emptyText, options = {}) {
  setAppVisible(true);
  view.innerHTML = `
    <h3 class="section-title">${title}</h3>
    <div id="library-grid"></div>
    ${options.afterHtml || ""}`;
  const grid = document.getElementById("library-grid");
  if (!items.length) {
    grid.outerHTML = `<div class="empty">${emptyText}</div>`;
  } else {
    grid.className = "grid";
    items.forEach((item) => grid.appendChild(makeLibraryCard(item, options)));
  }
  bindImageFallbacks(view);
  bindFavoriteButtons(view);
  window.scrollTo({ top: 0, behavior: "instant" });
}

function renderFavoritesPage() {
  renderLibraryGrid("Favorites", libraryCache.favorites || [], "No favorites yet.", {
    afterHtml: `
      <h3 class="section-title">Recommended for you</h3>
      <div id="recommendations-slot">${loadingHtml("Finding picks")}</div>`,
  });
  loadRecommendations();
}

async function loadRecommendations() {
  const slot = document.getElementById("recommendations-slot");
  if (!slot) return;
  try {
    const data = await api("/api/me/recommendations?limit=20");
    recommendationsCache = data.results || [];
    if (!recommendationsCache.length) {
      slot.innerHTML = `<div class="empty">No recommendations yet.</div>`;
      return;
    }
    const grid = document.createElement("div");
    grid.className = "grid";
    recommendationsCache.forEach((item) => grid.appendChild(makeTitleCard(item)));
    slot.innerHTML = "";
    slot.appendChild(grid);
    bindImageFallbacks(slot);
    bindFavoriteButtons(slot);
  } catch (err) {
    slot.innerHTML = `<div class="error">${err.message || err}</div>`;
  }
}

async function runSearch({
  showLoading = true,
  resetScroll = false,
  updateRoute = false,
  replaceRoute = true,
} = {}) {
  const q = searchInput.value.trim();
  if (!q) {
    if (viewController) viewController.abort();
    if (updateRoute) setRoute("/", { replace: replaceRoute });
    renderHome();
    return;
  }
  const params = searchParamsFromInputs();
  if (updateRoute) setRoute("/search", { replace: replaceRoute, params });
  const signal = newViewSignal();
  if (showLoading) view.innerHTML = loadingHtml("Searching");
  if (resetScroll) window.scrollTo({ top: 0, behavior: "instant" });
  try {
    const data = await api(`/api/search?${params}`, { signal });
    if (signal.aborted) return;
    renderTitleGrid(data.results);
  } catch (err) {
    showError(err);
  }
}

function scheduleSearch() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    runSearch({
      showLoading: searchInput.value.trim().length > 0,
      updateRoute: true,
      replaceRoute: routePath() === "/search",
    });
  }, 300);
}

searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearTimeout(searchDebounceTimer);
  await runSearch({ resetScroll: true, updateRoute: true, replaceRoute: false });
});

searchInput.addEventListener("input", scheduleSearch);
typeFilter.addEventListener("change", () => runSearch({
  showLoading: searchInput.value.trim().length > 0,
  updateRoute: true,
  replaceRoute: routePath() === "/search",
}));
yearFilter.addEventListener("input", scheduleSearch);

async function openDetail(mediaType, id, routeState = {}) {
  const signal = newViewSignal();
  view.innerHTML = loadingHtml();
  window.scrollTo({ top: 0, behavior: "instant" });
  try {
    const data = await api(`/api/${mediaType}/${id}`, { signal });
    if (signal.aborted) return;
    if (mediaType === "movie") renderMovieDetail(data);
    else renderTvDetail(data, routeState);
  } catch (err) {
    showError(err);
  }
}

function detailHero(d) {
  const bg = d.backdrop ? `style="background-image:url('${d.backdrop}')"` : "";
  const cast = (d.cast || []).map((c) => c.name).join(" - ");
  const favItem = {
    type: d.media_type,
    media_type: d.media_type,
    tmdb_id: d.id,
    id: d.id,
    title: d.title,
    poster: d.poster,
    year: d.year,
  };
  return `
    <section class="detail-hero" ${bg}>
      <div class="detail-flex">
        <div class="poster-shell">
          <img class="detail-poster" src="${imageSrc(d.poster)}" alt="" />
          ${favoriteButtonHtml(favItem, "poster-favorite")}
        </div>
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
  bindImageFallbacks(view);
  bindFavoriteButtons(view);
  hydrateRelatedCards();
}

function renderTvDetail(d, routeState = {}) {
  const savedResume = resumeForShow(d);
  const shouldResume = savedResume && !routeState.season && !routeState.episode;
  const initialSeason = shouldResume ? savedResume.season : routeState.season;
  const initialEpisode = shouldResume ? savedResume.episode : routeState.episode;
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
  const targetSeason = Number(initialSeason || seasons[0]?.season_number || 0);
  for (const s of seasons) {
    const tab = document.createElement("button");
    tab.className = `season-tab${s.season_number === targetSeason ? " active" : ""}`;
    tab.dataset.season = String(s.season_number);
    tab.textContent = s.name || `Season ${s.season_number}`;
    tab.addEventListener("click", () => {
      tabs.querySelectorAll(".season-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      setRoute(`/tv/${d.id}/season/${s.season_number}`);
      loadEpisodes(d, s.season_number);
    });
    tabs.appendChild(tab);
  }
  if (shouldResume) {
    setRoute(`/tv/${d.id}/season/${savedResume.season}/episode/${savedResume.episode}`, { replace: true });
  }
  if (targetSeason) loadEpisodes(d, targetSeason, initialEpisode);
  addStartOverButton(d, seasons);
  bindImageFallbacks(view);
  bindFavoriteButtons(view);
  hydrateRelatedCards();
}

function relatedSection(title, items = []) {
  if (!items.length) return "";
  return `
    <h3 class="section-title">${title}</h3>
    <div class="rail-wrap">
      <button class="rail-arrow left" type="button" aria-label="Scroll left">&lsaquo;</button>
      <div class="rail">
        ${items.map((item) => `
          <article class="mini-card" data-type="${item.media_type}" data-id="${item.id}" role="button" tabindex="0">
            <div class="poster-shell">
              <img alt="" src="${imageSrc(item.poster)}" />
              ${favoriteButtonHtml(item, "poster-favorite")}
            </div>
            <span>${item.title || "(untitled)"}</span>
          </article>`).join("")}
      </div>
      <button class="rail-arrow right" type="button" aria-label="Scroll right">&rsaquo;</button>
    </div>`;
}

function hydrateRelatedCards() {
  bindFavoriteButtons(view);
  view.querySelectorAll(".rail:not([data-drag-bound='true'])").forEach(enableDragScroll);
  view.querySelectorAll(".rail-wrap:not([data-arrow-bound='true'])").forEach(wireRailArrows);
}

function wireRailArrows(wrap) {
  wrap.dataset.arrowBound = "true";
  const rail = wrap.querySelector(".rail");
  const leftBtn = wrap.querySelector(".rail-arrow.left");
  const rightBtn = wrap.querySelector(".rail-arrow.right");
  if (!rail || !leftBtn || !rightBtn) return;

  const refresh = () => {
    const max = rail.scrollWidth - rail.clientWidth - 1;
    leftBtn.disabled = rail.scrollLeft <= 0;
    rightBtn.disabled = max <= 0 || rail.scrollLeft >= max;
  };
  const step = (dir) => {
    rail.scrollBy({ left: dir * rail.clientWidth * 0.85, behavior: "smooth" });
  };

  leftBtn.addEventListener("click", () => step(-1));
  rightBtn.addEventListener("click", () => step(1));
  rail.addEventListener("scroll", refresh, { passive: true });
  window.addEventListener("resize", refresh);
  refresh();
  setTimeout(refresh, 200);
  rail.querySelectorAll("img").forEach((img) => {
    if (!img.complete) img.addEventListener("load", refresh, { once: true });
  });
}

function enableDragScroll(rail) {
  rail.dataset.dragBound = "true";
  const DRAG_THRESHOLD = 10;
  let active = false;
  let dragged = false;
  let suppressClick = false;
  let startX = 0;
  let startScrollLeft = 0;
  let pointerId = null;

  rail.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse") return;
    active = true;
    dragged = false;
    startX = e.clientX;
    startScrollLeft = rail.scrollLeft;
    pointerId = e.pointerId;
  });

  rail.addEventListener("pointermove", (e) => {
    if (!active) return;
    const dx = e.clientX - startX;
    if (!dragged && Math.abs(dx) > DRAG_THRESHOLD) {
      dragged = true;
      suppressClick = true;
      rail.classList.add("dragging");
      try { rail.setPointerCapture(pointerId); } catch {}
    }
    if (dragged) rail.scrollLeft = startScrollLeft - dx;
  });

  const release = (e) => {
    if (!active) return;
    active = false;
    rail.classList.remove("dragging");
    if (pointerId !== null && rail.hasPointerCapture(pointerId)) {
      rail.releasePointerCapture(pointerId);
    }
    pointerId = null;
  };
  rail.addEventListener("pointerup", release);
  rail.addEventListener("pointercancel", release);

  rail.addEventListener("click", (e) => {
    if (suppressClick) {
      e.stopPropagation();
      e.preventDefault();
      suppressClick = false;
      dragged = false;
      return;
    }

    const card = e.target.closest(".mini-card");
    if (card) {
      navigate(`/${card.dataset.type}/${card.dataset.id}`);
    }
  }, true);
  rail.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest(".mini-card");
    if (!card || e.target.closest(".favorite-toggle")) return;
    e.preventDefault();
    navigate(`/${card.dataset.type}/${card.dataset.id}`);
  });
}

function episodeList(dataEpisodes, show) {
  return dataEpisodes.map((episode) => ({
    episode: episode.episode_number,
    episode_name: episode.name || "",
    poster: episode.still || show.poster,
  }));
}

function mediaForShowEpisode(show, seasonNumber, ep, episodes) {
  return {
    media_type: "tv",
    type: "tv",
    tmdb_id: show.id,
    imdb_id: show.imdb_id || "",
    season: seasonNumber,
    episode: ep.episode_number,
    episode_name: ep.name || "",
    show_title: show.title,
    title: `${show.title} S${seasonNumber} E${ep.episode_number}`,
    poster: ep.still || show.poster,
    year: show.year || "",
    episodes,
  };
}

function resumePayload(media) {
  return {
    type: "tv",
    media_type: "tv",
    tmdb_id: media.tmdb_id,
    id: media.tmdb_id,
    season: media.season,
    episode: media.episode,
    episode_name: media.episode_name || "",
    show_title: media.show_title || media.title || "",
    title: media.show_title || media.title || "",
    poster: media.poster || "",
    year: media.year || "",
  };
}

async function saveTvResume(media) {
  if (!media || media.type !== "tv" || !media.tmdb_id || !media.season || !media.episode) return;
  try {
    const data = await api("/api/me/resume", {
      method: "POST",
      body: JSON.stringify(resumePayload(media)),
    });
    libraryCache.resume = data.resume || {};
  } catch (err) {
    console.warn("Could not save resume point", err);
  }
}

async function clearTvResume(showId) {
  const data = await api(`/api/me/resume/${encodeURIComponent(showId)}`, { method: "DELETE" });
  libraryCache.resume = data.resume || {};
  return libraryCache.resume;
}

function addStartOverButton(show, seasons) {
  const resume = resumeForShow(show);
  if (!resume) return;
  const actions = document.getElementById("actions");
  if (!actions) return;
  const firstSeason = seasons[0]?.season_number || 1;
  const button = document.createElement("button");
  button.className = "secondary";
  button.type = "button";
  button.textContent = "Start over";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await clearTvResume(show.id);
      currentMedia = null;
      document.getElementById("player-slot").innerHTML = "";
      setRoute(`/tv/${show.id}/season/${firstSeason}`);
      document.querySelectorAll(".season-tab").forEach((tab) => tab.classList.remove("active"));
      document.querySelector(`.season-tab[data-season="${firstSeason}"]`)?.classList.add("active");
      await loadEpisodes(show, firstSeason);
      button.remove();
    } catch (err) {
      showError(err);
      button.disabled = false;
    }
  });
  actions.appendChild(button);
}

async function loadEpisodes(show, seasonNumber, episodeToPlay = "") {
  const slot = document.getElementById("episodes-slot");
  const signal = newViewSignal();
  slot.innerHTML = loadingHtml("Loading episodes");
  try {
    const data = await api(`/api/tv/${show.id}/season/${seasonNumber}`, { signal });
    if (signal.aborted) return;
    const episodes = episodeList(data.episodes, show);
    const grid = document.createElement("div");
    grid.className = "episodes";
    for (const ep of data.episodes) {
      const card = document.createElement("button");
      card.className = "episode";
      card.dataset.tmdbId = String(show.id);
      card.dataset.season = String(seasonNumber);
      card.dataset.episode = String(ep.episode_number);
      card.innerHTML = `
        <img src="${imageSrc(ep.still)}" alt="" />
        <div class="episode-body">
          <h4></h4>
          <p></p>
        </div>`;
      card.querySelector("h4").textContent = `${ep.episode_number}. ${ep.name || ""}`;
      card.querySelector("p").textContent = ep.overview || "";
      card.addEventListener("click", () => {
        setRoute(`/tv/${show.id}/season/${seasonNumber}/episode/${ep.episode_number}`);
        playMedia(mediaForShowEpisode(show, seasonNumber, ep, episodes));
      });
      grid.appendChild(card);
    }
    slot.innerHTML = "";
    slot.appendChild(grid);
    bindImageFallbacks(slot);
    if (episodeToPlay) {
      const ep = data.episodes.find((episode) => Number(episode.episode_number) === Number(episodeToPlay));
      if (ep) await playMedia(mediaForShowEpisode(show, seasonNumber, ep, episodes));
      else updateSelectedEpisode(currentMedia);
    } else {
      updateSelectedEpisode(currentMedia);
    }
  } catch (err) {
    showError(err);
  }
}

function updateSelectedEpisode(media) {
  document.querySelectorAll(".episode.active").forEach((card) => card.classList.remove("active"));
  if (!media || media.type !== "tv") return;
  document.querySelectorAll(".episode").forEach((card) => {
    const isCurrent = card.dataset.tmdbId === String(media.tmdb_id)
      && card.dataset.season === String(media.season)
      && card.dataset.episode === String(media.episode);
    card.classList.toggle("active", isCurrent);
  });
}

async function playMedia(media, providerName = "") {
  const signal = newViewSignal();
  await loadProviders();
  if (signal.aborted) return;
  currentMedia = media;
  updateSelectedEpisode(media);
  if (media.type === "tv") void saveTvResume(media);
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
    const { candidates } = await api(`/api/embed-candidates?${qs}`, { signal });
    if (signal.aborted) return;
    if (!candidates.length) throw new Error("No enabled provider supports this title type.");
    startFallbackPlayer(candidates, media, 0, selected);
  } catch (err) {
    showError(err);
  }
}

function startFallbackPlayer(candidates, media, index, selectedProvider = "") {
  const current = candidates[index];
  currentProviderName = current.provider || selectedProvider || currentProviderName;
  const availableProviders = candidates.map((candidate) => candidate.provider).filter(Boolean);
  renderIframePlayer({
    url: current.url,
    label: current.label,
    openUrl: current.url,
    iframeOptions: current.iframe || {},
    media,
    activeProvider: current.provider,
    availableProviders,
    onFail: index + 1 < candidates.length ? () => startFallbackPlayer(candidates, media, index + 1) : null,
    fallbackLabel: candidates[index + 1]?.label,
  });
}

function providerPickerHtml(media, activeProvider, availableProviders = null) {
  if (!media || !providersCache?.providers?.length) return "";
  const available = Array.isArray(availableProviders) ? new Set(availableProviders) : null;
  const options = providersCache.providers
    .filter((p) => p.enabled !== false && p.supports?.[media.type])
    .filter((p) => !available || available.has(p.name))
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

function episodeDisplayName(media) {
  if (!media?.episode) return "";
  const epName = media.episode_name || media.name || "";
  const ep = epName ? `: ${epName}` : "";
  return `Episode ${media.episode}${ep}`;
}

function tvEpisodeNavHtml(media) {
  if (!media || media.type !== "tv" || !Array.isArray(media.episodes)) return "";
  const currentIndex = media.episodes.findIndex((ep) => Number(ep.episode) === Number(media.episode));
  const previous = currentIndex > 0 ? media.episodes[currentIndex - 1] : null;
  const next = currentIndex >= 0 && currentIndex < media.episodes.length - 1 ? media.episodes[currentIndex + 1] : null;
  const current = media.episodes[currentIndex] || {
    episode: media.episode,
    episode_name: media.episode_name || "",
  };
  return `
    <div class="episode-nav" aria-label="Episode navigation">
      <button id="previous-episode" class="secondary episode-nav-button" type="button" ${previous ? "" : "disabled"}>
        Previous Episode
      </button>
      <p class="current-episode">Current playing: ${escapeAttr(episodeDisplayName(current))}</p>
      <button id="next-episode" class="secondary episode-nav-button" type="button" ${next ? "" : "disabled"}>
        Next Episode
      </button>
    </div>`;
}

function mediaForEpisode(baseMedia, episode) {
  return {
    ...baseMedia,
    episode: episode.episode,
    episode_name: episode.episode_name,
    title: `${baseMedia.show_title || baseMedia.title} S${baseMedia.season} E${episode.episode}`,
    poster: episode.poster || baseMedia.poster,
  };
}

function normalizeIframeAllow(value) {
  const allow = value || "autoplay; encrypted-media; fullscreen; picture-in-picture";
  if (/\bfullscreen\s+\*/i.test(allow)) return allow;
  if (/(^|;)\s*fullscreen\s*(;|$)/i.test(allow)) {
    return allow.replace(/(^|;)\s*fullscreen\s*(;|$)/i, (_match, prefix, suffix) => (
      `${prefix || ""} fullscreen *${suffix || ""}`
    ));
  }
  return `${allow}; fullscreen *`;
}

function fullscreenElement() {
  return document.fullscreenElement
    || document.webkitFullscreenElement
    || document.mozFullScreenElement
    || document.msFullscreenElement;
}

function enterFullscreen(el) {
  const request = el.requestFullscreen
    || el.webkitRequestFullscreen
    || el.webkitRequestFullScreen
    || el.mozRequestFullScreen
    || el.msRequestFullscreen;
  if (!request) return Promise.reject(new Error("Fullscreen is not supported by this browser."));
  return Promise.resolve(request.call(el));
}

function exitFullscreen() {
  const exit = document.exitFullscreen
    || document.webkitExitFullscreen
    || document.webkitCancelFullScreen
    || document.mozCancelFullScreen
    || document.msExitFullscreen;
  if (!exit) return Promise.resolve();
  return Promise.resolve(exit.call(document));
}

async function enterFirstSupportedFullscreen(elements) {
  let lastErr = null;
  for (const el of elements) {
    if (!el) continue;
    try {
      await enterFullscreen(el);
      return el;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Fullscreen is not supported by this browser.");
}

function renderIframePlayer({
  url,
  label,
  openUrl,
  iframeOptions = {},
  media = null,
  activeProvider = "",
  availableProviders = null,
  onFail = null,
  fallbackLabel = "",
}) {
  const slot = document.getElementById("player-slot") || view;
  const allow = normalizeIframeAllow(iframeOptions.allow);
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
      ${providerPickerHtml(media, activeProvider, availableProviders)}
    </div>
    <p class="player-info">Loaded: <b>${safeLabel}</b> - <a href="${safeOpenUrl}" target="_blank" rel="noreferrer">open in new tab</a></p>
    <div class="player-tools">
      <button id="reload-player" class="secondary" type="button">Reload</button>
      <button id="fullscreen-player" class="secondary" type="button">Fullscreen</button>
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
        webkitallowfullscreen
        mozallowfullscreen
        allow="${escapeAttr(allow)}">
      </iframe>
    </div>
    ${tvEpisodeNavHtml(media)}`;

  const iframe = slot.querySelector("iframe");
  const playerWrap = slot.querySelector("#player-wrap");
  const reloadPlayer = slot.querySelector("#reload-player");
  if (reloadPlayer) {
    reloadPlayer.addEventListener("click", () => {
      iframe.dataset.loaded = "";
      iframe.src = url;
    });
  }
  const fullscreenPlayer = slot.querySelector("#fullscreen-player");
  const syncFullscreenButton = () => {
    if (!fullscreenPlayer) return;
    const activeFullscreen = fullscreenElement();
    fullscreenPlayer.textContent = activeFullscreen === iframe || activeFullscreen === playerWrap
      ? "Exit fullscreen"
      : "Fullscreen";
  };
  if (fullscreenPlayer && playerWrap) {
    if (fullscreenSyncController) fullscreenSyncController.abort();
    fullscreenSyncController = new AbortController();
    fullscreenPlayer.addEventListener("click", async () => {
      try {
        const activeFullscreen = fullscreenElement();
        if (activeFullscreen === iframe || activeFullscreen === playerWrap) {
          await exitFullscreen();
        } else {
          await enterFirstSupportedFullscreen([iframe, playerWrap]);
        }
      } catch (err) {
        console.warn("Could not toggle fullscreen", err);
      } finally {
        syncFullscreenButton();
      }
    });
    ["fullscreenchange", "webkitfullscreenchange", "mozfullscreenchange", "MSFullscreenChange"]
      .forEach((eventName) => document.addEventListener(eventName, syncFullscreenButton, {
        signal: fullscreenSyncController.signal,
      }));
  }
  iframe.addEventListener("load", () => {
    iframe.dataset.loaded = "true";
  });
  const tryNext = slot.querySelector("#try-next");
  if (tryNext && onFail) tryNext.addEventListener("click", onFail);
  const currentIndex = media?.type === "tv" && Array.isArray(media.episodes)
    ? media.episodes.findIndex((ep) => Number(ep.episode) === Number(media.episode))
    : -1;
  const previousEpisode = currentIndex > 0 ? media.episodes[currentIndex - 1] : null;
  const nextEpisode = currentIndex >= 0 && currentIndex < media.episodes.length - 1
    ? media.episodes[currentIndex + 1]
    : null;
  const previousButton = slot.querySelector("#previous-episode");
  const nextButton = slot.querySelector("#next-episode");
  if (previousButton && previousEpisode) {
    previousButton.addEventListener("click", () => {
      const nextMedia = mediaForEpisode(media, previousEpisode);
      setRoute(`/tv/${nextMedia.tmdb_id}/season/${nextMedia.season}/episode/${nextMedia.episode}`);
      playMedia(nextMedia);
    });
  }
  if (nextButton && nextEpisode) {
    nextButton.addEventListener("click", () => {
      const nextMedia = mediaForEpisode(media, nextEpisode);
      setRoute(`/tv/${nextMedia.tmdb_id}/season/${nextMedia.season}/episode/${nextMedia.episode}`);
      playMedia(nextMedia);
    });
  }
  const picker = slot.querySelector("#player-provider-select");
  if (picker && media) {
    picker.addEventListener("change", () => playMedia(media, picker.value));
  }
  slot.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function bootApp(sessionInfo = {}) {
  setAppVisible(true);
  setCurrentUser(sessionInfo.user || currentUser);
  try {
    await Promise.all([loadProviders(true), loadLibrary()]);
  } catch (err) {
    showError(err);
  }
  renderCurrentRoute();
}

function renderCurrentRoute() {
  clearTimeout(searchDebounceTimer);
  const path = routePath();
  const params = new URLSearchParams(location.search);
  const tvMatch = path.match(/^\/tv\/(\d+)(?:\/season\/(\d+)(?:\/episode\/(\d+))?)?$/);
  const movieMatch = path.match(/^\/movie\/(\d+)$/);

  if (path === "/") {
    syncSearchInputs(new URLSearchParams());
    renderHome();
    return;
  }
  if (path === "/search") {
    if (!params.get("q")) {
      setRoute("/", { replace: true });
      renderHome();
      return;
    }
    syncSearchInputs(params);
    runSearch({ showLoading: true, resetScroll: true });
    return;
  }
  if (path === "/favorites") {
    syncSearchInputs(new URLSearchParams());
    renderFavoritesPage();
    return;
  }
  if (movieMatch) {
    openDetail("movie", movieMatch[1]);
    return;
  }
  if (tvMatch) {
    openDetail("tv", tvMatch[1], {
      season: tvMatch[2] || "",
      episode: tvMatch[3] || "",
    });
    return;
  }

  setRoute("/", { replace: true });
  renderHome();
}

window.addEventListener("popstate", renderCurrentRoute);

(async () => {
  try {
    const session = await api("/api/session");
    if (session.authenticated) await bootApp(session);
    else renderLogin();
  } catch {
    renderLogin();
  }
})();
