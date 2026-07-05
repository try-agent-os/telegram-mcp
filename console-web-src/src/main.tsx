import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initTelegram } from './telegram';
import './index.css';

// Initialise the Telegram environment (theme/viewport/safe-area/fullscreen CSS
// vars, initData) BEFORE React paints so the first frame already has correct
// insets and theme. Failures (e.g. opened in a plain browser) are swallowed —
// App() degrades to the "open from Telegram" notice.
initTelegram();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
