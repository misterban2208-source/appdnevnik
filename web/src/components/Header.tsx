import type { ReactNode } from 'react';
import { useStore } from '../store/index.ts';
import { IconSettings } from './Icons.tsx';
import Reveal from './Reveal.tsx';

interface Props {
  eyebrow?: string;
  title: string;
  sub?: string;
  right?: ReactNode;
}

export default function Header({ eyebrow, title, sub, right }: Props) {
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  return (
    <header className="header">
      <div>
        {eyebrow && (
          <Reveal i={0} className="eyebrow">
            {eyebrow}
          </Reveal>
        )}
        <Reveal i={1}>
          <h1>{title}</h1>
        </Reveal>
        {sub && (
          <Reveal i={2} className="sub">
            {sub}
          </Reveal>
        )}
      </div>
      <Reveal i={2} style={{ display: 'flex', gap: 8 }}>
        {right}
        <button className="icon-btn" onClick={() => setSettingsOpen(true)} aria-label="settings">
          <IconSettings />
        </button>
      </Reveal>
    </header>
  );
}
