import { useEffect, useRef, useState, useCallback } from 'react';
import type { Space, Message, SessionStatus, BridgeState, SectionInfo, Member, MentionSpec } from './types';
import { ExternalLink, AlertTriangle, Sun, Moon, Bell, BellOff } from 'lucide-react';
import { playChime, ensurePermission, showNotification } from './notify';
import { call, on, pingBridge } from './bridge';
import Sidebar from './components/Sidebar';
import MessageList from './components/MessageList';
import ThreadPanel from './components/ThreadPanel';
import Composer from './components/Composer';
import ScheduledView from './components/ScheduledView';
import Logo from './components/Logo';

interface Toast { id: number; text: string; err?: boolean; }

// Stable per-message cache key for an attachment. The wire `token` ROTATES on
// every poll (it's a per-response signed token), so caching by token misses
// every time → the image re-resolves and flickers. Key by messageId+index.
function attKey(messageId: string, index: number) { return `${messageId}#${index}`; }

// Merge already-resolved attachment image URLs into messages' `images`.
function mergeImages(msgs: Message[], urls: Record<string, string>): Message[] {
  let changed = false;
  const out = msgs.map((m) => {
    if (!m.attachments || m.attachments.length === 0) return m;
    const resolved = m.attachments.map((_a, i) => urls[attKey(m.messageId, i)]).filter(Boolean) as string[];
    const cur = m.images || [];
    const add = resolved.filter((u) => !cur.includes(u));
    if (add.length === 0) return m;
    changed = true;
    return { ...m, images: [...cur, ...add] };
  });
  return changed ? out : msgs;
}

// Keep optimistic reactions (add OR remove) visible until the server's view
// catches up, so toggling doesn't briefly revert on the next poll. `pending` is
// messageId → (emoji → { delta: +1|-1, exp }).
interface PendReact { delta: number; exp: number; }
function applyPending(msgs: Message[], pending: Map<string, Map<string, PendReact>>, now: number): Message[] {
  if (pending.size === 0) return msgs;
  return msgs.map((m) => {
    const pend = pending.get(m.messageId);
    if (!pend || pend.size === 0) return m;
    let reactions = (m.reactions || []).map((r) => ({ ...r }));
    let changed = false;
    for (const [emoji, { delta, exp }] of pend) {
      if (now > exp) continue; // stale → let expiry sweep handle it
      const r = reactions.find((x) => x.emoji === emoji);
      if (delta > 0) {
        if (r && r.mine) continue;                 // server already has my add
        if (r) { r.count += 1; r.mine = true; } else { reactions.push({ emoji, count: 1, mine: true }); }
        changed = true;
      } else {
        if (!r || !r.mine) continue;               // server already removed mine
        r.count -= 1; r.mine = false;
        if (r.count <= 0) reactions = reactions.filter((x) => x.emoji !== emoji);
        changed = true;
      }
    }
    return changed ? { ...m, reactions } : m;
  });
}

// Signature of the rendered-relevant fields — lets us reuse the previous message
// object when nothing visible changed, so memoised rows don't re-render (and
// images don't flicker) on every poll.
function msgSig(m: Message): string {
  return [
    m.body, m.ts, m.senderName, m.avatar, m.attachmentNote || '',
    (m.images || []).join(','),
    (m.reactions || []).map((r) => `${r.emoji}${r.count}${r.mine ? 1 : 0}`).join(','),
    (m.mentions || []).map((x) => x.text).join(','),
  ].join('|');
}

function reconcile(
  prev: Message[], fresh: Message[], urls: Record<string, string>,
  pending: Map<string, Map<string, PendReact>>, now: number,
): Message[] {
  const merged = applyPending(mergeImages(fresh, urls), pending, now);
  const byId = new Map(prev.map((m) => [m.messageId, m]));
  return merged.map((m) => {
    const old = byId.get(m.messageId);
    return old && msgSig(old) === msgSig(m) ? old : m;
  });
}

