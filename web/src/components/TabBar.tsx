import { useStore, useT, type View } from '../store/index.ts';
import { IconDay, IconList, IconMonth, IconStats, IconWeek } from './Icons.tsx';

export default function TabBar() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const t = useT();
  const tabs: Array<{ id: View; label: string; Icon: typeof IconDay }> = [
    { id: 'day', label: t.day, Icon: IconDay },
    { id: 'week', label: t.week, Icon: IconWeek },
    { id: 'month', label: t.month, Icon: IconMonth },
    { id: 'list', label: t.list, Icon: IconList },
    { id: 'stats', label: t.stats, Icon: IconStats },
  ];
  return (
    <nav className="tabbar">
      {tabs.map(({ id, label, Icon }) => (
        <button key={id} className={`tab${view === id ? ' active' : ''}`} onClick={() => setView(id)}>
          <Icon />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
