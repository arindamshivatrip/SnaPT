# SnaPT: ChatGPT Chat Optimizer v24

Reliability fix for the primary reload action.

## What changed
- Made the **Trim and reload** button more reliable
- The popup now:
  - re-attaches to the current ChatGPT tab first
  - writes settings into page storage
  - schedules a page-side `location.reload()` so the reload survives popup closure
  - also requests `chrome.tabs.reload()` as a fallback

## Why this helps
Some reload failures were likely caused by the popup closing or the tab not being fully reattached before the reload call. This patch keeps the same functionality but makes the reload action more robust.

## What did NOT change
- Trim logic
- Cache logic
- Debug behavior
- Appearance / popup layout


## v25 changes
- Removed `activeTab` from the manifest to keep permissions narrower while preserving `storage`, `tabs`, `scripting`, and the ChatGPT-only host permissions.
- Changed turn counting from message-based to user-anchored grouped turns:
  - one turn starts at a user message
  - all following assistant-final messages belong to that turn until the next user message
- `keep recent turns`, `start trimming after`, and `Load previous N` now follow grouped-turn semantics instead of raw visible-message counts.


## v26 changes
- Fixed a UI state bug where **Load previous N** could remain disabled while **Show all** stayed enabled.
- Fixed popup debug/status text wrapping so long URLs and multiline diagnostics stay inside the popup.
- Reduced live payload weight again by trimming each kept turn to:
  - the user node
  - plus only the last assistant-final node for that turn
- The full turn remains available in cache for older-message expansion, so the trim is lighter without changing the core mechanism.


## v27 changes
- Live trimmed payload now preserves assistant thinking/activity only for the most recent quarter of kept turns.
- Older kept turns stay minimal for speed.
- Cached history is now rendered turn-by-turn:
  - user message
  - optional merged/collapsible thinking/activity block
  - merged final assistant reply
- Popup debug/status text now wraps long lines more cleanly.


## v28 changes
- Live trimmed payload now preserves thinking/activity for exactly the last 2 kept turns, instead of the recent quarter.
- Turn grouping is now structure-first:
  - one turn starts at a user message
  - assistant-side content inside that turn is grouped first by position
  - the last assistant-side message becomes the final reply
  - earlier assistant-side messages become the thinking/activity block
- Cached history renderer continues to render one turn at a time with:
  - user message
  - optional merged collapsible thinking/activity block
  - merged final assistant reply


## v29 changes
- Fixed cached-panel layout so expanded cached history stays in a bounded scrolling region instead of pushing the page/composer around.
- Aligned the thinking/activity block to the same assistant lane as cached assistant replies.
- Removed the `Trim current DOM` button from the popup.


## v30 changes
- Removed the nested cached-history header/control bar so only the global top bar remains.
- Removed the internal cached-history scroll widget; cached turns now render inline in the thread flow.
- Aligned the thinking/activity block to the same assistant lane as cached assistant replies.
- Kept the popup without the `Trim current DOM` button.


## v31 changes
- Strips timer-only activity stubs like “Thought for 1m 23s” so they no longer appear as fake thinking.
- Broadens text extraction from assistant/tool payloads to surface more substantive cached activity content.
- Renders cached thinking/activity inside the assistant card instead of as a separate strip.
- Adds a visible chevron to the collapsible thinking/activity section.
