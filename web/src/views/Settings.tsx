import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import type { Category } from '@dnevnik/shared';
import { useLiveCategories, useStore, useT } from '../store/index.ts';
import { api } from '../lib/api.ts';
import { haptic, useBackButton } from '../lib/telegram.ts';
import { IconPlus, IconTrash } from '../components/Icons.tsx';
import Reveal, { modalMotion } from '../components/Reveal.tsx';
import { uuid } from '../lib/util.ts';

const PALETTE = ['#C9A961', '#3D5A99', '#5E8C61', '#8C5E7A', '#B5654A', '#6C7A89', '#A89F91', '#7A3E48', '#4F8A8B', '#9C8A5A'];
const HOURS = Array.from({ length: 25 }, (_, i) => i);

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`switch${on ? ' on' : ''}`}
      onClick={() => {
        haptic.selection();
        onChange(!on);
      }}
    />
  );
}

export default function Settings() {
  const t = useT();
  const close = () => useStore.getState().setSettingsOpen(false);
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const syncStatus = useStore((s) => s.syncStatus);
  const sync = useStore((s) => s.sync);
  const showToast = useStore((s) => s.showToast);
  const categories = useLiveCategories();
  const saveCategory = useStore((s) => s.saveCategory);
  const deleteCategory = useStore((s) => s.deleteCategory);
  const [newCat, setNewCat] = useState('');
  const [newColor, setNewColor] = useState(PALETTE[4]);
  const [exporting, setExporting] = useState(false);

  useEffect(() => useBackButton(close), []);

  const addCategory = async () => {
    const name = newCat.trim();
    if (!name) return;
    haptic.success();
    await saveCategory({ id: uuid(), userId: 0, name, color: newColor, sortOrder: categories.length, updatedAt: Date.now(), deletedAt: null });
    setNewCat('');
  };

  const exportNotes = async () => {
    setExporting(true);
    try {
      await api.exportNotes();
      haptic.success();
      showToast(t.exportSent);
    } catch {
      haptic.error();
      showToast(t.syncError);
    } finally {
      setExporting(false);
    }
  };

  const syncLabel =
    syncStatus === 'ok' ? t.synced : syncStatus === 'error' ? t.syncError : syncStatus === 'expired' ? t.sessionExpired : syncStatus === 'syncing' ? '…' : t.syncPending;

  return (
    <motion.div className="modal" {...modalMotion}>
      <div className="modal-head">
        <span />
        <h2>{t.settings}</h2>
        <button className="text-btn" onClick={close}>
          OK
        </button>
      </div>
      <div className="modal-body">
        <Reveal i={2} className="section-title" style={{ padding: '0 0 10px' }}>
          {t.appearance}
        </Reveal>
        <Reveal i={3} className="card" style={{ marginBottom: 14 }}>
          <div className="field">
            <label>{t.font}</label>
            <div className="font-preview">
              {(['serif', 'sans'] as const).map((f) => (
                <button
                  key={f}
                  className={`fp ${f}${settings.font === f ? ' active' : ''}`}
                  onClick={() => {
                    haptic.selection();
                    void update({ font: f });
                  }}
                >
                  <div className="big">{t.fontSample}</div>
                  <div className="sm">{t.fontSampleSm}</div>
                  <div className="sm" style={{ marginTop: 8, color: settings.font === f ? 'var(--gold)' : 'var(--text-3)' }}>
                    {f === 'serif' ? t.fontSerif : t.fontSans}
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>{t.language}</label>
            <div className="segment">
              <button className={settings.lang === 'ru' ? 'active' : ''} onClick={() => void update({ lang: 'ru' })}>
                Русский
              </button>
              <button className={settings.lang === 'en' ? 'active' : ''} onClick={() => void update({ lang: 'en' })}>
                English
              </button>
            </div>
          </div>
        </Reveal>

        <Reveal i={4} className="section-title" style={{ padding: '0 0 10px' }}>
          {t.behavior}
        </Reveal>
        <Reveal i={5} className="card" style={{ marginBottom: 14, paddingTop: 0, paddingBottom: 0 }}>
          <div className="switch-row">
            <div>
              <div className="lbl">{t.carryover}</div>
              <div className="hint">{t.carryoverHint}</div>
            </div>
            <Switch on={settings.carryover} onChange={(v) => void update({ carryover: v })} />
          </div>
          <div className="switch-row">
            <div className="lbl">{t.haptics}</div>
            <Switch on={settings.haptics} onChange={(v) => void update({ haptics: v })} />
          </div>
          <div className="switch-row">
            <div className="lbl">{t.visibleHours}</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select className="input" style={{ width: 'auto', padding: '8px 10px' }} value={settings.visibleStart} onChange={(e) => void update({ visibleStart: Math.min(Number(e.target.value), settings.visibleEnd - 1) })}>
                {HOURS.slice(0, 24).map((h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, '0')}:00
                  </option>
                ))}
              </select>
              <span style={{ color: 'var(--text-3)' }}>–</span>
              <select className="input" style={{ width: 'auto', padding: '8px 10px' }} value={settings.visibleEnd} onChange={(e) => void update({ visibleEnd: Math.max(Number(e.target.value), settings.visibleStart + 1) })}>
                {HOURS.slice(1).map((h) => (
                  <option key={h} value={h}>
                    {h === 24 ? '24:00' : `${String(h).padStart(2, '0')}:00`}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </Reveal>

        <Reveal i={6} className="section-title" style={{ padding: '0 0 10px' }}>
          {t.notifications}
        </Reveal>
        <Reveal i={7} className="card" style={{ marginBottom: 14, paddingTop: 0, paddingBottom: 0 }}>
          <div className="switch-row">
            <div className="lbl">{t.morningDigest}</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="time" className="input" style={{ width: 'auto', padding: '8px 10px' }} value={settings.digestMorning} onChange={(e) => e.target.value && void update({ digestMorning: e.target.value })} />
              <Switch on={settings.digestEnabled} onChange={(v) => void update({ digestEnabled: v })} />
            </div>
          </div>
          <div className="switch-row">
            <div className="lbl">{t.eveningReport}</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="time" className="input" style={{ width: 'auto', padding: '8px 10px' }} value={settings.digestEvening} onChange={(e) => e.target.value && void update({ digestEvening: e.target.value })} />
              <Switch on={settings.reportEnabled} onChange={(v) => void update({ reportEnabled: v })} />
            </div>
          </div>
          <div className="switch-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
            <div className="lbl">{t.defaultReminders}</div>
            <div className="chip-row">
              {[0, 5, 10, 15, 30, 60].map((r) => (
                <button
                  key={r}
                  className={`chip${settings.defaultReminders.includes(r) ? ' active' : ''}`}
                  onClick={() => {
                    haptic.selection();
                    const cur = settings.defaultReminders;
                    void update({ defaultReminders: cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r].sort((a, b) => a - b) });
                  }}
                >
                  {r === 0 ? t.reminderAt : r === 60 ? t.hourBefore : t.minBefore(r)}
                </button>
              ))}
            </div>
          </div>
        </Reveal>

        <Reveal i={8} className="section-title" style={{ padding: '0 0 10px' }}>
          {t.categories}
        </Reveal>
        <Reveal i={9} className="card" style={{ marginBottom: 14 }}>
          {categories.map((c) => (
            <CategoryRow key={c.id} cat={c} onSave={(cat) => void saveCategory(cat)} onDelete={() => void deleteCategory(c.id)} />
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <input className="input" value={newCat} placeholder={t.newCategory} onChange={(e) => setNewCat(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void addCategory()} />
            <button className="icon-btn gold" onClick={() => void addCategory()}>
              <IconPlus />
            </button>
          </div>
          <div className="chip-row" style={{ marginTop: 10 }}>
            {PALETTE.map((col) => (
              <button key={col} className={`color-swatch${newColor === col ? ' active' : ''}`} style={{ background: col }} onClick={() => setNewColor(col)} />
            ))}
          </div>
        </Reveal>

        <Reveal i={10} className="section-title" style={{ padding: '0 0 10px' }}>
          {t.data}
        </Reveal>
        <Reveal i={11} className="card" style={{ display: 'grid', gap: 10 }}>
          <button className="btn ghost" disabled={exporting} onClick={() => void exportNotes()}>
            {t.exportNotes}
          </button>
          <button className="btn ghost" onClick={() => void sync()}>
            <span className={`sync-dot ${syncStatus}`} />
            {syncLabel}
          </button>
          <div style={{ fontSize: 12, color: 'var(--text-3)', textAlign: 'center' }}>
            {t.version} 0.1.0 · {settings.tz}
          </div>
        </Reveal>
      </div>
    </motion.div>
  );
}

function CategoryRow({ cat, onSave, onDelete }: { cat: Category; onSave: (c: Category) => void; onDelete: () => void }) {
  const [name, setName] = useState(cat.name);
  const [pick, setPick] = useState(false);
  useEffect(() => setName(cat.name), [cat.name]);
  return (
    <div style={{ borderBottom: '1px solid var(--line)', padding: '8px 0' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="color-swatch" style={{ background: cat.color, flex: 'none' }} onClick={() => setPick((p) => !p)} />
        <input
          className="input"
          style={{ background: 'transparent', border: 0, padding: '6px 0' }}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== cat.name && onSave({ ...cat, name: name.trim() })}
        />
        <button style={{ color: 'var(--text-3)' }} onClick={onDelete}>
          <IconTrash width={18} height={18} />
        </button>
      </div>
      {pick && (
        <div className="chip-row" style={{ marginTop: 8 }}>
          {PALETTE.map((col) => (
            <button
              key={col}
              className={`color-swatch${cat.color === col ? ' active' : ''}`}
              style={{ background: col }}
              onClick={() => {
                onSave({ ...cat, color: col });
                setPick(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
