import { LogOut, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api, type Quality, type RoomSummary } from '../../api';
import { getEngine } from '../../engine';
import { useT } from '../../i18n';
import { storageEstimate } from '../../offline/db';
import { useRoom, useUI } from '../../store/room';
import { useSettings } from '../../store/settings';
import { formatBytes, useDownloads } from '../hooks';

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={v === value}
          className={v === value ? 'is-active' : ''}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function SettingsView({ onLogout }: { onLogout: () => void }) {
  const t = useT();
  const s = useSettings();
  const welcome = useRoom((st) => st.welcome);
  const waitForAll = useRoom((st) => st.state.waitForAll);
  const online = useRoom((st) => st.status === 'online');
  const dl = useDownloads();
  const stats = dl.stats();
  const [name, setName] = useState(s.name);
  const [room, setRoom] = useState(s.room);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [quota, setQuota] = useState<{ usage: number; quota: number }>();
  const engine = getEngine();

  useEffect(() => {
    if (online)
      api
        .rooms()
        .then(setRooms)
        .catch(() => undefined);
    void storageEstimate().then(setQuota);
  }, [online, stats.bytes]);

  const saveProfile = () => {
    const patch: Partial<typeof s> = {};
    if (name.trim() && name.trim() !== s.name) patch.name = name.trim();
    if (room.trim() && room.trim() !== s.room) patch.room = room.trim();
    if (Object.keys(patch).length) s.update(patch);
  };

  return (
    <div className="settings">
      <section>
        <h2 className="section-title">{t('profile')}</h2>
        <Field label={t('yourName')}>
          <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} onBlur={saveProfile} />
        </Field>
        <Field label={t('room')}>
          <div className="row">
            <input value={room} maxLength={32} onChange={(e) => setRoom(e.target.value)} />
            <button type="button" className="btn" onClick={saveProfile} disabled={room.trim() === s.room}>
              {t('changeRoom')}
            </button>
          </div>
        </Field>
        {rooms.length > 0 && (
          <Field label={t('activeRooms')}>
            <div className="chips">
              {rooms.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`chip ${r.name.toLowerCase() === s.room.toLowerCase() ? 'is-active' : ''}`}
                  onClick={() => {
                    setRoom(r.name);
                    s.update({ room: r.name });
                  }}
                >
                  {r.name} {r.listeners.length > 0 && `· ${r.listeners.length}`}
                </button>
              ))}
            </div>
          </Field>
        )}
      </section>

      <section>
        <h2 className="section-title">{t('audio')}</h2>
        <Field label={t('quality')} hint={t('qualityHint')}>
          <Segmented<Quality>
            value={s.quality}
            onChange={(quality) => s.update({ quality })}
            options={[
              ['low', t('qualityLow')],
              ['medium', t('qualityMedium')],
              ['high', t('qualityHigh')],
              ['original', t('qualityOriginal')],
            ]}
          />
        </Field>
        <Field label={`${t('latency')}: ${s.latencyMs} ms`} hint={t('latencyHint')}>
          <input
            type="range"
            min={0}
            max={500}
            step={10}
            value={s.latencyMs}
            onChange={(e) => s.update({ latencyMs: Number(e.target.value) })}
          />
        </Field>
        <Field label={`${t('volume')}: ${Math.round(s.volume * 100)}%`}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={s.volume}
            onChange={(e) => s.update({ volume: Number(e.target.value) })}
          />
        </Field>
        <Field label={t('headsetControls')}>
          <Segmented
            value={s.headsetControls}
            onChange={(headsetControls) => s.update({ headsetControls })}
            options={[
              ['me', t('headsetMe')],
              ['room', t('headsetRoom')],
            ]}
          />
        </Field>
        <label className="toggle">
          <input
            type="checkbox"
            checked={waitForAll}
            disabled={!online}
            onChange={(e) => void engine.setWaitForAll(e.target.checked)}
          />
          <span>
            {t('waitForAll')}
            <small>{t('waitForAllHint')}</small>
          </span>
        </label>
      </section>

      <section>
        <h2 className="section-title">{t('offline')}</h2>
        <Field label={`${t('prefetch')}: ${t('tracksAhead', { n: s.prefetch })}`} hint={t('prefetchHint')}>
          <input
            type="range"
            min={0}
            max={10}
            step={1}
            value={s.prefetch}
            onChange={(e) => s.update({ prefetch: Number(e.target.value) })}
          />
        </Field>
        <Field label={`${t('cacheLimit')}: ${formatBytes(s.autoCacheMB * 1024 * 1024)}`}>
          <input
            type="range"
            min={100}
            max={4000}
            step={100}
            value={s.autoCacheMB}
            onChange={(e) => s.update({ autoCacheMB: Number(e.target.value) })}
          />
        </Field>
        <p className="muted">
          {t('storageUsed', { used: formatBytes(stats.bytes), pinned: formatBytes(stats.pinnedBytes) })}
          {quota && quota.quota > 0 && (
            <>
              <br />
              {t('storageQuota', { quota: formatBytes(Math.max(0, quota.quota - quota.usage)) })}
            </>
          )}
        </p>
        {dl.quotaExceeded && <p className="warn">{t('storageFull')}</p>}
        <div className="row">
          <button type="button" className="btn" onClick={() => dl.retry()}>
            <RefreshCw size={16} /> {t('retryDownloads')}
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={stats.tracks === 0}
            onClick={() => {
              if (confirm(t('confirmClear'))) void dl.clear();
            }}
          >
            <Trash2 size={16} /> {t('clearDownloads')}
          </button>
        </div>
      </section>

      <section>
        <h2 className="section-title">{t('library')}</h2>
        <button
          type="button"
          className="btn"
          disabled={!online}
          onClick={() => {
            void api.rescan().then(() => useUI.getState().toast(t('rescan') + ' ✓'));
          }}
        >
          <RefreshCw size={16} /> {t('rescan')}
        </button>
      </section>

      <section>
        <h2 className="section-title">{t('language')}</h2>
        <Segmented
          value={s.language}
          onChange={(language) => s.update({ language })}
          options={[
            ['auto', t('languageAuto')],
            ['pl', 'Polski'],
            ['en', 'English'],
          ]}
        />
      </section>

      <section>
        <h2 className="section-title">{t('about')}</h2>
        <p className="muted">{t('version', { v: welcome?.serverVersion ?? '?' })}</p>
        <button type="button" className="btn" onClick={onLogout}>
          <LogOut size={16} /> {t('logout')}
        </button>
      </section>
    </div>
  );
}
