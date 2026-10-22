// Controls for one setting, by kind. Text boxes commit when they lose focus (not
// on every keystroke), so a half-typed number never becomes a patch.
import { MaterialCommunityIcons } from '@expo/vector-icons';
import Slider from '@react-native-community/slider';
import { useEffect, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getIn, parseJsonList, parseTyped, toDisplay, toStored, type Json, type LeafNode, type ObjectNode, type SettingNode } from '../lib/settings-model';
import { color, shape, space, TARGET, type as t } from '../theme';
import { Text } from './Text';
import { Button } from './ui';

export type Draft = Record<string, Json>;
export type Change = (path: string[], value: Json) => void;

export function SettingNodeView({ node, draft, onChange, forceOpen }: { node: SettingNode; draft: Draft; onChange: Change; forceOpen: boolean }) {
  if (node.kind === 'object') return <Section node={node} draft={draft} onChange={onChange} forceOpen={forceOpen} />;
  return <Leaf node={node} value={getIn(draft, node.path)} onChange={onChange} />;
}

function Section({ node, draft, onChange, forceOpen }: { node: ObjectNode; draft: Draft; onChange: Change; forceOpen: boolean }) {
  const [open, setOpen] = useState(false);
  const shown = open || forceOpen;
  return (
    <View style={s.section}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: shown }} onPress={() => setOpen((v) => !v)} style={s.sectionHead}>
        <MaterialCommunityIcons name={shown ? 'chevron-down' : 'chevron-right'} size={22} color={color.onSurfaceVariant} />
        <Text style={[t.title, { flex: 1, fontSize: 13 }]} numberOfLines={1}>{node.label}</Text>
        <Text style={t.label}>{node.children.length}</Text>
      </Pressable>
      {shown ? (
        <View style={s.sectionBody}>
          {node.children.map((child) => <SettingNodeView key={child.dotted} node={child} draft={draft} onChange={onChange} forceOpen={forceOpen} />)}
        </View>
      ) : null}
    </View>
  );
}

function Frame({ node, children, inline }: { node: LeafNode; children: React.ReactNode; inline?: React.ReactNode }) {
  return (
    <View style={s.field}>
      <View style={s.fieldHead}>
        <Text style={[t.body, { flex: 1, fontWeight: '800', letterSpacing: 0.8 }]}>{node.label}</Text>
        {inline}
      </View>
      {children}
      {node.help ? <Text style={s.help}>{node.help}</Text> : null}
    </View>
  );
}

function Leaf({ node, value, onChange }: { node: LeafNode; value: Json; onChange: Change }) {
  switch (node.kind) {
    case 'boolean':
      return (
        <Frame node={node} inline={(
          <Switch
            value={!!value}
            onValueChange={(v) => onChange(node.path, v)}
            trackColor={{ false: color.surfaceContainerHighest, true: color.primaryContainer }}
            thumbColor={value ? color.primary : color.outline}
            accessibilityLabel={node.label}
          />
        )}
        >
          {null}
        </Frame>
      );
    case 'enum':
      return <EnumField node={node} value={value} onChange={onChange} />;
    case 'range': {
      const bounds = node.bounds!;
      return <RangeField node={node} value={typeof value === 'number' ? value : 0} bounds={bounds} onChange={onChange} />;
    }
    case 'stringList':
      return <ListField node={node} value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} />;
    case 'json':
      return <JsonField node={node} value={value} onChange={onChange} />;
    default:
      return <TextField node={node} value={value} onChange={onChange} />;
  }
}

function TextField({ node, value, onChange }: { node: LeafNode; value: Json; onChange: Change }) {
  const secret = node.kind === 'secret';
  const [text, setText] = useState(secret ? '' : value == null ? '' : String(value));
  useEffect(() => { if (!secret) setText(value == null ? '' : String(value)); }, [value, secret]);
  const commit = () => {
    if (secret && !text) return; // the current value is hidden; blank means "leave it"
    onChange(node.path, parseTyped(node.kind === 'number' ? 0 : '', text));
  };
  return (
    <Frame node={node}>
      <TextInput
        style={s.input}
        value={text}
        onChangeText={setText}
        onBlur={commit}
        onSubmitEditing={commit}
        secureTextEntry={secret}
        placeholder={secret ? 'Current value hidden. Enter a replacement.' : undefined}
        placeholderTextColor={color.outline}
        keyboardType={node.kind === 'number' ? 'numeric' : 'default'}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={node.label}
      />
    </Frame>
  );
}

function RangeField({ node, value, bounds, onChange }: { node: LeafNode; value: number; bounds: NonNullable<LeafNode['bounds']>; onChange: Change }) {
  const [shown, setShown] = useState(toDisplay(value, bounds));
  useEffect(() => setShown(toDisplay(value, bounds)), [value, bounds]);
  return (
    <Frame node={node} inline={<Text style={t.led}>{shown}{bounds[3]}</Text>}>
      <Slider
        minimumValue={bounds[0]}
        maximumValue={bounds[1]}
        step={bounds[2]}
        value={shown}
        onValueChange={setShown}
        onSlidingComplete={(v) => onChange(node.path, toStored(v, bounds))}
        minimumTrackTintColor={color.primary}
        maximumTrackTintColor={color.surfaceContainerHighest}
        thumbTintColor={color.primary}
        accessibilityLabel={node.label}
        style={{ height: TARGET }}
      />
    </Frame>
  );
}

