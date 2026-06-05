import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';

// A shadcn-style date + time picker: a calendar popover paired with a time
// field. Self-contained (no calendar lib); styled via .dtp-* in index.css.
interface Props {
  value?: number;                 // initial epoch ms
  onConfirm: (ms: number) => void;
  onCancel: () => void;
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

function startOfDay(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function pad(n: number) { return String(n).padStart(2, '0'); }

export default function DateTimePicker({ value, onConfirm, onCancel }: Props) {
  const init = value ? new Date(value) : new Date(Date.now() + 60 * 60 * 1000);
  const [selected, setSelected] = useState<Date>(init);
  const [view, setView] = useState<Date>(startOfDay(new Date(init.getFullYear(), init.getMonth(), 1)));
  const [time, setTime] = useState<string>(`${pad(init.getHours())}:${pad(init.getMinutes())}`);
  const today = useMemo(() => startOfDay(new Date()), []);

  // Build the day grid (Mon-first) for the viewed month, padded with leading blanks.
  const cells = useMemo(() => {
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const lead = (first.getDay() + 6) % 7; // Mon=0
    const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    const arr: (Date | null)[] = [];
    for (let i = 0; i < lead; i += 1) arr.push(null);
    for (let day = 1; day <= daysInMonth; day += 1) arr.push(new Date(view.getFullYear(), view.getMonth(), day));
    return arr;
  }, [view]);

  const shiftMonth = (delta: number) => setView((v) => new Date(v.getFullYear(), v.getMonth() + delta, 1));

  const confirm = () => {
    const [h, m] = time.split(':').map(Number);
    const d = new Date(selected);
    d.setHours(Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0, 0, 0);
    if (d.getTime() < Date.now()) { window.alert('請選擇未來的時間'); return; }
    onConfirm(d.getTime());
  };

  const resultPreview = (() => {
    const [h, m] = time.split(':').map(Number);
    const d = new Date(selected);
    d.setHours(Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0, 0, 0);
    return d.toLocaleString();
  })();

  return (
    <div className="dtp">
      <div className="dtp-cal-head">
        <button className="dtp-nav" onClick={() => shiftMonth(-1)} aria-label="上個月"><ChevronLeft size={16} /></button>
        <span className="dtp-month">{view.getFullYear()} {MONTHS[view.getMonth()]}</span>
        <button className="dtp-nav" onClick={() => shiftMonth(1)} aria-label="下個月"><ChevronRight size={16} /></button>
      </div>
      <div className="dtp-grid dtp-weekdays">
        {WEEKDAYS.map((w) => <span key={w} className="dtp-wd">{w}</span>)}
      </div>
      <div className="dtp-grid">
        {cells.map((d, i) => d === null ? <span key={`b${i}`} className="dtp-day blank" /> : (
          <button
            key={d.toISOString()}
            className={`dtp-day${sameDay(d, selected) ? ' selected' : ''}${sameDay(d, today) ? ' today' : ''}`}
            disabled={startOfDay(d) < today}
            onClick={() => setSelected(d)}
          >{d.getDate()}</button>
        ))}
      </div>
      <div className="dtp-time-row">
        <CalendarDays size={15} className="dtp-time-icon" />
        <input className="dtp-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
      </div>
      <div className="dtp-footer">
        <span className="dtp-preview">{resultPreview}</span>
        <span className="dtp-actions">
          <button className="dtp-btn ghost" onClick={onCancel}>取消</button>
          <button className="dtp-btn primary" onClick={confirm}>確認</button>
        </span>
      </div>
    </div>
  );
}
