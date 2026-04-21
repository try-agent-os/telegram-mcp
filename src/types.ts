export type MediaType = 'voice' | 'video_note' | 'photo' | 'document' | 'video' | 'sticker' | 'url';

export interface TelegramMessage {
  id: number;
  telegram_message_id: number;
  chat_id: number;
  user_id: number | null;
  username: string | null;
  display_name: string | null;
  text: string | null;
  direction: 'in' | 'out';
  reply_to_message_id: number | null;
  media_type: MediaType | null;
  file_path: string | null;
  file_name: string | null;
  created_at: string;
}

export interface IncomingMessageEvent {
  userId: number;
  chatId: number;
  text: string;
  username: string | null;
  displayName: string | null;
  messageId: number;
  replyToMessageId: number | null;
  quotedText: string | null;
  mediaType: MediaType | null;
  filePath: string | null;
  fileName: string | null;
  isForward: boolean;
  forwardFrom: string | null;
  caption: string | null;
}

export interface UserRecord {
  user_id: number;
  username: string | null;
  display_name: string | null;
  status: 'allowed' | 'pending' | 'denied';
  timezone: string;
  created_at: string;
  updated_at: string;
}

// Legacy — used only for migration from access.json
export interface AccessPolicy {
  allowlist: number[];
  pending: number[];
  denied: number[];
  default_policy: 'pending' | 'allow' | 'deny';
  timezones: Record<string, string>;
}

export interface ChatInfo {
  chat_id: number;
  username: string | null;
  display_name: string | null;
  last_message_at: string;
  message_count: number;
  access_status: 'allowed' | 'pending' | 'denied' | 'unknown';
}