function EnumField({ node, value, onChange }: { node: LeafNode; value: Json; onChange: Change }) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const choices = node.choices ?? [];
  const current = choices.find((c) => String(c[0]) === String(value));
  return (
    <Frame node={node}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${node.label}: ${current?.[1] ?? String(value)}. Change.`} onPress={() => setOpen(true)} style={s.select}>
        <Text style={[t.body, { flex: 1 }]} numberOfLines={1}>{current?.[1] ?? String(value)}</Text>
        <MaterialCommunityIcons name="menu-down" size={24} color={color.onSurfaceVariant} />
      </Pressable>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable style={s.scrim} onPress={() => setOpen(false)} accessibilityLabel="Close" />
        <View style={[s.sheet, { paddingBottom: insets.bottom + space.md }]}>
          <View style={s.grabber} />
          <Text style={[t.title, { marginBottom: space.sm }]}>{node.label}</Text>
          <FlatList
            data={choices}
            keyExtractor={(c) => String(c[0])}
            style={{ maxHeight: 420 }}
            renderItem={({ item }) => {
              const on = String(item[0]) === String(value);
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => { setOpen(false); onChange(node.path, typeof value === 'number' ? Number(item[0]) : item[0]); }}
                  style={[s.option, on && { backgroundColor: color.tertiaryContainer }]}
                >
                  <Text style={[t.body, { flex: 1 }, on && { color: color.onTertiaryContainer }]}>{item[1]}</Text>
                  {on ? <MaterialCommunityIcons name="check" size={20} color={color.onTertiaryContainer} /> : null}
                </Pressable>
              );
            }}
          />
        </View>
      </Modal>
    </Frame>
  );
}

function ListField({ node, value, onChange }: { node: LeafNode; value: string[]; onChange: Change }) {
  const [items, setItems] = useState<string[]>(value);
  useEffect(() => setItems(value), [value]);
  const push = (next: string[]) => { setItems(next); onChange(node.path, next); };
  return (
    <Frame node={node}>
      {items.map((item, i) => (
        <View key={i} style={s.listRow}>
          <TextInput
            style={[s.input, { flex: 1, marginTop: 0 }]}
            value={item}
            onChangeText={(v) => setItems(items.map((x, k) => (k === i ? v : x)))}
            onBlur={() => onChange(node.path, items)}
            autoCapitalize="none"
            accessibilityLabel={`${node.label} ${i + 1}`}
          />
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove item ${i + 1}`} onPress={() => push(items.filter((_, k) => k !== i))} style={s.iconBtn}>
            <MaterialCommunityIcons name="close" size={20} color={color.onSurfaceVariant} />
          </Pressable>
        </View>
      ))}
      <Button compact icon="plus" label="ADD ITEM" tone="outlined" onPress={() => push([...items, ''])} style={{ alignSelf: 'flex-start', marginTop: space.sm }} />
    </Frame>
  );
}

function JsonField({ node, value, onChange }: { node: LeafNode; value: Json; onChange: Change }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [bad, setBad] = useState(false);
  useEffect(() => setText(JSON.stringify(value, null, 2)), [value]);
  return (
    <Frame node={node} inline={bad ? <Text style={[t.label, { color: color.error }]}>INVALID JSON LIST</Text> : undefined}>
      <TextInput
        style={[s.input, s.json, bad && { borderColor: color.error }]}
        value={text}
        onChangeText={setText}
        onBlur={() => {
          const parsed = parseJsonList(text);
          setBad(parsed === null);
          if (parsed !== null) onChange(node.path, parsed);
        }}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        accessibilityLabel={node.label}
      />
    </Frame>
  );
}

const s = StyleSheet.create({
  section: { borderRadius: shape.md, backgroundColor: color.surfaceContainerLow, borderWidth: 1, borderColor: color.outlineVariant, marginTop: space.sm, overflow: 'hidden' },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: TARGET, paddingHorizontal: space.md },
  sectionBody: { paddingHorizontal: space.md, paddingBottom: space.md },
  field: { paddingVertical: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.outlineVariant },
  fieldHead: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 36 },
  help: { color: color.onSurfaceVariant, fontSize: 12, lineHeight: 17, marginTop: space.xs },
  input: { marginTop: space.sm, minHeight: 48, borderRadius: shape.sm, borderWidth: 1, borderColor: color.outline, backgroundColor: color.surfaceDim, color: color.onSurface, paddingHorizontal: space.md, paddingVertical: space.sm, fontSize: 15, fontWeight: '600' },
  json: { minHeight: 120, fontFamily: 'monospace', fontSize: 12, textAlignVertical: 'top' },
  select: { marginTop: space.sm, minHeight: 48, borderRadius: shape.sm, borderWidth: 1, borderColor: color.outline, backgroundColor: color.surfaceDim, paddingHorizontal: space.md, flexDirection: 'row', alignItems: 'center' },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm },
  iconBtn: { width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center' },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { backgroundColor: color.surfaceContainerHigh, borderTopLeftRadius: shape.xl, borderTopRightRadius: shape.xl, padding: space.lg },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: color.outline, marginBottom: space.md },
  option: { minHeight: TARGET, flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, borderRadius: shape.md },
});
