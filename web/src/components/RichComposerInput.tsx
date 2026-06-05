import { forwardRef, useImperativeHandle, useRef, useState, useEffect } from 'react';
import type { Member, MentionSpec } from '../types';

export interface MentionHandle {
  getValue(): { text: string; mentions: MentionSpec[] };
  setValue(text: string): void;
  clear(): void;
  focus(): void;
}

interface Props {
  members: Member[];
  placeholder?: string;
  onTextChange?: (text: string) => void;
  onEnter?: () => void;
  onPaste?: (e: React.ClipboardEvent) => void;
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Render markdown source → HTML that contains EXACTLY the same characters (only
// wrapped in styling spans), so caret offsets map 1:1 to the source string. A
// single-pass tokenizer keeps every consumed char, hiding only the delimiters
// (.md-delim). Supports ```block```, `code`, *bold*, _italic_, ~strike~, links,
// and @mentions — the full Google Chat markdown set. A trailing sentinel <br>
// (ignored by source/caret) makes a final blank line visible.
function mdToHtml(text: string, mentionNames: string[]): string {
  const names = [...new Set(mentionNames)].filter(Boolean).sort((a, b) => b.length - a.length);
  const delim = (d: string) => `<span class="md-delim">${esc(d)}</span>`;
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const rest = text.slice(i);
    let m: RegExpMatchArray | null;
    const atLineStart = i === 0 || text[i - 1] === '\n';
    if (atLineStart && (m = rest.match(/^(\s*)([-*]|\d+\.)(\s)/))) {
      out += esc(m[1]) + `<span class="md-list-marker">${esc(m[2])}</span>` + esc(m[3]);
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^```([\s\S]*?)```/))) {
      out += delim('```') + `<code class="md-pre-inline">${esc(m[1])}</code>` + delim('```');
    } else if ((m = rest.match(/^`([^`\n]+)`/))) {
      out += delim('`') + `<code class="md-code">${esc(m[1])}</code>` + delim('`');
    } else if ((m = rest.match(/^\*([^*\n]+)\*/))) {
      out += delim('*') + `<strong>${esc(m[1])}</strong>` + delim('*');
    } else if ((m = rest.match(/^_([^_\n]+)_/))) {
      out += delim('_') + `<em>${esc(m[1])}</em>` + delim('_');
    } else if ((m = rest.match(/^~([^~\n]+)~/))) {
      out += delim('~') + `<s>${esc(m[1])}</s>` + delim('~');
    } else if ((m = rest.match(/^https?:\/\/[^\s<]+/))) {
      out += `<span class="md-link">${esc(m[0])}</span>`;
    } else {
      const name = names.find((nm) => rest.startsWith(nm));
      if (name) { out += `<span class="mention">${esc(name)}</span>`; i += name.length; continue; }
      out += esc(text[i]);
      i += 1;
      continue;
    }
    i += m[0].length;
  }
  return out + '<br data-sentinel="1">';
}

// --- caret <-> character-offset helpers (offsets are into the source text) ---
function isSentinel(n: Node): boolean {
  return (n as HTMLElement).tagName === 'BR' && (n as HTMLElement).dataset?.sentinel === '1';
}

function sourceOf(root: HTMLElement): string {
  let out = '';
  const walk = (n: Node) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) out += (c as Text).nodeValue || '';
      else if (isSentinel(c)) { /* skip layout-only sentinel */ }
      else if ((c as HTMLElement).tagName === 'BR') out += '\n';
      else walk(c);
    }
  };
  walk(root);
  return out;
}

function caretOffset(root: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.endContainer)) return sourceOf(root).length;
  const pre = range.cloneRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.endContainer, range.endOffset);
  // count chars (text nodes + BR as \n) within `pre`
  let count = 0;
  const walk = (n: Node) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) count += (c as Text).nodeValue?.length || 0;
      else if (isSentinel(c)) { /* skip */ }
      else if ((c as HTMLElement).tagName === 'BR') count += 1;
      else walk(c);
    }
  };
  // walk only the portion before the caret by using a temp fragment
  const frag = pre.cloneContents();
  walk(frag);
  return count;
}

function setCaret(root: HTMLElement, offset: number) {
  const sel = window.getSelection();
  if (!sel) return;
  let remaining = offset;
  const target: { node: Node; off: number } = { node: root, off: 0 };
  let found = false;
  const walk = (n: Node): boolean => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) {
        const len = (c as Text).nodeValue?.length || 0;
        if (remaining <= len) { target.node = c; target.off = remaining; found = true; return true; }
        remaining -= len;
      } else if (isSentinel(c)) {
        /* skip */
      } else if ((c as HTMLElement).tagName === 'BR') {
        if (remaining <= 0) { target.node = n; target.off = Array.from(n.childNodes).indexOf(c); found = true; return true; }
        remaining -= 1;
      } else if (walk(c)) return true;
    }
    return false;
  };
  walk(root);
  const range = document.createRange();
  if (found) range.setStart(target.node, target.off);
  else { range.selectNodeContents(root); range.collapse(false); }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

const RichComposerInput = forwardRef<MentionHandle, Props>(function RichComposerInput(
  { members, placeholder, onTextChange, onEnter, onPaste }, ref,
) {
  const editorRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const textRef = useRef('');
  const [picked, setPicked] = useState<Member[]>([]);
  const pickedRef = useRef<Member[]>([]);
  pickedRef.current = picked;
  const [query, setQuery] = useState<string | null>(null);
  const [anchor, setAnchor] = useState(0);
  const [active, setActive] = useState(0);
  const [empty, setEmpty] = useState(true);

  const mentionNames = () => {
    const names = pickedRef.current.map((p) => '@' + p.name);
    for (const m of members) if (textRef.current.includes('@' + m.name)) names.push('@' + m.name);
    return names;
  };

  const renderInto = (src: string, caret?: number) => {
    const el = editorRef.current;
    if (!el) return;
    el.innerHTML = src ? mdToHtml(src, mentionNames()) : '';
    if (caret != null) setCaret(el, caret);
  };

  const updateState = (src: string, caret: number) => {
    textRef.current = src;
    setEmpty(!src);
    onTextChange?.(src);
    const before = src.slice(0, caret);
    const mm = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (mm) { setQuery(mm[1]); setAnchor(caret - mm[1].length - 1); setActive(0); }
    else setQuery(null);
  };

  const handleInput = (e?: React.FormEvent) => {
    const el = editorRef.current;
    if (!el || composingRef.current) return;
    const caret = caretOffset(el);
    const src = sourceOf(el);
    updateState(src, caret);
    // Re-render (reformat) only on changes that can complete/alter a markdown
    // token; plain typing leaves the native caret untouched (it was vanishing
    // because we rebuilt innerHTML on every keystroke).
    const ev = (e as React.FormEvent & { nativeEvent: InputEvent })?.nativeEvent;
    const it = ev?.inputType || '';
    const data = ev?.data;
    const trigger = !ev
      || it.startsWith('delete') || it.startsWith('insertFromPaste')
      || it === 'insertLineBreak' || it === 'insertParagraph'
      || !data || data.length > 1 || /[*_~`\s@:]/.test(data);
    if (trigger) renderInto(src, caret);
  };

  useImperativeHandle(ref, () => ({
    getValue() {
      const text = textRef.current;
      const mentions: MentionSpec[] = [];
      const consumed: Array<[number, number]> = [];
      const overlaps = (s: number, e: number) => consumed.some(([a, b]) => s < b && e > a);
      for (const m of pickedRef.current) {
        const token = '@' + m.name;
        let from = 0;
        for (;;) {
          const idx = text.indexOf(token, from);
          if (idx === -1) break;
          if (!overlaps(idx, idx + token.length)) {
            mentions.push({ userId: m.userId, email: m.email, start: idx, len: token.length });
            consumed.push([idx, idx + token.length]);
            break;
          }
          from = idx + 1;
        }
      }
      return { text, mentions };
    },
    setValue(text: string) {
      const src = String(text || '');
      renderInto(src, src.length);
      textRef.current = src; setEmpty(!src); onTextChange?.(src);
      editorRef.current?.focus();
    },
    clear() {
      textRef.current = ''; setPicked([]); setQuery(null); setEmpty(true);
      const el = editorRef.current; if (el) el.innerHTML = '';
      onTextChange?.('');
    },
    focus() { editorRef.current?.focus(); },
  }), [members]);

  useEffect(() => { editorRef.current?.focus(); }, []);

  const candidates = query !== null
    ? members.filter((m) => m.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8)
    : [];

  const pick = (m: Member) => {
    const el = editorRef.current;
    if (!el) return;
    const caret = caretOffset(el);
    const src = sourceOf(el);
    const token = '@' + m.name + ' ';
    const next = src.slice(0, anchor) + token + src.slice(caret);
    setPicked((p) => (p.some((x) => x.userId === m.userId) ? p : [...p, m]));
    pickedRef.current = pickedRef.current.some((x) => x.userId === m.userId) ? pickedRef.current : [...pickedRef.current, m];
    setQuery(null);
    const pos = anchor + token.length;
    renderInto(next, pos);
    textRef.current = next; setEmpty(!next); onTextChange?.(next);
  };

  const insertNewline = () => {
    const el = editorRef.current;
    if (!el) return;
    const caret = caretOffset(el);
    const src = sourceOf(el);
    const next = src.slice(0, caret) + '\n' + src.slice(caret);
    renderInto(next, caret + 1);
    updateState(next, caret + 1);
  };

  // If the caret's line is a markdown list item (- / * / "N."), return its parts
  // so Enter can auto-continue (or exit on an empty item), Slack/Notion-style.
  const listContextAtCaret = () => {
    const el = editorRef.current;
    if (!el) return null;
    const caret = caretOffset(el);
    const src = sourceOf(el);
    const lineStart = src.lastIndexOf('\n', caret - 1) + 1;
    let lineEnd = src.indexOf('\n', caret);
    if (lineEnd === -1) lineEnd = src.length;
    const m = src.slice(lineStart, lineEnd).match(/^(\s*)([-*]|(\d+)\.)\s(.*)$/);
    if (!m) return null;
    return { caret, src, lineStart, lineEnd, indent: m[1], marker: m[2], num: m[3] ? Number(m[3]) : null, content: m[4] };
  };

  // Enter inside a list: continue it (new bullet / next number), or — on an empty
  // item — drop the marker to leave the list. Caller has already preventDefault'd.
  const continueOrExitList = (ctx: NonNullable<ReturnType<typeof listContextAtCaret>>) => {
    if (ctx.content.trim() === '') {
      const next = ctx.src.slice(0, ctx.lineStart) + ctx.src.slice(ctx.lineEnd);
      renderInto(next, ctx.lineStart);
      updateState(next, ctx.lineStart);
      return;
    }
    const marker = ctx.num != null ? `${ctx.num + 1}.` : ctx.marker;
    const insert = `\n${ctx.indent}${marker} `;
    const next = ctx.src.slice(0, ctx.caret) + insert + ctx.src.slice(ctx.caret);
    renderInto(next, ctx.caret + insert.length);
    updateState(next, ctx.caret + insert.length);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // While an IME composition is active (e.g. typing Chinese), let the input
    // method consume Enter to commit the candidate — don't send/handle it here.
    if (composingRef.current || (e.nativeEvent as KeyboardEvent).isComposing || e.keyCode === 229) return;
    if (query !== null && candidates.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % candidates.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + candidates.length) % candidates.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(candidates[active]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setQuery(null); return; }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // Inside an (unclosed) ``` code block, Enter adds a newline instead of
      // sending — so multi-line code blocks can be composed and sent verbatim
      // (an odd number of ``` fences before the caret ⇒ we're inside one).
      const el = editorRef.current;
      if (el) {
        const before = sourceOf(el).slice(0, caretOffset(el));
        if ((before.split('```').length - 1) % 2 === 1) { insertNewline(); return; }
      }
      // Inside a list, both Enter and Shift+Enter continue the list (or exit on
      // an empty item) instead of sending; outside, Enter sends / Shift+Enter wraps.
      const ctx = listContextAtCaret();
      if (ctx) { continueOrExitList(ctx); return; }
      if (e.shiftKey) insertNewline(); else onEnter?.();
    }
  };

  const onPasteText = (e: React.ClipboardEvent) => {
    // let the parent grab images first
    onPaste?.(e);
    if (e.defaultPrevented) return;
    // insert clipboard text as PLAIN text (avoid pasting rich HTML into the editor)
    const txt = e.clipboardData.getData('text/plain');
    if (txt) {
      e.preventDefault();
      const el = editorRef.current!;
      const caret = caretOffset(el);
      const src = sourceOf(el);
      const next = src.slice(0, caret) + txt + src.slice(caret);
      renderInto(next, caret + txt.length);
      updateState(next, caret + txt.length);
    }
  };

  return (
    <div className="mention-wrap">
      {query !== null && candidates.length > 0 && (
        <div className="mention-menu">
          {candidates.map((m, i) => (
            <button
              key={m.userId}
              className={`mention-item${i === active ? ' active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(m); }}
              onMouseEnter={() => setActive(i)}
            >
              {m.avatar ? <img src={m.avatar} alt="" referrerPolicy="no-referrer" /> : <span className="mi-blank" />}
              <span className="mi-name">{m.name}</span>
              {m.email && <span className="mi-email">{m.email}</span>}
            </button>
          ))}
        </div>
      )}
      <div
        ref={editorRef}
        className={`rich-editor${empty ? ' empty' : ''}`}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder}
        onInput={handleInput}
        onKeyDown={onKeyDown}
        onPaste={onPasteText}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; handleInput(); }}
      />
    </div>
  );
});

export default RichComposerInput;
