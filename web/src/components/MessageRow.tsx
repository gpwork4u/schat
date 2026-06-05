import { useState, useRef, memo } from 'react';
import { createPortal } from 'react-dom';
import { SmilePlus, MessageSquareText, Image as ImageIcon, Paperclip, Trash2 } from 'lucide-react';
import type { Message } from '../types';
import { colorFor, initials, fmtTime } from '../util';
import { RichText } from '../richtext';
import { call } from '../bridge';
import EmojiPicker, { type CustomEmoji } from './EmojiPicker';

// Compact 24h HH:MM for the hover timestamp in a grouped row's left gutter.
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

interface Props {
  m: Message;
  grouped: boolean;                 // same sender as previous row → compact
  onReact: (m: Message, emoji: string) => void;
  customEmojis: CustomEmoji[];
  emojiUrlMap: Record<string, string>;
  // Thread affordances (omitted inside the thread panel itself).
  replyCount?: number;
  lastReplyTs?: string;
  replyAvatars?: string[];
  threadKey?: string;
  onOpenThread?: (threadKey: string) => void;
  onDelete?: (m: Message) => void;
  canDelete?: boolean;             // true only for the viewer's own messages
}

function MessageRow({
  m, grouped, onReact, customEmojis, emojiUrlMap,
  replyCount = 0, lastReplyTs, replyAvatars, threadKey, onOpenThread, onDelete, canDelete,
}: Props) {
  const openThread = onOpenThread && threadKey ? () => onOpenThread(threadKey) : undefined;
  // Picker is portaled to <body> with fixed coords (flips above the anchor when
  // it'd overflow the viewport) so it's never clipped by the scrolling message
  // list — and shows the full Slack-style emoji set.
  const PICKER_H = 400;
  const PICKER_W = 352;
  const [picker, setPicker] = useState<{ left: number; top: number } | null>(null);
  const [avatarBroken, setAvatarBroken] = useState(false);
  const name = m.senderName || m.senderId || '未知使用者';

  // Reaction-hover tooltip: lazily fetch WHO reacted (Q3DB7e via get_reactors)
  // the first time a chip is hovered, then cache per-emoji on this row. State
  // ('loading' | 'error' | string[] of names) drives the portaled tooltip.
  const [tip, setTip] = useState<{ emoji: string; left: number; top: number } | null>(null);
  const [reactors, setReactors] = useState<Record<string, 'loading' | 'error' | string[]>>({});
  const hoverTimer = useRef<number | null>(null);

  const enterChip = (e: React.MouseEvent, emoji: string) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const left = Math.max(8, r.left);
    const top = r.top - 6;                                   // anchored above the chip
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      setTip({ emoji, left, top });
      if (reactors[emoji] === undefined) {
        setReactors((s) => ({ ...s, [emoji]: 'loading' }));
        call('get_reactors', { spaceKey: m.spaceKey, messageId: m.messageId, emoji }, 15000)
          .then((res: any) => {
            const names = (res?.reactors || []).map((x: any) => x.name || '使用者');
            setReactors((s) => ({ ...s, [emoji]: names }));
          })
          .catch(() => setReactors((s) => ({ ...s, [emoji]: 'error' })));
      }
    }, 300);
  };
  const leaveChip = () => {
    if (hoverTimer.current) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    setTip(null);
  };

  const tipText = (() => {
    if (!tip) return '';
    const re = m.reactions?.find((r) => r.emoji === tip.emoji);
    const state = reactors[tip.emoji];
    if (state === 'loading' || state === undefined) return '載入中…';
    if (state === 'error' || !Array.isArray(state) || state.length === 0) {
      return `${re?.count ?? 0} 人${re?.mine ? '（含你）' : ''}`;        // fallback to count
    }
    return `${state.join('、')} 用 ${tip.emoji} 回應`;
  })();

  const openPicker = (e: React.MouseEvent) => {
    if (picker) { setPicker(null); return; }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const openUp = r.bottom + PICKER_H > window.innerHeight && r.top > PICKER_H;
    const top = openUp ? Math.max(8, r.top - PICKER_H - 4) : r.bottom + 4;
    const left = Math.min(Math.max(8, r.right - PICKER_W), window.innerWidth - PICKER_W - 8);
    setPicker({ left, top });
  };

  const renderEmoji = (emoji: string) => {
    const url = emojiUrlMap[emoji];
    if (url) return <img className="emoji-img" src={url} alt={emoji} referrerPolicy="no-referrer" />;
    return <>{emoji}</>;
  };

  return (
    <div className={`msg${m.temp ? ' temp' : ''}`}>
      {grouped ? (
        <div className="avatar gutter" style={{ background: 'transparent', width: 36 }}>
          <span className="gutter-time">{shortTime(m.ts)}</span>
        </div>
      ) : m.avatar && !avatarBroken ? (
        <img className="avatar" src={m.avatar} alt={name} referrerPolicy="no-referrer"
          onError={() => setAvatarBroken(true)} />
      ) : (
        <div className="avatar" style={{ background: colorFor(name) }}>{initials(name)}</div>
      )}

      <div className="content">
        {!grouped && (
          <div className="meta">
            <span className="sender">{name}</span>
            <span className="time">{fmtTime(m.ts)}{m.temp ? ' · 傳送中…' : ''}</span>
          </div>
        )}
        {m.body ? <div className="body"><RichText text={m.body} mentions={m.mentions?.map((x) => x.text)} /></div> : null}

        {m.images && m.images.length > 0 && (
          <div className="msg-images">
            {m.images.map((src, i) => (
              <a key={i} href={src} target="_blank" rel="noopener noreferrer">
                <img className="msg-image" src={src} alt="image" referrerPolicy="no-referrer" />
              </a>
            ))}
          </div>
        )}
        {/* image attachments still resolving */}
        {m.attachments && m.attachments.length > 0 && (!m.images || m.images.length < m.attachments.length) && (
          <div className="attach-loading"><ImageIcon size={14} /> 載入圖片中…</div>
        )}
        {m.attachmentNote && <div className="attach-note"><Paperclip size={14} /> {m.attachmentNote}</div>}

        {m.reactions && m.reactions.length > 0 && (
          <div className="reactions">
            {m.reactions.map((r) => (
              <button className={`react-chip${r.mine ? ' mine' : ''}`} key={r.emoji}
                onClick={() => onReact(m, r.emoji)}
                onMouseEnter={(e) => enterChip(e, r.emoji)}
                onMouseLeave={leaveChip}>
                {renderEmoji(r.emoji)} <span className="rc-count">{r.count}</span>
              </button>
            ))}
            <button className="react-chip add-react" title="加上表情" onClick={openPicker}><SmilePlus size={15} /></button>
          </div>
        )}

        {replyCount > 0 && openThread && (
          <button className="thread-affordance" onClick={openThread}>
            <span className="thread-faces">
              {(replyAvatars || []).slice(0, 3).map((a, i) =>
                a ? <img key={i} src={a} referrerPolicy="no-referrer" alt="" />
                  : <span key={i} className="tf-blank" />)}
            </span>
            <span className="thread-count">{replyCount} 則回覆</span>
            {lastReplyTs && <span className="thread-last">最後回覆 {fmtTime(lastReplyTs)}</span>}
          </button>
        )}
      </div>

      {!m.temp && (
        <div className="hover-tools">
          <button title="加上表情" onClick={openPicker}><SmilePlus size={17} /></button>
          {openThread && <button title="在討論串回覆" onClick={openThread}><MessageSquareText size={17} /></button>}
          {canDelete && onDelete && (
            <button title="刪除訊息" className="danger" onClick={() => onDelete(m)}><Trash2 size={16} /></button>
          )}
        </div>
      )}

      {tip && createPortal(
        <div className="reactor-tip" style={{ left: tip.left, bottom: window.innerHeight - tip.top }}>
          {tipText}
        </div>,
        document.body,
      )}

      {picker && createPortal(
        <>
          <div className="emoji-backdrop" onClick={() => setPicker(null)} />
          <div className="emoji-pop" style={{ left: picker.left, top: picker.top }}>
            <EmojiPicker
              customEmojis={customEmojis}
              onPick={(emoji) => { onReact(m, emoji); setPicker(null); }}
            />
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

export default memo(MessageRow);
