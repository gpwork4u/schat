export interface Message {
  messageId: string;
  spaceKey: string;
  threadKey?: string;
  senderId?: string;
  senderName?: string;
  avatar?: string;
  body: string;
  ts: string; // ISO
  temp?: boolean;
  reactions?: { emoji: string; count: number; mine?: boolean }[];
  images?: string[];   // resolved image URLs / data-URLs to render inline
  attachments?: ImageAttachment[]; // image attachments pending lazy resolution
  attachmentNote?: string; // non-image files, e.g. "report.pdf"
  mentions?: MessageMention[]; // @mention spans for highlighting
}

export interface MessageMention {
  text: string;     // exact substring in the body, e.g. "@Mu Yang"
  userId: string;
}

// A member candidate for @mention autocomplete.
export interface Member {
  userId: string;
  name: string;
  avatar?: string;
  email?: string;
}

// A resolved mention to send: char offsets into the outgoing body text.
export interface MentionSpec {
  userId: string;
  email?: string;
  start: number;
  len: number;
}

export interface ImageAttachment {
  token: string;        // blob token → resolve via resolve_attachment op
  filename: string;
  contentType: string;
  width?: number | null;
  height?: number | null;
}

export interface Space {
  spaceKey: string;
  name: string;
  type?: 'space' | 'dm';
  section?: string;       // custom Google Chat section name, if any
  sectionOrder?: number;  // section display order
  unread?: number;
}

export interface SectionInfo {
  order: number;
  name: string;
}

export interface SessionStatus {
  accountBase: string;
  myUserId?: string;
  hasXsrf: boolean;
  hasWorldTemplate: boolean;
  emojiCount: number;
}

export type BridgeState = 'connecting' | 'no-extension' | 'no-chat-tab' | 'ready';
