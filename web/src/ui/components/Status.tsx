import { Wifi, WifiOff, Loader2, Users } from 'lucide-react';
import { useT } from '../../i18n';
import { useRoom } from '../../store/room';
import { clientId } from '../../store/settings';

export function ConnectionBadge() {
  const t = useT();
  const status = useRoom((s) => s.status);
  const listeners = useRoom((s) => s.members.filter((m) => m.connected).length);
  const label =
    status === 'online'
      ? t('statusOnline')
      : status === 'offline'
        ? t('statusOffline')
        : t('statusConnecting');
  return (
    <span className={`badge badge-${status}`} title={label} aria-label={label}>
      {status === 'online' ? (
        <Wifi size={14} />
      ) : status === 'offline' ? (
        <WifiOff size={14} />
      ) : (
        <Loader2 size={14} className="spin" />
      )}
      {status === 'online' && (
        <>
          <Users size={14} />
          {listeners}
        </>
      )}
    </span>
  );
}

/** Short sync quality summary for the player screen. */
export function SyncLine() {
  const t = useT();
  const status = useRoom((s) => s.status);
  const drift = useRoom((s) => s.player.driftMs);
  const accuracy = useRoom((s) => s.clockAccuracyMs);
  const rtt = useRoom((s) => s.rttMs);
  const waiting = useRoom((s) => s.waiting);
  if (waiting.length > 0)
    return <div className="sync-line warn">{t('waitingFor', { names: waiting.join(', ') })}</div>;
  if (status === 'offline') return <div className="sync-line warn">{t('statusOffline')}</div>;
  if (status !== 'online') return <div className="sync-line">{t('statusConnecting')}</div>;
  const parts: string[] = [];
  if (drift !== undefined)
    parts.push(Math.abs(drift) < 25 ? t('inSync') : t('drift', { ms: Math.round(drift) }));
  if (accuracy !== undefined && rtt !== undefined) {
    parts.push(t('syncInfo', { acc: Math.round(accuracy), rtt: Math.round(rtt) }));
  }
  return <div className="sync-line">{parts.join(' · ')}</div>;
}

export function Listeners() {
  const t = useT();
  const members = useRoom((s) => s.members);
  const me = clientId();
  if (members.length === 0) return null;
  return (
    <section className="listeners" aria-label={t('listeners')}>
      <h3>{t('listeners')}</h3>
      <ul>
        {members.map((m) => {
          const state = !m.connected ? 'away' : m.buffering || !m.ready ? 'loading' : 'ok';
          return (
            <li key={m.clientId} className={`listener listener-${state}`}>
              <span className="avatar" aria-hidden>
                {m.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="listener-name">
                {m.name}
                {m.clientId === me && <em> ({t('you')})</em>}
              </span>
              <span className="listener-meta">
                {m.connected && m.driftMs !== undefined
                  ? `${m.driftMs > 0 ? '+' : ''}${Math.round(m.driftMs)} ms`
                  : ''}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
