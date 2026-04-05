
const DEFAULTS = {
  enabled: true,
  keepCount: 12,
  minTurnsBeforeTrim: 20,
  uiTheme: "system"
};

const PAGE_STORAGE_KEY = "__CGAT_SETTINGS_V1__";

function setStatus(text) {
  const el = document.getElementById("status");
  if (!el) return;
  const visible = !!text && text !== "Popup ready.";
  el.dataset.visible = visible ? "true" : "false";
  el.textContent = visible ? text : "";
}

window.addEventListener("error", (event) => {
  setStatus(`Popup error: ${event.message}`);
});

function resolveTheme(uiTheme) {
  if (uiTheme === "light" || uiTheme === "dark") return uiTheme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyPopupTheme(uiTheme) {
  document.body.dataset.themeResolved = resolveTheme(uiTheme);
}

function updateEnabledCopy(isEnabled) {
  const label = document.getElementById("enabledLabel");
  const support = document.getElementById("enabledSupport");
  if (!label || !support) return;

  if (isEnabled) {
    label.textContent = "Enabled";
    support.textContent = "Automatic trim is on for this browser.";
  } else {
    label.textContent = "Disabled";
    support.textContent = "Automatic trim is off for this browser.";
  }
}

function normalizeSettings(input = {}) {
  const enabled = typeof input.enabled === "boolean" ? input.enabled : DEFAULTS.enabled;
  const keepCount = Math.max(2, Math.min(80, Number(input.keepCount) || DEFAULTS.keepCount));
  const minTurnsBeforeTrim = Math.max(
    keepCount,
    Math.min(500, Number(input.minTurnsBeforeTrim) || DEFAULTS.minTurnsBeforeTrim)
  );
  const uiTheme = ["system", "light", "dark"].includes(input.uiTheme) ? input.uiTheme : DEFAULTS.uiTheme;
  return { enabled, keepCount, minTurnsBeforeTrim, uiTheme };
}

async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function isChatGPTUrl(url) {
  return typeof url === "string" &&
    (url.startsWith("https://chatgpt.com/") || url.startsWith("https://chat.openai.com/"));
}

function setThemeControls(uiTheme) {
  const value = ["system", "light", "dark"].includes(uiTheme) ? uiTheme : "system";
  const input = document.querySelector(`input[name="uiTheme"][value="${value}"]`);
  if (input) input.checked = true;
  applyPopupTheme(value);
}

async function getSettingsFromUi() {
  const checkedTheme = document.querySelector('input[name="uiTheme"]:checked')?.value || "system";
  const settings = normalizeSettings({
    enabled: document.getElementById("enabled").checked,
    keepCount: document.getElementById("keepCount").value,
    minTurnsBeforeTrim: document.getElementById("minTurnsBeforeTrim").value,
    uiTheme: checkedTheme
  });

  document.getElementById("enabled").checked = settings.enabled;
  document.getElementById("keepCount").value = settings.keepCount;
  document.getElementById("minTurnsBeforeTrim").value = settings.minTurnsBeforeTrim;
  setThemeControls(settings.uiTheme);
  updateEnabledCopy(settings.enabled);

  return settings;
}

async function saveOnly(statusText = "Settings saved.") {
  const settings = await getSettingsFromUi();
  await chrome.storage.local.set(settings);
  applyPopupTheme(settings.uiTheme);
  setStatus(statusText);
}

function setAdvancedOpen(isOpen) {
  const toggle = document.getElementById("advancedToggle");
  const panel = document.getElementById("advancedPanel");
  toggle.dataset.open = isOpen ? "true" : "false";
  panel.dataset.open = isOpen ? "true" : "false";
}

async function ensureOnCorrectTab() {
  const tab = await getCurrentTab();
  if (!tab?.id || !isChatGPTUrl(tab.url)) {
    setStatus("Open a ChatGPT chat tab first.");
    return null;
  }
  return tab;
}

async function writeSettingsIntoPage(tabId, settings) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (storageKey, incomingSettings) => {
      localStorage.setItem(storageKey, JSON.stringify(incomingSettings));
      window.dispatchEvent(new CustomEvent("cgat-settings-updated", { detail: incomingSettings }));
      return true;
    },
    args: [PAGE_STORAGE_KEY, settings]
  });
}

