import { DEFAULT_AI_CONFIG, type AiConfig, type Mode } from './types';

const KEY = 'sg-ai-config';

export function loadAiConfig(): AiConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_AI_CONFIG;
    const parsed = JSON.parse(raw);
    // shallow-merge over defaults so new fields don't break old saved configs
    return {
      ...DEFAULT_AI_CONFIG,
      ...parsed,
      provider: { ...DEFAULT_AI_CONFIG.provider, ...(parsed.provider || {}) },
      filter: { ...DEFAULT_AI_CONFIG.filter, ...(parsed.filter || {}) },
      perSpace: parsed.perSpace || {},
    };
  } catch { return DEFAULT_AI_CONFIG; }
}

export function saveAiConfig(cfg: AiConfig) {
  try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* quota */ }
}

// Effective mode for a space: per-space override wins over the global default.
export function effectiveMode(cfg: AiConfig, spaceKey: string): Mode {
  const o = cfg.perSpace[spaceKey];
  return o || cfg.mode;
}

export interface IncomingMsg {
  spaceKey: string;
  isDm: boolean;
  body: string;
  mentionsMe: boolean;
}

// Does this incoming message pass the user-configured filter? (independent of
// mode — the caller checks mode separately.)
export function passesFilter(cfg: AiConfig, m: IncomingMsg): boolean {
  const f = cfg.filter;
  if (f.spaceMode === 'whitelist' && !f.whitelist.includes(m.spaceKey)) return false;
  if (f.onlyMentionsOrDm && !m.isDm && !m.mentionsMe) return false;
  const body = (m.body || '').toLowerCase();
  if (f.blockKeywords.some((k) => k && body.includes(k.toLowerCase()))) return false;
  if (f.allowKeywords.length && !f.allowKeywords.some((k) => k && body.includes(k.toLowerCase()))) return false;
  return true;
}
