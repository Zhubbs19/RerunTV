// Small Material 3 component kit in the box's retro colours. Buttons are at
// least 48dp, have a pressed "state layer", and a bevelled bottom edge.
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { color, shape, space, TARGET, type as t } from '../theme';

export type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];
export type Tone = 'tonal' | 'filled' | 'error' | 'outlined' | 'text';

const tones: Record<Tone, { bg: string; fg: string; border?: string }> = {
  tonal: { bg: color.surfaceContainerHighest, fg: color.onSurface },
  filled: { bg: color.primary, fg: color.onPrimary },
  error: { bg: color.errorContainer, fg: color.onErrorContainer },
  outlined: { bg: 'transparent', fg: color.primary, border: color.outline },
  text: { bg: 'transparent', fg: color.primary },
};

export function Card({ children, style, tone = 'container' }: { children: ReactNode; style?: StyleProp<ViewStyle>; tone?: 'container' | 'high' }) {
  return <View style={[s.card, tone === 'high' && { backgroundColor: color.surfaceContainerHigh }, style]}>{children}</View>;
}

export function SectionHeader({ eyebrow, title, right }: { eyebrow?: string; title: string; right?: ReactNode }) {
  return (
    <View style={s.sectionHeader}>
      <View style={{ flex: 1 }}>
        {eyebrow ? <Text style={t.eyebrow}>{eyebrow}</Text> : null}
        <Text style={t.title}>{title}</Text>
      </View>
      {right}
    </View>
  );
}

export interface ButtonProps {
  label?: string;
  sub?: string;
  icon?: IconName;
  tone?: Tone;
  onPress?: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  compact?: boolean;
}

export function Button({ label, sub, icon, tone = 'tonal', onPress, onPressIn, onPressOut, onLongPress, disabled, style, accessibilityLabel, compact }: ButtonProps) {
  const c = tones[tone];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={disabled}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      onLongPress={onLongPress}
      android_ripple={{ color: `${c.fg}33` }}
      style={({ pressed }) => [
        s.button,
        compact && s.buttonCompact,
        { backgroundColor: c.bg, borderColor: c.border ?? 'transparent', borderWidth: c.border ? 1 : 0 },
        tone !== 'text' && tone !== 'outlined' && s.bevel,
        pressed && { opacity: 0.82, transform: [{ translateY: 1 }] },
        disabled && { opacity: 0.38 },
        style,
      ]}
    >
      {icon ? <MaterialCommunityIcons name={icon} size={compact ? 20 : 24} color={c.fg} /> : null}
      {label ? <Text style={[s.buttonLabel, { color: c.fg }]} numberOfLines={1}>{label}</Text> : null}
      {sub ? <Text style={[s.buttonSub, { color: c.fg }]} numberOfLines={1}>{sub}</Text> : null}
    </Pressable>
  );
}

// Fires once on press, then repeats while held (volume, channel, D-pad).
export function RepeatButton({ onFire, ...props }: Omit<ButtonProps, 'onPress' | 'onPressIn' | 'onPressOut'> & { onFire: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fire = useRef(onFire);
  fire.current = onFire;
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);
  const loop = (delay: number) => {
    timer.current = setTimeout(() => {
      fire.current();
      loop(140);
    }, delay);
  };
  return (
    <Button
      {...props}
      onPressIn={() => {
        stop();
        fire.current();
        loop(420);
      }}
      onPressOut={stop}
    />
  );
}

export function Chip({ label, selected, onPress, icon }: { label: string; selected?: boolean; onPress?: () => void; icon?: IconName }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      style={({ pressed }) => [s.chip, selected && s.chipSelected, pressed && { opacity: 0.8 }]}
    >
      {icon ? <MaterialCommunityIcons name={icon} size={16} color={selected ? color.onTertiaryContainer : color.onSurfaceVariant} /> : null}
      <Text style={[s.chipLabel, selected && { color: color.onTertiaryContainer }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

// M3 segmented button: one choice among a few.
export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string; icon?: IconName }[]; value: T; onChange(v: T): void }) {
  return (
    <View style={s.segmented} accessibilityRole="tablist">
      {options.map((option, i) => {
        const on = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(option.value)}
            style={[s.segment, i > 0 && { borderLeftWidth: 1, borderLeftColor: color.outline }, on && { backgroundColor: color.tertiaryContainer }]}
          >
            {option.icon ? <MaterialCommunityIcons name={option.icon} size={18} color={on ? color.onTertiaryContainer : color.onSurfaceVariant} /> : null}
            <Text style={[s.segmentLabel, on && { color: color.onTertiaryContainer }]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Led({ state }: { state: 'online' | 'offline' | 'connecting' }) {
  const bg = state === 'online' ? color.success : state === 'offline' ? color.error : color.primary;
  return <View style={[s.led, { backgroundColor: bg, shadowColor: bg }]} />;
}

export function Empty({ text }: { text: string }) {
  return <Text style={s.empty}>{text}</Text>;
}

const s = StyleSheet.create({
  card: { backgroundColor: color.surfaceContainer, borderRadius: shape.lg, padding: space.lg, marginBottom: space.md, borderWidth: 1, borderColor: color.outlineVariant },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.md },
  button: { minHeight: TARGET, minWidth: TARGET, borderRadius: shape.md, paddingHorizontal: space.sm, paddingVertical: space.sm, alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 2, overflow: 'hidden' },
  buttonCompact: { minHeight: 40, borderRadius: shape.full, flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg },
  bevel: { borderBottomWidth: 3, borderBottomColor: 'rgba(0,0,0,0.45)', borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.10)' },
  buttonLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, textAlign: 'center' },
  buttonSub: { fontSize: 10, fontWeight: '700', letterSpacing: 1, opacity: 0.8, textAlign: 'center' },
  chip: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.md, borderRadius: shape.sm, borderWidth: 1, borderColor: color.outline },
  chipSelected: { backgroundColor: color.tertiaryContainer, borderColor: color.tertiaryContainer },
  chipLabel: { fontSize: 12, fontWeight: '800', letterSpacing: 1, color: color.onSurfaceVariant },
  segmented: { flexDirection: 'row', borderRadius: shape.full, borderWidth: 1, borderColor: color.outline, overflow: 'hidden' },
  segment: { flex: 1, minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs, paddingHorizontal: space.sm },
  segmentLabel: { fontSize: 12, fontWeight: '800', letterSpacing: 1.2, color: color.onSurfaceVariant },
  led: { width: 10, height: 10, borderRadius: 5, shadowOpacity: 0.9, shadowRadius: 6, shadowOffset: { width: 0, height: 0 }, elevation: 4 },
  empty: { color: color.onSurfaceVariant, textAlign: 'center', padding: space.xl, fontSize: 12, letterSpacing: 1 },
});
