// Material 3 navigation bar: icon + label per destination, with the pill
// "active indicator" behind the selected icon.
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, shape, space } from '../theme';
import type { IconName } from './ui';

const ICONS: Record<string, { on: IconName; off: IconName; label: string }> = {
  index: { on: 'remote', off: 'remote', label: 'REMOTE' },
  guide: { on: 'television-guide', off: 'television-guide', label: 'GUIDE' },
  lineup: { on: 'format-list-numbered', off: 'format-list-numbered', label: 'LINEUP' },
  more: { on: 'tune-variant', off: 'tune-variant', label: 'MORE' },
};

// Just the parts of the tab navigator props this bar uses.
interface BarProps {
  state: { index: number; routes: { key: string; name: string }[] };
  navigateToTab(routeKey: string): void;
}

export function TabBar({ state, navigateToTab }: BarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.bar, { paddingBottom: Math.max(insets.bottom, space.sm), paddingLeft: insets.left, paddingRight: insets.right }]} accessibilityRole="tablist">
      {state.routes.map((route, index) => {
        const meta = ICONS[route.name];
        if (!meta) return null;
        const focused = state.index === index;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={meta.label}
            style={s.item}
            onPress={() => { if (!focused) navigateToTab(route.key); }}
          >
            <View style={[s.pill, focused && s.pillOn]}>
              <MaterialCommunityIcons name={focused ? meta.on : meta.off} size={24} color={focused ? color.onPrimaryContainer : color.onSurfaceVariant} />
            </View>
            <Text style={[s.label, focused && { color: color.primary }]}>{meta.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: 'row', backgroundColor: color.surfaceContainer, borderTopWidth: 1, borderTopColor: color.outlineVariant, paddingTop: space.sm },
  item: { flex: 1, alignItems: 'center', gap: 4, minHeight: 64, justifyContent: 'center' },
  pill: { width: 64, height: 32, borderRadius: shape.full, alignItems: 'center', justifyContent: 'center' },
  pillOn: { backgroundColor: color.primaryContainer },
  label: { fontSize: 11, fontWeight: '800', letterSpacing: 1.2, color: color.onSurfaceVariant },
});