export default function App() {
  const [bridge, setBridge] = useState<BridgeState>('connecting');
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [sections, setSections] = useState<SectionInfo[]>([]);
  const [customEmojis, setCustomEmojis] = useState<{ shortcode: string; url: string }[]>([]);
  const [emojiUrlMap, setEmojiUrlMap] = useState<Record<string, string>>({});
  const [members, setMembers] = useState<Member[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [messagesByKey, setMessagesByKey] = useState<Record<string, Message[]>>({});
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  type Scheduled = { clientId: string; spaceKey: string; text: string; scheduledSec: number };
  const [showScheduled, setShowScheduled] = useState(false);
  const [loadingScheduled, setLoadingScheduled] = useState(false);
  const [scheduled, setScheduled] = useState<Scheduled[]>([]);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [openThreadKey, setOpenThreadKey] = useState<string | null>(null);
  const [attUrls, setAttUrls] = useState<Record<string, string>>({});
  const attUrlsRef = useRef<Record<string, string>>({});
  attUrlsRef.current = attUrls;
  // messageId → (emoji → expiry ts): optimistic reactions awaiting server echo.
  const pendingReactionsRef = useRef<Map<string, Map<string, PendReact>>>(new Map());
  const [filter, setFilter] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    (localStorage.getItem('sg-theme') as 'light' | 'dark') || 'light');
  const [notify, setNotify] = useState<boolean>(() => localStorage.getItem('sg-notify') === '1');
  const notifyRef = useRef(notify); notifyRef.current = notify;
  const notifiedRef = useRef<Set<string>>(new Set());   // messageIds already notified (dedupe)
  const resolvingRef = useRef<Set<string>>(new Set());
  const spacesRef = useRef<Space[]>([]); spacesRef.current = spaces;
  const myIdRef = useRef('');
  myIdRef.current = session?.myUserId || myIdRef.current;

  // Apply + persist the colour theme on the document root (covers portaled
  // popovers like the emoji picker / mention menu too).
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('sg-theme', theme);
  }, [theme]);

  useEffect(() => { localStorage.setItem('sg-notify', notify ? '1' : '0'); }, [notify]);

  const activeRef = useRef<string | null>(null);
  activeRef.current = activeKey;
  const scrollRef = useRef<HTMLDivElement>(null);
  // Bridge to call the latest reload/loadSpaces from event handlers + timers
  // without re-subscribing (avoids stale closures).
  const actionsRef = useRef<{ reloadSpace?: (k: string) => void; loadSpaces?: () => void; loadEmojis?: () => void; selectSpace?: (k: string) => void }>({});
  const activityTimer = useRef<number | undefined>(undefined);

  const toast = useCallback((text: string, err = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, err }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  // Toggle desktop notifications. Enabling requests browser permission and plays
  // the chime once as a preview so the user hears what to expect.
  const toggleNotify = useCallback(async () => {
    if (notify) { setNotify(false); return; }
    const ok = await ensurePermission();
    if (!ok) { toast('瀏覽器未授權通知，請在網址列允許通知後再試', true); return; }
    setNotify(true);
    playChime();
  }, [notify, toast]);

  // --- bridge / session detection ------------------------------------------
  const probe = useCallback(async () => {
    setBridge('connecting');
    const hasBridge = await pingBridge();
    if (!hasBridge) { setBridge('no-extension'); return; }
    try {
      const st = await call<SessionStatus>('session_status', {}, 6000);
      setSession(st);
      setBridge('ready');
    } catch (e) {
      const msg = String((e as Error).message || e);
      setBridge(msg.includes('no-chat-tab') ? 'no-chat-tab' : 'no-chat-tab');
    }
  }, []);

  useEffect(() => { void probe(); }, [probe]);

  // subscribe to push events from the extension
  useEffect(() => {
    const offs = [
      on('bridge-ready', () => { void probe(); }),
      on('bridge-disconnected', () => setBridge('connecting')),
      on('chat-tab-ready', () => { void probe(); }),
      on('session-ready', (st: SessionStatus) => { setSession(st); setBridge('ready'); }),
      on('sections-updated', () => { actionsRef.current.loadSpaces?.(); }),
      // The native client fired its custom-emoji RPC — replay it for the full set.
      on('emoji-rpc-ready', () => { actionsRef.current.loadEmojis?.(); }),
      on('message', (m: Message) => handleLive(m)),
      // Realtime mirror: any webchannel activity → debounced refetch of the open
      // channel + the world (unread / new channels).
      on('activity', () => {
        if (activityTimer.current) return;
        activityTimer.current = window.setTimeout(() => {
          activityTimer.current = undefined;
          // Only refresh the open channel on activity — refreshing the whole
          // channel list here floods the API; the world is polled on a timer.
          const k = activeRef.current;
          if (k) actionsRef.current.reloadSpace?.(k);
        }, 600);
      }),
    ];
    return () => offs.forEach((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probe]);

  // --- load spaces once ready ----------------------------------------------
  const loadingSpacesRef = useRef(false);
  const loadSpaces = useCallback(async () => {
    if (loadingSpacesRef.current) return; // avoid concurrent reloads stomping each other
    loadingSpacesRef.current = true;
    try {
      const { spaces: list, sections: secs } = await call<{ spaces: Space[]; sections?: SectionInfo[] }>('list_spaces', {}, 40000);
      if (secs) setSections(secs);
      setSpaces((prev) => {
        const unread: Record<string, number> = {};
        for (const s of prev) if (s.unread) unread[s.spaceKey] = s.unread;
        return list.map((s) => ({ ...s, unread: unread[s.spaceKey] || 0 }));
      });
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (msg.includes('no-chat-tab')) setBridge('no-chat-tab');
      else if (msg.includes('boq')) toast('請在 Google Chat 分頁開啟任一對話以啟用瀏覽', true);
      else toast(`載入頻道失敗：${msg}`, true);
    } finally {
      loadingSpacesRef.current = false;
    }
  }, [toast]);

  // Create a new space (channel), then refresh the list and open it.
  const newChannel = useCallback(async () => {
    const name = window.prompt('新頻道名稱');
    if (!name || !name.trim()) return;
    try {
      const res = await call<{ ok: boolean; spaceKey?: string; name?: string }>('create_space', { name: name.trim() }, 30000);
      await loadSpaces();
      toast(`已建立頻道「${res.name || name.trim()}」`);
      if (res.spaceKey) actionsRef.current.selectSpace?.(res.spaceKey);
    } catch (e) {
      toast(`建立頻道失敗：${String((e as Error).message || e)}`, true);
    }
  }, [loadSpaces, toast]);

  // Create a custom emoji: pick an image, name it, upload + register, refresh.
  const newEmoji = useCallback(async (file: File) => {
    const shortcode = window.prompt('emoji 代碼（例如 party_cat）');
    if (!shortcode || !shortcode.trim()) return;
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || '').split(',')[1] || '');
        fr.onerror = () => reject(new Error('讀取圖片失敗'));
        fr.readAsDataURL(file);
      });
      const res = await call<{ ok: boolean; shortcode?: string }>('create_emoji', {
        shortcode: shortcode.trim(), base64, filename: file.name, contentType: file.type || 'image/png',
      }, 60000);
      actionsRef.current.loadEmojis?.(); // re-fetch catalog so the new emoji's image URL resolves
      toast(`已建立自訂 emoji ${res.shortcode || `:${shortcode.trim()}:`}`);
    } catch (e) {
      toast(`建立 emoji 失敗：${String((e as Error).message || e)}`, true);
    }
  }, [toast]);

  const loadMembers = useCallback(() => {
    call<{ members: Member[] }>('list_members', {}, 8000)
      .then((r) => { if (r?.members) setMembers(r.members); })
      .catch(() => { /* mention candidates optional */ });
  }, []);

  type EmojiResp = { custom: { shortcode: string; url: string }[]; customUrlByShortcode: Record<string, string> };
  const applyEmojis = useCallback((r: EmojiResp) => {
    setCustomEmojis(r.custom || []);
    setEmojiUrlMap(r.customUrlByShortcode || {});
  }, []);
  const loadEmojis = useCallback(() => {
    // frecent first (instant), then the COMPLETE set via the paginated Gq6Wmd
    // "browse all" RPC (sequential pages → allow plenty of time for big orgs).
    call<EmojiResp>('list_emojis', {}, 8000).then(applyEmojis).catch(() => {});
    call<EmojiResp>('load_all_custom_emojis', {}, 60000).then(applyEmojis).catch(() => {});
  }, [applyEmojis]);

  useEffect(() => {
    if (bridge === 'ready' && spaces.length === 0) void loadSpaces();
    if (bridge === 'ready' && customEmojis.length === 0) loadEmojis();
    if (bridge === 'ready') loadMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  // --- messages ------------------------------------------------------------
  const reloadSpace = useCallback(async (key: string, showSpinner = false) => {
    if (showSpinner) setLoadingMsgs(true);
    try {
      const res = await call<{ messages: Message[] }>('load_space_messages', { spaceKey: key, maxTopics: 30 }, 60000);
      setMessagesByKey((prev) => {
        // Keep optimistic (temp) messages that the fresh fetch doesn't cover yet,
        // so a just-sent message never disappears while the server indexes it.
        const old = prev[key] || [];
        const bodies = new Set(res.messages.map((m) => m.body));
        const survivingTemps = old.filter((m) => m.temp && !bodies.has(m.body));
        // Reconcile against the previous list: re-apply resolved image URLs +
        // pending reactions, and reuse unchanged message objects so memoised rows
        // don't re-render (no image flicker) on each poll.
        const merged = reconcile(old, [...res.messages, ...survivingTemps], attUrlsRef.current, pendingReactionsRef.current, Date.now());
        return { ...prev, [key]: merged };
      });
      loadMembers(); // newly-seen senders become @mention candidates
    } catch (e) {
      toast(`載入訊息失敗：${String((e as Error).message || e)}`, true);
    } finally {
      if (showSpinner) setLoadingMsgs(false);
    }
  }, [toast, loadMembers]);

  // Page OLDER history: re-anchor list_topics to the oldest loaded message and
  // PREPEND whatever's older (deduped + re-sorted). list_topics is message-level,
  // so we anchor on the earliest ts we hold.
  const loadOlder = useCallback(async (key: string, oldestIso: string) => {
    if (!key || !oldestIso) return;
    const beforeTs = new Date(oldestIso).getTime() * 1000; // µs
    setLoadingOlder(true);
    try {
      const res = await call<{ messages: Message[] }>('load_older_messages', { spaceKey: key, beforeTs }, 60000);
      setMessagesByKey((prev) => {
        const cur = prev[key] || [];
        const byId = new Set(cur.map((m) => m.messageId));
        const additions = mergeImages(res.messages.filter((m) => !byId.has(m.messageId)), attUrlsRef.current);
        if (!additions.length) { toast('沒有更早的訊息了'); return prev; }
        const merged = [...cur, ...additions].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
        return { ...prev, [key]: merged };
      });
    } catch (e) {
      toast(`載入更早訊息失敗：${String((e as Error).message || e)}`, true);
    } finally {
      setLoadingOlder(false);
    }
  }, [toast]);

  const selectSpace = useCallback((key: string) => {
    setActiveKey(key);
    setReplyTo(null);
    setOpenThreadKey(null);
    setShowScheduled(false);
    setSpaces((prev) => prev.map((s) => (s.spaceKey === key ? { ...s, unread: 0 } : s)));
    void reloadSpace(key, !messagesByKey[key]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadSpace, messagesByKey]);

  const handleLive = useCallback((m: Message) => {
    if (!m || !m.spaceKey || !m.messageId) return;
    setMessagesByKey((prev) => {
      const list = prev[m.spaceKey];
      if (!list) return prev; // space not opened yet
      if (list.some((x) => x.messageId === m.messageId)) return prev;
      // Drop any optimistic placeholder this real message supersedes.
      const cleaned = list.filter((x) => !(x.temp && x.body === m.body));
      return { ...prev, [m.spaceKey]: [...cleaned, m] };
    });
    const inactive = m.spaceKey !== activeRef.current;
    if (inactive) {
      setSpaces((prev) => prev.map((s) => (s.spaceKey === m.spaceKey ? { ...s, unread: (s.unread || 0) + 1 } : s)));
    }
    // New-message notification: skip our own echoes; notify only when the user
    // isn't already looking at that channel (different channel OR tab hidden).
    const mine = !!m.senderId && !!myIdRef.current && m.senderId === myIdRef.current;
    if (notifyRef.current && !mine && !notifiedRef.current.has(m.messageId) && (inactive || document.hidden)) {
      notifiedRef.current.add(m.messageId);
      if (notifiedRef.current.size > 500) notifiedRef.current = new Set([...notifiedRef.current].slice(-200));
      const sp = spacesRef.current.find((s) => s.spaceKey === m.spaceKey);
      const where = sp ? (sp.type === 'dm' ? sp.name : `#${sp.name}`) : '新訊息';
      const title = m.senderName ? `${where} · ${m.senderName}` : where;
      playChime();
      showNotification(title, m.body || '（傳送了附件或訊息）', m.spaceKey, () => actionsRef.current.selectSpace?.(m.spaceKey));
    }
  }, []);

  // Expose latest reload/loadSpaces to event handlers + polling timers.
  actionsRef.current = { reloadSpace: (k: string) => void reloadSpace(k), loadSpaces: () => void loadSpaces(), loadEmojis, selectSpace };

  // Polling fallback so the mirror stays fresh even if the webchannel stream is
  // quiet or its frames aren't recognised: refresh the open channel + world on
  // a slow interval (the 'activity' trigger handles low-latency updates).
  useEffect(() => {
    if (bridge !== 'ready') return;
    const tMsgs = window.setInterval(() => { const k = activeRef.current; if (k) void reloadSpace(k); }, 20000);
    const tWorld = window.setInterval(() => { void loadSpaces(); }, 60000);
    return () => { window.clearInterval(tMsgs); window.clearInterval(tWorld); };
  }, [bridge, reloadSpace, loadSpaces]);

  // --- lazy-resolve received image attachments -----------------------------
  // Messages carry image attachments as blob tokens; resolve each (once) to a
  // data URL via the extension, then merge into the message's `images`.
  useEffect(() => {
    const msgs = activeKey ? messagesByKey[activeKey] || [] : [];
    const pending: { key: string; token: string; contentType: string }[] = [];
    for (const m of msgs) {
      (m.attachments || []).forEach((a, i) => {
        const key = attKey(m.messageId, i);
        if (!attUrls[key] && !resolvingRef.current.has(key)) {
          resolvingRef.current.add(key);
          pending.push({ key, token: a.token, contentType: a.contentType });
        }
      });
    }
    if (!pending.length) return;
    void (async () => {
      for (const a of pending) {
        try {
          const r = await call<{ url: string }>('resolve_attachment', { token: a.token, contentType: a.contentType }, 30000);
          if (r?.url) setAttUrls((prev) => ({ ...prev, [a.key]: r.url }));
          else resolvingRef.current.delete(a.key); // empty → allow a later retry
        } catch {
          // leave the key marked so a render loop doesn't hammer a failing fetch
        }
      }
    })();
  }, [activeKey, messagesByKey, attUrls]);

  // Once tokens resolve, fold the URLs into the stored messages (stable identity)
  // so images stay put across reloads instead of being recomputed each render.
  useEffect(() => {
    setMessagesByKey((prev) => {
      let any = false;
      const next: Record<string, Message[]> = {};
      for (const k of Object.keys(prev)) {
        const merged = mergeImages(prev[k], attUrls);
        next[k] = merged;
        if (merged !== prev[k]) any = true;
      }
      return any ? next : prev;
    });
  }, [attUrls]);

  // Always land on the newest message when opening a channel or when new
  // messages arrive. Scroll after layout (rAF) and again shortly after, so
  // late-loading avatars don't leave us stranded above the bottom.
  const activeMsgs = activeKey ? messagesByKey[activeKey] || [] : [];
  const lastMsgId = activeMsgs.length ? activeMsgs[activeMsgs.length - 1].messageId : '';
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const toBottom = () => { el.scrollTop = el.scrollHeight; };
    const raf = requestAnimationFrame(toBottom);
    const t = window.setTimeout(toBottom, 120);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(t); };
  }, [activeKey, lastMsgId, loadingMsgs]);

  // --- actions -------------------------------------------------------------
  const sendMessage = useCallback(async (text: string, mentions: MentionSpec[] = []) => {
    const key = activeKey;
    if (!key) return;
    const tempId = `temp_${Date.now()}`;
    const optimistic: Message = {
      messageId: tempId, spaceKey: key, threadKey: replyTo?.threadKey,
      senderId: myIdRef.current || 'me', senderName: '你', body: text, ts: new Date().toISOString(), temp: true,
      mentions: mentions.map((mn) => ({ text: text.substr(mn.start, mn.len), userId: mn.userId })),
    };
    setMessagesByKey((prev) => ({ ...prev, [key]: [...(prev[key] || []), optimistic] }));
    try {
      const res = await call<{ message?: Message }>('send_message', {
        spaceKey: key, text, mentions,
        threadKey: replyTo?.threadKey || '',
        sendMode: replyTo ? 'reply' : 'new',
      }, 30000);
      setReplyTo(null);
      // The send response echoes the real created message — swap the optimistic
      // placeholder for it so the message stays visible regardless of reload.
      if (res && res.message && res.message.messageId) {
        const real = { ...res.message, senderName: res.message.senderName || '你' };
        setMessagesByKey((prev) => {
          const list = (prev[key] || []).filter((m) => m.messageId !== tempId);
          if (list.some((m) => m.messageId === real.messageId)) return { ...prev, [key]: list };
          return { ...prev, [key]: [...list, real] };
        });
      }
      setTimeout(() => void reloadSpace(key), 1500);
    } catch (e) {
      setMessagesByKey((prev) => ({ ...prev, [key]: (prev[key] || []).filter((x) => x.messageId !== tempId) }));
      toast(`傳送失敗：${String((e as Error).message || e)}`, true);
      throw e;
    }
  }, [activeKey, replyTo, reloadSpace, toast]);

  const sendImage = useCallback(async (img: { dataUrl: string; base64: string; filename: string; contentType: string }, caption: string) => {
    const key = activeKey;
    if (!key) return;
    const tempId = `temp_${Date.now()}`;
    const optimistic: Message = {
      messageId: tempId, spaceKey: key, threadKey: replyTo?.threadKey,
      senderId: myIdRef.current || 'me', senderName: '你', body: caption, ts: new Date().toISOString(), temp: true,
      images: [img.dataUrl],
    };
    setMessagesByKey((prev) => ({ ...prev, [key]: [...(prev[key] || []), optimistic] }));
    try {
      await call('send_image', {
        spaceKey: key, threadKey: replyTo?.threadKey || '',
        base64: img.base64, filename: img.filename, contentType: img.contentType, caption,
      }, 90000);
      setReplyTo(null);
      setTimeout(() => void reloadSpace(key), 1500);
    } catch (e) {
      setMessagesByKey((prev) => ({ ...prev, [key]: (prev[key] || []).filter((x) => x.messageId !== tempId) }));
      toast(`圖片傳送失敗：${String((e as Error).message || e)}`, true);
      throw e;
    }
  }, [activeKey, replyTo, reloadSpace, toast]);

  const scheduleMessage = useCallback(async (text: string, whenMs: number) => {
    const key = activeKey;
    if (!key) return;
    try {
      await call('schedule_message', { spaceKey: key, text, whenMs }, 30000);
      toast(`已排程於 ${new Date(whenMs).toLocaleString()} 傳送`);
    } catch (e) {
      toast(`排程失敗：${String((e as Error).message || e)}`, true);
      throw e;
    }
  }, [activeKey, toast]);

  // List scheduled messages across ALL channels (list_unsent_messages with no
  // space filter returns every record; each carries its own spaceKey).
  // `silent` skips the loading spinner — used after cancel/reschedule, where the
  // list is already optimistically updated, so the view never flashes "載入中…".
  const refreshScheduled = useCallback(async (silent = false) => {
    if (!silent) setLoadingScheduled(true);
    try {
      const res = await call<{ scheduled: Scheduled[] }>('list_scheduled', {}, 20000);
      setScheduled(res.scheduled || []);
    } catch (e) {
      if (!silent) { setScheduled([]); toast(`載入排程失敗：${String((e as Error).message || e)}`, true); }
    } finally { if (!silent) setLoadingScheduled(false); }
  }, [toast]);

  const openScheduledView = useCallback(() => {
    setShowScheduled(true);
    void refreshScheduled();
  }, [refreshScheduled]);

  const sameItem = (a: Scheduled, b: Scheduled) => a.clientId === b.clientId && a.spaceKey === b.spaceKey;

  const cancelScheduledItem = useCallback(async (item: Scheduled) => {
    setScheduled((prev) => prev.filter((s) => !sameItem(s, item)));   // optimistic remove
    try {
      await call('cancel_scheduled', { spaceKey: item.spaceKey, clientId: item.clientId }, 20000);
      toast('已取消排程');
      void refreshScheduled(true);                                    // silent reconcile
    } catch (e) {
      toast(`取消失敗：${String((e as Error).message || e)}`, true);
      void refreshScheduled(true);                                    // restore from server
    }
  }, [refreshScheduled, toast]);

  const rescheduleItem = useCallback(async (item: Scheduled, whenMs: number) => {
    const sec = Math.floor(whenMs / 1000);
    setScheduled((prev) => prev.map((s) => (sameItem(s, item) ? { ...s, scheduledSec: sec } : s))); // optimistic
    try {
      await call('reschedule_message', { spaceKey: item.spaceKey, clientId: item.clientId, whenMs }, 20000);
      toast('已更新排程時間');
      void refreshScheduled(true);
    } catch (e) {
      toast(`更新失敗：${String((e as Error).message || e)}`, true);
      void refreshScheduled(true);
    }
  }, [refreshScheduled, toast]);

  const sendThreadReply = useCallback(async (threadKey: string, text: string, mentions: MentionSpec[] = []) => {
    const key = activeKey;
    if (!key) return;
    const tempId = `temp_${Date.now()}`;
    const optimistic: Message = {
      messageId: tempId, spaceKey: key, threadKey,
      senderId: myIdRef.current || 'me', senderName: '你', body: text, ts: new Date().toISOString(), temp: true,
      mentions: mentions.map((mn) => ({ text: text.substr(mn.start, mn.len), userId: mn.userId })),
    };
    setMessagesByKey((prev) => ({ ...prev, [key]: [...(prev[key] || []), optimistic] }));
    try {
      const res = await call<{ message?: Message }>('send_message', {
        spaceKey: key, text, threadKey, sendMode: 'reply', mentions,
      }, 30000);
      if (res && res.message && res.message.messageId) {
        const real = { ...res.message, threadKey, senderName: res.message.senderName || '你' };
        setMessagesByKey((prev) => {
          const list = (prev[key] || []).filter((m) => m.messageId !== tempId);
          if (list.some((m) => m.messageId === real.messageId)) return { ...prev, [key]: list };
          return { ...prev, [key]: [...list, real] };
        });
      }
      setTimeout(() => void reloadSpace(key), 1500);
    } catch (e) {
      setMessagesByKey((prev) => ({ ...prev, [key]: (prev[key] || []).filter((x) => x.messageId !== tempId) }));
      toast(`回覆失敗：${String((e as Error).message || e)}`, true);
      throw e;
    }
  }, [activeKey, reloadSpace, toast]);

  const reactTo = useCallback(async (m: Message, emoji: string) => {
    // Toggle: if I already reacted with this emoji, remove it; else add. Use the
    // stored message's current state as the source of truth for `mine`.
    const current = (messagesByKey[m.spaceKey] || []).find((x) => x.messageId === m.messageId) || m;
    const mine = !!current.reactions?.find((r) => r.emoji === emoji)?.mine;
    const action = mine ? 'remove' : 'add';
    const delta = mine ? -1 : 1;
    // Optimistic delta that survives polls until the server echoes it back.
    const pend = pendingReactionsRef.current.get(m.messageId) || new Map<string, PendReact>();
    pend.set(emoji, { delta, exp: Date.now() + 12000 });
    pendingReactionsRef.current.set(m.messageId, pend);
    setMessagesByKey((prev) => {
      const list = prev[m.spaceKey];
      if (!list) return prev;
      return { ...prev, [m.spaceKey]: applyPending(list, pendingReactionsRef.current, Date.now()) };
    });
    try {
      await call('react', { spaceKey: m.spaceKey, messageId: m.messageId, emoji, action }, 20000);
      setTimeout(() => void reloadSpace(m.spaceKey), 1500);
    } catch (e) {
      pend.delete(emoji);
      void reloadSpace(m.spaceKey); // re-fetch authoritative counts
      toast(`表情失敗：${String((e as Error).message || e)}`, true);
    }
  }, [messagesByKey, toast, reloadSpace]);

  const deleteMessage = useCallback(async (m: Message) => {
    if (!window.confirm('刪除這則訊息？此動作無法復原。')) return;
    const key = m.spaceKey;
    // Optimistic removal; restore on failure.
    const prevList = messagesByKey[key] || [];
    setMessagesByKey((prev) => ({ ...prev, [key]: (prev[key] || []).filter((x) => x.messageId !== m.messageId) }));
    try {
      await call('delete_message', { spaceKey: key, messageId: m.messageId }, 20000);
      toast('已刪除訊息');
    } catch (e) {
      setMessagesByKey((prev) => ({ ...prev, [key]: prevList }));
      toast(`刪除失敗：${String((e as Error).message || e)}`, true);
    }
  }, [messagesByKey, toast]);

  const openChatTab = useCallback(async () => {
    try { await call('open_chat_tab', {}, 6000); } catch { /* ignore */ }
    setTimeout(() => void probe(), 1500);
  }, [probe]);

  const activeSpace = spaces.find((s) => s.spaceKey === activeKey) || null;

  // --- render --------------------------------------------------------------
  return (
    <div className="app">
      <div className="rail">
        <div className="ws" title="Schat — Slack for Google Chat"><Logo size={26} /></div>
        <button className="railbtn" title="開啟 Google Chat 分頁" onClick={openChatTab}><ExternalLink size={18} /></button>
        <button
          className={`railbtn${notify ? ' on' : ''}`}
          title={notify ? '新訊息通知：開（點擊關閉）' : '新訊息通知：關（點擊開啟）'}
          onClick={() => void toggleNotify()}
        >
          {notify ? <Bell size={18} /> : <BellOff size={18} />}
        </button>
        <button
          className="railbtn"
          title={theme === 'dark' ? '切換到淺色模式' : '切換到深色模式'}
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        >
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>

      <Sidebar
        spaces={spaces}
        sections={sections}
        activeKey={activeKey}
        filter={filter}
        onFilter={setFilter}
        onSelect={selectSpace}
        onRefresh={() => void loadSpaces()}
        onNewChannel={() => void newChannel()}
        onNewEmoji={(f) => void newEmoji(f)}
        onOpenScheduled={openScheduledView}
        scheduledActive={showScheduled}
      />

      <div className="main">
        {bridge === 'ready' && session && !session.hasXsrf && (
          <div className="banner">
            <AlertTriangle size={15} style={{ verticalAlign: '-2px' }} /> Chat 分頁的 session 尚未就緒，請在 Google Chat 分頁載入完成（或點開任一對話）後重試。
            <button className="iconbtn" onClick={() => void probe()}>已開啟，重試</button>
          </div>
        )}

        {bridge !== 'ready' ? (
          <ConnectionState state={bridge} onOpenChat={openChatTab} onRetry={() => void probe()} />
        ) : showScheduled ? (
          <ScheduledView
            scheduled={scheduled}
            loading={loadingScheduled}
            spaceName={(k) => spaces.find((s) => s.spaceKey === k)?.name || k.replace(/^space:/, '')}
            onRefresh={() => void refreshScheduled()}
            onCancel={(item) => void cancelScheduledItem(item)}
            onReschedule={(item, ms) => void rescheduleItem(item, ms)}
            onGoChannel={(k) => selectSpace(k)}
          />
        ) : !activeKey ? (
          <div className="center-state">
            <h3>👋 選擇一個頻道開始</h3>
            <p>左側是你的 Google Chat 空間。點任一頻道載入訊息，在下方輸入框直接傳訊息。</p>
          </div>
        ) : (
          <>
            <header className="main-head">
              <span className="title">{activeSpace?.type === 'dm' ? '@' : '#'} {activeSpace?.name || activeKey}</span>
              <span className="spacer" />
            </header>

            <div className="main-body">
              <div className="msg-col">
                <div className="messages" ref={scrollRef}>
                  {loadingMsgs && activeMsgs.length === 0 ? (
                    <div className="loading-row"><div className="spinner" /> 載入訊息中…</div>
                  ) : activeMsgs.length === 0 ? (
                    <div className="center-state"><p>這個頻道還沒有訊息，或訊息尚未載入。傳一則訊息開始吧！</p></div>
                  ) : (
                    <>
                      <div className="load-older-row">
                        <button className="load-older" disabled={loadingOlder}
                          onClick={() => activeKey && loadOlder(
                            activeKey,
                            activeMsgs.reduce((min, m) => (m.ts < min ? m.ts : min), activeMsgs[0].ts),
                          )}>
                          {loadingOlder ? '載入中…' : '載入更早訊息'}
                        </button>
                      </div>
                      <MessageList
                        messages={activeMsgs}
                        onReact={reactTo}
                        onOpenThread={(key) => setOpenThreadKey(key)}
                        onDelete={deleteMessage}
                        myUserId={session?.myUserId || ''}
                        customEmojis={customEmojis}
                        emojiUrlMap={emojiUrlMap}
                      />
                    </>
                  )}
                </div>

                <Composer
                  channelName={activeSpace?.name || ''}
                  members={members}
                  replyTo={replyTo}
                  onCancelReply={() => setReplyTo(null)}
                  onSend={sendMessage}
                  onSendImage={sendImage}
                  onSchedule={scheduleMessage}
                />
              </div>

              {openThreadKey && (
                <ThreadPanel
                  threadKey={openThreadKey}
                  messages={activeMsgs}
                  members={members}
                  onClose={() => setOpenThreadKey(null)}
                  onReact={reactTo}
                  onSendReply={sendThreadReply}
                  customEmojis={customEmojis}
                  emojiUrlMap={emojiUrlMap}
                />
              )}
            </div>
          </>
        )}
      </div>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.err ? ' err' : ''}`}>{t.text}</div>
        ))}
      </div>
    </div>
  );
}

function ConnectionState({ state, onOpenChat, onRetry }: { state: BridgeState; onOpenChat: () => void; onRetry: () => void }) {
  if (state === 'connecting') {
    return <div className="center-state"><div className="spinner" /><p>連接擴充功能中…</p></div>;
  }
  if (state === 'no-extension') {
    return (
      <div className="center-state">
        <h3>找不到擴充功能</h3>
        <p>
          請到 <code>chrome://extensions</code> 開啟「開發者模式」，點「載入未封裝項目」選擇本專案的{' '}
          <code>extension/</code> 目錄，然後重新整理此頁面。
        </p>
        <button className="btn" onClick={onRetry}>重新偵測</button>
      </div>
    );
  }
  // no-chat-tab
  return (
    <div className="center-state">
      <h3>尚未連到 Google Chat</h3>
      <p>需要一個開著的 Google Chat 分頁當作執行器（所有讀寫都在該分頁的 origin 內發送）。</p>
      <button className="btn" onClick={onOpenChat}>開啟 Google Chat 分頁</button>
      <p style={{ fontSize: 13 }}>開好並登入後，點任一對話，再回來按重試。</p>
      <button className="iconbtn" onClick={onRetry}>重新偵測</button>
    </div>
  );
}
