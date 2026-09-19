import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore, useT } from '../store/index.ts';
import { haptic } from '../lib/telegram.ts';

const DURATION = 3000;

export default function Toast() {
  const toast = useStore((s) => s.toast);
  const dismiss = useStore((s) => s.dismissToast);
  const t = useT();

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(dismiss, DURATION);
    return () => clearTimeout(id);
  }, [toast?.id]);

  return (
    <AnimatePresence>
      {toast && (
        <motion.div
          key={toast.id}
          className="toast"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        >
          <span>{toast.message}</span>
          {toast.undo && (
            <button
              className="text-btn"
              onClick={() => {
                haptic.light();
                toast.undo?.();
                dismiss();
              }}
            >
              {t.undo}
            </button>
          )}
          <motion.div className="bar" initial={{ width: '100%' }} animate={{ width: 0 }} transition={{ duration: DURATION / 1000, ease: 'linear' }} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
