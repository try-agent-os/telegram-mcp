// Telegram Mini App platform bindings via @telegram-apps/sdk.
//
// This is the whole point of the kit migration: the SDK owns safe-area insets,
// fullscreen, theme and initData so we no longer hand-roll any of it.
//
//   • themeParams.bindCssVars()  → --tg-theme-* CSS vars (light/dark, live).
//   • viewport.bindCssVars()     → --tg-viewport-* incl. safe-area + content
//                                  safe-area insets, kept in sync on every
//                                  safeAreaChanged / contentSafeAreaChanged /
//                                  fullscreenChanged event by the SDK itself.
//   • viewport.requestFullscreen() → edge-to-edge immersive mode (Bot API 8.0+),
//                                  feature-detected via isSupported().
//
// initData is read from the launch params and exposed as the raw string the
// backend expects in `Authorization: tma <raw>`.
import {
  init,
  retrieveLaunchParams,
  retrieveRawInitData,
  themeParams,
  viewport,
} from '@telegram-apps/sdk';

let rawInitData = '';

/** Initialise the SDK and bind all CSS vars. Idempotent-ish; safe to call once. */
export function initTelegram(): void {
  try {
    init();
  } catch {
    // Not inside a Telegram environment (plain browser) — nothing to bind.
    return;
  }

  // Raw initData for the Authorization header. retrieveRawInitData returns the
  // exact query string Telegram signed; falls back to the legacy global.
  try {
    rawInitData = retrieveRawInitData() ?? '';
  } catch {
    rawInitData = '';
  }
  if (!rawInitData) {
    const legacy = window.Telegram?.WebApp?.initData;
    if (legacy) rawInitData = legacy;
  }

  // Theme → CSS vars (--tg-theme-bg-color, --tg-theme-text-color, …). Live.
  try {
    if (themeParams.mountSync.isAvailable()) themeParams.mountSync();
    if (themeParams.bindCssVars.isAvailable()) themeParams.bindCssVars();
  } catch {
    /* theme stays on the CSS fallback */
  }

  // Viewport → safe-area / content-safe-area / height CSS vars, then fullscreen.
  void (async () => {
    try {
      if (viewport.mount.isAvailable()) await viewport.mount();
      // Exposes, among others:
      //   --tg-viewport-safe-area-inset-{top,bottom,left,right}
      //   --tg-viewport-content-safe-area-inset-{top,bottom,left,right}
      if (viewport.bindCssVars.isAvailable()) viewport.bindCssVars();
      // Immersive fullscreen like BotFather Mini Apps. Feature-detected so older
      // clients (and desktop) don't throw; the safe-area vars above keep the
      // header clear of Telegram's own Close/⋯ controls once fullscreen.
      if (viewport.requestFullscreen.isAvailable() && !viewport.isFullscreen()) {
        await viewport.requestFullscreen();
      }
    } catch {
      /* viewport features unavailable on this client — CSS fallbacks apply */
    }
  })();
}

export function getRawInitData(): string {
  return rawInitData;
}

/** Launch-platform string ('ios' | 'android' | 'tdesktop' | …) for tgui's AppRoot. */
export function getPlatform(): string {
  try {
    return String(retrieveLaunchParams().tgWebAppPlatform ?? 'base');
  } catch {
    return 'base';
  }
}

/** Current color scheme for tgui's AppRoot appearance prop. */
export function getAppearance(): 'light' | 'dark' {
  try {
    if (themeParams.isDark?.()) return 'dark';
  } catch {
    /* fall through */
  }
  const scheme = window.Telegram?.WebApp?.colorScheme;
  return scheme === 'dark' ? 'dark' : 'light';
}
