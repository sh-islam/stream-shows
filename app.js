const API_BASE = (window.STREAM_SHOWS_API_BASE
  || (location.hostname.endsWith(".github.io")
    ? "https://shad-server.elf-tarpon.ts.net:8443"
    : ""));
const AUTH_TOKEN_KEY = "streamEmbedderToken";

const view = document.getElementById("view");
const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
const typeFilter = document.getElementById("type-filter");
const yearFilter = document.getElementById("year-filter");
const homeLink = document.getElementById("home-link");
const logoutLink = document.getElementById("logout-link");
const MISSING_IMAGE_SRC = "broken_image.png";

let providersCache = null;
let currentProviderName = "";
let currentMedia = null;
let viewController = null;
let fullscreenSyncController = null;
let searchDebounceTimer = null;

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
  renderHome();
});
logoutLink.addEventListener("click", async () => {
  localStorage.removeItem(AUTH_TOKEN_KEY);
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
      await bootApp();
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
        <img class="detail-poster" src="${imageSrc(h.poster)}" alt="" />
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
    <img class="card-poster" alt="" src="${imageSrc(item.poster)}" />
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
  bindImageFallbacks(view);
}

async function runSearch({ showLoading = true, resetScroll = false } = {}) {
  const q = searchInput.value.trim();
  if (!q) {
    if (viewController) viewController.abort();
    renderHome();
    return;
  }
  const params = new URLSearchParams({ q });
  if (typeFilter.value) params.set("type", typeFilter.value);
  if (yearFilter.value.trim()) params.set("year", yearFilter.value.trim());
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
    runSearch({ showLoading: searchInput.value.trim().length > 0 });
  }, 300);
}

searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearTimeout(searchDebounceTimer);
  await runSearch({ resetScroll: true });
});

searchInput.addEventListener("input", scheduleSearch);
typeFilter.addEventListener("change", () => runSearch({ showLoading: searchInput.value.trim().length > 0 }));
yearFilter.addEventListener("input", scheduleSearch);

async function openDetail(mediaType, id) {
  const signal = newViewSignal();
  view.innerHTML = loadingHtml();
  window.scrollTo({ top: 0, behavior: "instant" });
  try {
    const data = await api(`/api/${mediaType}/${id}`, { signal });
    if (signal.aborted) return;
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
        <img class="detail-poster" src="${imageSrc(d.poster)}" alt="" />
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
  bindImageFallbacks(view);
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
          <button class="mini-card" data-type="${item.media_type}" data-id="${item.id}">
            <img alt="" src="${imageSrc(item.poster)}" />
            <span>${item.title || "(untitled)"}</span>
          </button>`).join("")}
      </div>
      <button class="rail-arrow right" type="button" aria-label="Scroll right">&rsaquo;</button>
    </div>`;
}

function hydrateRelatedCards() {
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
      openDetail(card.dataset.type, card.dataset.id);
    }
  }, true);
}

async function loadEpisodes(show, seasonNumber) {
  const slot = document.getElementById("episodes-slot");
  const signal = newViewSignal();
  slot.innerHTML = loadingHtml("Loading episodes");
  try {
    const data = await api(`/api/tv/${show.id}/season/${seasonNumber}`, { signal });
    if (signal.aborted) return;
    const grid = document.createElement("div");
    grid.className = "episodes";
    for (const ep of data.episodes) {
      const card = document.createElement("button");
      card.className = "episode";
      card.innerHTML = `
        <img src="${imageSrc(ep.still)}" alt="" />
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
    bindImageFallbacks(slot);
  } catch (err) {
    showError(err);
  }
}

async function playMedia(media, providerName = "") {
  const signal = newViewSignal();
  await loadProviders(true);
  if (signal.aborted) return;
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
      ${providerPickerHtml(media, activeProvider)}
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
    </div>`;

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
