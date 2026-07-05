/// <reference types="vite/client" />

// Minimal typing for the legacy telegram-web-app.js global we fall back to.
interface TelegramWebApp {
  initData?: string;
  colorScheme?: 'light' | 'dark';
}
interface Window {
  Telegram?: { WebApp?: TelegramWebApp };
}
