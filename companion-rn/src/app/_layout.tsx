import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View } from 'react-native';
import { Text } from '../components/Text';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { SessionProvider, useBox } from '../lib/session';
import { color, shape, space, type as t } from '../theme';

// A short message near the bottom (M3 snackbar), for command failures and confirmations.
function Snackbar() {
  const { toast, toastIsError } = useBox();
  const insets = useSafeAreaInsets();
  if (!toast) return null;
  return (
    <View pointerEvents="none" style={[s.snackWrap, { bottom: insets.bottom + 96 }]}>
      <View style={[s.snack, toastIsError && { backgroundColor: color.errorContainer }]}>
        <Text style={[t.body, toastIsError && { color: color.onErrorContainer }]}>{toast}</Text>
      </View>
    </View>
  );
}

function Shell() {
  const { loaded } = useBox();
  if (!loaded) return <View style={{ flex: 1, backgroundColor: color.surface }} />;
  return (
    <View style={{ flex: 1, backgroundColor: color.surface }}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.surface }, animation: 'fade' }} />
      <Snackbar />
    </View>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="light" />
        <Shell />
      </SessionProvider>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  snackWrap: { position: 'absolute', left: space.lg, right: space.lg, alignItems: 'center' },
  snack: { backgroundColor: color.surfaceContainerHighest, borderRadius: shape.sm, paddingHorizontal: space.lg, paddingVertical: space.md, borderWidth: 1, borderColor: color.outline },
});
