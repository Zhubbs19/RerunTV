import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ChannelRow, IconToggle, SearchBar } from '../../components/Channels';
import { Screen, useNow } from '../../components/Screen';
import { Chip, Empty } from '../../components/ui';
import { filterChannels } from '../../lib/pure';
import { useBox } from '../../lib/session';
import { color, space, type as t } from '../../theme';

type Filter = 'all' | 'favorites' | 'quick';

export default function LineupScreen() {
  const { channels, state, tune, run, refreshChannels } = useBox();
  const now = useNow(15000);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const rows = useMemo(() => {
    const base = filter === 'favorites' ? channels.filter((c) => c.favorite) : filter === 'quick' ? channels.filter((c) => c.quickAccess) : channels;
    return filterChannels(base, query);
  }, [channels, filter, query]);

  async function flag(number: number, field: 'favorite' | 'quickAccess', value: boolean) {
    if (await run('Update channel', (c) => c.setFlag(number, field, value))) await refreshChannels();
  }

  return (
    <Screen title="LINEUP" onRefresh={refreshChannels}>
      <SearchBar value={query} onChange={setQuery} placeholder="Number or name" />
      <View style={s.chips}>
        <Chip label="ALL" selected={filter === 'all'} onPress={() => setFilter('all')} />
        <Chip label="FAVORITES" icon="star" selected={filter === 'favorites'} onPress={() => setFilter('favorites')} />
        <Chip label="QUICK" icon="flash" selected={filter === 'quick'} onPress={() => setFilter('quick')} />
      </View>
      <Text style={[t.body, { color: color.onSurfaceVariant, marginBottom: space.md }]}>
        Tap a channel to tune it. The star adds it to favorites; the bolt puts it on the Remote tab’s quick channels.
      </Text>
      {rows.length ? rows.map((row) => (
        <ChannelRow
          key={row.number}
          row={row}
          now={now}
          active={state?.number === row.number}
          onPress={() => tune(row.number)}
          trailing={(
            <View style={{ flexDirection: 'row' }}>
              <IconToggle icon="star-outline" onIcon="star" on={row.favorite} label={`Favorite channel ${row.number}`} onPress={() => flag(row.number, 'favorite', !row.favorite)} />
              <IconToggle icon="flash-outline" onIcon="flash" on={row.quickAccess} label={`Quick channel ${row.number}`} onPress={() => flag(row.number, 'quickAccess', !row.quickAccess)} />
            </View>
          )}
        />
      )) : <Empty text={channels.length ? 'NO CHANNELS MATCH' : 'LOADING LINEUP…'} />}
    </Screen>
  );
}

const s = StyleSheet.create({ chips: { flexDirection: 'row', gap: space.sm, marginBottom: space.md } });
