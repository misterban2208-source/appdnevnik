import { useEffect, useState } from 'react';
import { useStore, useT } from '../store/index.ts';
import VoiceSection from './VoiceSection.tsx';

function AutoTextarea({ value, placeholder, onChange }: { value: string; placeholder: string; onChange: (v: string) => void }) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <textarea
      value={local}
      placeholder={placeholder}
      rows={2}
      onChange={(e) => {
        setLocal(e.target.value);
        e.target.style.height = 'auto';
        e.target.style.height = `${e.target.scrollHeight}px`;
      }}
      onBlur={() => {
        if (local !== value) onChange(local);
      }}
    />
  );
}

export default function DayNotes({ date }: { date: string }) {
  const t = useT();
  const note = useStore((s) => s.notes[date]);
  const setNote = useStore((s) => s.setNote);
  return (
    <>
      <div className="section-title">{t.notes}</div>
      <div className="notes">
        <div className="note">
          <div className="nt">{t.morningNote}</div>
          <AutoTextarea value={note?.morning ?? ''} placeholder={t.morningPlaceholder} onChange={(v) => void setNote(date, 'morning', v)} />
          <VoiceSection date={date} section="morning" />
        </div>
        <div className="note">
          <div className="nt">{t.eveningNote}</div>
          <AutoTextarea value={note?.evening ?? ''} placeholder={t.eveningPlaceholder} onChange={(v) => void setNote(date, 'evening', v)} />
          <VoiceSection date={date} section="evening" />
        </div>
      </div>
    </>
  );
}
