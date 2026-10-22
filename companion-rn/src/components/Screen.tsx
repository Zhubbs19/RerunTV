import { useEffect, useState, type ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBox } from '../lib/session';
import { formatChannelNumber, formatCountdown, minutesLeft, modeLabel } from '../lib/pure';
import { color, shape, space, type as t } from '../theme';
import { Button, Card, Led } from './ui';

// Re-renders about once a second so countdowns tick between polls.
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function Screen({ title, children, onRefresh, scroll = true }: { title: string; children: ReactNode; onRefresh?: () => Promise<void>; scroll?: boolean }) {
  const insets = useSafeAreaInsets();
  const { connection } = useBox();
  const [refreshing, setRefreshing] = useState(false);
  const header = (
    <View style={s.header}>
      <View style={{ flex: 1 }}>
        <Text style={t.eyebrow}>RERUNTV // HEADEND CONTROL</Text>
        <Text style={t.headline}>{title}</Text>
      </View>
      <View style={s.status}>
        <Led state={connection} />
        <Text style={t.label}>{connection === 'online' ? 'ONLINE' : connection === 'offline' ? 'NO SIGNAL' : 'CONNECTING'}</Text>
      </View>
    </View>
  );
  if (!scroll) return <View style={{ flex: 1, paddingTop: insets.top + space.sm, paddingHorizontal: space.lg }}>{header}{children}</View>;
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingTop: insets.top + space.sm, paddingHorizontal: space.lg, paddingBottom: space.xxl }}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? (
        <RefreshControl
          refreshing={refreshing}
          tintColor={color.primary}
          colors={[color.primary]}
          progressBackgroundColor={color.surfaceContainerHigh}
          onRefresh={async () => {
            setRefreshing(true);
            try { await onRefresh(); } finally { setRefreshing(false); }
          }}
        />
      ) : undefined}
    >
      {header}
      {children}
    </ScrollView>
  );
}

// The big "now playing" readout at the top of the Remote tab: LED-style
// channel number, name, what is on, how long is left, and what is next.
export function NowPlaying() {
  const { state, connection, press } = useBox();
  const now = useNow();
  if (!state || state.number == null) {
    return (
      <Card tone="high">
        <Text style={t.eyebrow}>NOW WATCHING</Text>
        <Text style={[t.headline, { marginTop: space.xs }]}>{connection === 'offline' ? 'NO SIGNAL' : state?.powered === false ? 'POWERED OFF' : 'CONNECTING…'}</Text>
        {connection === 'offline' ? <Text style={[t.body, { color: color.onSurfaceVariant, marginTop: space.sm }]}>Cannot reach the box. Check that it is on and on the same Wi‑Fi.</Text> : null}
      </Card>
    );
  }
  const inBreak = state.onAir === 'break';
  const left = inBreak ? null : minutesLeft(state.nowEndsAtMs, now);
  const sleepMs = state.sleepEndsAtMs && state.sleepEndsAtMs > now ? state.sleepEndsAtMs - now : 0;
  return (
    <Card tone="high" style={{ paddingVertical: space.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
        <View style={s.numberPlate}>
          <Text style={t.display} accessibilityLabel={`Channel ${state.number}`}>{formatChannelNumber(state.number)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={t.eyebrow}>{state.powered === false ? 'POWERED OFF' : inBreak ? 'COMMERCIAL BREAK' : 'NOW WATCHING'}</Text>
          <Text style={t.title} numberOfLines={1}>{(state.name || `CHANNEL ${state.number}`).toUpperCase()}</Text>
          <NowTitle />
        </View>
      </View>
      <View style={s.metaRow}>
        {left != null ? <Text style={t.led}>{left} MIN LEFT</Text> : null}
        {state.timeMachineOn ? <Text style={t.led}>TIME MACHINE{state.timeOffsetMin ? ` ${state.timeOffsetMin < 0 ? '−' : '+'}${Math.abs(state.timeOffsetMin)}M` : ''}</Text> : null}
        {sleepMs > 0 ? <Text style={[t.led, { color: color.tertiary }]}>SLEEP {formatCountdown(sleepMs)}</Text> : null}
        {state.audioMode && state.audioMode !== 'stereo' ? <Text style={t.led}>{modeLabel('audioMode', state.audioMode)}</Text> : null}
      </View>
      {state.nextTitle && !inBreak ? <Text style={[t.label, { marginTop: space.sm }]} numberOfLines={1}>NEXT: {state.nextTitle.toUpperCase()}</Text> : null}
      {inBreak ? <Button icon="skip-next" label="SKIP BREAK" tone="filled" onPress={() => press('q')} style={{ marginTop: space.md }} /> : null}
    </Card>
  );
}

function NowTitle() {
  const { state, channels } = useBox();
  const row = channels.find((c) => c.number === state?.number);
  const text = state?.onAir === 'break' ? '' : row?.now ?? '';
  return text ? <Text style={[t.body, { color: color.onSurfaceVariant, marginTop: 2 }]} numberOfLines={2}>{text.toUpperCase()}</Text> : null;
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: space.lg, gap: space.md },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: color.surfaceContainer, borderRadius: shape.full, paddingHorizontal: space.md, minHeight: 32 },
  numberPlate: { minWidth: 84, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surfaceDim, borderRadius: shape.md, borderWidth: 1, borderColor: color.outlineVariant, paddingVertical: space.sm, paddingHorizontal: space.md },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg, marginTop: space.md },
});
