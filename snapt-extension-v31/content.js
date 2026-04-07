
(() => {
  if (window.__CGAT_CONTENT_LOADED__) return;
  window.__CGAT_CONTENT_LOADED__ = true;

  const DEFAULTS = {
    enabled: true,
    keepCount: 12,
    minTurnsBeforeTrim: 20,
    uiTheme: "system"
  };

  const HIDDEN_ATTR = "data-chatgpt-auto-trim-hidden";
  const STYLE_ID = "chatgpt-auto-trim-style";
  const BAR_ID = "chatgpt-auto-trim-bar";
  const CACHE_PANEL_ID = "chatgpt-auto-trim-cache-panel";
  const HINT_ID = "chatgpt-auto-trim-threshold-hint";
  const THEME_STYLE_ID = "chatgpt-auto-trim-theme-style";

  const state = {
    extraVisible: 0,
    showAll: false,
    timer: null,
    lastPreRender: null,
    hookSeen: false,
    extensionAlive: true,
    observerConnected: false,
    invalidationReason: null,
    lastStorageError: null,
    settingsCache: { ...DEFAULTS },
    isReloading: false,
    cacheRequestId: null,
    cachedMessages: [],
    hiddenActivityMessages: [],
    showHiddenActivity: false,
    payloadOlderTotalCount: 0,
    payloadLoadedOlderCount: 0,
    sampledRoleStyles: {},
    themeResolved: "dark",
    cachedTurns: []
  };

  function isInvalidationError(err) {
    const msg = String(err?.message || err || "");
    return /Extension context invalidated/i.test(msg) || /message port closed/i.test(msg);
  }

  function hasPayloadTrimAvailable() {
    const older = Number(state.lastPreRender?.olderAvailable || 0);
    const ready = !!state.lastPreRender?.cacheReady;
    return ready && older > 0;
  }

  function resolveThemeMode(mode) {
    if (mode === "light" || mode === "dark") return mode;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyUiTheme(settings = state.settingsCache) {
    const resolved = resolveThemeMode(settings?.uiTheme || "system");
    state.themeResolved = resolved;
    document.documentElement.dataset.cgatTheme = resolved;
  }

  function getChatHintStorageKey() {
    return `cgat-threshold-hint:${location.pathname}`;
  }

  function getHintPreference() {
    try {
      return sessionStorage.getItem(getChatHintStorageKey());
    } catch (_) {
      return null;
    }
  }

  function setHintPreference(value) {
    try {
      sessionStorage.setItem(getChatHintStorageKey(), value);
    } catch (_) {}
  }

  function setInvalidated(reason) {
    if (!state.extensionAlive) return;
    state.extensionAlive = false;
    state.invalidationReason = reason || "Extension context invalidated";
    try { clearTimeout(state.timer); } catch (_) {}
    try { observer.disconnect(); } catch (_) {}
    state.observerConnected = false;
    updateBar(computeTrim(state.settingsCache).hiddenTurns, state.settingsCache);
  }

  async function safeGetSettings() {
    if (!state.extensionAlive) return state.settingsCache;

    try {
      const settings = await chrome.storage.local.get(DEFAULTS);
      state.settingsCache = { ...DEFAULTS, ...settings };
      applyUiTheme(state.settingsCache);
      return state.settingsCache;
    } catch (err) {
      state.lastStorageError = String(err?.message || err || "");
      if (isInvalidationError(err)) {
        setInvalidated("Extension was reloaded. Refresh this chat tab.");
      }
      return state.settingsCache;
    }
  }

  async function safeSetSettings(settings) {
    state.settingsCache = { ...state.settingsCache, ...settings };
    applyUiTheme(state.settingsCache);
    if (!state.extensionAlive) return false;

    try {
      await chrome.storage.local.set(state.settingsCache);
      return true;
    } catch (err) {
      state.lastStorageError = String(err?.message || err || "");
      if (isInvalidationError(err)) {
        setInvalidated("Extension was reloaded. Refresh this chat tab.");
      }
      return false;
    }
  }

  function pushSettingsToPage(settings) {
    try {
      window.postMessage({
        source: "CGAT_CONTENT",
        type: "UPDATE_SETTINGS",
        payload: settings
      }, "*");
      return true;
    } catch (err) {
      state.lastStorageError = String(err?.message || err || "");
      return false;
    }
  }

  function requestCachedMessages(mode = "chunk") {
    const step = Math.max(1, Number(state.settingsCache.keepCount) || DEFAULTS.keepCount);
    const requestId = `cgat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    state.cacheRequestId = requestId;

    window.postMessage({
      source: "CGAT_CONTENT",
      type: "REQUEST_CACHED_MESSAGES",
      payload: {
        requestId,
        mode,
        currentLoaded: state.payloadLoadedOlderCount,
        step
      }
    }, "*");
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [${HIDDEN_ATTR}="true"] { display: none !important; }

      #${BAR_ID} {
        position: sticky;
        top: 12px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        width: fit-content;
        max-width: calc(100vw - 32px);
        margin: 12px auto 16px;
        padding: 8px 10px;
        border: 1px solid rgba(0,0,0,0.08);
        border-radius: 18px;
        background: rgba(255,255,255,0.92);
        backdrop-filter: blur(10px);
        box-shadow: 0 6px 24px rgba(0,0,0,0.12);
        color: #111827;
        font: 500 13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      #${BAR_ID} .cgat-actions {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        order: -1;
      }

      #${BAR_ID} .cgat-status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      #${CACHE_PANEL_ID} {
        width: min(920px, calc(100vw - 32px));
        margin: 0 auto 16px;
        display: none;
        flex-direction: column;
        gap: 0;
      }

      #${CACHE_PANEL_ID}[data-open="true"] {
        display: flex;
      }

      #${CACHE_PANEL_ID} .cgat-cache-header {
        font: 600 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0.02em;
        opacity: 0.72;
        padding: 0 2px 10px;
      }

      #${CACHE_PANEL_ID} .cgat-turn-shell {
        width: 100%;
        margin: 0 auto;
      }

      #${CACHE_PANEL_ID} .cgat-turn-shell[data-role="assistant"] .cgat-turn-bubble {
        margin-right: auto;
      }

      #${CACHE_PANEL_ID} .cgat-turn-shell[data-role="user"] .cgat-turn-bubble {
        margin-left: auto;
      }

      #${CACHE_PANEL_ID} .cgat-turn-bubble {
        max-width: min(100%, 900px);
        overflow-wrap: anywhere;
      }

      #${CACHE_PANEL_ID} .cgat-turn-text {
        white-space: normal;
        overflow-wrap: anywhere;
      }

      #${CACHE_PANEL_ID} .cgat-turn-text p {
        margin: 0 0 0.9em;
      }

      #${CACHE_PANEL_ID} .cgat-turn-text p:last-child {
        margin-bottom: 0;
      }

      #${CACHE_PANEL_ID} .cgat-turn-text pre {
        margin: 0.8em 0;
        padding: 12px 14px;
        border-radius: 14px;
        overflow-x: auto;
        font-size: 0.92em;
        line-height: 1.45;
        background: rgba(15, 23, 42, 0.08);
      }

      #${CACHE_PANEL_ID} .cgat-turn-text code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      }

      #${CACHE_PANEL_ID} .cgat-turn-text ul,
      #${CACHE_PANEL_ID} .cgat-turn-text ol {
        margin: 0.6em 0 0.9em 1.35em;
        padding: 0;
      }

      #${CACHE_PANEL_ID} .cgat-turn-text li + li {
        margin-top: 0.25em;
      }

      #${CACHE_PANEL_ID} .cgat-turn-text blockquote {
        margin: 0.8em 0;
        padding-left: 12px;
        border-left: 3px solid rgba(99, 102, 241, 0.35);
        opacity: 0.92;
      }

      @media (prefers-color-scheme: dark) {
        #${BAR_ID} {
          background: rgba(17,24,39,0.90);
          border-color: rgba(255,255,255,0.08);
          color: #f9fafb;
        }

        #${CACHE_PANEL_ID} .cgat-cache-controls {
          background: rgba(17,24,39,0.90);
          border-color: rgba(255,255,255,0.08);
          color: #f9fafb;
        }

        #${CACHE_PANEL_ID} .cgat-cache-controls button {
          background: #f9fafb;
          color: #111827;
        }

        #${CACHE_PANEL_ID} .cgat-turn-text pre {
          background: rgba(255,255,255,0.08);
        }
      }

      #${BAR_ID}[data-hidden="true"] { display: none !important; }

      #${BAR_ID} .cgat-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(37, 99, 235, 0.12);
        white-space: nowrap;
      }

      #${BAR_ID} .cgat-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #2563eb;
        flex: 0 0 auto;
      }

      #${BAR_ID} .cgat-meta {
        font-size: 12px;
        opacity: 0.82;
        padding: 0 2px;
      }

      #${BAR_ID} button {
        appearance: none;
        border: 0;
        border-radius: 999px;
        padding: 7px 12px;
        background: #111827;
        color: #ffffff;
        cursor: pointer;
        font: inherit;
        white-space: nowrap;
      }

      @media (prefers-color-scheme: dark) {
        #${BAR_ID} button { background: #f9fafb; color: #111827; }
      }

      #${BAR_ID} button[disabled] {
        opacity: 0.45;
        cursor: not-allowed;
      }


      #${BAR_ID} {
        width: min(1080px, calc(100vw - 32px));
        justify-content: space-between;
        padding: 12px 14px;
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 22px;
        background: linear-gradient(180deg, rgba(13,26,52,0.82), rgba(8,16,34,0.72));
        box-shadow: 0 12px 36px rgba(0,0,0,0.22);
        backdrop-filter: blur(18px) saturate(140%);
      }

      #${BAR_ID} .cgat-actions {
        order: 0;
      }

      #${BAR_ID} .cgat-status {
        margin-left: auto;
      }

      #${BAR_ID} .cgat-badge {
        background: rgba(59, 130, 246, 0.18);
        border: 1px solid rgba(96, 165, 250, 0.18);
      }

      #${BAR_ID} button,
      #${CACHE_PANEL_ID} .cgat-cache-controls button {
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.10);
        color: #f8fafc;
        backdrop-filter: blur(14px) saturate(140%);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
        transition: background 140ms ease, transform 140ms ease, border-color 140ms ease;
      }

      #${BAR_ID} button:hover,
      #${CACHE_PANEL_ID} .cgat-cache-controls button:hover {
        background: rgba(255,255,255,0.16);
        border-color: rgba(255,255,255,0.18);
        transform: translateY(-1px);
      }

      #${CACHE_PANEL_ID} {
        width: min(980px, calc(100vw - 32px));
        gap: 14px;
      }

      #${CACHE_PANEL_ID} .cgat-cache-controls {
        position: sticky;
        top: 72px;
        z-index: 2147483646;
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 22px;
        background: linear-gradient(180deg, rgba(13,26,52,0.80), rgba(8,16,34,0.70));
        box-shadow: 0 12px 36px rgba(0,0,0,0.20);
        backdrop-filter: blur(18px) saturate(140%);
        padding: 12px 14px;
        margin: 0 0 14px;
      }

      #${CACHE_PANEL_ID} .cgat-cache-meta {
        color: rgba(241,245,249,0.88);
      }

      #${CACHE_PANEL_ID} .cgat-cache-stack {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }

      #${CACHE_PANEL_ID} .cgat-activity-wrap {
        margin: 0 0 14px;
      }

      #${CACHE_PANEL_ID} .cgat-activity-toggle {
        width: auto;
      }

      #${CACHE_PANEL_ID} .cgat-activity-list {
        margin-top: 10px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      #${CACHE_PANEL_ID} .cgat-activity-row {
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 16px;
        background: rgba(255,255,255,0.05);
        padding: 12px 14px;
      }

      #${CACHE_PANEL_ID} .cgat-activity-label {
        font: 700 11px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: rgba(191,219,254,0.9);
        margin-bottom: 8px;
      }

      #${CACHE_PANEL_ID} .cgat-activity-text {
        color: rgba(226,232,240,0.92);
        font: 400 14px/1.65 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      #${CACHE_PANEL_ID} .cgat-turn-shell {
        max-width: 980px;
        margin: 0 auto;
        display: flex;
        width: 100%;
      }

      #${CACHE_PANEL_ID} .cgat-turn-shell[data-role="assistant"] {
        justify-content: flex-start;
      }

      #${CACHE_PANEL_ID} .cgat-turn-shell[data-role="user"] {
        justify-content: flex-end;
      }

      #${CACHE_PANEL_ID} .cgat-turn-bubble {
        width: min(100%, 880px);
        padding: 16px 18px;
        border-radius: 22px;
        border: 1px solid rgba(255,255,255,0.09);
        background: linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.04));
        box-shadow: 0 10px 30px rgba(0,0,0,0.14);
        backdrop-filter: blur(18px) saturate(140%);
      }

      #${CACHE_PANEL_ID} .cgat-turn-shell[data-role="user"] .cgat-turn-bubble {
        width: min(76%, 720px);
        background: linear-gradient(180deg, rgba(59,130,246,0.16), rgba(59,130,246,0.09));
      }

      #${CACHE_PANEL_ID} .cgat-turn-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
      }

      #${CACHE_PANEL_ID} .cgat-role-chip,
      #${CACHE_PANEL_ID} .cgat-cache-chip {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 4px 9px;
        font: 700 11px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      #${CACHE_PANEL_ID} .cgat-role-chip {
        background: rgba(255,255,255,0.10);
        color: rgba(248,250,252,0.95);
      }

      #${CACHE_PANEL_ID} .cgat-cache-chip {
        background: rgba(59,130,246,0.16);
        color: rgba(191,219,254,0.96);
      }

      #${CACHE_PANEL_ID} .cgat-turn-text {
        color: rgba(248,250,252,0.96);
        font: 400 15px/1.75 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      #${CACHE_PANEL_ID} .cgat-turn-text h1,
      #${CACHE_PANEL_ID} .cgat-turn-text h2,
      #${CACHE_PANEL_ID} .cgat-turn-text h3 {
        margin: 0 0 0.75em;
        line-height: 1.25;
        font-weight: 700;
      }

      #${CACHE_PANEL_ID} .cgat-turn-text h1 { font-size: 1.28rem; }
      #${CACHE_PANEL_ID} .cgat-turn-text h2 { font-size: 1.16rem; }
      #${CACHE_PANEL_ID} .cgat-turn-text h3 { font-size: 1.06rem; }

      #${CACHE_PANEL_ID} .cgat-turn-text p {
        margin: 0 0 1em;
      }

      #${CACHE_PANEL_ID} .cgat-turn-text ul,
      #${CACHE_PANEL_ID} .cgat-turn-text ol {
        margin: 0.7em 0 1em 1.35em;
      }

      #${CACHE_PANEL_ID} .cgat-turn-text strong {
        font-weight: 700;
        color: #ffffff;
      }

      #${CACHE_PANEL_ID} .cgat-turn-text em {
        font-style: italic;
      }

      #${CACHE_PANEL_ID} .cgat-turn-text code {
        display: inline-block;
        padding: 0.05em 0.38em;
        border-radius: 8px;
        background: rgba(255,255,255,0.09);
        font-size: 0.92em;
      }

      #${CACHE_PANEL_ID} .cgat-turn-text pre {
        padding: 14px 16px;
        border-radius: 16px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(2,6,23,0.46);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
      }

      #${CACHE_PANEL_ID} .cgat-turn-text blockquote {
        border-left: 3px solid rgba(96,165,250,0.45);
        background: rgba(255,255,255,0.03);
        padding: 10px 12px;
        border-radius: 12px;
      }

      @media (max-width: 720px) {
        #${BAR_ID},
        #${CACHE_PANEL_ID} {
          width: calc(100vw - 20px);
        }

        #${CACHE_PANEL_ID} .cgat-turn-bubble,
        #${CACHE_PANEL_ID} .cgat-turn-shell[data-role="user"] .cgat-turn-bubble {
          width: 100%;
          max-width: 100%;
        }

        #${BAR_ID} {
          gap: 10px;
        }

        #${BAR_ID} .cgat-status {
          margin-left: 0;
        }
      }
    `;

    document.documentElement.appendChild(style);

    if (!document.getElementById(THEME_STYLE_ID)) {
      const themeStyle = document.createElement("style");
      themeStyle.id = THEME_STYLE_ID;
      themeStyle.textContent = `
        html[data-cgat-theme="light"] {
          --cgat-bg: #f6f7fb;
          --cgat-surface: #fcfcff;
          --cgat-surface-2: #eef1f7;
          --cgat-text: #1b1b1f;
          --cgat-text-muted: #5c5f66;
          --cgat-outline: #c4c7cf;
          --cgat-primary: #355f97;
          --cgat-on-primary: #ffffff;
          --cgat-primary-container: #d6e3ff;
          --cgat-on-primary-container: #0f1c2b;
          --cgat-secondary-container: #dde3f0;
          --cgat-on-secondary-container: #2a3040;
          --cgat-shadow: rgba(0,0,0,0.08);
        }

        html[data-cgat-theme="dark"] {
          --cgat-bg: #131316;
          --cgat-surface: #1b1b1f;
          --cgat-surface-2: #211f26;
          --cgat-text: #e5e1e6;
          --cgat-text-muted: #c7c5d0;
          --cgat-outline: #47464f;
          --cgat-primary: #a8c7fa;
          --cgat-on-primary: #0b1d35;
          --cgat-primary-container: #214870;
          --cgat-on-primary-container: #d6e3ff;
          --cgat-secondary-container: #3a4456;
          --cgat-on-secondary-container: #dfe5f3;
          --cgat-shadow: rgba(0,0,0,0.28);
        }

        #${BAR_ID},
        #${CACHE_PANEL_ID} .cgat-cache-controls,
        #${HINT_ID} {
          border: 1px solid var(--cgat-outline);
          border-radius: 24px;
          background: var(--cgat-surface);
          color: var(--cgat-text);
          box-shadow: 0 8px 24px var(--cgat-shadow);
          backdrop-filter: none;
        }

        #${BAR_ID} {
          width: min(1080px, calc(100vw - 32px));
          justify-content: space-between;
          gap: 12px;
          padding: 12px 14px;
        }

        #${BAR_ID} .cgat-actions {
          order: 0;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }

        #${BAR_ID} .cgat-status {
          margin-left: auto;
          display: inline-flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }

        #${BAR_ID} .cgat-badge {
          background: var(--cgat-secondary-container);
          color: var(--cgat-on-secondary-container);
          border: 0;
        }

        #${BAR_ID} .cgat-dot {
          background: var(--cgat-primary);
        }

        #${BAR_ID} .cgat-meta,
        #${CACHE_PANEL_ID} .cgat-cache-meta,
        #${HINT_ID} .cgat-hint-body {
          color: var(--cgat-text-muted);
        }

        #${BAR_ID} button,
        #${CACHE_PANEL_ID} .cgat-cache-controls button,
        #${CACHE_PANEL_ID} .cgat-activity-toggle,
        #${HINT_ID} .cgat-hint-dismiss {
          appearance: none;
          border: 1px solid var(--cgat-outline);
          border-radius: 999px;
          padding: 8px 13px;
          font: 600 13px/1.1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          cursor: pointer;
          background: var(--cgat-surface);
          color: var(--cgat-text);
          transition: background 140ms ease, transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease;
        }

        #${BAR_ID} button:hover,
        #${CACHE_PANEL_ID} .cgat-cache-controls button:hover,
        #${CACHE_PANEL_ID} .cgat-activity-toggle:hover,
        #${HINT_ID} button:hover {
          transform: translateY(-1px);
        }

        #${HINT_ID} .cgat-hint-reload {
          background: var(--cgat-primary);
          color: var(--cgat-on-primary);
          border: 0;
          box-shadow: 0 4px 12px rgba(53,95,151,0.22);
        }

        #${CACHE_PANEL_ID} {
          width: min(980px, calc(100vw - 32px));
          gap: 14px;
          padding-bottom: 8px;
          margin: 0 auto 18px;
        }

        #${CACHE_PANEL_ID} .cgat-cache-stack {
          display: flex;
          flex-direction: column;
          gap: 14px;
          padding: 0 2px 8px;
        }

        #${CACHE_PANEL_ID} .cgat-turn-group {
          width: min(100%, 980px);
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 10px;
          align-items: stretch;
        }

        #${CACHE_PANEL_ID} .cgat-turn-activity-shell {
          width: 100%;
        }

        #${CACHE_PANEL_ID} .cgat-turn-activity {
          width: min(100%, 880px);
          margin-right: auto;
          border: 1px solid var(--cgat-outline);
          border-radius: 18px;
          background: var(--cgat-surface-2);
          box-shadow: 0 4px 12px var(--cgat-shadow);
          overflow: hidden;
        }

        #${CACHE_PANEL_ID} .cgat-turn-activity summary {
          list-style: none;
          cursor: pointer;
          padding: 12px 14px;
          font: 650 13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: var(--cgat-text);
        }

        #${CACHE_PANEL_ID} .cgat-turn-activity summary::-webkit-details-marker {
          display: none;
        }

        #${CACHE_PANEL_ID} .cgat-turn-activity[open] summary {
          border-bottom: 1px solid var(--cgat-outline);
        }

        #${CACHE_PANEL_ID} .cgat-turn-activity .cgat-activity-text {
          padding: 12px 14px 14px;
        }

        #${CACHE_PANEL_ID} .cgat-turn-shell {
          max-width: 980px;
          margin: 0 auto;
          display: flex;
          width: 100%;
        }

        #${CACHE_PANEL_ID} .cgat-turn-shell[data-role="assistant"] {
          justify-content: flex-start;
        }

        #${CACHE_PANEL_ID} .cgat-turn-shell[data-role="user"] {
          justify-content: flex-end;
        }

        #${CACHE_PANEL_ID} .cgat-turn-bubble {
          width: min(100%, 880px);
          padding: 16px 18px;
          border-radius: 24px;
          border: 1px solid var(--cgat-outline);
          background: var(--cgat-surface);
          color: var(--cgat-text);
          box-shadow: 0 8px 24px var(--cgat-shadow);
        }

        #${CACHE_PANEL_ID} .cgat-turn-shell[data-role="user"] .cgat-turn-bubble {
          width: min(76%, 720px);
          background: var(--cgat-primary-container);
        }

        #${CACHE_PANEL_ID} .cgat-turn-head {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
        }

        #${CACHE_PANEL_ID} .cgat-role-chip,
        #${CACHE_PANEL_ID} .cgat-cache-chip {
          display: inline-flex;
          align-items: center;
          border-radius: 999px;
          padding: 4px 9px;
          font: 700 11px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          background: var(--cgat-secondary-container);
          color: var(--cgat-on-secondary-container);
        }

        #${CACHE_PANEL_ID} .cgat-cache-chip {
          background: var(--cgat-surface-2);
          color: var(--cgat-text-muted);
        }

        #${CACHE_PANEL_ID} .cgat-turn-text,
        #${CACHE_PANEL_ID} .cgat-activity-text {
          color: var(--cgat-text);
        }

        #${CACHE_PANEL_ID} .cgat-turn-text strong,
        #${CACHE_PANEL_ID} .cgat-activity-text strong {
          color: var(--cgat-text);
        }

        #${CACHE_PANEL_ID} .cgat-turn-text code,
        #${CACHE_PANEL_ID} .cgat-activity-text code {
          display: inline-block;
          padding: 0.05em 0.38em;
          border-radius: 8px;
          background: var(--cgat-surface-2);
        }

        #${CACHE_PANEL_ID} .cgat-turn-text pre,
        #${CACHE_PANEL_ID} .cgat-activity-text pre {
          border: 1px solid var(--cgat-outline);
          background: var(--cgat-surface-2);
        }

        #${CACHE_PANEL_ID} .cgat-activity-row {
          border: 1px solid var(--cgat-outline);
          border-radius: 18px;
          background: var(--cgat-surface);
        }

        #${CACHE_PANEL_ID} .cgat-activity-label {
          color: var(--cgat-text-muted);
        }

        #${HINT_ID} {
          width: min(860px, calc(100vw - 32px));
          display: none;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 12px 14px;
          margin: 0 auto 16px;
        }

        #${HINT_ID}[data-open="true"] {
          display: flex;
        }

        #${HINT_ID} .cgat-hint-copy {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        #${HINT_ID} .cgat-hint-title {
          font: 700 14px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: var(--cgat-text);
        }

        #${HINT_ID} .cgat-hint-actions {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }

        @media (max-width: 720px) {
          #${BAR_ID},
          #${CACHE_PANEL_ID},
          #${HINT_ID} {
            width: calc(100vw - 20px);
          }

          #${CACHE_PANEL_ID} .cgat-turn-bubble,
          #${CACHE_PANEL_ID} .cgat-turn-shell[data-role="user"] .cgat-turn-bubble,
          #${CACHE_PANEL_ID} .cgat-turn-activity {
            width: 100%;
            max-width: 100%;
          }

          #${BAR_ID},
          #${HINT_ID} {
            gap: 10px;
          }

          #${BAR_ID} .cgat-status {
            margin-left: 0;
          }

          #${HINT_ID} {
            flex-direction: column;
            align-items: stretch;
          }

          #${HINT_ID} .cgat-hint-actions {
            justify-content: flex-start;
          }
        }
      `;
      document.documentElement.appendChild(themeStyle);
    }
  }

  function getMain() {
    return document.querySelector("main");
  }

  function sortInDomOrder(nodes) {
    return nodes.sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }

  function uniq(arr) {
    return Array.from(new Set(arr.filter(Boolean)));
  }

  function visibleEnough(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.closest(`#${BAR_ID}`) || el.closest(`#${CACHE_PANEL_ID}`)) return false;
    const text = (el.innerText || "").trim();
    const hasStructure = !!el.querySelector("p, pre, code, table, ol, ul, img, video");
    return text.length >= 8 || hasStructure;
  }

  function getTurnNodesWithMethod() {
    const main = getMain();
    if (!main) return { nodes: [], method: "no-main" };

    let nodes = uniq(Array.from(main.querySelectorAll('article[data-testid*="conversation-turn"], div[data-testid*="conversation-turn"]')))
      .filter(visibleEnough);
    if (nodes.length >= 2) return { nodes: sortInDomOrder(nodes), method: "data-testid" };

    const roleAnchors = Array.from(main.querySelectorAll("[data-message-author-role]"));
    nodes = uniq(roleAnchors.map((el) =>
      el.closest('article, section, [data-testid*="conversation-turn"], [class*="group"]')
    )).filter(visibleEnough);
    if (nodes.length >= 2) return { nodes: sortInDomOrder(nodes), method: "author-role" };

    nodes = uniq(Array.from(main.querySelectorAll("article, section")))
      .filter((el) => {
        if (!visibleEnough(el)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 220 && rect.height > 24;
      });
    if (nodes.length >= 2) return { nodes: sortInDomOrder(nodes), method: "article-section-fallback" };

    nodes = uniq(Array.from(main.children)).filter(visibleEnough);
    return { nodes: sortInDomOrder(nodes), method: "main-children-fallback" };
  }

  function getNodeRole(node) {
    if (!(node instanceof HTMLElement)) return null;
    const direct = node.getAttribute("data-message-author-role");
    if (direct === "user" || direct === "assistant") return direct;

    const userAnchor = node.querySelector('[data-message-author-role="user"]');
    if (userAnchor) return "user";

    const assistantAnchor = node.querySelector('[data-message-author-role="assistant"]');
    if (assistantAnchor) return "assistant";

    return null;
  }

  function groupNodesIntoTurns(nodes) {
    const turns = [];
    const prefixNodes = [];
    let currentTurn = null;

    for (const node of nodes) {
      const role = getNodeRole(node);

      if (role === "user") {
        currentTurn = { nodes: [node] };
        turns.push(currentTurn);
        continue;
      }

      if (role === "assistant") {
        if (currentTurn) {
          currentTurn.nodes.push(node);
        } else {
          prefixNodes.push(node);
        }
        continue;
      }

      if (currentTurn) {
        currentTurn.nodes.push(node);
      } else {
        prefixNodes.push(node);
      }
    }

    return { turns, prefixNodes };
  }

  function clearTrim() {
    document.querySelectorAll(`[${HIDDEN_ATTR}="true"]`).forEach((el) => {
      el.setAttribute(HIDDEN_ATTR, "false");
    });
  }

  function getOrCreateCachePanel() {
    let panel = document.getElementById(CACHE_PANEL_ID);
    const main = getMain();
    if (!main) return null;

    const firstTurn = getTurnNodesWithMethod().nodes[0] || null;
    const threadParent = firstTurn?.parentElement || null;
    const hint = document.getElementById(HINT_ID);
    const bar = document.getElementById(BAR_ID);

    if (!panel) {
      panel = document.createElement("div");
      panel.id = CACHE_PANEL_ID;
      panel.dataset.open = "false";
    }

    if (threadParent && firstTurn) {
      if (panel.parentElement !== threadParent || panel.nextSibling !== firstTurn) {
        threadParent.insertBefore(panel, firstTurn);
      }
    } else if (hint && hint.parentElement === main) {
      if (panel.parentElement !== main) {
        hint.insertAdjacentElement("afterend", panel);
      }
    } else if (bar && bar.parentElement === main) {
      if (panel.parentElement !== main) {
        bar.insertAdjacentElement("afterend", panel);
      }
    } else if (!main.contains(panel)) {
      main.prepend(panel);
    }

    return panel;
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  
  
  function cleanCachedText(raw) {
    let text = String(raw || "");

    text = text
      .replace(/[^]*/g, "")
      .replace(/【[^】]*†[^】]*】/g, "")
      .replace(/^\s*\[No text content extracted\]\s*$/gm, "")
      .replace(/^\s*Thought for (?:(?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s)?)\s*$/gmi, "")
      .replace(/^\s*Thinking for (?:(?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s)?)\s*$/gmi, "")
      .replace(/^\s*Activity\s*[·-]\s*(?:(?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s)?)\s*$/gmi, "")
      .replace(/\u200b/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return text;
  }

  function isDurationOnlyText(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    return /^(?:Thought|Thinking|Activity)(?:\s*for|\s*[·-])?\s*(?:(?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s)?)$/i.test(t)
      || /^(?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s)$/i.test(t);
  }

  function formatInline(text) {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    return out.replace(/\n/g, "<br>");
  }

  function looksLikeToolJson(text) {
    const t = String(text || "").trim();
    if (!t) return false;

    if ((t.startsWith("{") || t.startsWith("[")) &&
        /"?(search_query|open|click|find|response_length|image_query|product_query|calculator|weather|sports|finance)"?\s*:/.test(t)) {
      return true;
    }

    const punctuationDensity = ((t.match(/[{}\[\]":,]/g) || []).length) / Math.max(t.length, 1);
    return punctuationDensity > 0.12 && /:\s*["[{0-9]/.test(t);
  }

  function looksLikeAssistantMeta(text) {
    const t = String(text || "").trim().toLowerCase();
    if (!t) return false;

    const starters = [
      "i’m checking",
      "i'm checking",
      "i’m patching",
      "i'm patching",
      "i’m building",
      "i'm building",
      "i’m updating",
      "i'm updating",
      "i’m turning",
      "i'm turning",
      "i found the issue",
      "i found the likely gap",
      "i'm tightening",
      "i’m tightening",
      "attaching to current tab",
      "reloading chat",
      "settings saved",
      "popup ready",
      "running debug",
      "trim failed",
      "debug failed",
      "i’m pulling",
      "i'm pulling",
      "i’m going to",
      "i'm going to"
    ];

    if (starters.some((s) => t.startsWith(s))) return true;
    if (isDurationOnlyText(String(text || "").trim())) return true;
    if (/^(searching|checking|patching|building|updating)\b/.test(t)) return true;

    return false;
  }

  function looksLikeFinalAssistant(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    if (looksLikeToolJson(t)) return false;
    if (looksLikeAssistantMeta(t)) return false;
    if (t.length < 40) return false;

    const sentenceish = /[a-zA-Z].*[.!?]|\n\s*\n|[:]/.test(t);
    return sentenceish;
  }

  function classifyCachedMessage(msg) {
    const role = msg.role;
    const text = cleanCachedText(msg.text || "");

    if (!text) return "ignore";
    if (role === "user") return "user";
    if (looksLikeToolJson(text)) return "tool";
    if (looksLikeAssistantMeta(text)) return "assistant_meta";
    if (looksLikeFinalAssistant(text)) return "assistant_final";

    return "ignore";
  }

  function getActivityLabel(activityItems) {
    const hasTool = activityItems.some((item) => classifyCachedMessage(item) === "tool" || looksLikeToolJson(item.text || ""));
    const hasMeta = activityItems.some((item) => {
      const kind = classifyCachedMessage(item);
      return kind === "assistant_meta" || kind === "assistant_side" || kind === "assistant_final";
    });
    if (hasTool && hasMeta) return "Thinking + tools";
    if (hasTool) return "Tool activity";
    return "Thinking";
  }

  function mergeItemsText(items) {
    return items
      .map((item) => cleanCachedText(item.text || ""))
      .filter((text) => text && !isDurationOnlyText(text))
      .join("\n\n");
  }

  function renderMarkdownish(text) {
    const source = cleanCachedText(text);
    if (!source.trim()) return "";

    const blocks = source.split(/```/);
    const out = [];

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (i % 2 === 1) {
        const code = block.replace(/^\w+\n/, "").trim();
        if (code) out.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
        continue;
      }

      const paragraphs = block
        .split(/\n\s*\n/)
        .map((part) => part.trim())
        .filter(Boolean);

      for (const para of paragraphs) {
        const lines = para.split("\n").map((line) => line.trimRight()).filter(Boolean);
        if (!lines.length) continue;

        const heading = lines[0].match(/^(#{1,3})\s+(.+)$/);
        if (heading && lines.length === 1) {
          const level = Math.min(3, heading[1].length);
          out.push(`<h${level}>${formatInline(heading[2])}</h${level}>`);
          continue;
        }

        if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
          const items = lines.map((line) => `<li>${formatInline(line.replace(/^\s*[-*]\s+/, ""))}</li>`).join("");
          out.push(`<ul>${items}</ul>`);
          continue;
        }

        if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
          const items = lines.map((line) => `<li>${formatInline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`).join("");
          out.push(`<ol>${items}</ol>`);
          continue;
        }

        if (lines.every((line) => /^\s*>\s?/.test(line))) {
          const quote = lines.map((line) => formatInline(line.replace(/^\s*>\s?/, ""))).join("<br>");
          out.push(`<blockquote>${quote}</blockquote>`);
          continue;
        }

        out.push(`<p>${formatInline(lines.join("\n"))}</p>`);
      }
    }

    return out.join("");
  }

  async function handleLoadPrevious() {
    const settings = await safeGetSettings();
    const currentHidden = computeTrim(settings).hiddenTurns;
    const step = Math.max(1, Number(settings.keepCount) || DEFAULTS.keepCount);

    if (currentHidden > 0) {
      state.showAll = false;
      state.extraVisible += step;
      applyTrim(settings);
      return;
    }

    if (hasPayloadTrimAvailable()) {
      requestCachedMessages("chunk");
    }
  }

  async function handleShowAll() {
    const settings = await safeGetSettings();
    const currentHidden = computeTrim(settings).hiddenTurns;

    if (currentHidden > 0 && !hasPayloadTrimAvailable()) {
      state.showAll = true;
      applyTrim(settings);
      return;
    }

    if (hasPayloadTrimAvailable()) {
      requestCachedMessages("all");
    }
  }

  
  
  async function reloadWithCurrentTrimSettings() {
    const settings = await safeGetSettings();
    await safeSetSettings(settings);
    pushSettingsToPage(settings);
    setHintPreference("acted");
    location.reload();
  }

  function getOrCreateThresholdHint() {
    let hint = document.getElementById(HINT_ID);
    const main = getMain();
    if (!main) return null;

    if (!hint) {
      hint = document.createElement("div");
      hint.id = HINT_ID;
      hint.dataset.open = "false";
      hint.innerHTML = `
        <div class="cgat-hint-copy">
          <div class="cgat-hint-title">This chat may start slowing down</div>
          <div class="cgat-hint-body">Reload with trim to keep the page responsive.</div>
        </div>
        <div class="cgat-hint-actions">
          <button type="button" class="cgat-hint-reload">Reload with trim</button>
          <button type="button" class="cgat-hint-dismiss">Dismiss</button>
        </div>
      `;
      main.prepend(hint);

      hint.querySelector(".cgat-hint-reload")?.addEventListener("click", () => {
        reloadWithCurrentTrimSettings();
      });
      hint.querySelector(".cgat-hint-dismiss")?.addEventListener("click", () => {
        setHintPreference("dismissed");
        hint.dataset.open = "false";
      });
    } else if (!main.contains(hint)) {
      main.prepend(hint);
    }

    return hint;
  }

  function updateThresholdHint(info, settings) {
    const hint = getOrCreateThresholdHint();
    if (!hint) return;

    const alreadyHandled = getHintPreference();
    const crossedThreshold = !state.lastPreRender && Number(info?.totalTurns || 0) >= Number(settings?.minTurnsBeforeTrim || DEFAULTS.minTurnsBeforeTrim);

    if (!crossedThreshold || alreadyHandled) {
      hint.dataset.open = "false";
      return;
    }

    hint.dataset.open = "true";
  }


  function renderCachedMessages() {
    const panel = getOrCreateCachePanel();
    if (!panel) return;

    if (Array.isArray(state.cachedTurns) && state.cachedTurns.length > 0) {
      panel.dataset.open = "true";

      const turnCards = state.cachedTurns.map((turn, index) => {
        const user = turn.user || null;
        const assistantItems = Array.isArray(turn.assistant) ? turn.assistant : [];
        const activityItems = Array.isArray(turn.activity) ? turn.activity : [];

        const userHtml = user && cleanCachedText(user.text || "")
          ? `
            <article class="cgat-turn-shell" data-role="user">
              <div class="cgat-turn-bubble">
                <div class="cgat-turn-head">
                  <span class="cgat-role-chip">You</span>
                  <span class="cgat-cache-chip">Cached</span>
                </div>
                <div class="cgat-turn-text">${renderMarkdownish(user.text || "")}</div>
              </div>
            </article>
          `
          : "";

        const mergedActivityText = mergeItemsText(activityItems);
        const activityHtml = mergedActivityText
          ? `
              <details class="cgat-turn-activity">
                <summary>
                  <span class="cgat-activity-summary-label">${getActivityLabel(activityItems)}</span>
                  <span class="cgat-activity-summary-chevron" aria-hidden="true">▾</span>
                </summary>
                <div class="cgat-activity-text">${renderMarkdownish(mergedActivityText)}</div>
              </details>
            `
          : "";

        const mergedAssistantText = mergeItemsText(assistantItems);
        const hasAssistantCard = mergedAssistantText || mergedActivityText;
        const assistantHtml = hasAssistantCard
          ? `
            <article class="cgat-turn-shell" data-role="assistant">
              <div class="cgat-turn-bubble">
                <div class="cgat-turn-head">
                  <span class="cgat-role-chip">Assistant</span>
                  <span class="cgat-cache-chip">Cached</span>
                </div>
                ${activityHtml}
                ${mergedAssistantText ? `<div class="cgat-turn-text">${renderMarkdownish(mergedAssistantText)}</div>` : ""}
              </div>
            </article>
          `
          : "";

        return `
          <section class="cgat-turn-group" data-turn-index="${index}">
            ${userHtml}
            ${assistantHtml}
          </section>
        `;
      }).join("");

      panel.innerHTML = `
        <div class="cgat-cache-stack">
          ${turnCards}
        </div>
      `;
      return;
    }

    const prepared = state.cachedMessages.map((msg) => {
      const cleanText = cleanCachedText(msg.text || "");
      const kind = classifyCachedMessage({ ...msg, text: cleanText });
      return {
        ...msg,
        role: msg.role === "user" ? "user" : "assistant",
        cleanText,
        kind
      };
    });

    const visibleMessages = prepared.filter((msg) => msg.kind === "user" || msg.kind === "assistant_final");
    state.hiddenActivityMessages = prepared.filter((msg) => msg.kind === "assistant_meta" || msg.kind === "tool");

    if (!visibleMessages.length && !state.hiddenActivityMessages.length) {
      panel.dataset.open = "false";
      panel.innerHTML = "";
      return;
    }

    panel.dataset.open = "true";

    const cards = visibleMessages.map((msg) => {
      const roleLabel = msg.role === "user" ? "You" : "Assistant";
      const contentHtml = renderMarkdownish(msg.cleanText);

      return `
        <article class="cgat-turn-shell" data-msg-id="${msg.id}" data-role="${msg.role}">
          <div class="cgat-turn-bubble">
            <div class="cgat-turn-head">
              <span class="cgat-role-chip">${roleLabel}</span>
              <span class="cgat-cache-chip">Cached</span>
            </div>
            <div class="cgat-turn-text">${contentHtml}</div>
          </div>
        </article>
      `;
    }).join("");

    const activityCount = state.hiddenActivityMessages.length;
    let activityHtml = "";

    if (activityCount > 0) {
      const activityRows = state.showHiddenActivity
        ? state.hiddenActivityMessages.map((msg) => {
            const label = msg.kind === "tool" ? "Tool / JSON" : "Activity";
            return `
              <div class="cgat-activity-row">
                <div class="cgat-activity-label">${label}</div>
                <div class="cgat-activity-text">${renderMarkdownish(msg.cleanText)}</div>
              </div>
            `;
          }).join("")
        : "";

      activityHtml = `
        <div class="cgat-activity-wrap">
          <button type="button" class="cgat-activity-toggle">
            ${state.showHiddenActivity ? "Hide activity" : `Show activity (${activityCount})`}
          </button>
          ${state.showHiddenActivity ? `<div class="cgat-activity-list">${activityRows}</div>` : ""}
        </div>
      `;
    }

    panel.innerHTML = `
      ${activityHtml}
      <div class="cgat-cache-stack">
        ${cards}
      </div>
    `;

    panel.querySelector(".cgat-activity-toggle")?.addEventListener("click", () => {
      state.showHiddenActivity = !state.showHiddenActivity;
      renderCachedMessages();
    });
  }

  function clearCachedMessages() {
    state.cachedMessages = [];
    state.cachedTurns = [];
    state.hiddenActivityMessages = [];
    state.showHiddenActivity = false;
    state.showAll = false;
    state.payloadOlderTotalCount = 0;
    state.payloadLoadedOlderCount = 0;
    renderCachedMessages();
  }

  function getOrCreateBar() {
    let bar = document.getElementById(BAR_ID);
    const main = getMain();
    if (!main) return null;

    if (!bar) {
      bar = document.createElement("div");
      bar.id = BAR_ID;
      bar.dataset.hidden = "true";
      bar.innerHTML = `
        <span class="cgat-actions">
          <button type="button" class="cgat-load-btn">↑ Load previous</button>
          <button type="button" class="cgat-show-all-btn">Show all</button>
        </span>
        <span class="cgat-status">
          <span class="cgat-badge">
            <span class="cgat-dot"></span>
            <span class="cgat-hidden-text">0 hidden</span>
          </span>
          <span class="cgat-meta">No payload trim seen yet</span>
        </span>
      `;
      main.prepend(bar);

      bar.querySelector(".cgat-load-btn").addEventListener("click", () => {
        handleLoadPrevious();
      });

      bar.querySelector(".cgat-show-all-btn").addEventListener("click", () => {
        handleShowAll();
      });
    } else if (!main.contains(bar)) {
      main.prepend(bar);
    }

    return bar;
  }

  function updateBar(hiddenCount, settings) {
    const bar = getOrCreateBar();
    if (!bar) return;

    const payloadTrimmedCount = hasPayloadTrimAvailable()
      ? Math.max(0, Number(state.lastPreRender.olderAvailable || 0))
      : 0;

    const badgeText = hiddenCount > 0
      ? `${hiddenCount} hidden`
      : payloadTrimmedCount > 0
        ? `${Math.max(0, payloadTrimmedCount - state.payloadLoadedOlderCount)} older hidden`
        : `0 hidden`;

    bar.querySelector(".cgat-hidden-text").textContent = badgeText;

    const meta = bar.querySelector(".cgat-meta");
    if (!state.extensionAlive) {
      meta.textContent = state.invalidationReason || "Extension reloaded. Refresh this tab.";
    } else if (state.isReloading) {
      meta.textContent = "Reloading chat…";
    } else if (state.lastPreRender) {
      const shownOlder = state.payloadLoadedOlderCount > 0 ? ` · ${state.payloadLoadedOlderCount} cached shown` : "";
      meta.textContent = `Payload kept ${state.lastPreRender.kept}/${state.lastPreRender.total} · ${state.lastPreRender.mode}${shownOlder}`;
    } else {
      meta.textContent = state.hookSeen ? "Hook ready · no payload trim seen yet" : "Hook not seen yet";
    }

    const loadBtn = bar.querySelector(".cgat-load-btn");
    const showAllBtn = bar.querySelector(".cgat-show-all-btn");
    const step = Math.max(1, Number(settings.keepCount) || DEFAULTS.keepCount);

    const domExpandable = hiddenCount > 0;
    const payloadExpandable = hasPayloadTrimAvailable() && state.payloadLoadedOlderCount < state.payloadOlderTotalCount;
    const canExpand = state.extensionAlive && !state.isReloading && (domExpandable || payloadExpandable);

    loadBtn.textContent = `↑ Load previous ${step}`;
    loadBtn.disabled = !canExpand || (domExpandable && state.showAll && !payloadExpandable);
    showAllBtn.disabled = !(state.extensionAlive && !state.isReloading && (domExpandable || hasPayloadTrimAvailable()));

    bar.dataset.hidden = hiddenCount > 0 || state.hookSeen || !!state.lastPreRender || !state.extensionAlive ? "false" : "true";
  }

  function computeTrim(settings) {
    const { nodes, method } = getTurnNodesWithMethod();
    const enabled = !!settings.enabled;
    const keepCount = Math.max(2, Number(settings.keepCount) || DEFAULTS.keepCount);
    const minTurnsBeforeTrim = Math.max(keepCount, Number(settings.minTurnsBeforeTrim) || DEFAULTS.minTurnsBeforeTrim);

    const grouped = groupNodesIntoTurns(nodes);
    const turns = grouped.turns;
    let hiddenTurns = 0;
    let hiddenNodes = [];

    if (enabled && turns.length > minTurnsBeforeTrim && !state.showAll) {
      const visibleTurnCount = Math.min(turns.length, keepCount + state.extraVisible);
      hiddenTurns = Math.max(0, turns.length - visibleTurnCount);
      hiddenNodes = turns.slice(0, hiddenTurns).flatMap((turn) => turn.nodes);
    }

    return {
      nodes,
      method,
      hiddenTurns,
      hiddenNodes,
      totalTurns: turns.length,
      hasMain: !!getMain()
    };
  }

  function applyTrim(settings) {
    injectStyle();
    applyUiTheme(settings);
    clearTrim();
    const info = computeTrim(settings);
    if (info.hiddenNodes.length > 0) {
      info.hiddenNodes.forEach((el) => el.setAttribute(HIDDEN_ATTR, "true"));
    }
    updateBar(info.hiddenTurns, settings);
    updateThresholdHint(info, settings);
    return info;
  }

  async function loadAndApply() {
    const settings = await safeGetSettings();
    state.isReloading = false;
    applyTrim(settings);
  }

  function scheduleApply() {
    if (!state.extensionAlive) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      loadAndApply().catch((err) => {
        state.lastStorageError = String(err?.message || err || "");
        if (isInvalidationError(err)) {
          setInvalidated("Extension was reloaded. Refresh this chat tab.");
        }
      });
    }, 180);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== "CGAT_MAIN") return;

    if (event.data.type === "HOOK_READY") {
      state.hookSeen = true;
      scheduleApply();
    }

    if (event.data.type === "PAYLOAD_TRIM_REPORT") {
      state.hookSeen = true;
      state.lastPreRender = event.data.payload || null;
      state.showAll = false;
      clearCachedMessages();
      state.payloadOlderTotalCount = Number(state.lastPreRender?.olderAvailable || 0);
      scheduleApply();
    }

    if (event.data.type === "HOOK_ERROR") {
      state.hookSeen = true;
      state.lastStorageError = event.data?.payload?.message || "HOOK_ERROR";
      scheduleApply();
    }

    if (event.data.type === "CACHED_MESSAGES_RESPONSE") {
      const payload = event.data.payload || {};
      if (!payload.requestId || payload.requestId !== state.cacheRequestId) return;

      state.showAll = false;
      state.payloadOlderTotalCount = Number(payload.totalOlderCount || 0);
      state.payloadLoadedOlderCount = Number(payload.loadedOlderCount || 0);
      state.cachedMessages = Array.isArray(payload.messages) ? payload.messages : [];
      state.cachedTurns = Array.isArray(payload.turns) ? payload.turns : [];
      renderCachedMessages();
      updateBar(computeTrim(state.settingsCache).hiddenTurns, state.settingsCache);
    }
  });

  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === "PING") {
        sendResponse({ ok: true, hookSeen: state.hookSeen });
        return true;
      }

      if (message?.type === "APPLY_TRIM") {
        state.extraVisible = 0;
        state.showAll = false;
        const settings = { ...DEFAULTS, ...(message.settings || {}) };
        state.settingsCache = settings;
        const info = applyTrim(settings);
        sendResponse({
          urlOk: /chatgpt\.com|chat\.openai\.com/.test(location.hostname),
          ...info,
          lastPreRender: state.lastPreRender,
          hookSeen: state.hookSeen,
          extensionAlive: state.extensionAlive,
          invalidationReason: state.invalidationReason,
          lastStorageError: state.lastStorageError,
          observerConnected: state.observerConnected
        });
        return true;
      }

      if (message?.type === "DEBUG_TRIM") {
        const settings = { ...DEFAULTS, ...(message.settings || {}) };
        state.settingsCache = settings;
        const info = computeTrim(settings);
        sendResponse({
          urlOk: /chatgpt\.com|chat\.openai\.com/.test(location.hostname),
          ...info,
          lastPreRender: state.lastPreRender,
          hookSeen: state.hookSeen,
          extensionAlive: state.extensionAlive,
          invalidationReason: state.invalidationReason,
          lastStorageError: state.lastStorageError,
          observerConnected: state.observerConnected,
          payloadOlderTotalCount: state.payloadOlderTotalCount,
          payloadLoadedOlderCount: state.payloadLoadedOlderCount
        });
        return true;
      }
    });
  } catch (_) {
    setInvalidated("Extension messaging unavailable. Refresh this chat tab.");
  }

  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && (changes.enabled || changes.keepCount || changes.minTurnsBeforeTrim)) {
        state.extraVisible = 0;
        state.showAll = false;
        state.settingsCache = {
          ...state.settingsCache,
          ...(changes.enabled?.newValue !== undefined ? { enabled: changes.enabled.newValue } : {}),
          ...(changes.keepCount?.newValue !== undefined ? { keepCount: changes.keepCount.newValue } : {}),
          ...(changes.minTurnsBeforeTrim?.newValue !== undefined ? { minTurnsBeforeTrim: changes.minTurnsBeforeTrim.newValue } : {}),
          ...(changes.uiTheme?.newValue !== undefined ? { uiTheme: changes.uiTheme.newValue } : {})
        };
        applyUiTheme(state.settingsCache);
        clearCachedMessages();
        pushSettingsToPage(state.settingsCache);
        scheduleApply();
      }
    });
  } catch (_) {}

  const observer = new MutationObserver((mutations) => {
    const relevant = mutations.some((mutation) => {
      const target = mutation.target;
      return target instanceof Node && !!(target.parentElement?.closest("main") || (target instanceof HTMLElement && target.closest("main")));
    });
    if (relevant) scheduleApply();
  });

  function start() {
    applyUiTheme(state.settingsCache);
    injectStyle();
    renderCachedMessages();
    scheduleApply();
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      state.observerConnected = true;
    }
  }

  const systemThemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  systemThemeMedia.addEventListener?.("change", () => {
    if ((state.settingsCache.uiTheme || "system") === "system") {
      applyUiTheme(state.settingsCache);
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