async function triggerReliableReload(tabId, settings) {
  // First, schedule a page-side reload so the action survives popup closure.
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (storageKey, incomingSettings) => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(incomingSettings));
        window.dispatchEvent(new CustomEvent("cgat-settings-updated", { detail: incomingSettings }));
      } catch (_) {}

      window.setTimeout(() => {
        try {
          location.reload();
        } catch (_) {}
      }, 80);

      return true;
    },
    args: [PAGE_STORAGE_KEY, settings]
  });

  // Also ask Chrome to reload the tab as a best-effort fallback.
  try {
    await chrome.tabs.reload(tabId);
  } catch (_) {}
}

async function injectFallbackScripts(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["main-hook.js"],
      world: "MAIN"
    });
  } catch (_) {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  } catch (_) {}
}

async function ensureReady(tabId, settings) {
  await writeSettingsIntoPage(tabId, settings);

  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    if (ping?.ok) return ping;
  } catch (_) {}

  await injectFallbackScripts(tabId);

  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    if (ping?.ok) return ping;
  } catch (_) {
    throw new Error("Content script did not respond after reinjection. Refresh the chat tab once.");
  }

  throw new Error("Unknown attachment failure.");
}

async function getPageDiag(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const diag = window.__CGAT_DIAG__ || null;
      const cache = window.__CGAT_CACHE__ || null;
      const storageRaw = localStorage.getItem("__CGAT_SETTINGS_V1__");
      let storageSettings = null;
      try {
        storageSettings = storageRaw ? JSON.parse(storageRaw) : null;
      } catch (_) {}
      return { href: location.href, title: document.title, diag, cache, storageSettings };
    }
  });

  return results?.[0]?.result || null;
}

async function sendToActiveTab(type) {
  const tab = await ensureOnCorrectTab();
  if (!tab) return null;

  const settings = await getSettingsFromUi();
  await chrome.storage.local.set(settings);

  setStatus("Attaching to current tab...");
  await ensureReady(tab.id, settings);
  setStatus("Attached. Running command...");

  const response = await chrome.tabs.sendMessage(tab.id, { type, settings });
  return { response, tabId: tab.id };
}

