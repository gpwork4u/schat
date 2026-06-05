// bridge.ts — RPC client that talks to the extension's app-bridge content
// script via window.postMessage. The extension relays each op into the
// chat.google.com tab and returns the result here.

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

const pending = new Map<string, Pending>();
const handlers = new Map<string, Set<(data: any) => void>>();
let seq = 0;

window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const d: any = ev.data;
  if (!d || d.__sg !== true) return;

  if (d.dir === 'from-ext') {
    const p = pending.get(d.reqId);
    if (!p) return;
    pending.delete(d.reqId);
    if (d.ok) p.resolve(d.data);
    else p.reject(new Error(d.error || 'unknown error'));
  } else if (d.dir === 'event') {
    const set = handlers.get(d.event);
    if (set) for (const fn of set) fn(d.data);
  }
});

export function call<T = any>(op: string, args: Record<string, any> = {}, timeoutMs = 60000): Promise<T> {
  const reqId = `r${++seq}_${Date.now()}`;
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => {
      if (pending.has(reqId)) {
        pending.delete(reqId);
        reject(new Error('timeout'));
      }
    }, timeoutMs);
    pending.set(reqId, {
      resolve: (v) => { window.clearTimeout(t); resolve(v as T); },
      reject: (e) => { window.clearTimeout(t); reject(e); },
    });
    window.postMessage({ __sg: true, dir: 'to-ext', reqId, op, args }, window.location.origin);
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
  try {
    await call('ping', {}, timeoutMs);
    return true;
  } catch {
    return false;
  }
}
