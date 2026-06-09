import { Bot, Check, X, Pencil } from 'lucide-react';
import type { AiDraft } from '../ai/types';

interface Props {
  draft: AiDraft;
  busy?: boolean;
  onSend: () => void;
  onEdit: () => void;       // load into composer for editing
  onDismiss: () => void;
}

// Slack-style suggestion bar shown above the composer when an AI draft reply is
// pending (draft mode). Approve → send, edit → drop into the composer, or dismiss.
export default function AiDraftBar({ draft, busy, onSend, onEdit, onDismiss }: Props) {
  return (
    <div className="ai-draft-bar">
      <div className="ai-draft-head"><Bot size={13} /> AI 建議回覆</div>
      <div className="ai-draft-text">{draft.text}</div>
      <div className="ai-draft-actions">
        <button className="primary" disabled={busy} onClick={onSend}><Check size={14} /> 送出</button>
        <button onClick={onEdit}><Pencil size={14} /> 編輯</button>
        <button onClick={onDismiss}><X size={14} /> 捨棄</button>
      </div>
    </div>
  );
}
