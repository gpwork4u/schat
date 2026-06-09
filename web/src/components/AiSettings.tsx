import { useState } from 'react';
import { X, Bot } from 'lucide-react';
import type { Space } from '../types';
import type { AiConfig, Mode, Wire } from '../ai/types';

interface Props {
  config: AiConfig;
  spaces: Space[];
  onSave: (c: AiConfig) => void;
  onClose: () => void;
}

const MODES: { v: Mode; label: string }[] = [
  { v: 'off', label: '關閉' },
  { v: 'draft', label: '草稿（需批准）' },
  { v: 'auto', label: '自動送出' },
];

// AI auto-reply settings: provider (any OpenAI-compatible or Anthropic endpoint),
// persona, mode, and the trigger filter. All client-side; key stored locally.
export default function AiSettings({ config, spaces, onSave, onClose }: Props) {
  const [c, setC] = useState<AiConfig>(config);
  const set = (patch: Partial<AiConfig>) => setC((p) => ({ ...p, ...patch }));
  const setProvider = (patch: Partial<AiConfig['provider']>) => setC((p) => ({ ...p, provider: { ...p.provider, ...patch } }));
  const setFilter = (patch: Partial<AiConfig['filter']>) => setC((p) => ({ ...p, filter: { ...p.filter, ...patch } }));
  const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="ai-settings" onClick={(e) => e.stopPropagation()}>
        <header className="ai-set-head">
          <span><Bot size={16} style={{ verticalAlign: '-3px' }} /> AI 自動回覆設定</span>
          <button onClick={onClose}><X size={16} /></button>
        </header>
        <div className="ai-set-body">
          <label className="ai-field">
            <span>預設模式</span>
            <select value={c.mode} onChange={(e) => set({ mode: e.target.value as Mode })}>
              {MODES.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
            </select>
          </label>

          <fieldset className="ai-group">
            <legend>AI Provider</legend>
            <label className="ai-field">
              <span>格式</span>
              <select value={c.provider.wire} onChange={(e) => setProvider({ wire: e.target.value as Wire })}>
                <option value="openai">OpenAI 相容（/chat/completions）</option>
                <option value="anthropic">Anthropic（/messages）</option>
              </select>
            </label>
            <label className="ai-field"><span>Base URL</span>
              <input value={c.provider.baseUrl} onChange={(e) => setProvider({ baseUrl: e.target.value })}
                placeholder="https://api.openai.com/v1" /></label>
            <label className="ai-field"><span>Model</span>
              <input value={c.provider.model} onChange={(e) => setProvider({ model: e.target.value })}
                placeholder="gpt-4o-mini / claude-opus-4-8 / …" /></label>
            <label className="ai-field"><span>API Key</span>
              <input type="password" value={c.provider.apiKey} onChange={(e) => setProvider({ apiKey: e.target.value })}
                placeholder="存於本機，不上傳" /></label>
          </fieldset>

          <label className="ai-field col">
            <span>人設 / 語氣（system prompt）</span>
            <textarea rows={4} value={c.persona} onChange={(e) => set({ persona: e.target.value })} />
          </label>

          <fieldset className="ai-group">
            <legend>觸發條件（filter）</legend>
            <label className="ai-check">
              <input type="checkbox" checked={c.filter.onlyMentionsOrDm}
                onChange={(e) => setFilter({ onlyMentionsOrDm: e.target.checked })} />
              只在 @我 或私訊時回覆
            </label>
            <label className="ai-field"><span>頻道範圍</span>
              <select value={c.filter.spaceMode} onChange={(e) => setFilter({ spaceMode: e.target.value as 'all' | 'whitelist' })}>
                <option value="all">所有頻道</option>
                <option value="whitelist">僅指定頻道</option>
              </select>
            </label>
            {c.filter.spaceMode === 'whitelist' && (
              <div className="ai-whitelist">
                {spaces.map((s) => (
                  <label key={s.spaceKey} className="ai-check">
                    <input type="checkbox" checked={c.filter.whitelist.includes(s.spaceKey)}
                      onChange={(e) => setFilter({
                        whitelist: e.target.checked
                          ? [...c.filter.whitelist, s.spaceKey]
                          : c.filter.whitelist.filter((k) => k !== s.spaceKey),
                      })} />
                    {s.type === 'dm' ? '@' : '#'} {s.name}
                  </label>
                ))}
              </div>
            )}
            <label className="ai-field"><span>必含關鍵字</span>
              <input value={c.filter.allowKeywords.join(', ')} onChange={(e) => setFilter({ allowKeywords: list(e.target.value) })}
                placeholder="逗號分隔，留空=不限" /></label>
            <label className="ai-field"><span>排除關鍵字</span>
              <input value={c.filter.blockKeywords.join(', ')} onChange={(e) => setFilter({ blockKeywords: list(e.target.value) })}
                placeholder="逗號分隔" /></label>
          </fieldset>
        </div>
        <footer className="ai-set-foot">
          <button className="dtp-btn ghost" onClick={onClose}>取消</button>
          <button className="dtp-btn primary" onClick={() => { onSave(c); onClose(); }}>儲存</button>
        </footer>
      </div>
    </div>
  );
}
