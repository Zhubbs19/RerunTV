// The full box settings editor. A box that serves its settings registry gets
// the same sections and pages as its own setup screen (with a Simple /
// Advanced switch, defaults for settings never saved, and dimmed fields whose
// switch is off); an older box gets the generic tree the web remote offers.
// Either way: search, and one SAVE that the box applies and reports on.
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SearchBar } from '../components/Channels';
import { SettingNodeView, type Draft } from '../components/SettingFields';
import { Text } from '../components/Text';
import { Button, Card, Empty, Segmented } from '../components/ui';
import { MAX_CONTENT_WIDTH } from '../lib/layout';
import { buildGroups, buildRegistryGroups, buildSaveBody, countLeaves, describeResult, filterGroups, setIn, type Catalogue, type Json, type LeafNode, type Level } from '../lib/settings-model';
import { useBox } from '../lib/session';
import { useLayout } from '../lib/useLayout';
import { color, shape, space, TARGET, type as t } from '../theme';

const VERDICT_TIMEOUT_MS = 8000;

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const layout = useLayout();
  const { client, state, channels, showToast } = useBox();
  const [config, setConfig] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [themes, setThemes] = useState<{ id: string; label: string }[]>([]);
  const [pending, setPending] = useState<Record<string, Json>>({});
  const [registryEdits, setRegistryEdits] = useState<Record<string, { path: string[]; value: Json }>>({});
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [level, setLevel] = useState<Level>('basic');
  const [query, setQuery] = useState('');
  // undefined: the first group starts open; null: the viewer closed them all.
  const [openGroup, setOpenGroup] = useState<string | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [verdict, setVerdict] = useState<{ ok: boolean; text: string } | null>(null);
  const lastResultAt = useRef(0);
  const awaiting = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    setLoadError(null);
    try {
      const [cfg, themeList, cat] = await Promise.all([client.config(), client.themes(), client.catalogue()]);
      setConfig(cfg as Draft);
      setDraft(cfg as Draft);
      setThemes(themeList);
      setCatalogue(cat);
      setPending({});
      setRegistryEdits({});
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Settings are unavailable.');
    }
  }, [client]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // The box answers a save in its next /state: applied or refused.
  useEffect(() => {
    const result = state?.settingsResult;
    if (!result || !result.at || result.at === lastResultAt.current) return;
    lastResultAt.current = result.at;
    if (!awaiting.current) return;
    awaiting.current = false;
    if (timer.current) clearTimeout(timer.current);
    setSaving(false);
    setVerdict(describeResult(result));
    void load();
  }, [state?.settingsResult, load]);

  const groups = useMemo(() => {
    if (!config) return [];
    // Search looks through everything, whichever view is on.
    if (catalogue) return buildRegistryGroups(catalogue, config, { themes, channels, level: query.trim() ? 'advanced' : level });
    return buildGroups(config, themes);
  }, [config, themes, catalogue, channels, level, query]);
  const shown = useMemo(() => filterGroups(groups, query), [groups, query]);
  const searching = query.trim().length > 0;
  const changes = Object.keys(pending).length + Object.keys(registryEdits).length;
  const firstOpen = openGroup === undefined ? groups[0]?.title ?? null : openGroup;

  const onChange = useCallback((path: string[], value: Json, node?: LeafNode) => {
    setDraft((d) => setIn(d, path, value));
    if (node?.registry) setRegistryEdits((r) => ({ ...r, [path.join('.')]: { path, value } }));
    else setPending((p) => setIn(p, path, value));
    setVerdict(null);
  }, []);

  async function save() {
    if (!client || !changes) return;
    setSaving(true);
    setVerdict(null);
    awaiting.current = true;
    lastResultAt.current = state?.settingsResult?.at ?? lastResultAt.current;
    try {
      await client.saveSettings(buildSaveBody(pending, registryEdits));
      showToast('Settings sent to the box');
      // An older box never reports back, so do not wait forever.
      timer.current = setTimeout(() => {
        if (!awaiting.current) return;
        awaiting.current = false;
        setSaving(false);
        setVerdict({ ok: true, text: 'Sent. This box did not report back, so check the TV.' });
        void load();
      }, VERDICT_TIMEOUT_MS);
    } catch (e) {
      awaiting.current = false;
      setSaving(false);
      setVerdict({ ok: false, text: e instanceof Error ? e.message : 'The save failed.' });
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.surface }}>
      <View style={[s.bar, { paddingTop: insets.top + space.sm, paddingLeft: space.sm + insets.left, paddingRight: space.lg + insets.right }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={s.back}>
          <MaterialCommunityIcons name="arrow-left" size={24} color={color.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={t.eyebrow}>LIVE BOX CONFIGURATION</Text>
          <Text style={t.headline}>SETTINGS</Text>
        </View>
        <Button compact label={saving ? 'APPLYING…' : changes ? `SAVE (${changes})` : 'SAVE'} tone="filled" disabled={!changes || saving} onPress={save} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingTop: space.md, paddingHorizontal: space.lg + Math.max(insets.left, insets.right), paddingBottom: insets.bottom + space.xxl, alignItems: 'center' }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
      >
        <View style={{ width: '100%', maxWidth: Math.min(layout.contentWidth, MAX_CONTENT_WIDTH) }}>
          {verdict ? (
            <Card style={{ backgroundColor: verdict.ok ? color.tertiaryContainer : color.errorContainer, borderColor: verdict.ok ? color.tertiary : color.error }}>
              <Text style={[t.body, { color: verdict.ok ? color.onTertiaryContainer : color.onErrorContainer }]}>{verdict.text}</Text>
            </Card>
          ) : null}
          {loadError ? (
            <Card>
              <Text style={[t.body, { color: color.error }]}>Settings unavailable: {loadError}</Text>
              <Button label="RETRY" tone="filled" onPress={load} style={{ marginTop: space.md }} />
            </Card>
          ) : null}
          {!config && !loadError ? <Empty text="LOADING SETTINGS…" /> : null}
          {config ? (
            <>
              <SearchBar value={query} onChange={setQuery} placeholder="Search every setting" />
              {catalogue ? (
                <View style={{ marginBottom: space.md }}>
                  <Segmented<Level>
                    compact={layout.isCompact}
                    value={level}
                    onChange={setLevel}
                    options={[
                      { value: 'basic', label: 'SIMPLE', icon: 'tune-variant' },
                      { value: 'advanced', label: 'ADVANCED', icon: 'tune' },
                    ]}
                  />
                </View>
              ) : null}
              <Text style={[t.body, { color: color.onSurfaceVariant, marginBottom: space.md }]}>
                {catalogue
                  ? 'The same sections as the box’s own setup. Change what you like, then SAVE. The PIN lock, network and updates are changed on the box.'
                  : 'Change what you like, then SAVE. TV appearance applies to connected viewers. Advanced lists use JSON editors.'}
              </Text>
              {shown.map((group) => {
                const open = searching || firstOpen === group.title;
                return (
                  <View key={group.title} style={s.group}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ expanded: open }}
                      onPress={() => setOpenGroup(open ? null : group.title)}
                      style={s.groupHead}
                    >
                      <MaterialCommunityIcons name={open ? 'chevron-down' : 'chevron-right'} size={24} color={color.primary} />
                      <Text style={[t.title, { flex: 1, color: color.primary }]}>{group.title}</Text>
                      <Text style={t.label}>{countLeaves(group.nodes)}</Text>
                    </Pressable>
                    {open ? (
                      <View style={{ paddingHorizontal: space.md, paddingBottom: space.md }}>
                        {group.nodes.map((node) => <SettingNodeView key={node.dotted} node={node} draft={draft} onChange={onChange} forceOpen={searching} />)}
                      </View>
                    ) : null}
                  </View>
                );
              })}
              {shown.length === 0 ? <Empty text="NO SETTINGS MATCH" /> : null}
            </>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingBottom: space.sm, backgroundColor: color.surface, borderBottomWidth: 1, borderBottomColor: color.outlineVariant },
  back: { width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center', borderRadius: shape.full },
  group: { borderRadius: shape.lg, backgroundColor: color.surfaceContainer, borderWidth: 1, borderColor: color.outlineVariant, marginBottom: space.md, overflow: 'hidden' },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 56, paddingHorizontal: space.md },
});
