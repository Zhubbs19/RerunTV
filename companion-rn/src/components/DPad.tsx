// The navigation pad: arrows that repeat while held, OK (hold for the box's
// long-press OK), and BACK / MENU / GUIDE / INFO. Every button is a RemoteKey,
// so in TV mode the box routes it exactly as its own remote (tv/input.js).
import { View } from 'react-native';
import { Button, RepeatButton } from './ui';
import { useLayout } from '../lib/useLayout';
import { makeStyles, shape, space } from '../theme';

export function DPad({ onPress, extras = true }: { onPress(button: string, long?: boolean): void; extras?: boolean }) {
  const s = useStyles();
  const layout = useLayout();
  const key = [s.key, { width: layout.padKey, height: layout.padKey }];
  return (
    <View style={s.pad}>
      <View style={s.row}><RepeatButton style={key} icon="chevron-up" accessibilityLabel="Up" onFire={() => onPress('up')} /></View>
      <View style={s.row}>
        <RepeatButton style={key} icon="chevron-left" accessibilityLabel="Left" onFire={() => onPress('left')} />
        <Button style={key} label="OK" tone="filled" accessibilityLabel="OK. Hold for the long-press menu" onPress={() => onPress('ok')} onLongPress={() => onPress('ok', true)} />
        <RepeatButton style={key} icon="chevron-right" accessibilityLabel="Right" onFire={() => onPress('right')} />
      </View>
      <View style={s.row}><RepeatButton style={key} icon="chevron-down" accessibilityLabel="Down" onFire={() => onPress('down')} /></View>
      {extras ? (
        <View style={s.extras}>
          <Button style={s.flex} icon="arrow-left" label="BACK" onPress={() => onPress('back')} />
          <Button style={s.flex} icon="menu" label="MENU" onPress={() => onPress('menu')} />
          <Button style={s.flex} icon="television-guide" label="GUIDE" onPress={() => onPress('guide')} />
          <Button style={s.flex} icon="information-outline" label="INFO" onPress={() => onPress('info')} />
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles(() => ({
  pad: { alignItems: 'center', gap: space.sm },
  row: { flexDirection: 'row', gap: space.sm, justifyContent: 'center' },
  key: { borderRadius: shape.xl },
  extras: { flexDirection: 'row', gap: space.sm, alignSelf: 'stretch', marginTop: space.sm },
  flex: { flex: 1 },
}));
