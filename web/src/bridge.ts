// bridge.ts — RPC client to the extension. Two independent transports so the
// app runs either as a localhost page OR bundled inside the extension:
//
//   • localhost page      → window.postMessage ↔ app-bridge content script ↔ background
//   • chrome-extension://  → chrome.runtime.connect('sg-app') directly to background
//
// Both speak the same hub protocol: send {kind:'op',reqId,op,args}; receive
// {kind:'response'} / {kind:'event'}. Callers (call/on/pingBridge) are unchanged.

declare const chrome: any; // provided by the extension runtime (no @types/chrome dep)

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

const pending = new Map<string, Pending>();
const handlers = new Map<string, Set<(data: any) => void>>();
let seq = 0;

function emit(event: string, data: any) {
  const set = handlers.get(event);
  if (set) for (const fn of set) fn(data);
}
function resolveResponse(reqId: string, ok: boolean, data: any, error?: string) {
  const p = pending.get(reqId);
  if (!p) return;
  pending.delete(reqId);
  if (ok) p.resolve(data); else p.reject(new Error(error || 'unknown error'));
}

// --- transport selection --------------------------------------------------
const isExtensionPage =
  typeof chrome !== 'undefined' && !!chrome.runtime?.id && location.protocol === 'chrome-extension:';

// In-extension: a direct port to the background hub (same 'sg-app' protocol the
// app-bridge content script uses on localhost).
let extPort: any = null;
let extReconnect: number | null = null;
const outbox: any[] = [];

function extConnect() {
  try { extPort = chrome.runtime.connect({ name: 'sg-app' }); }
  catch { extPort = null; scheduleExtReconnect(); return; }
  extPort.onMessage.addListener((msg: any) => {
    if (!msg) return;
    if (msg.kind === 'response') resolveResponse(msg.reqId, !!msg.ok, msg.data, msg.error);
    else if (msg.kind === 'event') emit(msg.event, msg.data);
  });
  extPort.onDisconnect.addListener(() => {
    extPort = null;
    emit('bridge-disconnected', {});
    scheduleExtReconnect();
  });
  while (outbox.length) extPort.postMessage(outbox.shift());
  emit('bridge-ready', {});
}
function scheduleExtReconnect() {
  if (extReconnect) return;
  extReconnect = window.setTimeout(() => { extReconnect = null; extConnect(); }, 800);
}
function extSend(opMsg: any) {
  if (extPort) { try { extPort.postMessage(opMsg); return; } catch { extPort = null; } }
  outbox.push(opMsg);
  if (!extPort) extConnect();
}

if (isExtensionPage) {
  extConnect();
} else {
  // localhost page: app-bridge relays everything as tagged window messages.
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d: any = ev.data;
    if (!d || d.__sg !== true) return;
    if (d.dir === 'from-ext') resolveResponse(d.reqId, !!d.ok, d.data, d.error);
    else if (d.dir === 'event') emit(d.event, d.data);
  });
}

export function call<T = any>(op: string, args: Record<string, any> = {}, timeoutMs = 60000): Promise<T> {
  const reqId = `r${++seq}_${Date.now()}`;
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => {
      if (pending.has(reqId)) { pending.delete(reqId); reject(new Error('timeout')); }
    }, timeoutMs);
    pending.set(reqId, {
      resolve: (v) => { window.clearTimeout(t); resolve(v as T); },
      reject: (e) => { window.clearTimeout(t); reject(e); },
    });
    if (isExtensionPage) extSend({ kind: 'op', reqId, op, args });
    else window.postMessage({ __sg: true, dir: 'to-ext', reqId, op, args }, window.location.origin);
  });
}

export function on(event: string, fn: (data: any) => void): () => void {
  let set = handlers.get(event);
  if (!set) { set = new Set(); handlers.set(event, set); }
  set.add(fn);
  return () => { set!.delete(fn); };
}

/** Resolve true if the extension bridge answers a ping quickly. */
export async function pingBridge(timeoutMs = 1500): Promise<boolean> {
  try { await call('ping', {}, timeoutMs); return true; } catch { return false; }
}
