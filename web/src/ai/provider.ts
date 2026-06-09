import type { ProviderConfig } from './types';

export interface ReplyContext {
  spaceName: string;
  isDm: boolean;
  myName: string;
  // Recent thread/channel messages, oldest→newest, for context.
  history: { senderName: string; body: string; mine: boolean }[];
}

// Build a compact transcript the model replies to. We keep it provider-portable
// by sending the conversation as one user turn + the persona as the system
// prompt, and asking for ONLY the reply text back.
function buildPrompt(ctx: ReplyContext): string {
  const where = ctx.isDm ? `與 ${ctx.spaceName} 的私訊` : `頻道 #${ctx.spaceName}`;
  const lines = ctx.history.map((m) => `${m.mine ? `${ctx.myName}（我）` : m.senderName}：${m.body}`);
  return [
    `情境：${where}。以下是最近的對話（最後一則是需要你回覆的訊息）：`,
    '',
    lines.join('\n'),
    '',
    '請以「我」的身分寫出下一則回覆。只輸出回覆內容，不要加任何前綴或解釋。',
  ].join('\n');
}

async function callOpenAI(p: ProviderConfig, system: string, user: string): Promise<string> {
  const resp = await fetch(`${p.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${p.apiKey}` },
    body: JSON.stringify({
      model: p.model,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`AI ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return String(data?.choices?.[0]?.message?.content || '').trim();
}

async function callAnthropic(p: ProviderConfig, system: string, user: string): Promise<string> {
  const resp = await fetch(`${p.baseUrl.replace(/\/$/, '')}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': p.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: p.model,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!resp.ok) throw new Error(`AI ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('').trim();
}

// Generate a reply with the configured provider. Returns the reply text.
export async function generateReply(p: ProviderConfig, persona: string, ctx: ReplyContext): Promise<string> {
  if (!p.apiKey) throw new Error('尚未設定 API key');
  if (!p.model) throw new Error('尚未設定 model');
  const user = buildPrompt(ctx);
  const text = p.wire === 'anthropic' ? await callAnthropic(p, persona, user) : await callOpenAI(p, persona, user);
  if (!text) throw new Error('AI 沒有產生回覆');
  return text;
}
