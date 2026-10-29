import { Search } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { getEngine } from '../../engine';
import { useT } from '../../i18n';
import { searchTracks, useLibrary } from '../../store/library';
import { TrackRow } from '../components/TrackRow';

export function SearchView() {
  const t = useT();
  const index = useLibrary((s) => s.index);
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const results = useMemo(() => (index ? searchTracks(index, deferred) : []), [index, deferred]);
  return (
    <div className="search">
      <label className="search-box">
        <Search size={18} />
        <input
          type="search"
          value={query}
          placeholder={t('searchPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          enterKeyHint="search"
        />
      </label>
      {deferred && results.length === 0 && <div className="empty">{t('noResults')}</div>}
      <div className="track-list">
        {results.map((tr, i) => (
          <TrackRow
            key={tr.id}
            track={tr}
            showFolder
            onPlay={() =>
              void getEngine().playContext(
                { kind: 'search', id: deferred, name: `„${deferred}”`, tracks: results.map((r) => r.id) },
                i,
              )
            }
          />
        ))}
      </div>
    </div>
  );
}
