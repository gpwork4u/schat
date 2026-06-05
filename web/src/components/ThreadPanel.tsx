import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Message, Member, MentionSpec } from '../types';
import MessageRow from './MessageRow';
import RichComposerInput, { type MentionHandle } from './RichComposerInput';
import type { CustomEmoji } from './EmojiPicker';

interface Props {
  threadKey: string;
  messages: Message[];                 // all messages of the active space
  members: Member[];
  onClose: () => void;
  onReact: (m: Message, emoji: string) => void;
  onSendReply: (threadKey: string, text: string, mentions: MentionSpec[]) => Promise<void>;
  customEmojis: CustomEmoji[];
  emojiUrlMap: Record<string, string>;
}

export default function ThreadPanel({
  threadKey, messages, members, onClose, onReact, onSendReply, customEmojis, emojiUrlMap,
}: Props) {
  const [sending, setSending] = useState(false);
  const [hasText, setHasText] = useState(false);
  const inputRef = useRef<MentionHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const thread = messages
    .filter((m) => (m.threadKey || m.messageId) === threadKey)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  useEffect(() => { inputRef.current?.focus(); }, [threadKey]);
  const lastId = thread.length ? thread[thread.length - 1].messageId : '';
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId, threadKey]);

  const submit = async () => {
    const { text, mentions } = inputRef.current?.getValue() || { text: '', mentions: [] };
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await onSendReply(threadKey, t, mentions);
      inputRef.current?.clear();
      setHasText(false);
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="thread-panel">
      <header className="thread-head">
        <span className="title">討論串</span>
        <span className="sub">{thread.length} 則訊息</span>
        <span className="spacer" />
        <button className="iconbtn" title="關閉" onClick={onClose}><X size={16} /></button>
      </header>

      <div className="thread-msgs" ref={scrollRef}>
        {thread.map((m, i) => (
          <MessageRow
            key={m.messageId}
            m={m}
            grouped={i > 0 && m.senderId === thread[i - 1].senderId && !m.temp}
            onReact={onReact}
            customEmojis={customEmojis}
            emojiUrlMap={emojiUrlMap}
          />
        ))}
      </div>

      <div className="thread-composer">
        <RichComposerInput
          ref={inputRef}
          members={members}
          placeholder="回覆討論串…（@ 標註成員、支援 markdown）"
          onTextChange={(t) => setHasText(!!t.trim())}
          onEnter={() => void submit()}
        />
        <button className="send-btn" disabled={!hasText || sending} onClick={() => void submit()}>
          {sending ? '傳送中…' : '回覆'}
        </button>
      </div>
    </aside>
  );
}
