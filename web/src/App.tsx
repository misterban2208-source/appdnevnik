import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { EASE } from './components/Reveal.tsx';
import { useStore } from './store/index.ts';
import DayView from './views/DayView.tsx';
import WeekView from './views/WeekView.tsx';
import MonthView from './views/MonthView.tsx';
import ListView from './views/ListView.tsx';
import StatsView from './views/StatsView.tsx';
import TaskEditor from './views/TaskEditor.tsx';
import Settings from './views/Settings.tsx';
import TabBar from './components/TabBar.tsx';
import QuickAdd from './components/QuickAdd.tsx';
import Toast from './components/Toast.tsx';
import { IconPlus } from './components/Icons.tsx';
import { haptic } from './lib/telegram.ts';

export default function App() {
  const ready = useStore((s) => s.ready);
  const view = useStore((s) => s.view);
  const editor = useStore((s) => s.editor);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const setQuickAdd = useStore((s) => s.setQuickAdd);

  useEffect(() => {
    void useStore.getState().init();
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void useStore.getState().runCarryover();
        void useStore.getState().sync();
      }
    };
    const onOnline = () => void useStore.getState().sync();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    const id = setInterval(() => {
      const s = useStore.getState();
      // Crossing midnight while the app stays open: carry over and move "today".
      if (new Date().toDateString() !== new Date(s.today + 'T00:00').toDateString()) void s.runCarryover();
      void s.sync();
    }, 60_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      clearInterval(id);
    };
  }, []);

  if (!ready) return <div className="app" />;

  return (
    <div className="app">
      <div className="app-body">
        {/* Keyed so every view remounts and plays its own top-down entrance. */}
        <motion.div key={view} className="view-root" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25, ease: EASE }}>
          {view === 'day' && <DayView />}
          {view === 'week' && <WeekView />}
          {view === 'month' && <MonthView />}
          {view === 'list' && <ListView />}
          {view === 'stats' && <StatsView />}
        </motion.div>
        {view !== 'stats' && (
          <button
            className="fab"
            onClick={() => {
              haptic.medium();
              setQuickAdd(true);
            }}
            aria-label="add"
          >
            <IconPlus width={24} height={24} />
          </button>
        )}
        <TabBar />
      </div>
      <QuickAdd />
      <Toast />
      <AnimatePresence>
        {editor && <TaskEditor key="editor" />}
        {settingsOpen && <Settings key="settings" />}
      </AnimatePresence>
    </div>
  );
}
