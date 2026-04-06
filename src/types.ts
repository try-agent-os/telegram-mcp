export type MediaType = 'voice' | 'video_note' | 'photo' | 'document' | 'video' | 'sticker';

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
  chatId: number;
  text: string;
  username: string | null;
  displayName: string | null;
  messageId: number;
  replyToMessageId: number | null;
  mediaType: MediaType | null;
  filePath: string | null;
  fileName: string | null;
  isForward: boolean;
  forwardFrom: string | null;
  caption: string | null;
}

export interface AccessPolicy {
  allowlist: number[];
  pending: number[];
  denied: number[];
  default_policy: 'pending' | 'allow' | 'deny';
}

export interface ChatInfo {
  chat_id: number;
  username: string | null;
  display_name: string | null;
  last_message_at: string;
  message_count: number;
  access_status: 'allowed' | 'pending' | 'denied' | 'unknown';
}
