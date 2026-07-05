// Unit tests for the group / supergroup engagement policy.
//
// Run with:
//   npm test
//
// Uses Node's built-in `node:test` runner (no extra dependency).

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  isMentionedInText,
  isReplyToBot,
  isSlashCommand,
  shouldNotifyAgent,
  type BotIdentity,
  type PolicyMessage,
} from '../src/group-policy.js';

const BOT: BotIdentity = { id: 777, username: 'novostudio_agent_bot' };

// Helper: build a PolicyMessage with sensible defaults.
function msg(over: Partial<PolicyMessage> = {}): PolicyMessage {
  return {
    text: '',
    entities: [],
    replyToUserId: null,
    ...over,
  };
}

// Helper: build a `mention` entity that points at `@username` inside `text`.
// The offset is computed from the first occurrence.
function mentionEntity(text: string, handle: string) {
  const offset = text.indexOf(handle);
  if (offset < 0) throw new Error(`handle ${handle} not in text`);
  return { type: 'mention', offset, length: handle.length };
}

describe('isMentionedInText', () => {
  it('detects an @-mention of the bot at start of message', () => {
    const text = '@novostudio_agent_bot привет';
    assert.equal(
      isMentionedInText(
        msg({ text, entities: [mentionEntity(text, '@novostudio_agent_bot')] }),
        BOT,
      ),
      true,
    );
  });

  it('detects an @-mention of the bot in the middle of message', () => {
    const text = 'эй @novostudio_agent_bot, что думаешь?';
    assert.equal(
      isMentionedInText(
        msg({ text, entities: [mentionEntity(text, '@novostudio_agent_bot')] }),
        BOT,
      ),
      true,
    );
  });

  it('is case-insensitive on username', () => {
    const text = 'hey @Novostudio_Agent_Bot';
    assert.equal(
      isMentionedInText(
        msg({ text, entities: [mentionEntity(text, '@Novostudio_Agent_Bot')] }),
        BOT,
      ),
      true,
    );
  });

  it('ignores mentions of OTHER bots', () => {
    const text = 'привет @axionagentbot';
    assert.equal(
      isMentionedInText(
        msg({ text, entities: [mentionEntity(text, '@axionagentbot')] }),
        BOT,
      ),
      false,
    );
  });

  it('detects a text_mention (clicked-from-list) by embedded user id', () => {
    assert.equal(
      isMentionedInText(
        msg({
          text: 'Novo Studio Agent привет',
          entities: [{ type: 'text_mention', offset: 0, length: 17, user: { id: BOT.id } }],
        }),
        BOT,
      ),
      true,
    );
  });

  it('ignores text_mention pointing at a different user', () => {
    assert.equal(
      isMentionedInText(
        msg({
          text: 'Robert привет',
          entities: [{ type: 'text_mention', offset: 0, length: 6, user: { id: 999 } }],
        }),
        BOT,
      ),
      false,
    );
  });

  it('returns false for a message with no entities', () => {
    assert.equal(
      isMentionedInText(msg({ text: 'обычное сообщение без mention' }), BOT),
      false,
    );
  });

  it('does not false-positive on the bot username as plain substring without a mention entity', () => {
    // Telegram is responsible for emitting the entity; if the entity is
    // missing (e.g. the user typed it inside a code block), we treat it as
    // unaddressed. This guards against spammy false-positives.
    assert.equal(
      isMentionedInText(
        msg({ text: 'novostudio_agent_bot is great', entities: [] }),
        BOT,
      ),
      false,
    );
  });
});

describe('isReplyToBot', () => {
  it('returns true when the replied-to message author is the bot', () => {
    assert.equal(isReplyToBot(msg({ replyToUserId: BOT.id }), BOT), true);
  });

  it('returns false when replying to a human', () => {
    assert.equal(isReplyToBot(msg({ replyToUserId: 12345 }), BOT), false);
  });

  it('returns false when not a reply', () => {
    assert.equal(isReplyToBot(msg({ replyToUserId: null }), BOT), false);
  });
});

