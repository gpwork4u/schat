import { useRef, useState, useEffect } from 'react';
import { ChevronDown, Clock } from 'lucide-react';
import type { Message, Member, MentionSpec } from '../types';
import RichComposerInput, { type MentionHandle } from './RichComposerInput';
import DateTimePicker from './DateTimePicker';

// Quick schedule presets (Slack-style). Returns epoch ms for the next occurrence.
function nextAt(hour: number, dayOffset: number): number {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}
function nextMondayAt(hour: number): number {
  const d = new Date();
  const days = ((1 - d.getDay()) + 7) % 7 || 7; // next Monday (never today)
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

export interface PendingImage { dataUrl: string; base64: string; filename: string; contentType: string; }

interface Props {
  channelName: string;
  members: Member[];
  replyTo: Message | null;
  onCancelReply: () => void;
  onSend: (text: string, mentions: MentionSpec[]) => Promise<void>;
  onSendImage: (img: PendingImage, caption: string) => Promise<void>;
  onSchedule: (text: string, whenMs: number) => Promise<void>;
}

export default function Composer({ channelName, members, replyTo, onCancelReply, onSend, onSendImage, onSchedule }: Props) {
  const [sending, setSending] = useState(false);
  const [text, setText] = useState('');
  const [image, setImage] = useState<PendingImage | null>(null);
  const inputRef = useRef<MentionHandle>(null);
  const hasText = !!text.trim();

  useEffect(() => { inputRef.current?.focus(); }, [channelName, replyTo]);

  const readImageFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const base64 = dataUrl.split(',')[1] || '';
      setImage({ dataUrl, base64, filename: file.name || 'image.png', contentType: file.type || 'image/png' });
    };
    reader.readAsDataURL(file);
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const item = Array.from(e.clipboardData.items).find((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (item) {
      const file = item.getAsFile();
      if (file) { e.preventDefault(); readImageFile(file); }
    }
  };

  const submit = () => {
    const { text, mentions } = inputRef.current?.getValue() || { text: '', mentions: [] };
    const t = text.trim();
    if (!t && !image) return;
    const img = image;
    // Clear the box IMMEDIATELY for a snappy, Slack-like feel — the optimistic
    // message already shows in the timeline, so don't wait for the round-trip.
    inputRef.current?.clear();
    setText('');
    setImage(null);
    const p = img ? onSendImage(img, t) : onSend(t, mentions);
    Promise.resolve(p).catch(() => {
      // On failure, restore the text so nothing is lost (image can't be restored).
      if (!img && t) inputRef.current?.setValue(t);
    });
  };

  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Schedule the current text (no image support) at a chosen time, then clear.
  const schedule = async (whenMs: number) => {
    const { text } = inputRef.current?.getValue() || { text: '' };
    const t = text.trim();
    if (!t || sending) return;
    setMenuOpen(false); setPickerOpen(false);
    setSending(true);
    try {
      await onSchedule(t, whenMs);
      inputRef.current?.clear();
      setText('');
    } finally {
      setSending(false);
    }
  };

  const fmt = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const tomorrow9 = nextAt(9, 1);
  const nextMon9 = nextMondayAt(9);

  return (
    <div className="composer">
      {replyTo && (
        <div className="reply-pill">
          回覆 {replyTo.senderName || '討論串'}：{replyTo.body.slice(0, 40)}{replyTo.body.length > 40 ? '…' : ''}
          <button onClick={onCancelReply}>取消</button>
        </div>
      )}
      <div className="composer-box">
        {image && (
          <div className="composer-image">
            <img src={image.dataUrl} alt={image.filename} />
            <button className="rm-img" title="移除圖片" onClick={() => setImage(null)}>×</button>
          </div>
        )}
        <RichComposerInput
          ref={inputRef}
          members={members}
          placeholder={image ? '加上說明（可選）…' : replyTo ? '回覆討論串…' : '說點什麼...'}
          onTextChange={setText}
          onEnter={() => void submit()}
          onPaste={onPaste}
        />

        {/* Slack-style send control: a primary button + a caret that opens the
            schedule menu. Sits at the composer box's bottom-right. */}
        <div className="composer-toolbar">
          <span className="composer-hint-inline">Enter 傳送 · Shift+Enter 換行 · *粗* _斜_ ~刪~ `碼` @標註</span>
          <div className="send-split">
            <button className="send-btn" disabled={(!hasText && !image) || sending} onClick={() => void submit()}>
              {sending ? '傳送中…' : '傳送'}
            </button>
            {hasText && !image && (
              <div className="send-caret-wrap">
                <button className="send-caret" disabled={sending} title="排程傳送" onClick={() => setMenuOpen((v) => !v)}>
                  <ChevronDown size={15} />
                </button>
                {menuOpen && (
                  <>
                    <div className="send-menu-backdrop" onClick={() => setMenuOpen(false)} />
                    <div className="send-menu">
                      <div className="send-menu-title"><Clock size={13} /> 排程傳送</div>
                      <button onClick={() => void schedule(tomorrow9)}>明天上午 9:00<span>{fmt(tomorrow9)}</span></button>
                      <button onClick={() => void schedule(nextMon9)}>下週一上午 9:00<span>{fmt(nextMon9)}</span></button>
                      <button onClick={() => { setMenuOpen(false); setPickerOpen(true); }}>自訂日期與時間…</button>
                    </div>
                  </>
                )}
                {pickerOpen && (
                  <>
                    <div className="send-menu-backdrop" onClick={() => setPickerOpen(false)} />
                    <div className="dtp-pop">
                      <DateTimePicker
                        value={tomorrow9}
                        onConfirm={(ms) => void schedule(ms)}
                        onCancel={() => setPickerOpen(false)}
                      />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
