import { useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Card, Chip, Empty, RepeatButton, Segmented, SectionHeader } from '../../components/ui';
import { NowPlaying, Screen, useNow } from '../../components/Screen';
import { useBox } from '../../lib/session';
import { formatChannelNumber, formatCountdown, modeLabel } from '../../lib/pure';
import { color, shape, space, type as t } from '../../theme';

type Panel = 'channels' | 'keypad' | 'dpad';

function Row({ children }: { children: ReactNode }) {
  return <View style={s.row}>{children}</View>;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export default function RemoteScreen() {
  const { state, channels, press, tune, client, run, refreshChannels, showToast } = useBox();
  const now = useNow();
  const [panel, setPanel] = useState<Panel>('channels');
  const volume = typeof state?.volume === 'number' ? Math.round(state.volume * 100) : null;
  const ceiling = state?.volumeMax && state.volumeMax > 0 && state.volumeMax < 1 ? state.volumeMax : 1;
  const sleepMs = state?.sleepEndsAtMs && state.sleepEndsAtMs > now ? state.sleepEndsAtMs - now : 0;
  const quick = channels.filter((c) => c.quickAccess);
  const pc = state?.pcShutdown;
  const slots = state?.quickJumpSlots ?? {};

  return (
    <Screen title="REMOTE" onRefresh={refreshChannels}>
      {pc?.pending ? (
        <Card style={{ backgroundColor: color.errorContainer, borderColor: color.error }}>
          <Text style={[t.title, { color: color.onErrorContainer }]}>THE PC IS SHUTTING DOWN</Text>
          <Button label="CANCEL" tone="filled" onPress={() => run('Cancel', (c) => c.action('cancel-pc-shutdown'))} style={{ marginTop: space.md }} />
        </Card>
      ) : null}

      <NowPlaying />

      <Row>
        <Button style={s.flex} icon="power" label="POWER" tone="error" onPress={() => press('p')} />
        <Button style={s.flex} icon={state?.muted ? 'volume-off' : 'volume-high'} label="MUTE" sub={state?.muted ? 'MUTED' : undefined} tone={state?.muted ? 'filled' : 'tonal'} onPress={() => press('m')} />
        <Button style={s.flex} icon="television-guide" label="GUIDE" onPress={() => press('g')} />
        <Button style={s.flex} icon="information-outline" label="INFO" onPress={() => press('i')} />
      </Row>

      <Row>
        <Rocker label="CHANNEL" readout={state?.number != null ? `CH ${formatChannelNumber(state.number)}` : '—'} up={() => press('ArrowUp')} down={() => press('ArrowDown')} upLabel="CH +" downLabel="CH −" />
        <Rocker
          label="VOLUME"
          readout={state?.muted ? 'MUTED' : volume != null ? `${volume}%` : '—'}
          meter={state?.muted || volume == null ? 0 : Math.min(1, volume / (ceiling * 100))}
          up={() => press('+')}
          down={() => press('-')}
          upLabel="VOL +"
          downLabel="VOL −"
        />
      </Row>

      <Card>
        <Segmented<Panel>
          value={panel}
          onChange={setPanel}
          options={[
            { value: 'channels', label: 'CHANNELS', icon: 'television-classic' },
            { value: 'keypad', label: 'KEYPAD', icon: 'dialpad' },
            { value: 'dpad', label: 'D-PAD', icon: 'gamepad-round' },
          ]}
        />
        <View style={{ height: space.md }} />
        {panel === 'channels' ? (
          <View style={{ gap: space.md }}>
            <Row>
              <Button style={s.flex} icon="undo-variant" label="LAST" onPress={() => press('Backspace')} />
              <Button style={s.flex} icon="history" label="RECENT" onPress={() => press('Backspace', { shift: true })} />
              <Button style={s.flex} icon="star-plus" label="FAV +" onPress={() => press('ArrowUp', { shift: true })} />
              <Button style={s.flex} icon="star-minus" label="FAV −" onPress={() => press('ArrowDown', { shift: true })} />
            </Row>
            {state?.recent?.length ? (
              <View>
                <Text style={[t.label, { marginBottom: space.sm }]}>JUMP BACK</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
                  {state.recent.map((c) => <Chip key={c.number} icon="history" label={`${formatChannelNumber(c.number)} ${c.name ?? ''}`.trim().toUpperCase()} onPress={() => tune(c.number)} />)}
                </ScrollView>
              </View>
            ) : null}
            <Text style={t.label}>QUICK CHANNELS</Text>
            {quick.length ? chunk(quick, 3).map((group, i) => (
              <Row key={i}>
                {group.map((c) => (
                  <Button key={c.number} style={s.flex} label={formatChannelNumber(c.number)} sub={c.name.toUpperCase()} tone={state?.number === c.number ? 'filled' : 'tonal'} onPress={() => tune(c.number)} />
                ))}
                {Array.from({ length: 3 - group.length }).map((_, k) => <View key={`pad${k}`} style={s.flex} />)}
              </Row>
            )) : <Empty text="NO QUICK CHANNELS YET. MARK SOME IN LINEUP." />}
          </View>
        ) : null}

        {panel === 'keypad' ? (
          <View style={{ gap: space.sm }}>
            {[['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']].map((digits) => (
              <Row key={digits.join('')}>{digits.map((d) => <Button key={d} style={[s.flex, s.key]} label={d} onPress={() => press(d)} />)}</Row>
            ))}
            <Row>
              <Button style={[s.flex, s.key]} icon="undo-variant" label="LAST" onPress={() => press('Backspace')} />
              <Button style={[s.flex, s.key]} label="0" onPress={() => press('0')} />
              <Button style={[s.flex, s.key]} icon="keyboard-return" label="ENTER" tone="filled" onPress={() => press('Enter')} />
            </Row>
          </View>
        ) : null}

        {panel === 'dpad' ? (
          <View style={s.dpad}>
            <View style={s.dpadRow}><RepeatButton style={s.dpadKey} icon="chevron-up" accessibilityLabel="Up" onFire={() => press('ArrowUp')} /></View>
            <View style={s.dpadRow}>
              <RepeatButton style={s.dpadKey} icon="chevron-left" accessibilityLabel="Left" onFire={() => press('ArrowLeft')} />
              <Button style={s.dpadKey} label="OK" tone="filled" onPress={() => press('Enter')} />
              <RepeatButton style={s.dpadKey} icon="chevron-right" accessibilityLabel="Right" onFire={() => press('ArrowRight')} />
            </View>
            <View style={s.dpadRow}><RepeatButton style={s.dpadKey} icon="chevron-down" accessibilityLabel="Down" onFire={() => press('ArrowDown')} /></View>
            <Row>
              <Button style={s.flex} icon="arrow-left" label="BACK" onPress={() => press('Escape')} />
              <Button style={s.flex} icon="menu" label="TV MENU" onPress={() => press('?')} />
            </Row>
          </View>
        ) : null}
      </Card>

      <Card>
        <SectionHeader eyebrow="WHILE WATCHING" title="PICTURE & SOUND" />
        <View style={{ gap: space.sm }}>
          <Row>
            <Button style={s.flex} icon="closed-caption-outline" label="CAPTIONS" onPress={() => press('k')} />
            <Button style={s.flex} icon="image-filter-hdr" label="PICTURE" sub={modeLabel('pictureMode', state?.pictureMode)} onPress={() => press('v')} />
            <Button style={s.flex} icon="aspect-ratio" label="ASPECT" sub={modeLabel('aspectMode', state?.aspectMode)} onPress={() => press('a')} />
          </Row>
          <Row>
            <Button style={s.flex} icon="television-classic" label="CRT" sub={state?.crt == null ? undefined : state.crt ? 'ON' : 'OFF'} onPress={() => press('c')} />
            <Button style={s.flex} icon="surround-sound" label="AUDIO" sub={modeLabel('audioMode', state?.audioMode)} onPress={() => press('m', { shift: true })} />
            <Button style={s.flex} icon="moon-waning-crescent" label="SLEEP" sub={sleepMs ? formatCountdown(sleepMs) : 'OFF'} tone={sleepMs ? 'filled' : 'tonal'} onPress={() => press('z')} />
          </Row>
          <Row>
            <Button style={s.flex} icon="skip-next" label="SKIP BREAK" onPress={() => press('q')} />
            <Button style={s.flex} icon="television-play" label="WATCH TV" onPress={async () => { if (await run('Exit setup', (c) => c.action('watch-tv'))) showToast('Back to live TV'); }} />
          </Row>
        </View>
      </Card>

      <Card>
        <SectionHeader eyebrow="DVR-STYLE" title="TIME MACHINE" right={<Button compact label={state?.timeMachineOn ? 'EXIT' : 'ENTER'} tone={state?.timeMachineOn ? 'filled' : 'outlined'} onPress={() => press('t')} accessibilityLabel="Enter, play or exit the time machine" />} />
        <View style={{ gap: space.sm }}>
          <Row>
            <RepeatButton style={s.flex} icon="rewind" label="REWIND" onFire={() => press('ArrowLeft')} />
            <Button style={s.flex} icon="play" label="PLAY" tone="filled" onPress={() => press('Enter')} />
            <RepeatButton style={s.flex} icon="fast-forward" label="FORWARD" onFire={() => press('ArrowRight')} />
          </Row>
          <Row>
            <Button style={s.flex} icon="skip-previous" label="PREV" sub="BREAK" onPress={() => press('[')} />
            <Button style={s.flex} icon="record-circle-outline" label="LIVE" onPress={() => press('l')} />
            <Button style={s.flex} icon="skip-next" label="NEXT" sub="BREAK" onPress={() => press(']')} />
          </Row>
          <Row>
            <Button style={s.flex} icon="restart" label="START OVER" onPress={() => press('j')} />
          </Row>
          <Text style={t.label}>SAVED POINTS</Text>
          <Row>
            {['1', '2', '3', '4'].map((slot) => (
              <View key={slot} style={[s.flex, { gap: space.xs }]}>
                <Button compact label={`GO ${slot}`} tone={slots[slot] != null ? 'filled' : 'tonal'} disabled={slots[slot] == null} onPress={() => press(slot, { alt: true })} />
                <Button compact label="SAVE" tone="outlined" onPress={() => press(slot, { ctrl: true })} />
              </View>
            ))}
          </Row>
        </View>
      </Card>
    </Screen>
  );
}

// Two big buttons stacked like the rocker on a real remote.
function Rocker({ label, up, down, upLabel, downLabel, readout, meter }: { label: string; up(): void; down(): void; upLabel: string; downLabel: string; readout?: string; meter?: number }) {
  return (
    <View style={s.rocker}>
      <Text style={t.label}>{label}</Text>
      <RepeatButton icon="plus" label={upLabel} style={s.rockerKey} onFire={up} />
      {readout != null ? (
        <View style={s.readout}>
          <Text style={t.led}>{readout}</Text>
          {meter != null ? <View style={s.meter}><View style={[s.meterFill, { width: `${Math.round(meter * 100)}%` }]} /></View> : null}
        </View>
      ) : <View style={{ height: space.sm }} />}
      <RepeatButton icon="minus" label={downLabel} style={s.rockerKey} onFire={down} />
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.sm, marginBottom: space.md },
  flex: { flex: 1 },
  key: { minHeight: 56 },
  rocker: { flex: 1, backgroundColor: color.surfaceContainer, borderRadius: shape.xl, borderWidth: 1, borderColor: color.outlineVariant, padding: space.md, alignItems: 'stretch', gap: space.sm },
  rockerKey: { minHeight: 64, borderRadius: shape.lg },
  readout: { alignItems: 'center', gap: 6 },
  meter: { alignSelf: 'stretch', height: 6, borderRadius: shape.full, backgroundColor: color.surfaceDim, overflow: 'hidden' },
  meterFill: { height: 6, backgroundColor: color.primary },
  dpad: { alignItems: 'center', gap: space.sm },
  dpadRow: { flexDirection: 'row', gap: space.sm, justifyContent: 'center' },
  dpadKey: { width: 84, height: 84, borderRadius: shape.xl },
});
