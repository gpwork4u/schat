// Provider-agnostic AI auto-reply config (all client-side; no backend).
// Ported in spirit from the google-chat-bot agent: draft / auto modes + a
// filter that decides which incoming messages trigger a reply. The LLM call is
// pluggable — any OpenAI-compatible endpoint, or the Anthropic Messages API.

export type Wire = 'openai' | 'anthropic';
export type Mode = 'off' | 'draft' | 'auto';

export interface ProviderConfig {
  wire: Wire;            // request/response shape
  baseUrl: string;       // e.g. https://api.openai.com/v1  |  https://api.anthropic.com/v1
  apiKey: string;        // stored locally only
  model: string;         // e.g. gpt-4o-mini | claude-opus-4-8 | a local model id
}

export interface AiFilter {
  onlyMentionsOrDm: boolean;          // reply only when @me or in a DM
  spaceMode: 'all' | 'whitelist';     // which spaces are eligible
  whitelist: string[];                // spaceKeys (when spaceMode = whitelist)
  allowKeywords: string[];            // if non-empty, message must contain one
  blockKeywords: string[];            // skip if message contains any
}

export interface AiConfig {
  mode: Mode;                         // global default mode
  perSpace: Record<string, Mode>;     // spaceKey → mode override ('off'|'draft'|'auto')
  provider: ProviderConfig;
  persona: string;                    // system prompt: who you are / how you reply
  filter: AiFilter;
}

// A generated draft awaiting send (draft mode) or just-sent record (auto).
export interface AiDraft {
  spaceKey: string;
  threadKey?: string;
  text: string;
  replyToId: string;     // message we're replying to (dedupe)
  createdAt: number;
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  mode: 'off',
  perSpace: {},
  provider: { wire: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
  persona:
    '你是訊息主人本人，正在用 Google Chat 回覆訊息。以第一人稱、用對方使用的語言，' +
    '口吻自然簡潔、像真人快速回覆，不要過度客套、不要自稱 AI、不要加簽名。只輸出回覆內容本身。',
  filter: {
    onlyMentionsOrDm: true,
    spaceMode: 'all',
    whitelist: [],
    allowKeywords: [],
    blockKeywords: [],
  },
};