function formatDiag(response, pageDiag) {
  const lines = [];

  if (response) {
    lines.push(`URL ok: ${response.urlOk}`);
    lines.push(`Main found: ${response.hasMain}`);
    lines.push(`DOM candidates: ${response.totalTurns}`);
    lines.push(`Would hide: ${response.hiddenTurns}`);
    lines.push(`DOM method: ${response.method}`);
    lines.push(`Hook seen: ${response.hookSeen ? "yes" : "no"}`);
    lines.push(`Extension alive: ${response.extensionAlive ? "yes" : "no"}`);
    lines.push(`Observer connected: ${response.observerConnected ? "yes" : "no"}`);
    if (response.invalidationReason) lines.push(`Invalidation: ${response.invalidationReason}`);
    if (response.lastStorageError) lines.push(`Last storage error: ${response.lastStorageError}`);
    if (response.lastPreRender) {
      lines.push(`Last payload trim: ${response.lastPreRender.kept}/${response.lastPreRender.total}`);
      lines.push(`Payload mode: ${response.lastPreRender.mode}`);
      lines.push(`Payload URL: ${response.lastPreRender.url || "n/a"}`);
    } else {
      lines.push("Last payload trim: none seen yet");
    }
  }

  if (pageDiag?.storageSettings) {
    lines.push("");
    lines.push("[PAGE SETTINGS]");
    lines.push(`Enabled: ${pageDiag.storageSettings.enabled}`);
    lines.push(`keepCount: ${pageDiag.storageSettings.keepCount}`);
    lines.push(`minTurnsBeforeTrim: ${pageDiag.storageSettings.minTurnsBeforeTrim}`);
    lines.push(`uiTheme: ${pageDiag.storageSettings.uiTheme || "system"}`);
  }

  if (pageDiag?.cache) {
    const c = pageDiag.cache;
    lines.push("");
    lines.push("[PAGE CACHE]");
    lines.push(`Ready: ${c.ready ? "yes" : "no"}`);
    lines.push(`Renderable cached: ${c.renderableIds?.length ?? 0}`);
    lines.push(`Visible cached: ${c.visibleIds?.length ?? 0}`);
    lines.push(`Mapping cached: ${c.totalMappingNodes ?? 0}`);
    lines.push(`Last cached url: ${c.lastConversationUrl || "n/a"}`);
  }

  if (pageDiag?.diag) {
    const d = pageDiag.diag;
    lines.push("");
    lines.push("[PAGE HOOK]");
    lines.push(`Version: ${d.version || "unknown"}`);
    lines.push(`Hook installed: ${d.hookInstalled ? "yes" : "no"}`);
    lines.push(`JSON calls: ${d.jsonCalls ?? 0}`);
    lines.push(`Conversation responses seen: ${d.chatResponsesSeen ?? 0}`);
    lines.push(`Conversation trim calls: ${d.conversationTrimCalls ?? 0}`);
    lines.push(`Skipped non-conversation JSON: ${d.skippedNonConversationJson ?? 0}`);
    lines.push(`Trim attempts: ${d.trimAttempts ?? 0}`);
    lines.push(`Trim applied: ${d.trimApplied ?? 0}`);
    lines.push(`Last decision: ${d.lastDecision || "n/a"}`);
    lines.push(`Last total: ${d.lastTotal ?? "n/a"}`);
    lines.push(`Last kept: ${d.lastKept ?? "n/a"}`);
    lines.push(`Last keepCount: ${d.keepCount ?? "n/a"}`);
    lines.push(`Last trim ms: ${d.lastTrimMs ?? "n/a"}`);
    lines.push(`Last url: ${d.lastUrl || "n/a"}`);
    lines.push(`Last chain len: ${d.lastChainLength ?? "n/a"}`);
    lines.push(`Last renderable chain len: ${d.lastRenderableChainLength ?? "n/a"}`);

    if (d.reasonCounts && typeof d.reasonCounts === "object") {
      lines.push(`Reasons: ${Object.entries(d.reasonCounts).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
    }

    if (d.lastError) lines.push(`Last error: ${d.lastError}`);
  }

  lines.push("");
  lines.push("[INTERPRETATION]");
  lines.push("This pass only updates the UI. Trim, cache, and loading behavior stay the same.");
  return lines.join("\n");
}

document.getElementById("advancedToggle").addEventListener("click", () => {
  const next = document.getElementById("advancedPanel").dataset.open !== "true";
  setAdvancedOpen(next);
});

document.getElementById("enabled").addEventListener("change", () => saveOnly().catch(err => setStatus(`Save failed: ${err.message}`)));
document.getElementById("keepCount").addEventListener("change", () => saveOnly().catch(err => setStatus(`Save failed: ${err.message}`)));
document.getElementById("minTurnsBeforeTrim").addEventListener("change", () => saveOnly().catch(err => setStatus(`Save failed: ${err.message}`)));

for (const radio of document.querySelectorAll('input[name="uiTheme"]')) {
  radio.addEventListener("change", async () => {
    const settings = await getSettingsFromUi();
    applyPopupTheme(settings.uiTheme);
    await saveOnly("Appearance updated.");
  });
}

document.getElementById("trimBtn").addEventListener("click", async () => {
  try {
    const result = await sendToActiveTab("APPLY_TRIM");
    if (!result) return;
    const { response, tabId } = result;
    const pageDiag = await getPageDiag(tabId);
    setStatus(response ? formatDiag(response, pageDiag) : "No response from page.");
  } catch (err) {
    setStatus(`Trim failed: ${err.message}`);
  }
});

document.getElementById("debugBtn").addEventListener("click", async () => {
  try {
    const result = await sendToActiveTab("DEBUG_TRIM");
    if (!result) return;
    const { response, tabId } = result;
    const pageDiag = await getPageDiag(tabId);
    setStatus(response ? formatDiag(response, pageDiag) : "No debug response from page.");
  } catch (err) {
    setStatus(`Debug failed: ${err.message}`);
  }
});

document.getElementById("reloadBtn").addEventListener("click", async () => {
  try {
    const tab = await ensureOnCorrectTab();
    if (!tab) return;

    const settings = await getSettingsFromUi();
    await chrome.storage.local.set(settings);

    setStatus("Attaching to current tab...");
    await ensureReady(tab.id, settings);

    setStatus("Scheduling trim and reload...");
    await triggerReliableReload(tab.id, settings);
  } catch (err) {
    setStatus(`Reload failed: ${err.message}`);
  }
});

async function init() {
  const raw = await chrome.storage.local.get(DEFAULTS);
  const settings = normalizeSettings(raw);
  await chrome.storage.local.set(settings);

  document.getElementById("enabled").checked = settings.enabled;
  document.getElementById("keepCount").value = settings.keepCount;
  document.getElementById("minTurnsBeforeTrim").value = settings.minTurnsBeforeTrim;
  setThemeControls(settings.uiTheme);
  updateEnabledCopy(settings.enabled);
  setAdvancedOpen(false);
  setStatus("");
}

const systemThemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
systemThemeMedia.addEventListener?.("change", () => {
  const checked = document.querySelector('input[name="uiTheme"]:checked')?.value || "system";
  if (checked === "system") applyPopupTheme("system");
});

init().catch(err => setStatus(`Init failed: ${err.message}`));
