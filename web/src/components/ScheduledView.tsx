import { useState } from 'react';
import { Clock, RefreshCw, Trash2, CalendarClock } from 'lucide-react';
import DateTimePicker from './DateTimePicker';

export interface Scheduled { clientId: string; spaceKey: string; text: string; scheduledSec: number; }

interface Props {
  scheduled: Scheduled[];
  loading: boolean;
  spaceName: (key: string) => string;
  onRefresh: () => void;
  onCancel: (item: Scheduled) => void;
  onReschedule: (item: Scheduled, whenMs: number) => void;
  onGoChannel: (spaceKey: string) => void;
}

// A dedicated page listing every scheduled ("unsent") message across channels,
// sorted by send time, with reschedule (shadcn-style date+time picker) + cancel.
export default function ScheduledView({ scheduled, loading, spaceName, onRefresh, onCancel, onReschedule, onGoChannel }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const items = [...scheduled].sort((a, b) => a.scheduledSec - b.scheduledSec);

  return (
    <div className="sched-view">
      <header className="main-head">
        <span className="title"><CalendarClock size={17} style={{ verticalAlign: '-3px' }} /> 已排程訊息</span>
        <span className="spacer" />
        <button className="iconbtn" onClick={onRefresh} title="重新整理"><RefreshCw size={14} /></button>
      </header>

      <div className="sched-view-body">
        {loading ? (
          <div className="loading-row"><div className="spinner" /> 載入中…</div>
        ) : items.length === 0 ? (
          <div className="center-state"><h3>🗓️ 沒有已排程的訊息</h3><p>在任一頻道輸入訊息後，點傳送旁的箭頭即可排程。</p></div>
        ) : (
          <ul className="sched-list">
            {items.map((s) => {
              const when = new Date(s.scheduledSec * 1000);
              const overdue = when.getTime() < Date.now();
              return (
                <li className="sched-card" key={`${s.spaceKey}:${s.clientId}`}>
                  <div className="sched-card-top">
                    <button className="sched-chan" onClick={() => onGoChannel(s.spaceKey)} title="前往頻道">
                      # {spaceName(s.spaceKey)}
                    </button>
                    <span className={`sched-when${overdue ? ' overdue' : ''}`}>
                      <Clock size={13} /> {when.toLocaleString()}
                    </span>
                  </div>
                  <div className="sched-card-text">{s.text || '（無內文）'}</div>
                  <div className="sched-card-actions">
                    <button onClick={() => setEditing(editing === s.clientId ? null : s.clientId)}>
                      <CalendarClock size={14} /> 改時間
                    </button>
                    <button className="danger" onClick={() => onCancel(s)}><Trash2 size={14} /> 取消</button>
                  </div>
                  {editing === s.clientId && (
                    <div className="sched-edit">
                      <DateTimePicker
                        value={s.scheduledSec * 1000}
                        onConfirm={(ms) => { setEditing(null); onReschedule(s, ms); }}
                        onCancel={() => setEditing(null)}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
