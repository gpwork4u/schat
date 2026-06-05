import React from 'react';

// Render Google Chat / Slack-style markdown in message bodies as safe React
// nodes (no dangerouslySetInnerHTML). Supports:
//   *bold*  _italic_  ~strike~  `code`  ```block```  auto-linked URLs, and
//   highlighted @mentions (passed in as exact substrings).

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;!?)\]}'"])/g;

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Wrap any @mention substrings in a styled span; plain text otherwise.
function emitText(out: React.ReactNode[], text: string, keyBase: string, mentionRe: RegExp | null) {
  if (!mentionRe) { if (text) out.push(text); return; }
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  mentionRe.lastIndex = 0;
  while ((m = mentionRe.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<span key={`${keyBase}-m${i++}`} className="mention">{m[0]}</span>);
    last = m.index + m[0].length;
    if (m[0].length === 0) mentionRe.lastIndex++; // guard against zero-width
  }
  if (last < text.length) out.push(text.slice(last));
}

function linkify(text: string, keyBase: string, mentionRe: RegExp | null): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  let i = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > last) emitText(out, text.slice(last, m.index), `${keyBase}-t${i}`, mentionRe);
    const url = m[0];
    out.push(
      <a key={`${keyBase}-l${i++}`} href={url} target="_blank" rel="noopener noreferrer">{url}</a>
    );
    last = m.index + url.length;
  }
  if (last < text.length) emitText(out, text.slice(last), `${keyBase}-tz`, mentionRe);
  return out;
}

function renderInline(text: string, keyBase: string, mentionRe: RegExp | null): React.ReactNode[] {
  const tokens: React.ReactNode[] = [];
  const parts = text.split(/(`[^`]+`)/g);
  parts.forEach((part, pi) => {
    if (/^`[^`]+`$/.test(part)) {
      tokens.push(<code key={`${keyBase}-c${pi}`} className="md-code">{part.slice(1, -1)}</code>);
      return;
    }
    const sub = part.split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g);
    sub.forEach((s, si) => {
      const key = `${keyBase}-${pi}-${si}`;
      if (/^\*[^*\n]+\*$/.test(s)) tokens.push(<strong key={key}>{linkify(s.slice(1, -1), key, mentionRe)}</strong>);
      else if (/^_[^_\n]+_$/.test(s)) tokens.push(<em key={key}>{linkify(s.slice(1, -1), key, mentionRe)}</em>);
      else if (/^~[^~\n]+~$/.test(s)) tokens.push(<s key={key}>{linkify(s.slice(1, -1), key, mentionRe)}</s>);
      else if (s) tokens.push(<React.Fragment key={key}>{linkify(s, key, mentionRe)}</React.Fragment>);
    });
  });
  return tokens;
}

export function RichText({ text, mentions }: { text: string; mentions?: string[] }): React.ReactElement {
  // Build one alternation regex from the (longest-first) mention substrings so
  // overlapping names match the most specific one.
  const mentionRe = mentions && mentions.length
    ? new RegExp([...new Set(mentions)].sort((a, b) => b.length - a.length).map(escapeRe).join('|'), 'g')
    : null;
  const blocks = text.split(/(```[\s\S]*?```)/g);
  return (
    <>
      {blocks.map((block, bi) => {
        if (/^```[\s\S]*```$/.test(block)) {
          const inner = block.replace(/^```\n?/, '').replace(/\n?```$/, '');
          return <pre key={`b${bi}`} className="md-pre"><code>{inner}</code></pre>;
        }
        const lines = block.split('\n');
        return (
          <React.Fragment key={`b${bi}`}>
            {lines.map((line, li) => {
              const key = `b${bi}-${li}`;
              // bullet list: "- x" / "* x"   numbered: "1. x"
              const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
              const numbered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
              if (bullet) {
                return (
                  <div className="md-li" key={key} style={{ paddingLeft: bullet[1].length * 8 }}>
                    <span className="md-bullet">•</span>
                    <span>{renderInline(bullet[2], key, mentionRe)}</span>
                  </div>
                );
              }
              if (numbered) {
                return (
                  <div className="md-li" key={key} style={{ paddingLeft: numbered[1].length * 8 }}>
                    <span className="md-bullet">{numbered[2]}.</span>
                    <span>{renderInline(numbered[3], key, mentionRe)}</span>
                  </div>
                );
              }
              return (
                <React.Fragment key={key}>
                  {renderInline(line, key, mentionRe)}
                  {li < lines.length - 1 ? <br /> : null}
                </React.Fragment>
              );
            })}
          </React.Fragment>
        );
      })}
    </>
  );
}
