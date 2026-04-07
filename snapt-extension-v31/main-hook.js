
(() => {
  if (window.__CGAT_MAIN_HOOK_LOADED__) return;
  window.__CGAT_MAIN_HOOK_LOADED__ = true;

  const STORAGE_KEY = "__CGAT_SETTINGS_V1__";
  const REPORT_PREFIX = "CGAT_MAIN";

  const DEFAULTS = {
    enabled: true,
    keepCount: 12,
    minTurnsBeforeTrim: 20
  };

  const DIAG = window.__CGAT_DIAG__ = {
    version: "v31",
    hookInstalled: true,
    initializedAt: Date.now(),
    jsonCalls: 0,
    chatResponsesSeen: 0,
    trimAttempts: 0,
    trimApplied: 0,
    reasonCounts: {},
    lastDecision: null,
    lastTotal: null,
    lastKept: null,
    lastUrl: null,
    lastMode: null,
    lastTrimMs: null,
    lastChainLength: null,
    lastRenderableChainLength: null,
    keepCount: null,
    lastError: null,
    cacheReady: false,
    cacheRenderable: 0,
    cacheVisible: 0,
    cacheTotalMapping: 0,
    syntheticNodesPerTurn: "older=minimal,last2=with_activity",
    optimizedConversationOnly: true,
    skippedNonConversationJson: 0,
    conversationTrimCalls: 0
  };

  const CACHE = window.__CGAT_CACHE__ = {
    version: "v31",
    ready: false,
    mapping: null,
    currentNode: null,
    chainChronoIds: [],
    renderableIds: [],
    visibleIds: [],
    activityIds: [],
    turnGroups: [],
    visibleMessageIds: [],
    lastConversationUrl: null,
    lastCachedAt: null,
    totalMappingNodes: 0,
    recentThinkingTurns: 0,
    recentTurnBuffer: []
  };

  let cachedSettings = null;

  function post(type, payload = {}) {
    try {
      window.postMessage({ source: REPORT_PREFIX, type, payload }, "*");
    } catch (_) {}
  }

  function noteReason(reason) {
    DIAG.reasonCounts[reason] = (DIAG.reasonCounts[reason] || 0) + 1;
    DIAG.lastDecision = reason;
  }

  function readSettings() {
    if (cachedSettings) return cachedSettings;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      cachedSettings = {
        enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULTS.enabled,
        keepCount: Math.max(2, Number(parsed.keepCount) || DEFAULTS.keepCount),
        minTurnsBeforeTrim: Math.max(2, Number(parsed.minTurnsBeforeTrim) || DEFAULTS.minTurnsBeforeTrim)
      };
    } catch (_) {
      cachedSettings = { ...DEFAULTS };
    }
    DIAG.keepCount = cachedSettings.keepCount;
    return cachedSettings;
  }

  function updateCachedSettings(incoming) {
    cachedSettings = {
      enabled: typeof incoming.enabled === "boolean" ? incoming.enabled : DEFAULTS.enabled,
      keepCount: Math.max(2, Number(incoming.keepCount) || DEFAULTS.keepCount),
      minTurnsBeforeTrim: Math.max(2, Number(incoming.minTurnsBeforeTrim) || DEFAULTS.minTurnsBeforeTrim)
    };
    DIAG.keepCount = cachedSettings.keepCount;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedSettings));
    } catch (_) {}
    return cachedSettings;
  }

  window.addEventListener("cgat-settings-updated", (event) => {
    updateCachedSettings(event?.detail || {});
    post("HOOK_READY", { settings: cachedSettings, refreshed: true });
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== "CGAT_CONTENT") return;

    if (event.data.type === "UPDATE_SETTINGS") {
      updateCachedSettings(event.data.payload || {});
      noteReason("settings_updated_from_content");
      post("HOOK_READY", { settings: cachedSettings, refreshed: true, via: "content-message" });
      return;
    }

    if (event.data.type === "REQUEST_CACHED_MESSAGES") {
      const payload = event.data.payload || {};
      const requestId = payload.requestId || null;
      const mode = payload.mode === "all" ? "all" : "chunk";
      const currentLoaded = Math.max(0, Number(payload.currentLoaded) || 0);
      const step = Math.max(1, Number(payload.step) || readSettings().keepCount || DEFAULTS.keepCount);

      const response = buildCachedMessagesResponse({ mode, currentLoaded, step });
      post("CACHED_MESSAGES_RESPONSE", { requestId, ...response });
    }
  });

  function isObject(value) {
    return value && typeof value === "object" && !Array.isArray(value);
  }

  function messageLike(node) {
    if (!isObject(node)) return null;
    return isObject(node.message) ? node.message : node;
  }

  function messageRole(node) {
    const msg = messageLike(node);
    return msg?.author?.role || msg?.role || msg?.message?.author?.role || null;
  }

  function extractText(value, seen = new WeakSet(), depth = 0) {
    if (typeof value === "string") return value;
    if (value == null) return "";
    if (depth > 5) return "";

    if (Array.isArray(value)) {
      return value.map((item) => extractText(item, seen, depth + 1)).filter(Boolean).join("\n\n");
    }

    if (typeof value !== "object") return "";

    if (seen.has(value)) return "";
    seen.add(value);

    const priorityKeys = [
      "text", "content", "value", "parts", "children",
      "title", "body", "description", "summary",
      "message", "result", "input", "output",
      "stdout", "stderr", "reasoning", "status_text",
      "caption", "explanation"
    ];

    const chunks = [];
    for (const key of priorityKeys) {
      if (key in value) {
        const text = extractText(value[key], seen, depth + 1);
        if (text) chunks.push(text);
      }
    }

    if (chunks.length === 0) {
      for (const [key, child] of Object.entries(value)) {
        if (["id", "parent", "children", "author", "role", "create_time", "update_time", "recipient", "name", "status"].includes(key)) {
          continue;
        }
        const text = extractText(child, seen, depth + 1);
        if (text) chunks.push(text);
      }
    }

    return [...new Set(chunks.filter(Boolean))].join("\n\n");
  }

  function isDurationOnlyText(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    return /^(?:Thought|Thinking|Activity)(?:\s*for|\s*[·-])?\s*(?:(?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s)?)$/i.test(t)
      || /^(?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s)$/i.test(t);
  }

  function serializeMessageNode(id, node) {
    const msg = messageLike(node) || {};
    const role = messageRole(node) || "unknown";
    const content = msg.content || msg.message?.content || {};
    const parts = Array.isArray(content?.parts) ? content.parts : Array.isArray(msg.parts) ? msg.parts : [];
    const text = extractText(parts.length ? parts : content) || "";
    const createTime = Number(msg.create_time || node?.create_time || 0) || 0;
    return {
      id,
      role,
      text: text.trim(),
      createTime
    };
  }

  function cleanCachedText(raw) {
    return String(raw || "")
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
  }

  function looksLikeToolJson(text) {
    const t = cleanCachedText(text);
    if (!t) return false;

    if ((t.startsWith("{") || t.startsWith("[")) &&
        /"?(search_query|open|click|find|response_length|image_query|product_query|calculator|weather|sports|finance)"?\s*:/.test(t)) {
      return true;
    }

    const punctuationDensity = ((t.match(/[{}\[\]":,]/g) || []).length) / Math.max(t.length, 1);
    return punctuationDensity > 0.12 && /:\s*["[{0-9]/.test(t);
  }

  function looksLikeAssistantMeta(text) {
    const t = cleanCachedText(text).toLowerCase();
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
    if (isDurationOnlyText(cleanCachedText(text))) return true;
    if (/^(searching|checking|patching|building|updating)\b/.test(t)) return true;

    return false;
  }

  function looksLikeFinalAssistant(text) {
    const t = cleanCachedText(text);
    if (!t) return false;
    if (looksLikeToolJson(t)) return false;
    if (looksLikeAssistantMeta(t)) return false;
    if (t.length < 40) return false;
    return /[a-zA-Z].*[.!?]|\n\s*\n|:/.test(t);
  }

  function classifySerializedMessage(msg) {
    const role = msg?.role || "unknown";
    const text = cleanCachedText(msg?.text || "");

    if (!text) return "ignore";
    if (role === "user") return "user";
    if (looksLikeToolJson(text)) return "tool";
    if (looksLikeAssistantMeta(text)) return "assistant_meta";
    if (looksLikeFinalAssistant(text)) return "assistant_final";
    return "assistant_side";
  }

  function isVisibleMessageKind(kind) {
    return kind === "user" || kind === "assistant_final";
  }

  function buildTurnGroupsFromChain(mapping, chainChrono) {
    const renderableIds = chainChrono.filter((id) => hasRenderableMessage(mapping[id]));
    const visibleMessageIds = [];
    const activityIds = [];
    const turnGroups = [];
    let currentTurn = null;

    for (const id of renderableIds) {
      const serialized = serializeMessageNode(id, mapping[id]);
      const role = serialized?.role || "unknown";
      const kind = classifySerializedMessage(serialized);

      if (role === "user") {
        currentTurn = {
          userId: id,
          visibleIds: [id],
          assistantAllIds: [],
          assistantFinalIds: [],
          activityIds: [],
          allIds: [id]
        };
        turnGroups.push(currentTurn);
        visibleMessageIds.push(id);
        continue;
      }

      if (!currentTurn) {
        continue;
      }

      // assistant-side content belongs to the current user-anchored turn
      if (role === "assistant" || kind === "tool" || kind === "assistant_meta" || kind === "assistant_side" || kind === "assistant_final") {
        currentTurn.assistantAllIds.push(id);
        currentTurn.allIds.push(id);
      }
    }

    for (const turn of turnGroups) {
      const assistantSerialized = turn.assistantAllIds
        .map((id) => serializeMessageNode(id, mapping[id]))
        .filter(Boolean);

      let finalAssistantId = null;
      for (let i = assistantSerialized.length - 1; i >= 0; i--) {
        const item = assistantSerialized[i];
        if (cleanCachedText(item.text || "") && !looksLikeToolJson(item.text || "")) {
          finalAssistantId = item.id;
          break;
        }
      }
      if (!finalAssistantId && assistantSerialized.length > 0) {
        finalAssistantId = assistantSerialized[assistantSerialized.length - 1].id;
      }

      turn.assistantFinalIds = finalAssistantId ? [finalAssistantId] : [];
      turn.activityIds = turn.assistantAllIds.filter((id) => id !== finalAssistantId);
      turn.syntheticIds = finalAssistantId ? [turn.userId, finalAssistantId] : [turn.userId];

      if (finalAssistantId) {
        visibleMessageIds.push(finalAssistantId);
        turn.visibleIds.push(finalAssistantId);
      }
      activityIds.push(...turn.activityIds);
    }

    return {
      renderableIds,
      visibleMessageIds,
      activityIds,
      turnGroups
    };
  }

  function hasRenderableMessage(node) {
    const msg = messageLike(node);
    if (!isObject(msg)) return false;
    const role = messageRole(node);
    const content = msg.content || msg.message?.content || null;
    const parts = content?.parts || msg.parts || null;
    return !!role || !!content || (Array.isArray(parts) && parts.length > 0);
  }

  function isStructuralPrefixNode(node) {
    const role = messageRole(node);
    if (role === "system" || role === "developer") return true;
    if (!hasRenderableMessage(node)) return true;
    return false;
  }

  function pickLatestMappingId(mapping) {
    const ids = Object.keys(mapping);
    let bestId = ids[ids.length - 1] || null;
    let bestTime = -Infinity;

    for (const id of ids) {
      const node = mapping[id];
      const t = Number(node?.message?.create_time) || Number(node?.create_time) || 0;
      if (t >= bestTime) {
        bestTime = t;
        bestId = id;
      }
    }
    return bestId;
  }

  function collectCurrentChain(mapping, currentId) {
    const chainNewestFirst = [];
    const seen = new Set();
    let cursor = currentId;

    while (cursor && mapping[cursor] && !seen.has(cursor)) {
      chainNewestFirst.push(cursor);
      seen.add(cursor);
      cursor = mapping[cursor].parent || null;
    }

    return chainNewestFirst.reverse();
  }


  function cacheConversation(mapping, current, chainChrono, urlStr) {
    try {
      const grouped = buildTurnGroupsFromChain(mapping, chainChrono);

      CACHE.mapping = structuredClone(mapping);
      CACHE.currentNode = current;
      CACHE.chainChronoIds = chainChrono.slice();
      CACHE.renderableIds = grouped.renderableIds;
      CACHE.visibleIds = grouped.turnGroups.map((turn) => turn.userId);
      CACHE.visibleMessageIds = grouped.visibleMessageIds;
      CACHE.activityIds = grouped.activityIds;
      CACHE.turnGroups = grouped.turnGroups.map((turn) => ({
        userId: turn.userId,
        visibleIds: turn.visibleIds.slice(),
        assistantFinalIds: turn.assistantFinalIds.slice(),
        syntheticIds: turn.syntheticIds.slice(),
        activityIds: turn.activityIds.slice(),
        allIds: turn.allIds.slice()
      }));
      CACHE.lastConversationUrl = urlStr || "";
      CACHE.lastCachedAt = Date.now();
      CACHE.totalMappingNodes = Object.keys(mapping).length;
      CACHE.recentTurnBuffer = grouped.turnGroups.slice(-2).map((turn) => ({
        userId: turn.userId,
        assistantFinalIds: turn.assistantFinalIds.slice(),
        activityIds: turn.activityIds.slice(),
        assistant: turn.assistantFinalIds
          .map((id) => serializeMessageNode(id, mapping[id]))
          .filter(Boolean),
        activity: turn.activityIds
          .map((id) => serializeMessageNode(id, mapping[id]))
          .filter((item) => {
            const cleaned = cleanCachedText(item?.text || "");
            return cleaned && !isDurationOnlyText(cleaned);
          })
      }));
      CACHE.ready = true;

      DIAG.cacheReady = true;
      DIAG.cacheRenderable = CACHE.renderableIds.length;
      DIAG.cacheVisible = CACHE.visibleIds.length;
      DIAG.cacheTotalMapping = CACHE.totalMappingNodes;
    } catch (err) {
      DIAG.lastError = String(err?.message || err);
      noteReason("cache_failed");
    }
  }

  function buildSyntheticSelection(mapping, chainChrono, keepCount) {
    const grouped = buildTurnGroupsFromChain(mapping, chainChrono);
    const turnGroups = grouped.turnGroups;

    DIAG.lastChainLength = chainChrono.length;
    DIAG.lastRenderableChainLength = turnGroups.length;

    if (turnGroups.length === 0) {
      noteReason("no_visible_chain");
      return null;
    }

    const keptTurns = turnGroups.slice(-keepCount);
    if (!keptTurns.length) {
      noteReason("kept_visible_empty");
      return null;
    }

    const firstVisibleToKeep = keptTurns[0].userId;
    const startIndex = chainChrono.indexOf(firstVisibleToKeep);
    if (startIndex < 0) {
      noteReason("start_index_missing");
      return null;
    }

    const prefixCandidates = chainChrono
      .slice(0, startIndex)
      .filter((id) => isStructuralPrefixNode(mapping[id]));

    const ordered = [];
    const seen = new Set();

    if (prefixCandidates.length > 0) {
      const firstPrefix = prefixCandidates[0];
      if (mapping[firstPrefix] && !seen.has(firstPrefix)) {
        ordered.push(firstPrefix);
        seen.add(firstPrefix);
      }

      const lastPrefix = prefixCandidates[prefixCandidates.length - 1];
      if (lastPrefix && mapping[lastPrefix] && !seen.has(lastPrefix)) {
        ordered.push(lastPrefix);
        seen.add(lastPrefix);
      }
    }

    const recentThinkingTurns = Math.min(2, Math.max(1, keptTurns.length));
    DIAG.recentThinkingTurns = recentThinkingTurns;
    const recentThinkingStart = Math.max(0, keptTurns.length - recentThinkingTurns);

    keptTurns.forEach((turn, index) => {
      const idsForTurn = index >= recentThinkingStart
        ? [turn.userId, ...turn.activityIds, ...turn.assistantFinalIds]
        : turn.syntheticIds;

      for (const id of idsForTurn) {
        if (mapping[id] && !seen.has(id)) {
          ordered.push(id);
          seen.add(id);
        }
      }
    });

    if (ordered.length === 0) {
      noteReason("ordered_empty");
      return null;
    }

    return ordered;
  }

  function synthesizeLinearMapping(mapping, orderedIds, currentId) {
    const newMapping = {};

    for (let i = 0; i < orderedIds.length; i++) {
      const id = orderedIds[i];
      const original = mapping[id];
      if (!original) continue;

      const clone = structuredClone(original);
      const prevId = i > 0 ? orderedIds[i - 1] : null;
      const nextId = i < orderedIds.length - 1 ? orderedIds[i + 1] : null;

      clone.parent = prevId;
      clone.children = nextId ? [nextId] : [];

      newMapping[id] = clone;
    }

    const safeCurrent = newMapping[currentId] ? currentId : orderedIds[orderedIds.length - 1];
    return {
      mapping: newMapping,
      currentNode: safeCurrent
    };
  }

  function pruneMappingObject(container) {
    const settings = readSettings();
    DIAG.keepCount = settings.keepCount;
    DIAG.trimAttempts += 1;

    if (!settings.enabled) {
      noteReason("disabled");
      return null;
    }

    const mapping = container?.mapping;
    if (!isObject(mapping)) {
      noteReason("no_mapping");
      return null;
    }

    const total = Object.keys(mapping).length;
    DIAG.lastTotal = total;
    if (total <= settings.minTurnsBeforeTrim || total <= settings.keepCount + 2) {
      noteReason("below_threshold");
      return null;
    }

    let current = container?.current_node;
    if (!current || !mapping[current]) current = pickLatestMappingId(mapping);
    if (!current || !mapping[current]) {
      noteReason("no_current");
      return null;
    }

    const chainChrono = collectCurrentChain(mapping, current);
    if (chainChrono.length <= settings.keepCount + 2) {
      noteReason("chain_too_short");
      return null;
    }

    cacheConversation(mapping, current, chainChrono, DIAG.lastUrl);

    const orderedIds = buildSyntheticSelection(mapping, chainChrono, settings.keepCount);
    if (!orderedIds || orderedIds.length === 0) {
      return null;
    }

    if (orderedIds.length >= total) {
      noteReason("synthetic_not_smaller");
      return null;
    }

    const syntheticCurrent = orderedIds[orderedIds.length - 1];
    const synthetic = synthesizeLinearMapping(mapping, orderedIds, syntheticCurrent);
    DIAG.lastKept = Object.keys(synthetic.mapping).length;
    DIAG.lastMode = "mapping-synthetic";
    DIAG.trimApplied += 1;
    noteReason("trim_applied");

    const visibleTotal = CACHE.visibleIds.length;
    const olderAvailable = Math.max(0, visibleTotal - settings.keepCount);

    return {
      changed: true,
      value: {
        ...container,
        mapping: synthetic.mapping,
        current_node: synthetic.currentNode
      },
      report: {
        mode: "mapping-synthetic",
        total,
        kept: Object.keys(synthetic.mapping).length,
        keepCount: settings.keepCount,
        visibleTotal,
        olderAvailable,
        cacheReady: CACHE.ready
      }
    };
  }

  function tryTrimValue(value, depth = 0, seen = new WeakSet()) {
    if (!value || typeof value !== "object" || depth > 10) return null;
    if (seen.has(value)) return null;
    seen.add(value);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const trimmed = tryTrimValue(value[i], depth + 1, seen);
        if (trimmed?.changed) {
          const clone = value.slice();
          clone[i] = trimmed.value;
          return {
            changed: true,
            value: clone,
            report: trimmed.report
          };
        }
      }
      return null;
    }

    const direct = pruneMappingObject(value);
    if (direct) return direct;

    for (const [key, child] of Object.entries(value)) {
      const trimmed = tryTrimValue(child, depth + 1, seen);
      if (trimmed?.changed) {
        return {
          changed: true,
          value: { ...value, [key]: trimmed.value },
          report: trimmed.report
        };
      }
    }

    return null;
  }


  function buildCachedMessagesResponse({ mode, currentLoaded, step }) {
    const settings = readSettings();

    if (!CACHE.ready || !CACHE.mapping || !Array.isArray(CACHE.turnGroups) || CACHE.turnGroups.length === 0) {
      noteReason("cached_messages_not_ready");
      return {
        ready: false,
        messages: [],
        turns: [],
        totalOlderCount: 0,
        loadedOlderCount: 0,
        remainingOlderCount: 0,
        fromCache: false
      };
    }

    const turnGroups = CACHE.turnGroups;
    const totalTurns = turnGroups.length;
    const recentTurnCount = Math.max(1, settings.keepCount);
    const olderCount = Math.max(0, totalTurns - recentTurnCount);

    let targetOlderCount = 0;
    if (mode === "all") {
      targetOlderCount = olderCount;
    } else {
      targetOlderCount = Math.min(olderCount, currentLoaded + step);
    }

    const startIndex = Math.max(0, olderCount - targetOlderCount);
    const endIndex = olderCount;
    const selectedTurns = turnGroups.slice(startIndex, endIndex);

    const recentBufferByUserId = new Map(
      (Array.isArray(CACHE.recentTurnBuffer) ? CACHE.recentTurnBuffer : []).map((turn) => [turn.userId, turn])
    );

    const turns = selectedTurns.map((turn) => {
      const backup = recentBufferByUserId.get(turn.userId);
      const assistant = turn.assistantFinalIds
        .map((id) => serializeMessageNode(id, CACHE.mapping[id]))
        .filter(Boolean);

      let activity = turn.activityIds
        .map((id) => serializeMessageNode(id, CACHE.mapping[id]))
        .filter(Boolean);

      if (activity.length === 0 && Array.isArray(backup?.activity) && backup.activity.length > 0) {
        activity = backup.activity.slice();
      }

      activity = activity.filter((item) => {
        const cleaned = cleanCachedText(item?.text || "");
        return cleaned && !isDurationOnlyText(cleaned);
      });

      return {
        user: serializeMessageNode(turn.userId, CACHE.mapping[turn.userId]),
        assistant: assistant.length > 0 ? assistant : (Array.isArray(backup?.assistant) ? backup.assistant.slice() : []),
        activity
      };
    });

    const selectedIds = selectedTurns.flatMap((turn) => turn.allIds);
    const messages = selectedIds
      .map((id) => serializeMessageNode(id, CACHE.mapping[id]))
      .filter(Boolean);

    noteReason(mode === "all" ? "cached_messages_all" : "cached_messages_chunk");

    return {
      ready: true,
      fromCache: true,
      messages,
      turns,
      totalOlderCount: olderCount,
      loadedOlderCount: selectedTurns.length,
      remainingOlderCount: Math.max(0, olderCount - selectedTurns.length),
      totalVisible: totalTurns,
      visibleRecentCount: recentTurnCount
    };
  }

  function maybeTrimPayload(payload, url) {
    const settings = readSettings();
    if (!settings.enabled) {
      noteReason("disabled");
      return payload;
    }

    const urlStr = typeof url === "string" ? url : "";
    DIAG.lastUrl = urlStr.slice(0, 180);

    if (!/\/backend-api\/conversation\//.test(urlStr)) {
      DIAG.skippedNonConversationJson += 1;
      noteReason("skipped_non_conversation");
      return payload;
    }

    DIAG.chatResponsesSeen += 1;
    DIAG.conversationTrimCalls += 1;

    const started = performance.now();
    try {
      const trimmed = tryTrimValue(payload);
      DIAG.lastTrimMs = Math.round((performance.now() - started) * 100) / 100;

      if (!trimmed?.changed) {
        if (!DIAG.lastDecision) noteReason("no_change");
        return payload;
      }

      post("PAYLOAD_TRIM_REPORT", {
        ...trimmed.report,
        url: DIAG.lastUrl
      });

      return trimmed.value;
    } catch (err) {
      DIAG.lastError = String(err?.message || err);
      noteReason("exception");
      post("HOOK_ERROR", { message: DIAG.lastError });
      return payload;
    }
  }

  const originalJson = Response.prototype.json;
  Response.prototype.json = async function(...args) {
    DIAG.jsonCalls += 1;
    const data = await originalJson.apply(this, args);
    return maybeTrimPayload(data, this?.url);
  };

  post("HOOK_READY", { settings: readSettings(), refreshed: false });
})();
