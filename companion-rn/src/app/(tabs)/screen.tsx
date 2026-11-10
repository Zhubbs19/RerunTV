// SCREEN: whatever is on the box's screen, readable and drivable from the
// phone. The box describes its top surface (a dialog, the TV menu, the guide,
// a setup page, live TV) and every control on it (GET /api/ui); a row here
// presses, picks, adjusts or types into the real control on the box
// (POST /api/ui). The D-pad sends remote buttons through the box's own
// remote path, so the screen can also be walked the way a remote does.
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { SearchBar } from '../../components/Channels';
import { DPad } from '../../components/DPad';
import { Screen } from '../../components/Screen';
import { Text } from '../../components/Text';
import { Button, Card, Chip, Empty, SectionHeader } from '../../components/ui';
import type { IconName } from '../../components/ui';
import { ApiError, type ScreenAction } from '../../lib/api';
import {
  groupItems, isTextItem, itemAction, itemValueText, screenHeading, stepValue, surfaceLabel,
  type ScreenItem, type ScreenSnapshot,
} from '../../lib/screen-model';
import { useBox } from '../../lib/session';
import { useLayout } from '../../lib/useLayout';
import { makeStyles, shape, space, TARGET, useTheme } from '../../theme';

const POLL_MS = 1500;

const KIND_ICONS: Record<string, IconName> = {
  button: 'gesture-tap-button', tab: 'tab', option: 'format-list-bulleted-square', link: 'link-variant',
  checkbox: 'checkbox-marked', switch: 'toggle-switch', radio: 'radiobox-marked', select: 'form-select',
  range: 'tune', number: 'numeric', text: 'keyboard-outline', textarea: 'keyboard-outline', password: 'form-textbox-password',
};

function iconFor(item: ScreenItem): IconName {
  if (item.locked) return 'lock-outline';
  if (item.kind === 'checkbox' || item.kind === 'switch') return item.checked ? 'toggle-switch' : 'toggle-switch-off-outline';
  if (item.kind === 'radio') return item.checked ? 'radiobox-marked' : 'radiobox-blank';
  return KIND_ICONS[item.kind] ?? 'circle-small';
}

