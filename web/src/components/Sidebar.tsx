import { useRef, useState } from 'react';
import { RefreshCw, Plus, SmilePlus, CalendarClock } from 'lucide-react';
import type { Space, SectionInfo } from '../types';
import Logo from './Logo';

interface Props {
  spaces: Space[];
  sections: SectionInfo[];
  activeKey: string | null;
  filter: string;
  onFilter: (v: string) => void;
  onSelect: (key: string) => void;
  onRefresh: () => void;
  onNewChannel: () => void;
  onNewEmoji: (file: File) => void;
  onOpenScheduled: () => void;
  scheduledActive: boolean;
}

interface Group { key: string; label: string; items: Space[]; }

export default function Sidebar({ spaces, sections, activeKey, filter, onFilter, onSelect, onRefresh, onNewChannel, onNewEmoji, onOpenScheduled, scheduledActive }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const emojiFileRef = useRef<HTMLInputElement>(null);
  const toggle = (k: string) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));

  const f = filter.trim().toLowerCase();
  const shown = f ? spaces.filter((s) => s.name.toLowerCase().includes(f)) : spaces;

  // Build groups: each custom Google Chat section (in its order) first, then
  // any spaces not in a section, then DMs.
  const groups: Group[] = [];
  const orderedSections = [...sections].sort((a, b) => a.order - b.order);
  for (const sec of orderedSections) {
    const items = shown.filter((s) => s.section === sec.name);
    if (items.length) groups.push({ key: `sec-${sec.order}`, label: sec.name, items });
  }
  const unsectionedSpaces = shown.filter((s) => s.type !== 'dm' && !s.section);
  const dms = shown.filter((s) => s.type === 'dm' && !s.section);
  if (unsectionedSpaces.length) groups.push({ key: 'spaces', label: '頻道', items: unsectionedSpaces });
  if (dms.length) groups.push({ key: 'dms', label: '私訊', items: dms });

  const renderChan = (s: Space) => (
    <button
      key={s.spaceKey}
      className={`chan${s.spaceKey === activeKey ? ' active' : ''}${s.unread ? ' unread' : ''}`}
      onClick={() => onSelect(s.spaceKey)}
      title={s.name}
    >
      <span className="hash">{s.type === 'dm' ? '@' : '#'}</span>
      <span className="name">{s.name}</span>
      {!!s.unread && <span className="badge">{s.unread}</span>}
    </button>
  );

  return (
    <nav className="sidebar">
      <div className="sidebar-head">
        <h2 className="brand"><Logo size={20} /> Schat</h2>
        <button className="railbtn" title="新增頻道" style={{ width: 28, height: 28 }} onClick={onNewChannel}><Plus size={16} /></button>
        <button className="railbtn" title="新增自訂 emoji" style={{ width: 28, height: 28 }} onClick={() => emojiFileRef.current?.click()}><SmilePlus size={15} /></button>
        <button className="railbtn" title="重新整理頻道列表" style={{ width: 28, height: 28 }} onClick={onRefresh}><RefreshCw size={15} /></button>
        <input ref={emojiFileRef} type="file" accept="image/*" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onNewEmoji(f); e.target.value = ''; }} />
      </div>
      <div className="sidebar-search">
        <input placeholder="搜尋頻道與私訊" value={filter} onChange={(e) => onFilter(e.target.value)} />
      </div>
      <button className={`sidebar-nav${scheduledActive ? ' active' : ''}`} onClick={onOpenScheduled}>
        <CalendarClock size={15} /> 已排程訊息
      </button>
      <div className="chan-list">
        {shown.length === 0 && (
          <div className="sidebar-empty">{spaces.length === 0 ? '尚無頻道，點右上角重新整理載入' : '沒有符合的項目'}</div>
        )}
        {groups.map((g) => (
          <div className="chan-section" key={g.key}>
            <button className="section-label" onClick={() => toggle(g.key)}>
              <span className="caret">{collapsed[g.key] ? '▸' : '▾'}</span>
              {g.label}
              <span className="count">{g.items.length}</span>
            </button>
            {!collapsed[g.key] && g.items.map(renderChan)}
          </div>
        ))}
      </div>
    </nav>
  );
}
