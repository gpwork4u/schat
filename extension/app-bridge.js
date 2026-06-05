// app-bridge.js — content script injected into the local web app (localhost).
//
// Bridges the page's window.postMessage RPC to the extension's background hub.
//
//   page  ──postMessage(to-ext)──> app-bridge ──port──> background
//   page  <──postMessage(from-ext)── app-bridge <──port── background  (responses)
//   page  <──postMessage(event)──── app-bridge <──port── background   (push events)
//
// The page only sees window messages tagged { __sg: true }; it never touches
// chrome.* APIs (which it can't anyway). This is how the page detects that the
// extension is installed: it gets a `bridge-ready` event.

(function () {
  let port = null;
  const outbox = []; // ops queued while the port is (re)connecting

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'sg-app' });
    } catch (e) {
      port = null;
      scheduleReconnect();
      return;
    }
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.kind === 'response') {
        window.postMessage(
          { __sg: true, dir: 'from-ext', reqId: msg.reqId, ok: msg.ok, data: msg.data, error: msg.error },
          window.location.origin
        );
      } else if (msg.kind === 'event') {
        window.postMessage(
          { __sg: true, dir: 'event', event: msg.event, data: msg.data },
          window.location.origin
        );
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      // The service worker idled out or was reloaded — tell the page and retry.
      window.postMessage({ __sg: true, dir: 'event', event: 'bridge-disconnected', data: {} }, window.location.origin);
      scheduleReconnect();
    });
    // Flush anything queued during the gap.
    while (outbox.length) port.postMessage(outbox.shift());
    window.postMessage({ __sg: true, dir: 'event', event: 'bridge-ready', data: {} }, window.location.origin);
  }

  let reconnectTimer = null;
  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 800);
  }

  function send(opMsg) {
    if (port) {
      try {
        port.postMessage(opMsg);
        return;
      } catch (e) {
        port = null;
      }
    }
    outbox.push(opMsg);
    if (!port) connect();
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data || {};
    if (d.__sg !== true || d.dir !== 'to-ext') return;
    send({ kind: 'op', reqId: d.reqId, op: d.op, args: d.args || {} });
  });

  connect();
  // Re-announce on full load in case the page's listener attached late.
  window.addEventListener('load', () => {
    window.postMessage({ __sg: true, dir: 'event', event: 'bridge-ready', data: {} }, window.location.origin);
  });
})();
