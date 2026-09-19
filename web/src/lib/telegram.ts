import WebApp from '@twa-dev/sdk';

export const tg = WebApp;

export function isInTelegram(): boolean {
  return Boolean(tg.initData);
}

export function initTelegram(): void {
  try {
    tg.ready();
    tg.expand();
    tg.setHeaderColor('#0b0b0d');
    tg.setBackgroundColor('#0b0b0d');
    // Bot API 7.7+: keep vertical drags inside the app instead of closing it.
    const anyTg = tg as unknown as { disableVerticalSwipes?: () => void; isVerticalSwipesEnabled?: boolean };
    anyTg.disableVerticalSwipes?.();
  } catch {
    /* running outside Telegram */
  }
}

export function initData(): string {
  return tg.initData || '';
}

export function tgUser() {
  return tg.initDataUnsafe?.user ?? null;
}

let hapticsEnabled = true;
export function setHapticsEnabled(v: boolean) {
  hapticsEnabled = v;
}

export const haptic = {
  light() {
    if (hapticsEnabled) try { tg.HapticFeedback.impactOccurred('light'); } catch { /* noop */ }
  },
  medium() {
    if (hapticsEnabled) try { tg.HapticFeedback.impactOccurred('medium'); } catch { /* noop */ }
  },
  rigid() {
    if (hapticsEnabled) try { tg.HapticFeedback.impactOccurred('rigid'); } catch { /* noop */ }
  },
  selection() {
    if (hapticsEnabled) try { tg.HapticFeedback.selectionChanged(); } catch { /* noop */ }
  },
  success() {
    if (hapticsEnabled) try { tg.HapticFeedback.notificationOccurred('success'); } catch { /* noop */ }
  },
  warning() {
    if (hapticsEnabled) try { tg.HapticFeedback.notificationOccurred('warning'); } catch { /* noop */ }
  },
  error() {
    if (hapticsEnabled) try { tg.HapticFeedback.notificationOccurred('error'); } catch { /* noop */ }
  },
};

function backButtonSupported(): boolean {
  try {
    return isInTelegram() && tg.isVersionAtLeast('6.1');
  } catch {
    return false;
  }
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
