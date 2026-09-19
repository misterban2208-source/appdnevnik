import WebApp from '@twa-dev/sdk';

export const tg = WebApp;

const BG = '#0b0b0d';

export function isInTelegram(): boolean {
  return Boolean(tg.initData);
}

function versionAtLeast(v: string): boolean {
  try {
    return tg.isVersionAtLeast(v);
  } catch {
    return false;
  }
}

/** Every call is guarded on its own: one unsupported method must not cancel the rest. */
export function initTelegram(): void {
  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* running outside Telegram or old client */
    }
  };
  const anyTg = tg as unknown as {
    disableVerticalSwipes?: () => void;
    setBottomBarColor?: (c: string) => void;
    viewportStableHeight?: number;
    onEvent?: (ev: string, cb: () => void) => void;
  };
  safe(() => tg.ready());
  safe(() => tg.expand());
  // Hex colours are accepted from 6.9; older clients only take the named keys.
  safe(() => tg.setHeaderColor(versionAtLeast('6.9') ? BG : 'bg_color'));
  safe(() => tg.setBackgroundColor(BG));
  if (versionAtLeast('7.10')) safe(() => anyTg.setBottomBarColor?.(BG));
  // Bot API 7.7+: keep vertical drags inside the app instead of closing it.
  if (versionAtLeast('7.7')) safe(() => anyTg.disableVerticalSwipes?.());

  // Keep the layout inside the visible part of the WebView (collapsed sheet on iOS).
  const applyViewport = () => {
    const h = anyTg.viewportStableHeight;
    if (isInTelegram() && typeof h === 'number' && h > 0) document.documentElement.style.setProperty('--app-height', `${h}px`);
  };
  applyViewport();
  safe(() => anyTg.onEvent?.('viewportChanged', applyViewport));
}

export function initData(): string {
  return tg.initData || '';
}

export function tgUser() {
  return tg.initDataUnsafe?.user ?? null;
}

/** 'ios' | 'android' | 'android_x' | 'macos' | 'tdesktop' | 'weba' | 'web' | 'unknown' (also 'unknown' in a plain browser tab). */
export function platform(): string {
  try {
    return (tg as { platform?: string }).platform || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Asks Telegram to confirm before closing the app (6.2+); silently ignored elsewhere. */
export function enableClosingConfirmation(): void {
  if (!isInTelegram() || !versionAtLeast('6.2')) return;
  try { tg.enableClosingConfirmation(); } catch { /* noop */ }
}

export function disableClosingConfirmation(): void {
  if (!isInTelegram() || !versionAtLeast('6.2')) return;
  try { tg.disableClosingConfirmation(); } catch { /* noop */ }
}

/** Resolves true when the bot may write to the user (or when the question cannot be asked at all). */
export function requestWriteAccess(): Promise<boolean> {
  if (!isInTelegram() || !versionAtLeast('6.9')) return Promise.resolve(true);
  return new Promise((resolve) => {
    try {
      tg.requestWriteAccess((granted) => resolve(Boolean(granted)));
    } catch {
      resolve(true);
    }
  });
}

let hapticsEnabled = true;
export function setHapticsEnabled(v: boolean) {
  hapticsEnabled = v;
}

const hapticsSupported = () => hapticsEnabled && versionAtLeast('6.1');

export const haptic = {
  light() {
    if (hapticsSupported()) try { tg.HapticFeedback.impactOccurred('light'); } catch { /* noop */ }
  },
  medium() {
    if (hapticsSupported()) try { tg.HapticFeedback.impactOccurred('medium'); } catch { /* noop */ }
  },
  rigid() {
    if (hapticsSupported()) try { tg.HapticFeedback.impactOccurred('rigid'); } catch { /* noop */ }
  },
  selection() {
    if (hapticsSupported()) try { tg.HapticFeedback.selectionChanged(); } catch { /* noop */ }
  },
  success() {
    if (hapticsSupported()) try { tg.HapticFeedback.notificationOccurred('success'); } catch { /* noop */ }
  },
  warning() {
    if (hapticsSupported()) try { tg.HapticFeedback.notificationOccurred('warning'); } catch { /* noop */ }
  },
  error() {
    if (hapticsSupported()) try { tg.HapticFeedback.notificationOccurred('error'); } catch { /* noop */ }
  },
};

function backButtonSupported(): boolean {
  return isInTelegram() && versionAtLeast('6.1');
}

/** Show/hide Telegram's native back button; returns a cleanup function. */
export function useBackButton(onBack: (() => void) | null): () => void {
  if (!backButtonSupported()) return () => {};
  try {
    if (onBack) {
      tg.BackButton.show();
      tg.BackButton.onClick(onBack);
      return () => {
        try {
          tg.BackButton.offClick(onBack);
          tg.BackButton.hide();
        } catch { /* noop */ }
      };
    }
    tg.BackButton.hide();
  } catch { /* noop */ }
  return () => {};
}
