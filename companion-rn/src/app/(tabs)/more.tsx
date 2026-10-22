import { useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';
import { Screen } from '../../components/Screen';
import { Button, Card, SectionHeader } from '../../components/ui';
import { useBox } from '../../lib/session';
import { color, shape, space, type as t } from '../../theme';

function confirm(title: string, message: string, ok: string, run: () => void) {
  Alert.alert(title, message, [{ text: 'Cancel', style: 'cancel' }, { text: ok, style: 'destructive', onPress: run }]);
}

export default function MoreScreen() {
  const { session, state, connection, press, run, showToast, signOut } = useBox();
  const [headline, setHeadline] = useState('');
  const [ticker, setTicker] = useState('');
  const pc = state?.pcShutdown;

  return (
    <Screen title="MORE">
      <Card>
        <SectionHeader eyebrow="LIVE INSERTS" title="ALERTS & TICKER" />
        <Text style={[t.body, { color: color.onSurfaceVariant, marginBottom: space.md }]}>These interrupt whatever is on the TV right now.</Text>
        <Text style={t.label}>BREAKING NEWS HEADLINE (OPTIONAL)</Text>
        <TextInput style={s.input} value={headline} onChangeText={setHeadline} maxLength={180} placeholder="Custom headline" placeholderTextColor={color.outline} />
        <View style={s.row}>
          <Button style={s.flex} icon="newspaper-variant-outline" label="BREAKING NEWS" tone="error"
            onPress={() => confirm('Breaking news', 'Interrupt what is on screen with a breaking news alert?', 'Trigger', async () => { if (await run('News alert', (c) => c.news(headline.trim()))) showToast('News alert triggered'); })} />
          <Button style={s.flex} icon="alert-octagon-outline" label="EAS TEST"
            onPress={() => confirm('Emergency Alert test', 'Run an Emergency Alert System test on the TV?', 'Run test', () => { void press('e'); })} />
        </View>
        <View style={s.row}>
          <Button style={s.flex} icon="head-question-outline" label="TRIVIA" onPress={async () => { if (await run('Trivia', (c) => c.trivia())) showToast('Trivia started'); }} />
        </View>
        <Text style={[t.label, { marginTop: space.sm }]}>ON-SCREEN TICKER</Text>
        <TextInput style={[s.input, { minHeight: 72, textAlignVertical: 'top' }]} value={ticker} onChangeText={setTicker} multiline placeholder="Ticker message" placeholderTextColor={color.outline} />
        <View style={s.row}>
          <Button style={s.flex} icon="text-short" label="SHOW TICKER" tone="filled" onPress={async () => { if (await run('Ticker', (c) => c.ticker(ticker, true))) showToast('Ticker on'); }} />
          <Button style={s.flex} icon="text-box-remove-outline" label="HIDE TICKER" onPress={async () => { if (await run('Ticker', (c) => c.ticker(ticker, false))) showToast('Ticker off'); }} />
        </View>
      </Card>

      <Card>
        <SectionHeader eyebrow="THE BOX" title="SET UP & DISPLAY" />
        <View style={s.row}>
          <Button style={s.flex} icon="cog-outline" label="SETUP" onPress={() => press('s')} />
          <Button style={s.flex} icon="menu" label="TV MENU" onPress={() => press('?')} />
          <Button style={s.flex} icon="fullscreen" label="FULL" sub="SCREEN" onPress={() => press('f')} />
        </View>
        <View style={s.row}>
          <Button style={s.flex} icon="eye-off-outline" label="HINT BAR" onPress={() => press('h')} />
          <Button style={s.flex} icon="drag" label="LOGO" sub="EDITOR" onPress={() => press('o')} />
          <Button style={s.flex} icon="television-play" label="WATCH TV" onPress={async () => { if (await run('Exit setup', (c) => c.action('watch-tv'))) showToast('Back to live TV'); }} />
        </View>
        {pc?.allowed ? (
          <Button icon="power-plug-off" label="SHUT DOWN PC" tone="error" style={{ marginTop: space.sm }}
            onPress={() => confirm('Shut down the PC', 'Shut down the computer running RerunTV? It turns off after a 20-second countdown you can cancel.', 'Shut down', () => { void run('Shut down', (c) => c.action('shutdown-pc')); })} />
        ) : null}
      </Card>

      <Card>
        <SectionHeader eyebrow="THIS PHONE" title="CONNECTION" />
        <Text style={t.body}>BOX: {session?.baseUrl ?? '—'}</Text>
        <Text style={[t.body, { marginTop: space.xs }]}>STATUS: {connection === 'online' ? 'ONLINE' : connection === 'offline' ? 'NO SIGNAL' : 'CONNECTING'}</Text>
        <Text style={[t.label, { marginTop: space.sm }]}>Full box settings are on the web remote for now: open the box address in a browser on this network.</Text>
        <Button icon="link-off" label="FORGET THIS BOX" tone="outlined" style={{ marginTop: space.md }}
          onPress={() => confirm('Forget this box', 'You will need the pairing code to connect again.', 'Forget', () => { void signOut(); })} />
      </Card>
    </Screen>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  flex: { flex: 1 },
  input: { marginTop: space.sm, minHeight: 48, borderRadius: shape.sm, borderWidth: 1, borderColor: color.outline, backgroundColor: color.surfaceDim, color: color.onSurface, paddingHorizontal: space.md, paddingVertical: space.sm, fontSize: 15, fontWeight: '600' },
});
