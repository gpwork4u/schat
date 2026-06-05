// content.js — runs on chat.google.com (isolated world, document_start).
//
//   background.js ──tabs.sendMessage(sg-op)──> content.js ──postMessage──> inject-main.js (MAIN world)
//   background.js <──sendResponse(op-result)── content.js <──postMessage── inject-main.js
//   background.js <──runtime.sendMessage(sg-event)── content.js <──postMessage(event)── inject-main.js
//
// content.js owns no Chat wire-format logic; it is a pure relay between the
// extension messaging plane and the MAIN-world hook.

const log = (...a) => console.log('[sg:content]', ...a);
const warn = (...a) => console.warn('[sg:content]', ...a);

// --- 1. Inject the MAIN-world hook ASAP -----------------------------------
try {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('inject-main.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
} catch (e) {
  warn('inject failed', e);
}

log('active @', location.href);

// --- 2. Pending RPCs awaiting a MAIN-world result -------------------------
// reqId → sendResponse callback handed to us by chrome.tabs.sendMessage.
const pending = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'sg-op') return false;
  const { reqId, op, args } = msg;
  pending.set(reqId, sendResponse);
  window.postMessage(
    { source: 'sg-content', kind: 'op', reqId, op, args: args || {} },
    '*'
  );
  // Safety net: if MAIN world never replies, release the channel.
  setTimeout(() => {
    if (pending.has(reqId)) {
      pending.get(reqId)({ ok: false, error: 'main-world-timeout' });
      pending.delete(reqId);
    }
  }, 55000);
  return true; // keep the response channel open (async)
});

// --- 3. Messages coming back from inject-main.js (MAIN world) -------------
window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const data = ev.data || {};
  if (data.source !== 'sg-main') return;

  if (data.kind === 'op-result') {
    const cb = pending.get(data.reqId);
    if (cb) {
      cb({ ok: !!data.ok, data: data.data, error: data.error || '' });
      pending.delete(data.reqId);
    }
    return;
  }

  if (data.kind === 'event') {
    try {
      chrome.runtime.sendMessage({ type: 'sg-event', event: data.event, data: data.data });
    } catch (e) {
      // Service worker may be asleep; it will wake on the next message.
    }
    return;
  }
});
