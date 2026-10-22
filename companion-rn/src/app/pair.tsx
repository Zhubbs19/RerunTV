// First run: find the box and trade its pairing code for a session. A QR scan
// of the pairing link the box shows fills in both fields; typing works too.
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Text } from '../components/Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Card, Led } from '../components/ui';
import { ApiError, pair } from '../lib/api';
import { COMPANION_PORT, discoverBoxes, mergeFound, type FoundBox } from '../lib/discovery';
import { normalizeCode, parseTarget } from '../lib/pure';
import { useBox } from '../lib/session';
import { color, shape, space, type as t } from '../theme';

export default function PairScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signIn } = useBox();
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [found, setFound] = useState<FoundBox[]>([]);
  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  function search() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setFound([]);
    setProgress(null);
    setSearchNote(null);
    setSearching(true);
    discoverBoxes({
      signal: controller.signal,
      onFound: (box) => setFound((list) => mergeFound(list, box)),
      onProgress: (done, total) => setProgress({ done, total }),
      onMethods: ({ localIp }) => setSearchNote(localIp ? null : "Could not read this phone's Wi-Fi address. Is Wi-Fi on?"),
    }).finally(() => { if (abortRef.current === controller) setSearching(false); });
  }

  useEffect(() => {
    search();
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pick(box: FoundBox) {
    setAddress(box.port === COMPANION_PORT ? box.host : `${box.host}:${box.port}`);
    setError(null);
  }

  async function connect(addr = address, pairing = code) {
    setError(null);
    const target = parseTarget(addr);
    const clean = normalizeCode(pairing);
    if (!target) return setError('Enter the box address, like 192.168.1.20.');
    if (!clean) return setError('Enter the pairing code shown on the box.');
    setBusy(true);
    try {
      await signIn(await pair(target.baseUrl, clean));
      router.replace('/');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function startScan() {
    setError(null);
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) return setError('Camera access is needed to scan. You can type the address and code instead.');
    }
    setScanning(true);
  }

  function onScanned(data: string) {
    setScanning(false);
    const target = parseTarget(data);
    if (!target) return setError('That QR code is not a RerunTV pairing link.');
    setAddress(target.baseUrl);
    if (target.code) {
      setCode(target.code);
      void connect(target.baseUrl, target.code);
    }
  }

  if (scanning) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => onScanned(data)}
        />
        <View style={[s.scanOverlay, { paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.lg }]}>
          <Text style={[t.title, { textAlign: 'center' }]}>POINT AT THE PAIRING QR CODE</Text>
          <View style={s.reticle} />
          <Button label="CANCEL" tone="tonal" onPress={() => setScanning(false)} />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[s.page, { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.xl, paddingLeft: space.lg + insets.left, paddingRight: space.lg + insets.right, alignItems: 'center' }]} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <View style={{ width: '100%', maxWidth: 480 }}>
        <View style={s.brand}>
          <Led state="connecting" />
          <View>
            <Text style={t.eyebrow}>RERUNTV // HEADEND CONTROL</Text>
            <Text style={t.headline}>COMPANION</Text>
          </View>
        </View>

        <Text style={[t.body, { color: color.onSurfaceVariant, marginBottom: space.lg }]}>
          Pair this phone with your box once. On the box, open the companion service to see its address, pairing code and QR code.
        </Text>

        <Button icon="qrcode-scan" label="SCAN QR CODE" tone="filled" onPress={startScan} style={{ marginBottom: space.lg }} />

        <Card>
          <View style={s.nearbyHead}>
            <View style={{ flex: 1 }}>
              <Text style={t.eyebrow}>ON THIS NETWORK</Text>
              <Text style={t.title}>NEARBY BOXES</Text>
            </View>
            <Button compact label={searching ? 'SEARCHING…' : 'SEARCH AGAIN'} tone="outlined" disabled={searching} onPress={search} />
          </View>
          {found.map((box) => (
            <Pressable key={`${box.host}:${box.port}`} accessibilityRole="button" accessibilityLabel={`Use ${box.name ?? box.host}`} onPress={() => pick(box)} style={[s.found, address === (box.port === COMPANION_PORT ? box.host : `${box.host}:${box.port}`) && { borderColor: color.primary }]}>
              <MaterialCommunityIcons name="television-classic" size={22} color={color.primary} />
              <View style={{ flex: 1 }}>
                <Text style={t.title} numberOfLines={1}>{(box.name ?? 'RERUNTV BOX').toUpperCase()}</Text>
                <Text style={t.label}>{box.host}</Text>
              </View>
              <Text style={t.label}>USE</Text>
            </Pressable>
          ))}
          {searching && !found.length ? <Text style={[t.label, { marginTop: space.sm }]}>SEARCHING{progress ? ` · ${progress.done}/${progress.total}` : '…'}</Text> : null}
          {!searching && !found.length ? <Text style={[t.body, { color: color.onSurfaceVariant, marginTop: space.sm }]}>{searchNote ?? 'No box found. Make sure the Companion service is on and this phone is on the same Wi-Fi, or type the address below.'}</Text> : null}
        </Card>

        <Card>
          <Text style={t.label}>BOX ADDRESS</Text>
          <TextInput
            style={s.input}
            value={address}
            onChangeText={setAddress}
            placeholder="192.168.1.20"
            placeholderTextColor={color.outline}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel="Box address"
          />
          <Text style={[t.label, { marginTop: space.md }]}>PAIRING CODE</Text>
          <TextInput
            style={[s.input, s.codeInput]}
            value={code}
            onChangeText={setCode}
            placeholder="00000000"
            placeholderTextColor={color.outline}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="number-pad"
            maxLength={16}
            accessibilityLabel="Pairing code"
            onSubmitEditing={() => connect()}
          />
          {error ? (
            <View style={s.error}>
              <MaterialCommunityIcons name="alert-circle-outline" size={18} color={color.onErrorContainer} />
              <Text style={[t.body, { color: color.onErrorContainer, flex: 1 }]}>{error}</Text>
            </View>
          ) : null}
          <Button label={busy ? 'PAIRING…' : 'PAIR'} tone="filled" disabled={busy} onPress={() => connect()} style={{ marginTop: space.lg }} />
        </Card>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  page: { paddingHorizontal: space.lg },
  brand: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.xl },
  input: { marginTop: space.sm, minHeight: 52, borderRadius: shape.sm, borderWidth: 1, borderColor: color.outline, backgroundColor: color.surfaceDim, color: color.onSurface, paddingHorizontal: space.md, fontSize: 16, fontWeight: '700' },
  codeInput: { fontSize: 24, letterSpacing: 6, textAlign: 'center' },
  error: { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: color.errorContainer, borderRadius: shape.sm, padding: space.md, marginTop: space.md },
  nearbyHead: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.sm },
  found: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 56, paddingHorizontal: space.md, borderRadius: shape.md, borderWidth: 1, borderColor: color.outlineVariant, backgroundColor: color.surfaceContainerHigh, marginTop: space.sm },
  scanOverlay: { flex: 1, alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, backgroundColor: 'rgba(0,0,0,0.25)' },
  reticle: { width: 240, height: 240, borderRadius: shape.xl, borderWidth: 3, borderColor: color.primary },
});
