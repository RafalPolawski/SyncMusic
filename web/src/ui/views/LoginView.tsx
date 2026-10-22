import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../../api';
import { useT } from '../../i18n';
import { useSettings } from '../../store/settings';

interface Props {
  needsPassword: boolean;
  onDone: () => void;
  /** Offered when the server is unreachable but a cached library exists. */
  onOffline?: (() => void) | undefined;
  unreachable?: boolean;
}

export function LoginView({ needsPassword, onDone, onOffline, unreachable }: Props) {
  const t = useT();
  const settings = useSettings();
  const [password, setPassword] = useState('');
  const [name, setName] = useState(settings.name);
  const [room, setRoom] = useState(settings.room);
  const [error, setError] = useState<string | undefined>(unreachable ? t('serverUnreachable') : undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (needsPassword) await api.login(password);
      settings.update({ name: name.trim(), room: room.trim() || 'main' });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError(t('wrongPassword'));
      else if (err instanceof ApiError && err.status === 429) setError(t('tooManyAttempts'));
      else setError(t('serverUnreachable'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <img src="/icon-192.png" alt="" className="login-logo" width={96} height={96} />
      <h1>{t('loginTitle')}</h1>
      <p className="muted">{t('loginSubtitle')}</p>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          <span>{t('yourName')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={32}
            autoComplete="nickname"
          />
        </label>
        <label>
          <span>{t('room')}</span>
          <input value={room} onChange={(e) => setRoom(e.target.value)} maxLength={32} />
        </label>
        {needsPassword && (
          <label>
            <span>{t('password')}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn primary wide" disabled={busy || !name.trim()}>
          {t('join')}
        </button>
        {onOffline && (
          <button type="button" className="btn wide" onClick={onOffline}>
            {t('continueOffline')}
          </button>
        )}
      </form>
    </div>
  );
}
