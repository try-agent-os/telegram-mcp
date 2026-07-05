// Side-effect module: set the env the console modules read at import time.
// Imported FIRST (before the modules under test) so their module-load env reads
// see these values. Kept out of *.test.ts so the test runner doesn't run it.
export const BOT_TOKEN = 'test-bot-token-0123456789';
export const OWNER_ID = 1000001;

process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.CONSOLE_OWNER_ID = String(OWNER_ID);
process.env.CONSOLE_INITDATA_MAX_AGE = '3600';
process.env.CONSOLE_KOMODO_TICKET_TTL = '60';
