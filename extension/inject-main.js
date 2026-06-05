// inject-main.js — runs in chat.google.com's MAIN world at document_start.
//
// The only place that touches Google Chat's private wire protocol. It:
//   1. Hooks fetch / XHR to learn session state (xsrf token, account base,
//      request footer, group refs) and CACHE real request templates, and hooks
//      the BrowserChannel long-poll to stream incoming messages.
//   2. Exposes an RPC op surface (driven by content.js) for the local Slack-like
//      app: list_spaces, load_space_messages, send_message, react.
//
// Protocol (window.postMessage):
//   content → main : { source:'sg-content', kind:'op', reqId, op, args }
//   main → content : { source:'sg-main', kind:'op-result', reqId, ok, data, error }
//   main → content : { source:'sg-main', kind:'event', event, data }
//
// Endpoints + payload shapes were reverse-engineered from REAL captured traffic
// of the current Google Chat (Dynamite) web client:
//   /api/paginated_world  → space + DM list   (root[0][4] = world items)
//   /api/list_topics      → one space's topics, each topic[6] = messages
//   /api/create_topic     → send a new message
//   /api/update_reaction  → add / remove an emoji reaction
//   /webchannel/events    → real-time message stream (length-prefixed frames)
//
// Message record (inside list_topics topic[6][j] AND webchannel frames):
//   m[0] = [[null,null,null,[null, msgId, [[spaceId]]]], msgId]
//   m[1] = [[senderId], "Full Name", "avatarUrl", "email", "short", ...]
//   m[2] = created μs (string)   m[9] = body text   m[13] = msgId
// World item:
//   item[0] = group ref  (space: [[id]]  /  DM: [null,null,[dmId]])
//   item[3][0][0][0] = viewer's own user id
//   item[4] = space name (string) | null for DMs
//   item[31] = members [[ [[id],"Name","avatar","email",...], ... ]]