describe('isSlashCommand', () => {
  it('detects a bot_command entity at offset 0', () => {
    assert.equal(
      isSlashCommand(
        msg({ text: '/status', entities: [{ type: 'bot_command', offset: 0, length: 7 }] }),
      ),
      true,
    );
  });

  it('detects a slash prefix even without an entity', () => {
    assert.equal(isSlashCommand(msg({ text: '/status' })), true);
  });

  it('detects /cmd@botname form', () => {
    assert.equal(
      isSlashCommand(
        msg({
          text: '/status@novostudio_agent_bot',
          entities: [{ type: 'bot_command', offset: 0, length: 28 }],
        }),
      ),
      true,
    );
  });

  it('returns false for non-slash messages', () => {
    assert.equal(isSlashCommand(msg({ text: 'hello world' })), false);
  });

  it('returns false for slash NOT at offset 0', () => {
    assert.equal(
      isSlashCommand(
        msg({ text: 'do this: /status', entities: [{ type: 'bot_command', offset: 9, length: 7 }] }),
      ),
      false,
    );
  });
});

describe('shouldNotifyAgent', () => {
  it('always notifies in private chats, regardless of mention', () => {
    assert.equal(
      shouldNotifyAgent('private', msg({ text: 'привет' }), BOT),
      true,
    );
  });

  it('never notifies in channels (broadcast posts)', () => {
    const text = '@novostudio_agent_bot';
    assert.equal(
      shouldNotifyAgent(
        'channel',
        msg({ text, entities: [mentionEntity(text, '@novostudio_agent_bot')] }),
        BOT,
      ),
      false,
    );
  });

  it('does NOT notify on unaddressed group messages', () => {
    assert.equal(
      shouldNotifyAgent('group', msg({ text: 'обычное сообщение без mention' }), BOT),
      false,
    );
  });

  it('notifies in group when the bot is @-mentioned', () => {
    const text = '@novostudio_agent_bot привет';
    assert.equal(
      shouldNotifyAgent(
        'group',
        msg({ text, entities: [mentionEntity(text, '@novostudio_agent_bot')] }),
        BOT,
      ),
      true,
    );
  });

  it('notifies in supergroup when replying to a bot message', () => {
    assert.equal(
      shouldNotifyAgent('supergroup', msg({ text: 'спасибо', replyToUserId: BOT.id }), BOT),
      true,
    );
  });

  it('notifies in supergroup on a slash command', () => {
    assert.equal(
      shouldNotifyAgent(
        'supergroup',
        msg({ text: '/status', entities: [{ type: 'bot_command', offset: 0, length: 7 }] }),
        BOT,
      ),
      true,
    );
  });

  it('notifies in a group when chatId is in the alwaysEngage override set', () => {
    const ENGAGED = -1000000001;
    const overrides = new Set<number>([ENGAGED]);
    // Unaddressed message in an "always engage" group → notify.
    assert.equal(
      shouldNotifyAgent(
        'group',
        msg({ text: 'обычное сообщение без mention' }),
        BOT,
        { chatId: ENGAGED, alwaysEngage: overrides },
      ),
      true,
    );
    // Same message in a DIFFERENT (non-overridden) group → still no notify.
    assert.equal(
      shouldNotifyAgent(
        'group',
        msg({ text: 'обычное сообщение без mention' }),
        BOT,
        { chatId: -1, alwaysEngage: overrides },
      ),
      false,
    );
  });

  it('still does NOT notify in channels even if their chatId is in alwaysEngage', () => {
    // Channels are broadcast surfaces — the override does not promote them.
    const ENGAGED = -1001234567890;
    assert.equal(
      shouldNotifyAgent(
        'channel',
        msg({ text: 'anything' }),
        BOT,
        { chatId: ENGAGED, alwaysEngage: new Set([ENGAGED]) },
      ),
      false,
    );
  });

  it('matches the test-plan group "Novo Studio" scenarios', () => {
    // 1. The owner sends `@novostudio_agent_bot привет` → notify
    const t1 = '@novostudio_agent_bot привет';
    assert.equal(
      shouldNotifyAgent('group', msg({ text: t1, entities: [mentionEntity(t1, '@novostudio_agent_bot')] }), BOT),
      true,
    );
    // 2. "обычное сообщение без mention" → no notify
    assert.equal(
      shouldNotifyAgent('group', msg({ text: 'обычное сообщение без mention' }), BOT),
      false,
    );
    // 3. Reply to a prior bot message → notify
    assert.equal(
      shouldNotifyAgent('group', msg({ text: 'ок', replyToUserId: BOT.id }), BOT),
      true,
    );
    // 4. Slash command /status → notify
    assert.equal(
      shouldNotifyAgent('group', msg({ text: '/status' }), BOT),
      true,
    );
  });
});
