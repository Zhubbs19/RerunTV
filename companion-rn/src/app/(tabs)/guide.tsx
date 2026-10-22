import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ChannelRow, SearchBar } from '../../components/Channels';
import { Screen, useNow } from '../../components/Screen';
import { Button, Card, Chip, Empty, RepeatButton, SectionHeader } from '../../components/ui';
import { filterChannels } from '../../lib/pure';
import { useBox } from '../../lib/session';
import { space } from '../../theme';

type Filter = 'all' | 'favorites';

export default function GuideScreen() {
  const { channels, state, tune, press, refreshChannels } = useBox();
  const now = useNow(15000);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [showGrid, setShowGrid] = useState(false);
  const rows = useMemo(() => filterChannels(filter === 'favorites' ? channels.filter((c) => c.favorite) : channels, query), [channels, filter, query]);

  return (
    <Screen title="GUIDE" onRefresh={refreshChannels}>
      <SearchBar value={query} onChange={setQuery} placeholder="Search channels" />
      <View style={s.chips}>
        <Chip label="ALL" selected={filter === 'all'} onPress={() => setFilter('all')} />
        <Chip label="FAVORITES" icon="star" selected={filter === 'favorites'} onPress={() => setFilter('favorites')} />
        <View style={{ flex: 1 }} />
        <Chip label={showGrid ? 'HIDE TV GUIDE' : 'TV GUIDE'} icon="television-guide" selected={showGrid} onPress={() => setShowGrid((v) => !v)} />
      </View>

      {showGrid ? (
        <Card>
          <SectionHeader eyebrow="ON THE TV" title="NAVIGATE THE GRID" right={<Button compact label="OPEN / CLOSE" tone="filled" onPress={() => press('g')} />} />
          <View style={s.grid}>
            <View style={s.gridRow}><RepeatButton style={s.pad} icon="chevron-up" accessibilityLabel="Channel up" onFire={() => press('ArrowUp')} /></View>
            <View style={s.gridRow}>
              <RepeatButton style={s.pad} icon="chevron-left" accessibilityLabel="Earlier" onFire={() => press('ArrowLeft')} />
              <Button style={s.pad} label="TUNE" tone="filled" onPress={() => press('Enter')} />
              <RepeatButton style={s.pad} icon="chevron-right" accessibilityLabel="Later" onFire={() => press('ArrowRight')} />
            </View>
            <View style={s.gridRow}><RepeatButton style={s.pad} icon="chevron-down" accessibilityLabel="Channel down" onFire={() => press('ArrowDown')} /></View>
          </View>
          <View style={[s.gridRow, { marginTop: space.md }]}>
            <Button style={{ flex: 1 }} compact label="DETAILS" onPress={() => press('i')} />
            <Button style={{ flex: 1 }} compact label="DOCK" onPress={() => press('d')} />
            <Button style={{ flex: 1 }} compact label="CLOSE" onPress={() => press('Escape')} />
          </View>
        </Card>
      ) : null}

      {rows.length ? rows.map((row) => (
        <ChannelRow key={row.number} row={row} now={now} active={state?.number === row.number} onPress={() => tune(row.number)} />
      )) : <Empty text={channels.length ? 'NO CHANNELS MATCH' : 'LOADING LINEUP…'} />}
    </Screen>
  );
}

const s = StyleSheet.create({
  chips: { flexDirection: 'row', gap: space.sm, marginBottom: space.md, alignItems: 'center' },
  grid: { alignItems: 'center', gap: space.sm },
  gridRow: { flexDirection: 'row', gap: space.sm, justifyContent: 'center' },
  pad: { width: 84, height: 64 },
});