export default function ScreenTab() {
  const { color, type: t } = useTheme();
  const s = useStyles();
  const layout = useLayout();
  const { client, pressRemote, hasFeature, showToast } = useBox();
  const [snap, setSnap] = useState<ScreenSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [text, setText] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [exact, setExact] = useState('');
  const busy = useRef(false);
  const supported = hasFeature('ui');

  const load = useCallback(async () => {
    if (!client) return;
    try {
      setSnap(await client.screen());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The box did not describe its screen.');
    }
  }, [client]);

  // Watch the screen while this tab is in front.
  useFocusEffect(useCallback(() => {
    if (!supported) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (stopped) return;
      if (!busy.current) await load();
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [load, supported]));

  const act = useCallback(async (action: ScreenAction) => {
    if (!client) return;
    busy.current = true;
    try {
      setSnap(await client.act(action));
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : 'The box could not do that.', true);
      void load();
    } finally {
      busy.current = false;
    }
  }, [client, load, showToast]);

  const remote = useCallback(async (button: string, long?: boolean) => {
    await pressRemote(button, long);
    if (supported) setTimeout(() => { void load(); }, 250);
  }, [pressRemote, load, supported]);

  const onRow = (item: ScreenItem) => {
    if (!snap) return;
    if (item.locked) { showToast(item.locked, true); return; }
    if (item.disabled) { showToast('That control is switched off right now.', true); return; }
    const what = itemAction(item);
    if (what === 'press') { void act({ op: 'activate', snapshot: snap.id, index: item.index }); return; }
    if (what === 'type') {
      // Focus the field on the box; the text box below types into it.
      setText(item.secret ? '' : String(item.value ?? ''));
      setOpen(null);
      void act({ op: 'focus', snapshot: snap.id, index: item.index });
      return;
    }
    setExact(item.value == null ? '' : String(item.value));
    setOpen(open === item.index ? null : item.index);
    if (what === 'adjust') void act({ op: 'focus', snapshot: snap.id, index: item.index });
  };

  const focused = snap && snap.focusedIndex != null ? snap.items[snap.focusedIndex] : null;
  const typingInto = isTextItem(focused) ? focused : null;
  const groups = snap ? groupItems(snap.items, query) : [];

  const sendText = (submit: boolean) => {
    if (!typingInto) { showToast('Pick a text field in the list first.', true); return; }
    void act({ op: 'text', text, submit });
  };

  const readout = (
    <Card tone="high">
      {snap ? (
        <>
          <Text style={t.eyebrow}>{surfaceLabel(snap)}</Text>
          <Text style={[t.title, { marginTop: space.xs }]} numberOfLines={3}>{screenHeading(snap).toUpperCase()}</Text>
          {focused ? (
            <Text style={[t.label, { marginTop: space.sm }]} numberOfLines={2}>
              SELECTED: <Text style={[t.label, { color: color.primary }]}>{focused.label.toUpperCase()}</Text>
              {itemValueText(focused) ? ` · ${itemValueText(focused).toUpperCase()}` : ''}
            </Text>
          ) : null}
          {snap.locked ? (
            <View style={s.lockLine}>
              <MaterialCommunityIcons name="lock-outline" size={16} color={color.onSurfaceVariant} />
              <Text style={[t.label, { flex: 1 }]}>{snap.locked}</Text>
            </View>
          ) : null}
        </>
      ) : (
        <>
          <Text style={t.eyebrow}>ON SCREEN</Text>
          <Text style={[t.title, { marginTop: space.xs }]}>{supported ? (error ? 'CAN’T SEE THE SCREEN' : 'LOOKING…') : 'REMOTE ONLY'}</Text>
          <Text style={[t.body, { color: color.onSurfaceVariant, marginTop: space.sm }]}>
            {supported
              ? (error ?? 'Asking the box what it shows.')
              : 'This box doesn’t describe its screen to the phone yet. Update RerunTV on the box to see and tap what’s on screen. The pad below works now.'}
          </Text>
        </>
      )}
    </Card>
  );

  const pad = (
    <Card>
      <SectionHeader eyebrow="LIKE THE REMOTE" title="NAVIGATE" />
      <DPad onPress={(button, long) => { void remote(button, long); }} />
    </Card>
  );

  const typing = supported ? (
    <Card>
      <SectionHeader eyebrow="PHONE KEYBOARD" title="TYPE ON THE BOX" />
      <Text style={[t.body, { color: color.onSurfaceVariant, marginBottom: space.sm }]}>
        {typingInto ? `Typing into ${typingInto.label}.` : 'Tap a text field in the list, then type here.'}
      </Text>
      <TextInput
        style={s.input}
        value={text}
        onChangeText={setText}
        editable={!!typingInto}
        secureTextEntry={!!typingInto?.secret || typingInto?.kind === 'password'}
        multiline={typingInto?.kind === 'textarea'}
        keyboardType={typingInto?.kind === 'number' ? 'numeric' : 'default'}
        placeholder={typingInto?.placeholder ?? (typingInto ? 'Text for the box' : 'No field selected')}
        placeholderTextColor={color.outline}
        onSubmitEditing={() => sendText(false)}
      />
      <View style={s.row}>
        <Button style={s.flex} icon="send" label="SEND" tone="filled" disabled={!typingInto} onPress={() => sendText(false)} />
        <Button style={s.flex} icon="keyboard-return" label="SEND + ENTER" disabled={!typingInto} onPress={() => sendText(true)} />
      </View>
    </Card>
  ) : null;

  const list = supported && snap ? (
    <Card>
      <SectionHeader eyebrow={`${snap.items.length} CONTROLS${snap.truncated ? ' (FIRST 400)' : ''}`} title="ON THIS SCREEN" />
      {snap.items.length > 8 ? <SearchBar value={query} onChange={setQuery} placeholder="Find a control" /> : null}
      {groups.length === 0 ? <Empty text={snap.items.length ? 'NOTHING MATCHES' : snap.kind === 'tv' ? 'NOTHING TO PICK ON LIVE TV. USE THE PAD, MENU OR GUIDE.' : 'NOTHING TO PICK HERE'} /> : null}
      {groups.map((group, gi) => (
        <View key={`${group.title}-${gi}`} style={{ marginBottom: space.sm }}>
          {group.title ? <Text style={[t.label, s.groupTitle]}>{group.title.toUpperCase()}</Text> : null}
          {group.items.map((item) => {
            const value = itemValueText(item);
            const muted = !!item.locked || !!item.disabled;
            const expanded = open === item.index;
            return (
              <View key={item.index}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: muted, selected: !!item.selected, expanded: expanded || undefined }}
                  accessibilityLabel={`${item.label}${value ? `, ${value}` : ''}${item.locked ? ', locked' : ''}`}
                  onPress={() => onRow(item)}
                  style={({ pressed }) => [s.item, item.focused && s.itemFocused, item.selected && s.itemSelected, pressed && { opacity: 0.8 }]}
                >
                  <MaterialCommunityIcons name={iconFor(item)} size={20} color={muted ? color.outline : item.selected ? color.onTertiaryContainer : color.primary} />
                  <Text style={[t.body, { flex: 1 }, muted && { color: color.outline }, item.selected && { color: color.onTertiaryContainer }]} numberOfLines={2}>{item.label.toUpperCase()}</Text>
                  {value ? <Text style={[t.led, s.value, muted && { color: color.outline }]} numberOfLines={1}>{value.toUpperCase()}</Text> : null}
                </Pressable>
                {expanded && item.kind === 'select' ? (
                  <View style={s.options}>
                    {(item.options ?? []).map((option) => (
                      <Chip key={option.value} label={option.label.toUpperCase()} selected={option.value === item.value}
                        onPress={() => { if (!option.disabled) { setOpen(null); void act({ op: 'set', snapshot: snap.id, index: item.index, value: option.value }); } }} />
                    ))}
                  </View>
                ) : null}
                {expanded && (item.kind === 'range' || item.kind === 'number') ? (
                  <View style={[s.row, s.adjust]}>
                    <Button compact icon="minus" accessibilityLabel="Less" onPress={() => { const v = stepValue(item, -1); setExact(String(v)); void act({ op: 'set', snapshot: snap.id, index: item.index, value: v }); }} />
                    <TextInput style={[s.input, s.flex, { marginTop: 0, minWidth: 0 }]} value={exact} onChangeText={setExact} keyboardType="numeric" placeholder={item.min != null && item.max != null ? `${item.min}–${item.max}` : 'Number'} placeholderTextColor={color.outline} />
                    <Button compact label="SET" tone="filled" onPress={() => { const n = Number(exact); if (Number.isFinite(n) && exact.trim() !== '') void act({ op: 'set', snapshot: snap.id, index: item.index, value: n }); }} />
                    <Button compact icon="plus" accessibilityLabel="More" onPress={() => { const v = stepValue(item, 1); setExact(String(v)); void act({ op: 'set', snapshot: snap.id, index: item.index, value: v }); }} />
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      ))}
    </Card>
  ) : null;

  return (
    <Screen title="SCREEN" onRefresh={supported ? load : undefined} wide>
      {layout.twoColumn ? (
        <View style={s.columns}>
          <View style={s.column}>{readout}{pad}{typing}</View>
          <View style={s.column}>{list}</View>
        </View>
      ) : (
        <>
          {readout}
          {pad}
          {typing}
          {list}
        </>
      )}
    </Screen>
  );
}

const useStyles = makeStyles((color) => ({
  columns: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  column: { flex: 1 },
  row: { flexDirection: 'row', gap: space.sm, marginTop: space.sm, alignItems: 'center' },
  flex: { flex: 1 },
  lockLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.sm },
  groupTitle: { marginTop: space.sm, marginBottom: space.xs },
  item: { minHeight: TARGET, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: shape.md, borderWidth: 1, borderColor: 'transparent' },
  itemFocused: { borderColor: color.primary, backgroundColor: color.surfaceContainerHigh },
  itemSelected: { backgroundColor: color.tertiaryContainer },
  value: { maxWidth: '45%', textAlign: 'right' },
  adjust: { paddingHorizontal: space.md, paddingBottom: space.sm, marginTop: 0 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
  input: { marginTop: space.sm, minHeight: 48, borderRadius: shape.sm, borderWidth: 1, borderColor: color.outline, backgroundColor: color.surfaceDim, color: color.onSurface, paddingHorizontal: space.md, paddingVertical: space.sm, fontSize: 15, fontWeight: '600' },
}));