(function () {
  const MAX_BODY = 500000;
  const API_COUNTER_RE = /[?&]c=(\d+)/;
  const DEFAULT_PREFS = [
    null, null, null, null, 2, 2, null, 2, 2, 2, 2, null, null, null, null, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, null, null, 2, 2, null, null, null, 2, 2, null, null, null,
    null, 2, 2, 2, 2, null, 2, null, null, 2, null, 2, 2, 2, 2, null, 2, null, 2, 2, null,
    null, null, 2, 2,
  ];

  const state = {
    accountBase: '/u/0',
    apiCounter: 0,
    requestFooter: null,                 // captured trailing footer (random id at [0])
    requestHeaders: null,                // { 'accept-language', 'x-framework-xsrf-token' }
    googExtBin: '',
    myUserId: '',
    groupRefById: Object.create(null),   // id → group ref (item[0] from world)
    emojiCatalog: Object.create(null),
    userNames: Object.create(null),      // userId → display name
    tmplListTopics: null,                // last real /api/list_topics request body
    tmplPaginatedWorld: null,            // last real /api/paginated_world request body
    tmplListCustomEmojis: null,          // last real /api/list_custom_emojis request body
    worldWalked: false,                  // did the one-time full paginated_world walk run?
    tmplEmojiRpc: null,                  // captured qL7xZc batchexecute request {url, body}
    tmplReactorRpc: null,                // captured Q3DB7e (list reactors) request {url, body}
    batchAt: '',                         // `at` token from any DynamiteWebUi batchexecute body
    batchUrl: '',                        // a reusable DynamiteWebUi batchexecute URL (f.sid/bl/…)
    // Section membership is a ONE-TIME delta the native client consumes at
    // startup, so we accumulate it persistently from EVERY observed
    // paginated_world response (incl. the native client's initial sync that our
    // document_start XHR hook sees), rather than trying to re-fetch it.
    sectionAcc: { nameByOrder: Object.create(null), orderBySpaceId: Object.create(null) },
    avatarById: Object.create(null),     // userId → avatar url (so it never blanks on reload)
    emailById: Object.create(null),      // userId → email (for @mention candidates)
    attachmentCache: Object.create(null), // blob token → resolved data URL (image attachments)
    // Persistent union of every space/DM we've ever seen — incl. sectioned
    // spaces that the regular paginated_world list EXCLUDES but the native
    // client's startup sync (captured passively) includes. id → {spaceKey,name,type}
    spacesById: Object.create(null),
  };

  const log = (...a) => console.log('[sg:main]', ...a);

  // --- helpers --------------------------------------------------------------
  function cloneJSON(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function randomKey(length = 11) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const buf = new Uint8Array(length);
    crypto.getRandomValues(buf);
    let out = '';
    for (let i = 0; i < length; i += 1) out += alphabet[buf[i] % alphabet.length];
    return out;
  }
  function spaceIDFromKey(spaceKey) {
    const raw = String(spaceKey || '').trim();
    if (!raw) return '';
    const parts = raw.split(':');
    return parts.length > 1 ? parts.slice(1).join(':') : raw;
  }
  function groupIdFromRef(ref) {
    if (!Array.isArray(ref)) return '';
    if (typeof ref?.[0]?.[0] === 'string' && ref[0][0]) return ref[0][0];   // space [[id]]
    if (typeof ref?.[2]?.[0] === 'string' && ref[2][0]) return ref[2][0];   // dm [null,null,[id]]
    return '';
  }
  function buildGroupRef(spaceKey) {
    const id = spaceIDFromKey(spaceKey);
    if (id && Array.isArray(state.groupRefById[id])) return cloneJSON(state.groupRefById[id]);
    return id ? [[id]] : null;
  }
  function nextApiCounter() { state.apiCounter += 1; return state.apiCounter; }
  function buildFooter(randomId) {
    if (Array.isArray(state.requestFooter)) {
      const f = cloneJSON(state.requestFooter);
      f[0] = randomId ? String(Math.trunc((Math.random() - 0.5) * 9e18)) : 0;
      return f;
    }
    return [randomId ? String(Math.trunc((Math.random() - 0.5) * 9e18)) : 0, 3, 1, navigator.language || 'en', DEFAULT_PREFS];
  }
  function parseMicroTS(s) {
    const us = Number(s);
    if (!Number.isFinite(us) || us <= 0) return new Date().toISOString();
    return new Date(us / 1000).toISOString();
  }
  function truncate(s) {
    if (typeof s !== 'string') return s;
    return s.length > MAX_BODY ? s.slice(0, MAX_BODY) + '…[truncated]' : s;
  }
  function stripParse(text) {
    let b = String(text || '').trim();
    if (b.startsWith(")]}'")) b = b.slice(4).trim();
    if (!b) return null;
    return JSON.parse(b);
  }
  function headersToObject(h) {
    const out = {};
    if (!h) return out;
    try { if (h instanceof Headers) { h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); }); return out; } } catch {}
    if (Array.isArray(h)) { for (const p of h) if (Array.isArray(p) && p.length >= 2) out[String(p[0]).toLowerCase()] = String(p[1]); return out; }
    if (typeof h === 'object') for (const [k, v] of Object.entries(h)) out[String(k).toLowerCase()] = String(v);
    return out;
  }
  function postResult(reqId, ok, data, error) {
    window.postMessage({ source: 'sg-main', kind: 'op-result', reqId, ok, data, error: error || '' }, '*');
  }
  function emitEvent(event, data) {
    window.postMessage({ source: 'sg-main', kind: 'event', event, data }, '*');
  }

  // --- learn session state from observed requests ---------------------------
  const requestHeadersReady = [];

  function updateRequestState(url, body, headersObj) {
    if (!url) return;
    const baseMatch = String(url).match(/(\/u\/\d+)\//);
    if (baseMatch) state.accountBase = baseMatch[1];
    const counterMatch = String(url).match(API_COUNTER_RE);
    if (counterMatch) {
      const n = Number(counterMatch[1]);
      if (Number.isFinite(n) && n > state.apiCounter) state.apiCounter = n;
    }
    const headers = headersObj || {};
    if (/\/api\//.test(String(url)) && headers['x-framework-xsrf-token']) {
      const firstTime = !state.requestHeaders?.['x-framework-xsrf-token'];
      state.requestHeaders = {
        'accept-language': headers['accept-language'] || navigator.language || 'en',
        'x-framework-xsrf-token': headers['x-framework-xsrf-token'],
      };
      if (firstTime) {
        requestHeadersReady.splice(0).forEach((r) => r());
        emitEvent('session-ready', sessionStatus());
      }
    }
    if (typeof headers['x-goog-ext-353267353-bin'] === 'string' && headers['x-goog-ext-353267353-bin']) {
      state.googExtBin = headers['x-goog-ext-353267353-bin'];
    }

    // The FULL custom-emoji list comes from a legacy batchexecute RPC (qL7xZc),
    // NOT /api/list_custom_emojis. Its body is form-encoded (f.req=…&at=…), so
    // capture it raw here (before the JSON-only early return) to replay later.
    if (/\/data\/batchexecute/.test(String(url)) && /qL7xZc/.test(String(url)) && typeof body === 'string' && body) {
      const firstEmojiRpc = !state.tmplEmojiRpc;
      state.tmplEmojiRpc = { url: String(url), body };
      if (firstEmojiRpc) emitEvent('emoji-rpc-ready', {});
    }
    // Any DynamiteWebUi batchexecute carries the `at` token and a reusable URL
    // (f.sid/bl/source-path) we need to mint our OWN batchexecute calls (e.g.
    // Q3DB7e reactor lookup). Capture them generically — qL7xZc fires at startup,
    // so we don't need the user to trigger Q3DB7e first.
    if (/\/data\/batchexecute/.test(String(url)) && typeof body === 'string' && body) {
      try {
        const at = new URLSearchParams(body).get('at');
        if (at) state.batchAt = at;
      } catch { /* not form-encoded */ }
      if (!state.batchUrl) state.batchUrl = String(url);
      if (/Q3DB7e/.test(String(url))) state.tmplReactorRpc = { url: String(url), body };
    }

    if (typeof body !== 'string' || !body.trim().startsWith('[')) return;
    let parsed;
    try { parsed = JSON.parse(body); } catch { return; }
    if (!Array.isArray(parsed)) return;
    const footer = parsed[parsed.length - 1];
    if (Array.isArray(footer) && footer.length >= 4 && (typeof footer[0] === 'string' || footer[0] === 0)) {
      state.requestFooter = cloneJSON(footer);
    }
    // Cache real request templates so we can replay them with one field swapped.
    if (/\/api\/list_topics/.test(url)) state.tmplListTopics = cloneJSON(parsed);
    // The native client knows the correct list_custom_emojis payload; grab it so
    // we can replay the FULL custom-emoji list (frecent only returns ~recent).
    if (/\/api\/list_custom_emojis/.test(url)) state.tmplListCustomEmojis = cloneJSON(parsed);
    // Only cache the ITEMS variant (req[3] without section-type 8) — caching the
    // sections variant here would poison buildPaginatedWorldReq and return no items.
    if (/\/api\/paginated_world/.test(url) && Array.isArray(parsed[3]) && !parsed[3].includes(8)) {
      state.tmplPaginatedWorld = cloneJSON(parsed);
    }
    // Remember the group ref the SPA used for sends, keyed by id.
    if (/\/api\/create_topic/.test(url) && Array.isArray(parsed[4])) {
      const id = groupIdFromRef(parsed[4]);
      if (id) state.groupRefById[id] = cloneJSON(parsed[4]);
    }
  }

  function waitForRequestHeaders(timeoutMs = 30000) {
    if (state.requestHeaders?.['x-framework-xsrf-token']) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const i = requestHeadersReady.indexOf(resolve);
        if (i >= 0) requestHeadersReady.splice(i, 1);
        reject(new Error('Chat session not ready — open a Google Chat conversation in the chat.google.com tab first'));
      }, timeoutMs);
      requestHeadersReady.push(() => { clearTimeout(t); resolve(); });
    });
  }

  // Expose the loaded emoji catalog to the app's reaction picker. Custom emojis
  // carry an image url; we also hand back the shortcode→url map so the app can
  // render custom-emoji reaction chips as images.
  function listEmojis() {
    const custom = [];
    const map = {};
    const seen = new Set();
    for (const key of Object.keys(state.emojiCatalog)) {
      const c = state.emojiCatalog[key];
      if (c.type === 'custom' && c.shortcode && !seen.has(c.shortcode)) {
        seen.add(c.shortcode);
        custom.push({ shortcode: c.shortcode, url: c.url || '' });
        if (c.url) map[c.shortcode] = c.url;
      }
    }
    return { custom, customUrlByShortcode: map };
  }

  // Mention candidates for the composer's @autocomplete. Built from everyone
  // we've seen post (name + avatar + email), since the dedicated people-search
  // RPC lives on a different host/format. Covers the common "tag an active
  // member" case; lurkers who never posted won't appear.
  function listMembers() {
    const members = [];
    const seen = new Set();
    for (const userId of Object.keys(state.userNames)) {
      if (seen.has(userId) || !/^\d+$/.test(userId)) continue;
      seen.add(userId);
      members.push({
        userId,
        name: state.userNames[userId],
        avatar: state.avatarById[userId] || '',
        email: state.emailById[userId] || '',
      });
    }
    members.sort((a, b) => a.name.localeCompare(b.name));
    return { members };
  }

  // --- markdown <-> formatting annotations (type 8) -------------------------
  // Google Chat's current client does NOT send code blocks as raw ``` fences —
  // it strips the fences and adds a type-8 formatting annotation:
  //   [8, start, len, null,null,null,null, [fmtCode]]   fmtCode 7 = code block.
  // Only fmtCode 7 is confirmed from real traffic; other codes (bold/italic/…)
  // are left as raw markdown until we capture their codes.
  const FMT_CODE_BLOCK = 7;

  // OUTGOING: turn ```fenced``` spans in the composer text into de-fenced body +
  // type-8 annotations, and shift mention offsets to the de-fenced positions.
  function transformOutgoing(text, mentions) {
    const src = String(text || '');
    const drop = new Array(src.length).fill(false);
    const spans = [];
    const re = /```([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const s = m.index, e = re.lastIndex;
      for (let k = 0; k < 3; k += 1) { drop[s + k] = true; drop[e - 1 - k] = true; }
      spans.push({ innerStart: s + 3, innerEnd: e - 3 });
    }
    if (!spans.length) return { body: src, formatAnns: [], mentions: mentions || [] };
    // Build de-fenced body + an original→output offset map.
    let body = '';
    const map = new Array(src.length + 1).fill(0);
    for (let i = 0; i < src.length; i += 1) { map[i] = body.length; if (!drop[i]) body += src[i]; }
    map[src.length] = body.length;
    const formatAnns = spans.map((sp) => {
      const start = map[sp.innerStart];
      const len = map[sp.innerEnd] - start;
      return [8, start, len, null, null, null, null, [FMT_CODE_BLOCK]];
    });
    const adj = (mentions || []).map((mm) => ({ ...mm, start: map[Math.min(Math.max(0, mm.start | 0), src.length)] }));
    return { body, formatAnns, mentions: adj };
  }

  // INCOMING: re-insert markdown delimiters for the type-8 spans we understand,
  // so the existing markdown renderer (richtext.tsx) shows them correctly.
  function applyFormatAnnotations(body, anns) {
    if (typeof body !== 'string' || !Array.isArray(anns)) return body;
    const wraps = [];
    for (const a of anns) {
      if (!Array.isArray(a) || a[0] !== 8) continue;
      const start = a[1], len = a[2];
      const code = Array.isArray(a[7]) ? a[7][0] : null;
      if (typeof start !== 'number' || typeof len !== 'number' || len < 0) continue;
      const fence = code === FMT_CODE_BLOCK ? '```' : '';   // only known code
      if (!fence) continue;
      wraps.push({ start, end: start + len, fence });
    }
    if (!wraps.length) return body;
    // Insert from right to left so earlier offsets stay valid.
    wraps.sort((x, y) => y.start - x.start);
    let out = body;
    for (const w of wraps) {
      out = out.slice(0, w.end) + w.fence + out.slice(w.end);
      out = out.slice(0, w.start) + w.fence + out.slice(w.start);
    }
    return out;
  }

  // Build type-6 mention annotations for a create_topic/create_message payload[2].
  // mentions: [{ userId, email, start, len }] with char offsets into the body.
  function buildMentionAnnotations(mentions) {
    if (!Array.isArray(mentions)) return [];
    const out = [];
    for (const mm of mentions) {
      if (!mm || !mm.userId) continue;
      const uid = String(mm.userId);
      const userSeg = mm.email ? [[uid], uid ? mm.email : ''] : [[uid]];
      // [6, start, len, null, [[uid], 3, [[uid], email]], null×13, 3]
      const ann = new Array(20).fill(null);
      ann[0] = 6;
      ann[1] = Number(mm.start) || 0;
      ann[2] = Number(mm.len) || 0;
      ann[4] = [[uid], 3, userSeg];
      ann[19] = 3;
      out.push(ann);
    }
    return out;
  }

  function sessionStatus() {
    return {
      accountBase: state.accountBase,
      myUserId: state.myUserId || '',
      hasXsrf: !!state.requestHeaders?.['x-framework-xsrf-token'],
      hasWorldTemplate: Array.isArray(state.tmplPaginatedWorld),
      emojiCount: Object.keys(state.emojiCatalog).length,
      sectionNames: Object.values(state.sectionAcc.nameByOrder),
      sectionMemberCount: Object.keys(state.sectionAcc.orderBySpaceId).length,
      spacesCaptured: Object.keys(state.spacesById).length,
    };
  }

  // --- emoji catalog (from /api/get_frecent_emojis_v2) ----------------------
  function ingestFrecentEmojis(text) {
    let parsed;
    try { parsed = stripParse(text); } catch { return; }
    const entries = parsed?.[0]?.[1];
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [o0, o1] = entry;
      if (o0 === null && Array.isArray(o1)) {
        const shortcode = o1[2];
        if (typeof shortcode === 'string' && shortcode) {
          state.emojiCatalog[shortcode] = {
            type: 'custom',
            uuid: typeof o1[0] === 'string' ? o1[0] : '',
            shortcode,
            userId: Array.isArray(o1[4]) ? (o1[4][0] || '') : '',
            localId: Array.isArray(o1[5]) ? (o1[5][0] || '') : '',
            timestamp: Number(o1[7] || 0),
            blob: typeof o1[8] === 'string' ? o1[8] : '',
            url: typeof o1[10] === 'string' ? o1[10] : '',   // custom emoji image
          };
        }
      } else if (Array.isArray(o0)) {
        const unicode = o0[0];
        const aliases = Array.isArray(o0[1]) ? o0[1].filter((a) => typeof a === 'string') : [];
        if (typeof unicode === 'string' && unicode) {
          const item = { type: 'unicode', unicode, aliases };
          state.emojiCatalog[unicode] = item;
          for (const a of aliases) state.emojiCatalog[a] = item;
        }
      }
    }
  }

  // Tolerant custom-emoji ingestion: walk an arbitrary response tree and pick up
  // every node that looks like a custom-emoji record (shortcode at [2] + image
  // URL at [10]). Lets us harvest the FULL custom set from list_custom_emojis
  // regardless of the exact wrapper shape, not just the frecent subset.
  function ingestCustomEmojiTree(json) {
    let n = 0;
    const seen = new Set();
    (function walk(x) {
      if (!Array.isArray(x)) return;
      const sc = x[2];
      if (typeof sc === 'string' && /^:.+:$/.test(sc) && typeof x[10] === 'string' && /^https?:/.test(x[10])) {
        if (!seen.has(sc)) {
          seen.add(sc);
          state.emojiCatalog[sc] = {
            type: 'custom',
            uuid: typeof x[0] === 'string' ? x[0] : '',
            shortcode: sc,
            userId: Array.isArray(x[4]) ? (x[4][0] || '') : '',
            localId: Array.isArray(x[5]) ? (x[5][0] || '') : '',
            timestamp: Number(x[7] || 0),
            blob: typeof x[8] === 'string' ? x[8] : '',
            url: x[10],
          };
          n += 1;
        }
        return;
      }
      for (const y of x) walk(y);
    })(json);
    return n;
  }

  // --- IndexedDB harvest (the FULL custom-emoji set lives in the native
  // client's IDB cache; /api/list_custom_emojis is never called by it and its
  // payload is undiscoverable, so read the cache directly). --------------------
  function idbReq(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb error'));
    });
  }

  // Deep-scan one IDB record: if it carries a custom-emoji image URL, pair it
  // with the most shortcode-looking string in the same record.
  function harvestEmojiFromRecord(rec, into) {
    const strings = [];
    (function walk(x, depth) {
      if (depth > 8 || x == null) return;
      if (typeof x === 'string') { strings.push(x); return; }
      if (typeof x === 'object') for (const k of Object.keys(x)) walk(x[k], depth + 1);
    })(rec, 0);
    const url = strings.find((s) => /^https?:\/\//.test(s) && /chat_custom_emoji|customemoji|emoji/i.test(s) && /googleusercontent|ggpht|lh\d/.test(s));
    if (!url) return;
    let sc = strings.find((s) => /^:[^\s:]{1,60}:$/.test(s))
      || strings.find((s) => /^[a-z0-9_+\-]{2,40}$/i.test(s) && !/^https?:/.test(s));
    if (!sc) return;
    if (!sc.startsWith(':')) sc = `:${sc}:`;
    if (!into[sc]) into[sc] = url;
  }

  async function harvestCustomEmojisFromIDB() {
    if (!self.indexedDB || !indexedDB.databases) return { added: 0, dbs: [] };
    const found = Object.create(null);
    const dbInfo = [];
    let dbs = [];
    try { dbs = await indexedDB.databases(); } catch { return { added: 0, dbs: [] }; }
    for (const meta of dbs) {
      const name = meta && meta.name;
      if (!name) continue;
      let db;
      try { db = await idbReq(indexedDB.open(name)); } catch { continue; }
      const stores = Array.from(db.objectStoreNames || []);
      for (const store of stores) {
        try {
          const all = await idbReq(db.transaction(store, 'readonly').objectStore(store).getAll());
          const before = Object.keys(found).length;
          if (Array.isArray(all)) for (const rec of all) harvestEmojiFromRecord(rec, found);
          const got = Object.keys(found).length - before;
          if (got > 0) dbInfo.push({ db: name, store, got });
        } catch { /* skip store */ }
      }
      try { db.close(); } catch { /* noop */ }
    }
    // Ingest into the catalog so listEmojis() returns them.
    let added = 0;
    for (const sc of Object.keys(found)) {
      if (!state.emojiCatalog[sc] || state.emojiCatalog[sc].type !== 'custom') {
        state.emojiCatalog[sc] = { type: 'custom', shortcode: sc, url: found[sc] };
        added += 1;
      }
    }
    return { added, dbs: dbInfo };
  }

  // Diagnostic: dump IDB databases/stores + a sample of any store whose entries
  // mention custom emoji, so the harvest heuristic can be verified/tuned.
  async function dumpIdb() {
    if (!self.indexedDB || !indexedDB.databases) return { error: 'indexedDB.databases unavailable' };
    const out = [];
    let dbs = [];
    try { dbs = await indexedDB.databases(); } catch (e) { return { error: String(e) }; }
    for (const meta of dbs) {
      const name = meta && meta.name;
      if (!name) continue;
      let db;
      try { db = await idbReq(indexedDB.open(name)); } catch { continue; }
      for (const store of Array.from(db.objectStoreNames || [])) {
        try {
          const all = await idbReq(db.transaction(store, 'readonly').objectStore(store).getAll());
          const n = Array.isArray(all) ? all.length : 0;
          const blob = JSON.stringify(all);
          const hit = /chat_custom_emoji|customEmoji|custom_emoji|emoji/i.test(blob || '');
          const entry = { db: name, store, count: n, emojiish: hit };
          if (hit && Array.isArray(all)) entry.sample = all.slice(0, 2).map((r) => JSON.stringify(r).slice(0, 600));
          out.push(entry);
        } catch { out.push({ db: name, store, error: true }); }
      }
      try { db.close(); } catch { /* noop */ }
    }
    return { stores: out };
  }

  // Replay the native client's qL7xZc batchexecute (captured passively). Its
  // response carries custom-emoji nodes in the SAME shape as frecent
  // ([uuid,null,":sc:",…,blob@8,…,lh3url@10]), so ingestCustomEmojiTree handles
  // it. This is how Google Chat itself loads the full set.
  async function replayEmojiRpc() {
    if (!state.tmplEmojiRpc) return 0;
    const { url, body } = state.tmplEmojiRpc;
    const xsrf = state.requestHeaders?.['x-framework-xsrf-token'];
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: Object.assign(
        { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        xsrf ? { 'x-framework-xsrf-token': xsrf } : {},
      ),
      body,
    });
    if (!resp.ok) throw new Error(`emoji rpc ${resp.status}`);
    const text = await resp.text();
    const m = text.match(/"wrb\.fr","qL7xZc","((?:\\.|[^"\\])*)"/);
    if (!m) return 0;
    let inner;
    try { inner = JSON.parse(JSON.parse(`"${m[1]}"`)); } catch { return 0; }
    return ingestCustomEmojiTree(inner);
  }

  // --- get_reactors via Q3DB7e batchexecute ---------------------------------
  // Q3DB7e is the legacy batchexecute that lists WHO reacted with a given emoji.
  // Request (form-encoded f.req=<json>&at=<token>) was reverse-engineered from
  // REAL captured traffic (collector webRequest source records request bodies):
  //   inner = [
  //     [msgId, null, [msgId, null, groupRef]],   // msgId = opaque m[0][1]
  //     emojiSeg,                                  // ["👍"] | [null,[uuid,…]] (== react payload[1])
  //     10,                                        // page size
  //   ]
  //   groupRef: DM    = ["dm/<id>",    "<id>", 5]
  //             space = ["space/<id>", "<id>", 2]
  // Response inner = [[[uid,"human/uid",0],…], "", [tsRef]]; inner[0] = reactors.
  // We mint the request ourselves (no captured Q3DB7e needed) — the `at` token
  // and a reusable batchexecute URL come from ANY DynamiteWebUi batchexecute
  // (qL7xZc fires at startup), captured into state.batchAt / state.batchUrl.

  // Build the emoji segment used inside an update_reaction / reactor request,
  // matching react()'s payload[1] encoding (custom vs unicode).
  function buildEmojiSeg(emoji) {
    const cat = state.emojiCatalog[emoji];
    const isShortcode = emoji.startsWith(':') && emoji.endsWith(':');
    if (cat && cat.type === 'custom') {
      return [null, [cat.uuid, null, cat.shortcode, 1, [cat.userId || ''], [cat.localId || ''], null, Number(cat.timestamp) || 0, cat.blob || '']];
    }
    if (cat && cat.type === 'unicode') return [cat.unicode];
    if (!isShortcode) return [emoji];
    return null;
  }

  // The Q3DB7e group ref is prefixed+typed, unlike the /api group ref:
  //   DM → ["dm/<id>","<id>",5]   space → ["space/<id>","<id>",2].
  // We detect DM via the captured native ref shape ([null,null,[id]]) or the
  // accumulated space type, falling back to space.
  function batchGroupRef(spaceKey) {
    const id = spaceIDFromKey(spaceKey);
    const nativeRef = buildGroupRef(spaceKey);
    const isDM = (Array.isArray(nativeRef) && Array.isArray(nativeRef[2]) && typeof nativeRef[2][0] === 'string')
      || state.spacesById[id]?.type === 'dm';
    return isDM ? [`dm/${id}`, id, 5] : [`space/${id}`, id, 2];
  }

  // Parse a Q3DB7e response text → array of reactor user-id strings.
  function parseReactorResponse(text) {
    const m = text.match(/"wrb\.fr","Q3DB7e","((?:\\.|[^"\\])*)"/);
    if (!m) return [];
    let inner;
    try { inner = JSON.parse(JSON.parse(`"${m[1]}"`)); } catch { return []; }
    const list = Array.isArray(inner?.[0]) ? inner[0] : [];
    const ids = [];
    for (const r of list) {
      const uid = Array.isArray(r) ? r[0] : null;
      if (typeof uid === 'string' && uid) ids.push(uid);
    }
    return ids;
  }

  // Derive a Q3DB7e batchexecute URL from any captured DynamiteWebUi
  // batchexecute (swap the rpcids param), so we never depend on a prior Q3DB7e.
  function batchExecuteUrl(rpcid) {
    const base = state.tmplReactorRpc?.url || state.batchUrl;
    if (!base) return '';
    return /[?&]rpcids=/.test(base)
      ? base.replace(/([?&]rpcids=)[^&]*/, `$1${rpcid}`)
      : base + (base.includes('?') ? '&' : '?') + `rpcids=${rpcid}`;
  }

  // Resolve user IDs → display names via /api/get_members (the only source for
  // people who reacted but never posted, so aren't in state.userNames). Request
  // payload[1] = [[[[uid,1]]]] (one user), payload[99] = standard footer; the
  // response carries a member node [[[uid,1]], "Name", "avatarUrl", …]. We query
  // one id per call (the multi-user nesting isn't confirmed) and cache results.
  function parseMemberName(json, wantUid) {
    let found = null;
    (function walk(n) {
      if (found || !Array.isArray(n)) return;
      if (typeof n[1] === 'string' && n[1] && Array.isArray(n[0])
        && JSON.stringify(n[0]).includes(wantUid)) {
        found = { name: n[1], avatar: typeof n[2] === 'string' ? n[2] : '' };
        return;
      }
      for (const x of n) walk(x);
    })(json);
    return found;
  }
  async function resolveUserNames(userIds) {
    const missing = [...new Set(userIds.map(String))].filter((uid) => uid && !state.userNames[uid]);
    const MAX_LOOKUPS = 30;                                  // bound load per hover
    await Promise.all(missing.slice(0, MAX_LOOKUPS).map(async (uid) => {
      try {
        const payload = new Array(100).fill(null);
        payload[1] = [[[[uid, 1]]]];
        payload[99] = buildFooter(false);
        const json = stripParse(await apiPost('/api/get_members', JSON.stringify(payload), ''));
        const m = parseMemberName(json, uid);
        if (m && m.name) {
          state.userNames[uid] = m.name;
          if (m.avatar) state.avatarById[uid] = m.avatar;
        }
      } catch { /* leave unresolved; UI falls back to a placeholder */ }
    }));
  }

  // List who reacted to a message with a specific emoji (mapped to names where
  // known). Lazily called from the app on reaction hover.
  async function getReactors(spaceKey, messageId, emoji) {
    await waitForRequestHeaders();
    if (!messageId) throw new Error('message_id required');
    const id = spaceIDFromKey(spaceKey);
    if (!id) throw new Error('space_key required');
    const seg = buildEmojiSeg(emoji);
    if (!seg) throw new Error(`custom emoji "${emoji}" not loaded — use it once in the Chat tab, then reload`);
    const url = batchExecuteUrl('Q3DB7e');
    if (!url) throw new Error('no batchexecute URL captured yet — open the chat.google.com tab');

    const inner = [
      [messageId, null, [messageId, null, batchGroupRef(spaceKey)]],
      seg,
      10,
    ];
    const freq = JSON.stringify([[['Q3DB7e', JSON.stringify(inner), null, 'generic']]]);
    const bodyParams = new URLSearchParams();
    bodyParams.set('f.req', freq);
    if (state.batchAt) bodyParams.set('at', state.batchAt);

    const xsrf = state.requestHeaders?.['x-framework-xsrf-token'];
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: Object.assign(
        { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        xsrf ? { 'x-framework-xsrf-token': xsrf } : {},
      ),
      body: bodyParams.toString(),
    });
    if (!resp.ok) throw new Error(`reactor rpc ${resp.status}`);
    const ids = parseReactorResponse(await resp.text());
    await resolveUserNames(ids);                             // fill names for non-speakers
    const reactors = ids.map((uid) => ({ userId: uid, name: state.userNames[uid] || '' }));
    return { reactors };
  }

  // Diagnostic: report whether we can mint a Q3DB7e call (at token + URL).
  function dumpReactorRpc() {
    return {
      hasBatchAt: !!state.batchAt,
      batchUrl: batchExecuteUrl('Q3DB7e'),
      capturedQ3DB7e: !!state.tmplReactorRpc,
    };
  }

  // --- full custom-emoji catalog via Gq6Wmd (the "browse all" RPC) ----------
  // Gq6Wmd is the paginated list-ALL-custom-emojis batchexecute (qL7xZc only
  // returns a ~36 recent subset). Pagination is by an opaque protobuf cursor we
  // reproduce byte-for-byte from the previous page's LAST emoji (uuid + µs ts):
  //   cursor = base64( PREFIX + 0x24 + uuid(36 ascii) + 0x20 + varint(ts) )
  // Verified against real captured cursors. Request:
  //   page 1 : [[[2,[[1]],1],[3,[[1]],1]], 72]
  //   page N : [null, 72, <cursor>, null, <token>]   token = page1 resp[3]
  // Entry shape (len 10): [uuid,null,":sc:",1,[uid,…],[localId],ts@6,blob@7,null,url@9].

  // base-128 varint of a non-negative integer (uses %/Math.floor — values exceed
  // 2^32 so bitwise ops would corrupt them).
  function varintBytes(n) {
    const out = [];
    let v = Math.max(0, Math.floor(n));
    while (v > 0x7f) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); }
    out.push(v % 128);
    return out;
  }
  const EMOJI_CURSOR_PREFIX = [0x12, 0x09, 0x08, 0x03, 0x12, 0x03, 0x0a, 0x01, 0x01, 0x18, 0x01, 0x1a, 0x24];
  function buildEmojiCursor(uuid, tsMicros) {
    const bytes = EMOJI_CURSOR_PREFIX
      .concat(Array.from(String(uuid), (c) => c.charCodeAt(0)))   // 0x24 = len-36 uuid
      .concat([0x20], varintBytes(Number(tsMicros) || 0));
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  // Ingest one Gq6Wmd emoji entry (url@9 — differs from frecent/qL7xZc url@10).
  function ingestBrowseEmoji(entry) {
    if (!Array.isArray(entry)) return false;
    const sc = entry[2];
    const url = entry[9];
    if (typeof sc !== 'string' || !/^:.+:$/.test(sc) || typeof url !== 'string' || !/^https?:/.test(url)) return false;
    state.emojiCatalog[sc] = {
      type: 'custom',
      uuid: typeof entry[0] === 'string' ? entry[0] : '',
      shortcode: sc,
      userId: Array.isArray(entry[4]) ? (entry[4][0] || '') : '',
      localId: Array.isArray(entry[5]) ? (entry[5][0] || '') : '',
      timestamp: Number(entry[6] || 0),
      blob: typeof entry[7] === 'string' ? entry[7] : '',
      url,
    };
    return true;
  }

  async function loadAllCustomEmojisViaBrowse() {
    await waitForRequestHeaders();
    const url = batchExecuteUrl('Gq6Wmd');
    if (!url || !state.batchAt) return { added: 0, pages: 0 };
    const xsrf = state.requestHeaders?.['x-framework-xsrf-token'];
    const PAGE = 72;
    let added = 0, pages = 0, token = '', cursor = null;
    for (let i = 0; i < 60; i += 1) {                          // hard cap (~4300 emojis)
      const inner = cursor === null
        ? [[[2, [[1]], 1], [3, [[1]], 1]], PAGE]               // first page (filter form)
        : [null, PAGE, cursor, null, token];                   // continuation
      const freq = JSON.stringify([[['Gq6Wmd', JSON.stringify(inner), null, 'generic']]]);
      const bodyParams = new URLSearchParams();
      bodyParams.set('f.req', freq);
      bodyParams.set('at', state.batchAt);
      const resp = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: Object.assign(
          { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          xsrf ? { 'x-framework-xsrf-token': xsrf } : {},
        ),
        body: bodyParams.toString(),
      });
      if (!resp.ok) break;
      const text = await resp.text();
      const m = text.match(/"wrb\.fr","Gq6Wmd","((?:\\.|[^"\\])*)"/);
      if (!m) break;
      let respInner;
      try { respInner = JSON.parse(JSON.parse(`"${m[1]}"`)); } catch { break; }
      const list = Array.isArray(respInner?.[0]) ? respInner[0] : [];
      if (typeof respInner?.[3] === 'string') token = respInner[3];
      let last = null;
      for (const it of list) { if (ingestBrowseEmoji(it)) added += 1; last = it; }
      pages += 1;
      if (list.length < PAGE || !last || !last[0]) break;       // last page reached
      cursor = buildEmojiCursor(last[0], last[6]);
    }
    return { added, pages };
  }

  // Fetch the COMPLETE custom-emoji catalog. Primary source is the paginated
  // Gq6Wmd "browse all" RPC; qL7xZc replay (recent subset) and IDB harvest are
  // kept as fallbacks for anything Gq6Wmd misses or when batch creds aren't up.
  async function loadAllCustomEmojis() {
    let browse = { added: 0, pages: 0 };
    let rpc = 0;
    let idb = { added: 0, dbs: [] };
    try { browse = await loadAllCustomEmojisViaBrowse(); } catch { /* fall through */ }
    try { rpc = await replayEmojiRpc(); } catch { /* fall through */ }
    try { idb = await harvestCustomEmojisFromIDB(); } catch { /* noop */ }
    return Object.assign(listEmojis(), {
      added: browse.added + rpc + idb.added,
      browseAdded: browse.added,
      browsePages: browse.pages,
      rpcAdded: rpc,
      hadEmojiRpc: !!state.tmplEmojiRpc,
      idbDbs: idb.dbs,
    });
  }

  // --- /api/ POST helper ----------------------------------------------------
  function apiPost(path, jsonBody, spaceId) {
    const url = `${state.accountBase}${path}?c=${nextApiCounter()}`;
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      if (state.requestHeaders?.['accept-language']) xhr.setRequestHeader('Accept-Language', state.requestHeaders['accept-language']);
      if (state.requestHeaders?.['x-framework-xsrf-token']) xhr.setRequestHeader('X-Framework-Xsrf-Token', state.requestHeaders['x-framework-xsrf-token']);
      if (spaceId) xhr.setRequestHeader('X-Goog-Chat-Space-Id', spaceId);
      if (state.googExtBin) xhr.setRequestHeader('X-Goog-Ext-353267353-Bin', state.googExtBin);
      // Never let one hung request stall the whole op (the 55s bridge timeout
      // would then surface as undefined data in the app).
      xhr.timeout = 15000;
      xhr.ontimeout = () => reject(new Error(`${path} timeout`));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(String(xhr.responseText || ''));
        else reject(Object.assign(new Error(`${path} failed: ${xhr.status} ${truncate(String(xhr.responseText || ''))}`), { status: xhr.status }));
      };
      xhr.onerror = () => reject(new Error(`${path} network error`));
      xhr.send(jsonBody);
    });
  }

  // --- resolve_attachment: blob token → displayable data URL ----------------
  // Received images are stored as a blob token (annotation type 13). The native
  // client shows them via GET /api/get_attachment_url?url_type=FIFE_URL. That
  // endpoint either streams the image or hands back a (possibly auth-gated) FIFE
  // URL. A localhost <img> can't carry chat.google.com cookies (SameSite), so we
  // fetch in-origin here and return a data: URL the app can render anywhere.
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(new Error('read blob failed'));
      fr.readAsDataURL(blob);
    });
  }

  const PUBLIC_IMG_HOST = /googleusercontent\.com|ggpht\.com|lh\d\.google/;

  // Resolve a blob token to a DIRECTLY-renderable image URL. FIFE_URL hands back
  // a public googleusercontent URL (loadable cross-origin with no-referrer, like
  // avatars) — far cheaper/stabler than base64 and it doesn't flicker on reload.
  // Falls back to a data: URL only if no public URL is obtainable.
  async function resolveAttachmentUrl(u) {
    const resp = await fetch(u, { credentials: 'include' });
    if (!resp.ok) throw new Error(`attachment fetch ${resp.status}`);
    const ct = resp.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) {
      // FIFE_URL body carries the public image URL (text/proto, maybe escaped).
      const text = (await resp.text()).replace(/\\\//g, '/');
      const m = text.match(/https?:\/\/[^\s"'\\\]]+/);
      if (m) return m[0];
    }
    // It streamed the image. If it redirected to a public host, use that URL.
    if (resp.url && resp.url !== u && PUBLIC_IMG_HOST.test(resp.url)) return resp.url;
    // Last resort: inline the bytes (works anywhere, but heavier).
    return await blobToDataURL(await resp.blob());
  }

  async function resolveAttachment(token, contentType, size) {
    if (!token) throw new Error('attachment token required');
    if (state.attachmentCache[token]) return { url: state.attachmentCache[token] };
    await waitForRequestHeaders();
    const sz = size && /^[ws]\d+$/.test(size) ? size : 'w512';
    const u = `${state.accountBase}/api/get_attachment_url`
      + `?url_type=FIFE_URL&content_type=${encodeURIComponent(contentType || 'image/png')}`
      + `&attachment_token=${encodeURIComponent(token)}&allow_caching=true&sz=${sz}`;
    const url = await resolveAttachmentUrl(u);
    state.attachmentCache[token] = url;
    return { url };
  }

  // --- list_spaces via /api/paginated_world ---------------------------------
  // req[0] = client prefs/footer. Borrow from a cached real request if we have
  // one; otherwise a sane default. The two world builders below ALWAYS set
  // req[1]/req[3] explicitly so they can never poison each other via the cache.
  function worldPrefs() {
    const t = state.tmplPaginatedWorld;
    if (Array.isArray(t) && Array.isArray(t[0])) return cloneJSON(t[0]);
    return [0, 3, 1, navigator.language || 'en', DEFAULT_PREFS];
  }

  // Items variant: page size at [1][0][0]. MUST stay 30 — a large page returns
  // a single "recent conversations" page that DROPS the dfe.w.ws section block
  // (and the section-member spaces). The section data only rides along the
  // native-size (30) paginated responses + their section-chain token.
  function buildPaginatedWorldReq(token) {
    return [
      worldPrefs(),
      [[30, null, null, [2, 1, 2, null, 1, null, null, 2, 2, null, null, 1, null, null, null, [[4], [8]]], null, token || null]],
      null, [4, 2, 5, 6, 7, 3], null, null, null, null, 0,
    ];
  }

  function collectMembers(node) {
    const out = [];
    const seen = new Set();
    (function walk(x) {
      if (!Array.isArray(x)) return;
      const id = x?.[0]?.[0];
      const name = x?.[1];
      if (typeof id === 'string' && /^\d+$/.test(id) && typeof name === 'string' && name && !seen.has(id)) {
        seen.add(id);
        out.push({ id, name, avatar: typeof x[2] === 'string' ? x[2] : '' });
        return;
      }
      for (const y of x) walk(y);
    })(node);
    return out;
  }

  function parseWorld(json) {
    const items = json?.[0]?.[4];
    if (!Array.isArray(items)) return [];
    if (!state.myUserId) {
      for (const it of items) {
        const my = it?.[3]?.[0]?.[0]?.[0];
        if (typeof my === 'string' && /^\d+$/.test(my)) { state.myUserId = my; break; }
      }
    }
    const spaces = [];
    for (const it of items) {
      if (!Array.isArray(it)) continue;
      const ref = it[0];
      const id = groupIdFromRef(ref);
      if (!id) continue;
      state.groupRefById[id] = cloneJSON(ref);
      const isSpace = typeof it[4] === 'string' && it[4];
      let name = '';
      if (isSpace) {
        name = it[4];
      } else {
        const members = collectMembers(it[31]);
        for (const m of members) if (m.id && m.name) state.userNames[m.id] = m.name;
        const others = members.filter((m) => m.id && m.id !== state.myUserId);
        name = (others.length ? others : members).map((m) => m.name).filter(Boolean).join('、');
      }
      const sp = { spaceKey: 'space:' + id, name: name || id, type: isSpace ? 'space' : 'dm' };
      spaces.push(sp);
      // Persist into the union so sectioned spaces seen only in the native
      // client's sync survive (the regular list excludes them). Prefer a real
      // name over a bare id if we learn it later.
      const prev = state.spacesById[id];
      if (!prev || (prev.name === id && sp.name !== id)) state.spacesById[id] = sp;
    }
    return spaces;
  }

  // Custom sections (the user-organised groups in Chat's left rail) live in
  // root[0][1] — an array of "dfe.w.ws" descriptors. Each section entry:
  //   e[1][1] = order ("0".."9")   e[1][2] = name ("非工作用")
  //   e[2]    = [ [[spaceId]], ... ] member spaces (spread across descriptors)
  function parseSections(json, opts) {
    const acc = (opts && opts.acc) || state.sectionAcc;
    const silent = !!(opts && opts.silent);
    const wsList = json?.[0]?.[1];
    if (!Array.isArray(wsList)) return;
    const before = Object.keys(acc.orderBySpaceId).length;
    for (const ws of wsList) {
      if (!Array.isArray(ws) || ws[0] !== 'dfe.w.ws') continue;
      const entries = ws[9];
      if (!Array.isArray(entries)) continue;
      for (const e of entries) {
        if (!Array.isArray(e) || !Array.isArray(e[1])) continue;
        const order = e[1][1];
        const name = e[1][2];
        if (typeof order !== 'string') continue;
        if (typeof name === 'string' && name) acc.nameByOrder[order] = name;
        if (Array.isArray(e[2])) {
          for (const ref of e[2]) {
            const id = ref?.[0]?.[0];
            if (typeof id === 'string' && id) acc.orderBySpaceId[id] = order;
          }
        }
      }
    }
    // Newly learned section membership → nudge the app to re-render the sidebar.
    // Suppressed when called from our own listSpaces pages (silent) to avoid a
    // sections-updated → loadSpaces → paginated_world → parseSections feedback
    // storm; only passive captures of the native client's sync emit. Debounced.
    if (!silent && acc === state.sectionAcc && Object.keys(acc.orderBySpaceId).length > before) {
      scheduleSectionsUpdated();
    }
  }

  // Page through the whole world. There are TWO parallel continuation chains
  // (verified against real traffic):
  //   • root[0][2]        → next page of items (spaces/DMs)
  //   • root[0][1][0][6]  → the section-membership page (carries the
  //                          section→space mapping in root[0][1])
  // We walk both with one work-queue, parsing sections + items on every page,
  // so we always resolve both the full channel list AND custom-section members.
  // Fetch one paginated_world page, accumulate its spaces into spacesById, and
  // return the page's spaces + both continuation tokens.
  async function fetchWorldPage(tok) {
    const json = stripParse(await apiPost('/api/paginated_world', JSON.stringify(buildPaginatedWorldReq(tok)), ''));
    parseSections(json, { silent: true });
    const spaces = parseWorld(json);
    for (const s of spaces) {
      const id = spaceIDFromKey(s.spaceKey);
      if (id) state.spacesById[id] = { ...(state.spacesById[id] || {}), ...s };
    }
    return { spaces, nextItems: json?.[0]?.[2], nextSection: json?.[0]?.[1]?.[0]?.[6] };
  }

  // Walk BOTH continuation chains (regular list root[0][2] + section page
  // root[0][1][0][6]) into spacesById. Bounded by a fetch cap + token dedup.
  async function walkWorld(startTokens, cap) {
    const queue = startTokens.filter((t) => typeof t === 'string' && t);
    const done = new Set();
    let fetches = 0;
    while (queue.length && fetches < cap) {
      const tok = queue.shift();
      if (done.has(tok)) continue;
      done.add(tok);
      let page;
      try { page = await fetchWorldPage(tok); } catch { continue; }
      fetches += 1;
      if (typeof page.nextItems === 'string' && page.nextItems && !done.has(page.nextItems)) queue.push(page.nextItems);
      if (typeof page.nextSection === 'string' && page.nextSection && !done.has(page.nextSection)) queue.push(page.nextSection);
    }
  }

  // Assemble the space list from spacesById (the union of everything we've seen,
  // incl. passively-synced sectioned spaces) + section membership.
  function assembleSpaces() {
    const all = Object.keys(state.spacesById).map((id) => ({ ...state.spacesById[id] }));
    const acc = state.sectionAcc;
    for (const s of all) {
      const order = acc.orderBySpaceId[spaceIDFromKey(s.spaceKey)];
      if (order != null && acc.nameByOrder[order]) {
        s.section = acc.nameByOrder[order];
        s.sectionOrder = Number(order);
      }
    }
    const sections = Object.keys(acc.nameByOrder)
      .map((o) => ({ order: Number(o), name: acc.nameByOrder[o] }))
      .sort((a, b) => a.order - b.order);
    return { spaces: all, sections };
  }

  async function listSpaces() {
    await waitForRequestHeaders();
    // First page synchronously → fast initial paint. The full multi-page walk
    // runs ONCE in the background (subsequent polls stay a single fetch); the
    // passive native-sync into spacesById fills in everything else meanwhile.
    let first = { nextItems: null, nextSection: null };
    try { first = await fetchWorldPage(null); } catch { /* fall back to cached spacesById */ }
    if (!state.worldWalked && (first.nextItems || first.nextSection)) {
      state.worldWalked = true;
      void (async () => {
        await walkWorld([first.nextItems, first.nextSection], 20);
        scheduleSectionsUpdated();   // tell the app to re-pull the now-fuller list
      })();
    }
    return assembleSpaces();
  }

  // --- load_space_messages via /api/list_topics -----------------------------
  function buildListTopicsReq(ref, anchorMicros) {
    // anchorMicros: load topics at-or-before this µs time. Omitted ⇒ NOW (latest).
    const now = (Number(anchorMicros) > 0 ? Number(anchorMicros) : Date.now() * 1000);
    let req;
    if (Array.isArray(state.tmplListTopics)) {
      req = cloneJSON(state.tmplListTopics);
    } else {
      req = new Array(100).fill(null);
      req[1] = 40; req[4] = [3, 1, 4]; req[5] = 1000; req[6] = 20; req[10] = 2;
      req[99] = buildFooter(false);
    }
    req[7] = ref;
    // CRITICAL fix (verified against real traffic): req[3][4][0] is the "as-of"
    // ANCHOR — list_topics returns the newest topics/messages at-or-before it.
    // The cached template freezes this at capture time, so replaying it shows
    // ancient messages and hides recent ones. Re-anchor to NOW to always load
    // the latest. req[8] (world head) and req[9] (last-read) are also bumped.
    req[3] = [null, null, null, null, [now]];
    req[8] = [now];
    req[9] = [now];
    return req;
  }

  // m[20] = reactions: [ [emojiSeg, count, mineBool, ts], ... ]
  //   emojiSeg unicode = ["👍"]; custom = [null, [uuid,null,":shortcode:",…]]
  function parseReactions(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const re of arr) {
      if (!Array.isArray(re)) continue;
      const seg = re[0];
      const count = typeof re[1] === 'number' ? re[1] : 1;
      const mine = re[2] === true;
      let emoji = '';
      if (Array.isArray(seg)) {
        if (typeof seg[0] === 'string') emoji = seg[0];                                   // unicode
        else if (Array.isArray(seg[1]) && typeof seg[1][2] === 'string') emoji = seg[1][2]; // custom :shortcode:
      }
      if (emoji) out.push({ emoji, count, mine });
    }
    return out;
  }

  // m[10] is the ANNOTATIONS array (mentions, links, meet links, uploads…),
  // NOT a plain attachment list. Each entry a[0] is a type tag; type 13 is an
  // uploaded image/file. We only surface image attachments for inline display.
  //   type-13 shape: a[9][0]=blob token, a[9][2]=filename,
  //                  a[9][3]=content-type, a[9][4]=[w,h].
  function parseAttachments(anns) {
    if (!Array.isArray(anns)) return [];
    const out = [];
    for (const a of anns) {
      if (!Array.isArray(a) || a[0] !== 13) continue;
      const meta = a[9];
      if (!Array.isArray(meta)) continue;
      const token = typeof meta[0] === 'string' ? meta[0] : '';
      const filename = typeof meta[2] === 'string' ? meta[2] : (typeof a[8] === 'string' ? a[8] : 'file');
      const contentType = typeof meta[3] === 'string' ? meta[3] : '';
      const dims = Array.isArray(meta[4]) ? meta[4] : null;
      if (!token) continue;
      out.push({
        token,
        filename,
        contentType,
        isImage: /^image\//i.test(contentType),
        width: dims && typeof dims[0] === 'number' ? dims[0] : null,
        height: dims && typeof dims[1] === 'number' ? dims[1] : null,
      });
    }
    return out;
  }

  // type-6 annotation = @mention. Shape:
  //   [6, startIndex, length, null, [[userId], 3, [[userId], email]], …, 3]
  // We surface the exact mention substring so the app can highlight it.
  function parseMentions(anns, body) {
    if (!Array.isArray(anns) || typeof body !== 'string') return [];
    const out = [];
    for (const a of anns) {
      if (!Array.isArray(a) || a[0] !== 6) continue;
      const start = a[1], len = a[2];
      const userId = a?.[4]?.[0]?.[0];
      if (typeof start !== 'number' || typeof len !== 'number') continue;
      const text = body.substr(start, len);
      if (text) out.push({ text, userId: userId ? String(userId) : '' });
    }
    return out;
  }

  function parseMessageRecord(m, spaceKey, topicId) {
    if (!Array.isArray(m) || m.length < 10) return null;
    const body = applyFormatAnnotations(typeof m[9] === 'string' ? m[9] : '', m[10]);
    const attachments = parseAttachments(m[10]);
    if (!body && attachments.length === 0) return null;   // keep image-only messages
    const msgId = m?.[0]?.[1] || m?.[13];
    if (!msgId) return null;
    const sender = Array.isArray(m[1]) ? m[1] : [];
    const senderId = sender?.[0]?.[0] || '';
    const senderName = sender?.[1] || sender?.[4] || '';
    const senderEmail = typeof sender?.[3] === 'string' ? sender[3] : '';
    let avatar = typeof sender?.[2] === 'string' ? sender[2] : '';
    if (senderId && senderName) state.userNames[senderId] = String(senderName);
    if (senderId && senderEmail) state.emailById[senderId] = senderEmail;
    // Cache avatar by user so a record that omits it (live frames, some pages)
    // still renders the right face instead of blanking out.
    if (senderId && avatar) state.avatarById[senderId] = avatar;
    if (!avatar && senderId) avatar = state.avatarById[senderId] || '';
    // The thread/topic id used for replies is the STRING id (e.g. "NQVfB4q_H54"),
    // embedded per-message at m[0][0][3][1]. The numeric topic[1] is a timestamp,
    // NOT a topic id — replying with it 500s create_message. Prefer the embedded
    // string id, fall back to the topicId the caller derived from topic[0][1].
    const topicFromMsg = m?.[0]?.[0]?.[3]?.[1];
    const threadId = (typeof topicFromMsg === 'string' && topicFromMsg) ? topicFromMsg : (topicId || '');
    return {
      messageId: String(msgId),
      spaceKey,
      threadKey: threadId ? String(threadId) : '',
      senderId: senderId ? String(senderId) : '',
      senderName: String(senderName || state.userNames[senderId] || ''),
      avatar,
      body,
      ts: parseMicroTS(m[2]),
      reactions: parseReactions(m[20]),
      mentions: parseMentions(m[10], body),
      // Image attachments carry a blob token the app resolves lazily via
      // resolve_attachment → get_attachment_url. Non-image files get a note.
      attachments: attachments.filter((a) => a.isImage),
      attachmentNote: (() => {
        const files = attachments.filter((a) => !a.isImage);
        return files.length ? files.map((f) => f.filename).join('、') : '';
      })(),
    };
  }

  function parseTopics(json, spaceKey) {
    const topics = json?.[0]?.[1];
    if (!Array.isArray(topics)) return { messages: [], topicCount: 0 };
    const msgs = [];
    for (const t of topics) {
      if (!Array.isArray(t)) continue;
      // t[0] = [null, topicStringId, [[spaceId]]]; t[0][1] is the real topic id.
      // (t[1] is a numeric timestamp — using it as the thread key 500s replies.)
      const topicId = t?.[0]?.[1] ? String(t[0][1]) : (t?.[1] ? String(t[1]) : '');
      const mlist = t?.[6];
      if (!Array.isArray(mlist)) continue;
      for (const m of mlist) {
        const pm = parseMessageRecord(m, spaceKey, topicId);
        if (pm) msgs.push(pm);
      }
    }
    msgs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return { messages: msgs, topicCount: topics.length };
  }

  async function loadSpaceMessages(spaceKey, beforeTs) {
    await waitForRequestHeaders();
    const ref = buildGroupRef(spaceKey);
    if (!ref) throw new Error('unknown space — reload the channel list first');
    // beforeTs (µs): re-anchor list_topics to page OLDER history. The response
    // includes topics at-or-before it; the app dedups by messageId on reconcile.
    const anchor = Number(beforeTs) > 0 ? Number(beforeTs) : 0;
    const text = await apiPost('/api/list_topics', JSON.stringify(buildListTopicsReq(ref, anchor)), spaceIDFromKey(spaceKey));
    const { messages, topicCount } = parseTopics(stripParse(text), spaceKey);
    return { spaceKey, messages, topicCount, older: anchor > 0 };
  }

  // --- send_message via /api/create_topic -----------------------------------
  // The create_topic / create_message responses echo back the full message
  // record we just created (same shape as list_topics messages), so we parse it
  // out and hand the real message back to the app — no reload needed to show it.
  function extractSentMessage(respText, spaceKey) {
    try {
      const json = stripParse(respText);
      const found = parseWebchannelFrame(json);
      if (!found.length) return null;
      const m = found[0];
      m.spaceKey = 'space:' + spaceIDFromKey(spaceKey);
      if (!m.senderName) m.senderName = state.userNames[state.myUserId] || '你';
      return m;
    } catch { return null; }
  }

  async function sendNewTopic(spaceKey, text, mentions) {
    await waitForRequestHeaders();
    const ref = buildGroupRef(spaceKey);
    if (!ref) throw new Error('unknown space');
    const payload = new Array(100).fill(null);
    const out = transformOutgoing(text, mentions);
    payload[1] = out.body;
    const anns = [...out.formatAnns, ...buildMentionAnnotations(out.mentions)];
    if (anns.length) payload[2] = anns;
    payload[4] = ref;
    payload[5] = [1];
    payload[6] = randomKey();
    payload[7] = 1;
    payload[8] = [1];
    payload[99] = buildFooter(true);
    const resp = await apiPost('/api/create_topic', JSON.stringify(payload), spaceIDFromKey(spaceKey));
    return { ok: true, message: extractSentMessage(resp, spaceKey) };
  }

  // create_message (reply in an existing topic/thread)
  async function sendReply(spaceKey, threadKey, text, mentions) {
    await waitForRequestHeaders();
    if (!threadKey) throw new Error('thread key required for reply');
    const ref = buildGroupRef(spaceKey);
    if (!ref) throw new Error('unknown space');
    const payload = new Array(100).fill(null);
    payload[0] = [null, null, null, [null, threadKey, ref]];
    const out = transformOutgoing(text, mentions);
    payload[1] = out.body;
    const anns = [...out.formatAnns, ...buildMentionAnnotations(out.mentions)];
    if (anns.length) payload[2] = anns;
    payload[5] = randomKey();
    payload[6] = [1];
    payload[7] = [1];
    payload[99] = buildFooter(true);
    const resp = await apiPost('/api/create_message', JSON.stringify(payload), spaceIDFromKey(spaceKey));
    const message = extractSentMessage(resp, spaceKey);
    if (message) message.threadKey = String(threadKey);
    return { ok: true, message };
  }

  // --- send_image: Google resumable upload → create_topic with attachment ---
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  // The finalize response is a protobuf whose field 1 (tag 0x0a) is the blob
  // token string we must reference in create_topic.
  function extractUploadToken(respText) {
    let raw;
    try { raw = atob(respText.trim()); } catch { return ''; }
    if (raw.charCodeAt(0) !== 0x0a) {
      // not the shape we expect — fall back to any long base64-ish run
      const m = respText.match(/[A-Za-z0-9+/_-]{40,}={0,2}/);
      return m ? m[0] : '';
    }
    // read varint length at offset 1
    let i = 1, shift = 0, len = 0, b;
    do { b = raw.charCodeAt(i++); len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    return raw.slice(i, i + len);
  }

  // Custom-emoji finalize response is a protobuf with field 1 (tag 0x0a) =
  // upload token and field 2 (tag 0x12) = blob token; create_custom_emoji
  // (bOib7c) needs BOTH. Generic length-delimited field reader.
  function extractUploadTokens(respText) {
    let raw;
    try { raw = atob(String(respText).trim()); } catch { return null; }
    const fields = {};
    let i = 0;
    while (i < raw.length) {
      const tag = raw.charCodeAt(i++);
      if ((tag & 0x07) !== 2) break;                          // only length-delimited
      let shift = 0, len = 0, b;
      do { b = raw.charCodeAt(i++); len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
      fields[tag >> 3] = raw.slice(i, i + len);
      i += len;
    }
    return { uploadToken: fields[1] || '', blobToken: fields[2] || '' };
  }

  // Resumable upload of a custom-emoji image (upload_type=CUSTOM_EMOJI). Same
  // two-step start→upload,finalize dance as attachments; returns both tokens.
  function uploadCustomEmoji(bytes, filename, contentType) {
    const startUrl = `${state.accountBase}/uploads?upload_type=CUSTOM_EMOJI&upload_protocol=resumable`;
    const xsrf = state.requestHeaders?.['x-framework-xsrf-token'];
    const uploadUrl = new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', startUrl, true);
      xhr.setRequestHeader('X-Goog-Upload-Protocol', 'resumable');
      xhr.setRequestHeader('X-Goog-Upload-Command', 'start');
      xhr.setRequestHeader('X-Goog-Upload-Content-Length', String(bytes.length));
      xhr.setRequestHeader('X-Goog-Upload-Header-Content-Type', contentType);
      xhr.setRequestHeader('X-Goog-Upload-File-Name', filename);
      if (xsrf) xhr.setRequestHeader('X-Framework-Xsrf-Token', xsrf);
      xhr.timeout = 20000;
      xhr.ontimeout = () => reject(new Error('emoji upload start timeout'));
      xhr.onload = () => {
        const u = xhr.getResponseHeader('x-goog-upload-url');
        if (u) resolve(u); else reject(new Error(`emoji upload start failed: ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('emoji upload start network error'));
      xhr.send('');
    });
    return uploadUrl.then((u) => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', u, true);
      xhr.setRequestHeader('X-Goog-Upload-Command', 'upload, finalize');
      xhr.setRequestHeader('X-Goog-Upload-Offset', '0');
      xhr.timeout = 60000;
      xhr.ontimeout = () => reject(new Error('emoji upload timeout'));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const tokens = extractUploadTokens(String(xhr.responseText || ''));
          if (tokens && tokens.uploadToken) resolve(tokens);
          else reject(new Error('no emoji upload tokens in response'));
        } else reject(new Error(`emoji upload failed: ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('emoji upload network error'));
      xhr.send(bytes);
    }));
  }

  function uploadAttachment(groupId, key, bytes, filename, contentType) {
    const startUrl = `${state.accountBase}/uploads?group_id=${encodeURIComponent(groupId)}&topic_id=${key}&message_id=${key}&otr=false&transcoded_video=false&upload_type=ATTACHMENT&upload_protocol=resumable`;
    const xsrf = state.requestHeaders?.['x-framework-xsrf-token'];
    // 1) start → get the resumable session url from the response header
    const uploadUrl = new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', startUrl, true);
      xhr.setRequestHeader('X-Goog-Upload-Protocol', 'resumable');
      xhr.setRequestHeader('X-Goog-Upload-Command', 'start');
      xhr.setRequestHeader('X-Goog-Upload-Content-Length', String(bytes.length));
      xhr.setRequestHeader('X-Goog-Upload-Header-Content-Type', contentType);
      xhr.setRequestHeader('X-Goog-Upload-File-Name', filename);
      if (xsrf) xhr.setRequestHeader('X-Framework-Xsrf-Token', xsrf);
      xhr.timeout = 20000;
      xhr.ontimeout = () => reject(new Error('upload start timeout'));
      xhr.onload = () => {
        const u = xhr.getResponseHeader('x-goog-upload-url');
        if (u) resolve(u); else reject(new Error(`upload start failed: ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('upload start network error'));
      xhr.send('');
    });
    // 2) upload + finalize → response carries the blob token
    return uploadUrl.then((u) => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', u, true);
      xhr.setRequestHeader('X-Goog-Upload-Command', 'upload, finalize');
      xhr.setRequestHeader('X-Goog-Upload-Offset', '0');
      xhr.timeout = 60000;
      xhr.ontimeout = () => reject(new Error('upload timeout'));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const token = extractUploadToken(String(xhr.responseText || ''));
          if (token) resolve(token); else reject(new Error('no upload token in response'));
        } else reject(new Error(`upload failed: ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('upload network error'));
      xhr.send(bytes);
    }));
  }

  async function sendImage(spaceKey, threadKey, base64, filename, contentType, caption) {
    await waitForRequestHeaders();
    const groupId = spaceIDFromKey(spaceKey);
    const ref = buildGroupRef(spaceKey);
    if (!groupId || !ref) throw new Error('unknown space');
    const bytes = base64ToBytes(base64);
    const key = randomKey();
    const token = await uploadAttachment(groupId, key, bytes, filename || 'image.png', contentType || 'image/png');
    const attachment = [[13, null, 0, null, null, null, null, null, `${filename || 'image.png'}${bytes.length}0`, [token]]];

    const payload = new Array(100).fill(null);
    if (threadKey) {
      payload[0] = [null, null, null, [null, threadKey, ref]];
      payload[1] = caption || '';
      payload[2] = attachment;
      payload[5] = key;
      payload[6] = [1];
      payload[7] = [1];
      payload[99] = buildFooter(true);
      const resp = await apiPost('/api/create_message', JSON.stringify(payload), groupId);
      const message = extractSentMessage(resp, spaceKey);
      return { ok: true, message };
    }
    payload[1] = caption || '';
    payload[2] = attachment;
    payload[4] = ref;
    payload[5] = [1];
    payload[6] = key;
    payload[7] = 1;
    payload[8] = [1];
    payload[99] = buildFooter(true);
    const resp = await apiPost('/api/create_topic', JSON.stringify(payload), groupId);
    return { ok: true, message: extractSentMessage(resp, spaceKey) };
  }

  // --- create_space via /api/create_group -----------------------------------
  // Verified payload (real traffic): [0] = [name,…,[[1]],[],…,4,…], [2] = a
  // fresh client request id, [3]=0, [5]=9, [7]=[null,16,…,1000,20,[]], [99]=footer.
  // Response: ["dfe.g.cg",[[[spaceId]],name,…]] → the new space id.
  async function createSpace(name) {
    await waitForRequestHeaders();
    const nm = String(name || '').trim();
    if (!nm) throw new Error('space name required');
    const payload = new Array(100).fill(null);
    payload[0] = [nm, null, null, null, null, null, null, null, [[1]], [], null, null, 4, null, 0, null, 0];
    payload[2] = randomKey();
    payload[3] = 0;
    payload[5] = 9;
    payload[7] = [null, 16, null, null, null, 1000, 20, []];
    payload[99] = buildFooter(false);
    const parsed = stripParse(await apiPost('/api/create_group', JSON.stringify(payload), ''));
    // Response wrapped: [["dfe.g.cg",[[[spaceId]],name,…],…]] → id at [0][1][0][0][0].
    const spaceId = parsed?.[0]?.[1]?.[0]?.[0]?.[0] || '';
    return { ok: true, spaceId, spaceKey: spaceId ? `space:${spaceId}` : '', name: nm };
  }

  // --- create_custom_emoji: upload image → bOib7c batchexecute ---------------
  // bOib7c inner = [null, ":shortcode:", [uploadToken, blobToken, filename, ct]].
  // Response echoes the new emoji record [uuid,null,":sc:",1,[uid…],[lid],ts,blob]
  // (no image URL yet — the app re-fetches the catalog to pick up the lh3 URL).
  async function createEmoji(shortcode, base64, filename, contentType) {
    await waitForRequestHeaders();
    let sc = String(shortcode || '').trim().replace(/\s+/g, '_');
    if (!sc) throw new Error('shortcode required');
    if (!sc.startsWith(':')) sc = `:${sc}`;
    if (!sc.endsWith(':')) sc = `${sc}:`;
    const fn = filename || 'emoji.png';
    const ct = contentType || 'image/png';
    const { uploadToken, blobToken } = await uploadCustomEmoji(base64ToBytes(base64), fn, ct);
    const url = batchExecuteUrl('bOib7c');
    if (!url) throw new Error('no batchexecute URL captured yet — open the chat.google.com tab');
    const inner = [null, sc, [uploadToken, blobToken, fn, ct]];
    const freq = JSON.stringify([[['bOib7c', JSON.stringify(inner), null, 'generic']]]);
    const bodyParams = new URLSearchParams();
    bodyParams.set('f.req', freq);
    if (state.batchAt) bodyParams.set('at', state.batchAt);
    const xsrf = state.requestHeaders?.['x-framework-xsrf-token'];
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: Object.assign(
        { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        xsrf ? { 'x-framework-xsrf-token': xsrf } : {},
      ),
      body: bodyParams.toString(),
    });
    if (!resp.ok) throw new Error(`create emoji rpc ${resp.status}`);
    const text = await resp.text();
    const m = text.match(/"wrb\.fr","bOib7c","((?:\\.|[^"\\])*)"/);
    let rec = null;
    if (m) { try { rec = JSON.parse(JSON.parse(`"${m[1]}"`)); } catch { /* ignore */ } }
    const made = Array.isArray(rec?.[0]) ? rec[0] : null;
    return { ok: true, shortcode: made && made[2] ? made[2] : sc };
  }

  // --- scheduled ("unsent") messages ----------------------------------------
  // create: [footer, [[clientId,groupRef],null,null,text,null,null,1,[[schedSec]],""]]
  // delete: [footer, [clientId,groupRef]]
  // update: [footer, [[clientId,groupRef],null×6,[[newSchedSec]]], [[[8,[null,[1]]]]]]   (field-8 mask = time)
  // list  : [footer, [], [null,null,1,null,1]] → ["dfe.rs.lum", <records|null>, [syncToken]]
  // Scheduled time is epoch SECONDS (not µs). The clientId is a client-minted key
  // we must remember to later cancel/reschedule (also echoed in create/update resp).
  async function scheduleMessage(spaceKey, text, whenMs) {
    await waitForRequestHeaders();
    const ref = buildGroupRef(spaceKey);
    if (!ref) throw new Error('unknown space — reload the channel list first');
    const body = String(text || '').trim();
    if (!body) throw new Error('message text required');
    const sec = Math.floor(Number(whenMs) / 1000);
    if (!(sec > 0)) throw new Error('valid schedule time required');
    const clientId = randomKey();
    const payload = [
      buildFooter(false),
      [[clientId, ref], null, null, body, null, null, 1, [[sec]], ''],
    ];
    stripParse(await apiPost('/api/create_unsent_message', JSON.stringify(payload), spaceIDFromKey(spaceKey)));
    return { ok: true, clientId, scheduledSec: sec };
  }

  // --- delete a message via /api/delete_message -----------------------------
  // payload[0] is the same message ref shape as react()/update_reaction:
  // [[null,null,null,[null,messageId,ref]], messageId]. messageId = opaque m[0][1].
  async function deleteMessage(spaceKey, messageId) {
    await waitForRequestHeaders();
    const spaceId = spaceIDFromKey(spaceKey);
    if (!spaceId || !messageId) throw new Error('space and message required');
    const ref = buildGroupRef(spaceKey) || [[spaceId]];
    const payload = new Array(100).fill(null);
    payload[0] = [[null, null, null, [null, messageId, ref]], messageId];
    payload[99] = buildFooter(false);
    stripParse(await apiPost('/api/delete_message', JSON.stringify(payload), spaceId));
    return { ok: true };
  }

  async function cancelScheduled(spaceKey, clientId) {
    await waitForRequestHeaders();
    const ref = buildGroupRef(spaceKey);
    if (!ref || !clientId) throw new Error('space and clientId required');
    const payload = [buildFooter(false), [String(clientId), ref]];
    stripParse(await apiPost('/api/delete_unsent_message', JSON.stringify(payload), spaceIDFromKey(spaceKey)));
    return { ok: true };
  }

  async function rescheduleMessage(spaceKey, clientId, whenMs) {
    await waitForRequestHeaders();
    const ref = buildGroupRef(spaceKey);
    if (!ref || !clientId) throw new Error('space and clientId required');
    const sec = Math.floor(Number(whenMs) / 1000);
    if (!(sec > 0)) throw new Error('valid schedule time required');
    const payload = [
      buildFooter(false),
      [[String(clientId), ref], null, null, null, null, null, null, [[sec]]],
      [[[8, [null, [1]]]]],                                   // field mask: 8 = scheduled time
    ];
    stripParse(await apiPost('/api/update_unsent_message', JSON.stringify(payload), spaceIDFromKey(spaceKey)));
    return { ok: true, scheduledSec: sec };
  }

  // record: [[clientId,groupRef],[sec,ns],[sec,ns],text,…,[[schedSec],?],""]
  function parseUnsentRecord(rec) {
    if (!Array.isArray(rec)) return null;
    const pair = rec[0];
    const clientId = Array.isArray(pair) ? pair[0] : null;
    const groupId = groupIdFromRef(Array.isArray(pair) ? pair[1] : null);
    if (typeof clientId !== 'string' || !clientId) return null;
    return {
      clientId,
      spaceKey: groupId ? `space:${groupId}` : '',
      text: typeof rec[3] === 'string' ? rec[3] : '',
      scheduledSec: Number(rec?.[7]?.[0]?.[0]) || 0,
    };
  }

  async function listScheduled(spaceKey) {
    await waitForRequestHeaders();
    const payload = [buildFooter(false), [], [null, null, 1, null, 1]];
    const parsed = stripParse(await apiPost('/api/list_unsent_messages', JSON.stringify(payload), spaceKey ? spaceIDFromKey(spaceKey) : ''));
    // Response is wrapped: [["dfe.rs.lum", <records|null>, [token]]] — records at [0][1].
    const recs = Array.isArray(parsed?.[0]?.[1]) ? parsed[0][1] : [];
    let items = recs.map(parseUnsentRecord).filter(Boolean);
    if (spaceKey) items = items.filter((x) => x.spaceKey === `space:${spaceIDFromKey(spaceKey)}`);
    items.sort((a, b) => a.scheduledSec - b.scheduledSec);
    return { scheduled: items };
  }

  // --- react via /api/update_reaction ---------------------------------------
  async function react(spaceKey, messageId, emoji, action) {
    await waitForRequestHeaders();
    const spaceId = spaceIDFromKey(spaceKey);
    if (!spaceId) throw new Error('space_key required');
    if (!messageId) throw new Error('message_id required');
    const cat = state.emojiCatalog[emoji];
    const isShortcode = emoji.startsWith(':') && emoji.endsWith(':');
    const code = action === 'remove' ? 2 : 1;
    // The group ref inside payload[0] MUST match the conversation type — space
    // is [[id]] but a DM is [null,null,[dmId]]. Hardcoding [[id]] 404s on DMs.
    const ref = buildGroupRef(spaceKey) || [[spaceId]];
    const payload = new Array(100).fill(null);
    payload[0] = [[null, null, null, [null, messageId, ref]], messageId];
    if (cat && cat.type === 'custom') {
      payload[1] = [null, [cat.uuid, null, cat.shortcode, 1, [cat.userId || ''], [cat.localId || ''], null, Number(cat.timestamp) || 0, cat.blob || '']];
    } else if (cat && cat.type === 'unicode') {
      payload[1] = [cat.unicode];
    } else if (!isShortcode) {
      // Plain unicode emoji (e.g. 👍). The server identifies it by codepoint —
      // no frecent-catalog entry needed, so just send the character directly.
      payload[1] = [emoji];
    } else {
      throw new Error(`custom emoji "${emoji}" not loaded — use it once in the Chat tab, then reload`);
    }
    payload[2] = code;
    payload[99] = buildFooter(false);
    await apiPost('/api/update_reaction', JSON.stringify(payload), spaceId);
    return { ok: true };
  }

  // --- webchannel frame → live message events -------------------------------
  function allDigits(s) { return typeof s === 'string' && s.length > 0 && /^[0-9]+$/.test(s); }
  function tryParseLiveRecord(arr) {
    // Same record shape as list_topics messages.
    if (!Array.isArray(arr) || arr.length < 10) return null;
    const body = arr[9];
    if (typeof body !== 'string' || !body) return null;
    const senderId = arr?.[1]?.[0]?.[0];
    if (typeof senderId !== 'string' || !allDigits(senderId)) return null;
    if (!allDigits(arr[2])) return null;
    const msgId = arr?.[0]?.[1] || arr?.[13];
    if (typeof msgId !== 'string' || !msgId) return null;
    const spaceId = groupIdFromRef(arr?.[0]?.[0]?.[3]?.[2]);   // handles space + DM ref shapes
    const topicId = arr?.[0]?.[0]?.[3]?.[1];                   // string topic id (for thread grouping)
    const senderName = arr?.[1]?.[1] || arr?.[1]?.[4] || state.userNames[senderId] || '';
    let avatar = typeof arr?.[1]?.[2] === 'string' ? arr[1][2] : '';
    if (senderId && senderName) state.userNames[senderId] = String(senderName);
    if (senderId && avatar) state.avatarById[senderId] = avatar;
    if (!avatar && senderId) avatar = state.avatarById[senderId] || '';
    return {
      messageId: String(msgId),
      spaceKey: spaceId ? 'space:' + spaceId : '',
      threadKey: typeof topicId === 'string' ? topicId : '',
      senderId, senderName: String(senderName), avatar,
      body: applyFormatAnnotations(body, arr[10]), ts: parseMicroTS(arr[2]),
    };
  }
  function parseWebchannelFrame(frame) {
    const out = [];
    const seen = new Set();
    (function walk(v) {
      if (!Array.isArray(v)) return;
      const pm = tryParseLiveRecord(v);
      if (pm) { if (!seen.has(pm.messageId)) { seen.add(pm.messageId); out.push(pm); } return; }
      for (const item of v) walk(item);
    })(frame);
    return out;
  }

  // The current Chat client's realtime stream mostly carries compact "something
  // changed" notifications (typing/presence/new-activity pings), NOT full
  // message bodies. So beyond parsing any full message we can, we also fire a
  // debounced 'activity' signal on every frame; the app refetches on it. This
  // makes the UI a faithful live mirror without decoding every frame variant.
  let activityTimer = null;
  function signalActivity() {
    if (activityTimer) return;
    activityTimer = setTimeout(() => { activityTimer = null; emitEvent('activity', {}); }, 400);
  }

  // Heavily debounced so a burst of section-bearing pages → one sidebar refresh.
  let sectionsUpdatedTimer = null;
  function scheduleSectionsUpdated() {
    if (sectionsUpdatedTimer) return;
    sectionsUpdatedTimer = setTimeout(() => { sectionsUpdatedTimer = null; emitEvent('sections-updated', {}); }, 1500);
  }

  // --- op dispatcher --------------------------------------------------------
  async function handleOp(reqId, op, args) {
    try {
      let data;
      switch (op) {
        case 'session_status': data = sessionStatus(); break;
        case 'list_emojis': data = listEmojis(); break;
        case 'load_all_custom_emojis': data = await loadAllCustomEmojis(); break;
        case 'dump_idb': data = await dumpIdb(); break;
        case 'list_members': data = listMembers(); break;
        case 'list_spaces': data = await listSpaces(); break;
        case 'load_space_messages': data = await loadSpaceMessages(args.spaceKey); break;
        case 'load_older_messages': data = await loadSpaceMessages(args.spaceKey, args.beforeTs); break;
        case 'create_space': data = await createSpace(args.name); break;
        case 'create_emoji': data = await createEmoji(args.shortcode, args.base64, args.filename, args.contentType); break;
        case 'schedule_message': data = await scheduleMessage(args.spaceKey, args.text, args.whenMs); break;
        case 'delete_message': data = await deleteMessage(args.spaceKey, args.messageId); break;
        case 'list_scheduled': data = await listScheduled(args.spaceKey); break;
        case 'cancel_scheduled': data = await cancelScheduled(args.spaceKey, args.clientId); break;
        case 'reschedule_message': data = await rescheduleMessage(args.spaceKey, args.clientId, args.whenMs); break;
        case 'send_message':
          data = (args.sendMode === 'reply' && args.threadKey)
            ? await sendReply(args.spaceKey, args.threadKey, args.text, args.mentions)
            : await sendNewTopic(args.spaceKey, args.text, args.mentions);
          break;
        case 'send_image': data = await sendImage(args.spaceKey, args.threadKey || '', args.base64, args.filename, args.contentType, args.caption); break;
        case 'react': data = await react(args.spaceKey, args.messageId, args.emoji, args.action || 'add'); break;
        case 'get_reactors': data = await getReactors(args.spaceKey, args.messageId, args.emoji); break;
        case 'dump_reactor_rpc': data = dumpReactorRpc(); break;
        case 'resolve_attachment': data = await resolveAttachment(args.token, args.contentType, args.size); break;
        default: throw new Error(`unknown op: ${op}`);
      }
      postResult(reqId, true, data, '');
    } catch (e) {
      postResult(reqId, false, null, String(e?.message || e));
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data || {};
    if (d.source !== 'sg-content' || d.kind !== 'op') return;
    handleOp(d.reqId, d.op, d.args || {});
  });

  // --- network hooks --------------------------------------------------------
  const _fetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    let reqBody = '';
    if (init && typeof init.body === 'string') reqBody = init.body;
    const reqHeaders = headersToObject((init && init.headers) || (input instanceof Request ? input.headers : null));
    updateRequestState(url, reqBody, reqHeaders);
    const resp = await _fetch.apply(this, arguments);
    // Passively capture section membership if the native client uses fetch()
    // for paginated_world (its startup sync carries the one-time member delta).
    if (/\/api\/paginated_world/.test(url)) {
      try { resp.clone().text().then((t) => { try { const j = stripParse(t); parseWorld(j); parseSections(j); } catch {} }); } catch {}
    }
    return resp;
  };

  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  const _setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__sg = { method, url, headers: {} };
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (!this.__sg) this.__sg = { headers: {} };
    if (!this.__sg.headers) this.__sg.headers = {};
    this.__sg.headers[String(name).toLowerCase()] = String(value);
    return _setRequestHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const meta = this.__sg || {};
    updateRequestState(meta.url, typeof body === 'string' ? body : '', meta.headers || {});
    const url = String(meta.url || '');

    if (/\/api\/get_frecent_emojis_v2(?:\?|$)/.test(url)) {
      this.addEventListener('load', () => { try { ingestFrecentEmojis(String(this.responseText || '')); } catch {} });
    }

    // Passively capture custom-section membership from the native client's own
    // paginated_world responses (its startup sync carries the one-time member
    // delta our app's later re-fetch never sees).
    if (/\/api\/paginated_world/.test(url)) {
      this.addEventListener('load', () => { try { const j = stripParse(String(this.responseText || '')); parseWorld(j); parseSections(j); } catch {} });
    }

    if (/\/webchannel\/events/i.test(url)) {
      this.__sgCursor = 0;
      this.__sgBuf = '';
      const pump = () => {
        let txt = '';
        try { txt = String(this.responseText || ''); } catch { return; }
        if (txt.length <= this.__sgCursor) return;
        this.__sgBuf += txt.slice(this.__sgCursor);
        this.__sgCursor = txt.length;
        if (this.__sgBuf.startsWith(")]}'")) this.__sgBuf = this.__sgBuf.slice(4).replace(/^\s+/, '');
        while (true) {
          const nl = this.__sgBuf.indexOf('\n');
          if (nl < 0) return;
          const n = Number(this.__sgBuf.slice(0, nl).trim());
          if (!Number.isFinite(n) || n <= 0) { this.__sgBuf = this.__sgBuf.slice(nl + 1); continue; }
          if (this.__sgBuf.length < nl + 1 + n) return;
          const payload = this.__sgBuf.slice(nl + 1, nl + 1 + n);
          this.__sgBuf = this.__sgBuf.slice(nl + 1 + n);
          let parsed;
          try { parsed = JSON.parse(payload); } catch { continue; }
          for (const m of parseWebchannelFrame(parsed)) emitEvent('message', m);
          signalActivity();
        }
      };
      this.addEventListener('readystatechange', () => { if (this.readyState >= 3) pump(); });
    }
    return _send.apply(this, arguments);
  };

  log('network hooks installed');
  setTimeout(() => emitEvent('session-ready', sessionStatus()), 0);
})();
