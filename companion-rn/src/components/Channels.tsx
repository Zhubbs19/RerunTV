import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatChannelNumber, minutesLeft, type LineupRow } from '../lib/pure';
import { color, shape, space, TARGET, type as t } from '../theme';

// M3 search bar: a pill with a leading icon and a clear action.
export function SearchBar({ value, onChange, placeholder }: { value: string; onChange(v: string): void; placeholder: string }) {
  return (
    <View style={s.search}>
      <MaterialCommunityIcons name="magnify" size={22} color={color.onSurfaceVariant} />
      <TextInput
        style={s.searchInput}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={color.outline}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel={placeholder}
      />
      {value ? (
        <Pressable onPress={() => onChange('')} accessibilityLabel="Clear search" hitSlop={12}>
          <MaterialCommunityIcons name="close-circle" size={20} color={color.onSurfaceVariant} />
        </Pressable>
      ) : null}
    </View>
  );
}

// One channel: number plate, name, what is on and next. Tapping tunes; the
// trailing actions (favorite / quick access) are optional.
export function ChannelRow({ row, now, active, onPress, trailing }: { row: LineupRow; now: number; active?: boolean; onPress(): void; trailing?: React.ReactNode }) {
  const left = minutesLeft(row.endsAtMs, now);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Channel ${row.number} ${row.name}. ${row.now ? `On now: ${row.now}.` : ''} Tap to tune.`}
      onPress={onPress}
      android_ripple={{ color: `${color.primary}22` }}
      style={({ pressed }) => [s.row, active && s.rowActive, pressed && { opacity: 0.85 }]}
    >
      <View style={[s.plate, active && { backgroundColor: color.primaryContainer }]}>
        <Text style={[t.led, { fontSize: 16 }]}>{formatChannelNumber(row.number)}</Text>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={t.title} numberOfLines={1}>{(row.name || `CHANNEL ${row.number}`).toUpperCase()}</Text>
        {row.now ? <Text style={[t.body, { color: color.onSurface }]} numberOfLines={1}>{row.now.toUpperCase()}{left != null ? `  ·  ${left} MIN` : ''}</Text> : null}
        {row.next ? <Text style={t.label} numberOfLines={1}>NEXT: {row.next.toUpperCase()}</Text> : null}
      </View>
      {trailing}
    </Pressable>
  );
}

export function IconToggle({ icon, onIcon, on, label, onPress }: { icon: React.ComponentProps<typeof MaterialCommunityIcons>['name']; onIcon: React.ComponentProps<typeof MaterialCommunityIcons>['name']; on: boolean; label: string; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [s.iconToggle, on && { backgroundColor: color.primaryContainer }, pressed && { opacity: 0.8 }]}
    >
      <MaterialCommunityIcons name={on ? onIcon : icon} size={22} color={on ? color.onPrimaryContainer : color.onSurfaceVariant} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  search: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 52, borderRadius: shape.full, backgroundColor: color.surfaceContainerHigh, paddingHorizontal: space.lg, marginBottom: space.md },
  searchInput: { flex: 1, color: color.onSurface, fontSize: 15, fontWeight: '600', paddingVertical: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 64, paddingVertical: space.sm, paddingHorizontal: space.md, borderRadius: shape.lg, backgroundColor: color.surfaceContainer, borderWidth: 1, borderColor: color.outlineVariant, marginBottom: space.sm },
  rowActive: { borderColor: color.primary },
  plate: { minWidth: 56, minHeight: 40, borderRadius: shape.sm, backgroundColor: color.surfaceDim, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.sm },
  iconToggle: { width: TARGET - 4, height: TARGET - 4, borderRadius: shape.full, alignItems: 'center', justifyContent: 'center' },
});
