import { useMemo } from 'react';
import type { Message } from '../types';
import { dayLabel, dayKey } from '../util';
import MessageRow from './MessageRow';
import type { CustomEmoji } from './EmojiPicker';

interface Props {
  messages: Message[];
  onReact: (m: Message, emoji: string) => void;
  onOpenThread: (threadKey: string) => void;
  onDelete?: (m: Message) => void;
  myUserId?: string;
  customEmojis: CustomEmoji[];
  emojiUrlMap: Record<string, string>;
}

interface Thread {
  key: string; root: Message; replyCount: number;
  lastReplyTs?: string; replyAvatars: string[];
}

// Google Chat is thread-based: every topic (threadKey) is a thread. The main
// channel view shows each thread's root message; replies collapse into a
// "N 則回覆" affordance that opens the thread panel (Slack style).
function buildThreads(messages: Message[]): Thread[] {
  const byKey = new Map<string, Message[]>();
  for (const m of messages) {
    const key = m.threadKey || m.messageId;
    const arr = byKey.get(key);
    if (arr) arr.push(m);
    else byKey.set(key, [m]);
  }
  const threads: Thread[] = [];
  for (const [key, arr] of byKey) {
    const sorted = [...arr].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const replies = sorted.slice(1);
    threads.push({
      key,
      root: sorted[0],
      replyCount: replies.length,
      lastReplyTs: replies.length ? replies[replies.length - 1].ts : undefined,
      replyAvatars: Array.from(new Set(replies.map((r) => r.avatar || ''))),
    });
  }
  // order threads by their root's timestamp so channel chronology is preserved
  threads.sort((a, b) => (a.root.ts < b.root.ts ? -1 : a.root.ts > b.root.ts ? 1 : 0));
  return threads;
}

export default function MessageList({ messages, onReact, onOpenThread, onDelete, myUserId, customEmojis, emojiUrlMap }: Props) {
  const threads = useMemo(() => buildThreads(messages), [messages]);

  const rows: JSX.Element[] = [];
  let lastDay = '';
  let prevSender = '';

  for (const t of threads) {
    const m = t.root;
    const dk = dayKey(m.ts);
    if (dk !== lastDay) {
      rows.push(
        <div className="day-divider" key={`day-${dk}-${m.messageId}`}>
          <div className="line" /><div className="pill">{dayLabel(m.ts)}</div><div className="line" />
        </div>
      );
      lastDay = dk;
      prevSender = '';
    }

    // Group consecutive same-sender rows (incl. optimistic temp ones, so a
    // just-sent message doesn't briefly show an avatar then lose it on swap).
    const grouped = !!m.senderId && m.senderId === prevSender && t.replyCount === 0;
    prevSender = m.senderId || '';

    rows.push(
      <MessageRow
        key={m.messageId}
        m={m}
        grouped={grouped}
        onReact={onReact}
        customEmojis={customEmojis}
        emojiUrlMap={emojiUrlMap}
        replyCount={t.replyCount}
        lastReplyTs={t.lastReplyTs}
        replyAvatars={t.replyAvatars}
        threadKey={t.key}
        onOpenThread={onOpenThread}
        onDelete={onDelete}
        canDelete={!!myUserId && m.senderId === myUserId}
      />
    );
  }

  return <>{rows}</>;
}
