// background.js — service worker. The hub that routes RPC between the local
// Slack-like web app and the Google Chat tab.
//
//   web app (localhost) ──port──> background ──tabs.sendMessage──> content.js
//                                     │  (on chat.google.com)        │
//                                     │                              ▼
//                                     │                         inject-main.js
//                                     └──────── events broadcast ◀────┘
//
// Two message planes:
//   1. RPC ops: app → background → chat tab → result → app  (request/response)
//   2. Events:  chat tab → background → all app ports        (push, e.g. new msg)

const CHAT_TAB_URLS = [
  'https://chat.google.com/*',
  'https://mail.google.com/chat/*',
];

// Long-lived ports from app-bridge.js (one per open web-app tab).
const appPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sg-app') return;
  appPorts.add(port);
  port.onDisconnect.addListener(() => appPorts.delete(port));
  port.onMessage.addListener((msg) => handleAppMessage(port, msg));
});

function broadcastEvent(event, data) {
  for (const port of appPorts) {
    try {
      port.postMessage({ kind: 'event', event, data });
    } catch {
      appPorts.delete(port);
    }
  }
}

async function findChatTab() {
  const tabs = await chrome.tabs.query({ url: CHAT_TAB_URLS });
  // Prefer a loaded tab.
  const loaded = tabs.find((t) => t.status === 'complete') || tabs[0];
  return loaded || null;
}

async function handleAppMessage(port, msg) {
  if (!msg || msg.kind !== 'op') return;
  const { reqId, op, args } = msg;

  // Background-level ops that don't need the chat tab.
  if (op === 'ping') {
    port.postMessage({ kind: 'response', reqId, ok: true, data: { pong: true } });
    return;
  }
  if (op === 'open_chat_tab') {
    try {
      const existing = await findChatTab();
      if (existing) {
        await chrome.tabs.update(existing.id, { active: true });
        port.postMessage({ kind: 'response', reqId, ok: true, data: { tabId: existing.id, created: false } });
      } else {
        const tab = await chrome.tabs.create({ url: 'https://chat.google.com/', active: true });
        port.postMessage({ kind: 'response', reqId, ok: true, data: { tabId: tab.id, created: true } });
      }
    } catch (e) {
      port.postMessage({ kind: 'response', reqId, ok: false, error: String(e?.message || e) });
    }
    return;
  }

  // Everything else is forwarded into the chat tab.
  const tab = await findChatTab();
  if (!tab) {
    port.postMessage({
      kind: 'response',
      reqId,
      ok: false,
      error: 'no-chat-tab',
    });
    return;
  }

  try {
    const result = await sendToChatTab(tab.id, { type: 'sg-op', reqId, op, args });
    port.postMessage({ kind: 'response', reqId, ...result });
  } catch (e) {
    port.postMessage({
      kind: 'response',
      reqId,
      ok: false,
      error: String(e?.message || e),
    });
  }
}

function sendToChatTab(tabId, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    // The content script may take a while (network RPCs). Give it generous time.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('chat-tab timeout'));
    }, 60000);
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response || { ok: false, error: 'empty-response' });
      });
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    }
  });
}

// Events pushed from the chat tab (content.js) → broadcast to all app ports.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === 'sg-event') {
    broadcastEvent(msg.event, msg.data);
    return false;
  }

  // chrome.cookies is only reachable from the service worker — kept for any
  // future need to dump google.com auth cookies.
  if (msg.type === 'dump-google-cookies') {
    collectGoogleCookies()
      .then((cookies) => sendResponse({ ok: true, cookies }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  return false;
});

// Notify the app when the chat tab navigates/reloads so the UI can re-sync.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const url = tab?.url || '';
  if (/^https:\/\/chat\.google\.com\//.test(url) || /^https:\/\/mail\.google\.com\/chat\//.test(url)) {
    broadcastEvent('chat-tab-ready', { tabId, url });
  }
});

const RELEVANT_COOKIE_DOMAINS = ['.google.com', 'chat.google.com', 'mail.google.com'];
async function collectGoogleCookies() {
  const all = await Promise.all(
    RELEVANT_COOKIE_DOMAINS.map((domain) => chrome.cookies.getAll({ domain }))
  );
  const seen = new Set();
  const out = [];
  for (const list of all) {
    for (const c of list || []) {
      const key = `${c.domain}|${c.name}|${c.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: c.name, value: c.value, domain: c.domain, path: c.path });
    }
  }
  return out;
}
