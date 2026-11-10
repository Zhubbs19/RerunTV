// BLOCK: one calendar block's editor, the phone's version of the box's
// SCHEDULE › BLOCKS card. Name, a date range or a weekly time, the hours and
// days it narrows to, priority, how a date range runs (loop, a video a day or
// a week), and its folder, picked from the channel folders and scanned on the
// box. SAVE sends only what changed; DELETE removes the block.
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StackHeader } from '../components/Screen';
import { Text } from '../components/Text';
import { Button, Card, Chip, Empty, SectionHeader, Segmented, Stepper } from '../components/ui';
import { ApiError, type FolderEntry } from '../lib/api';
import {
  blockTitle, changedFields, clampDay, convertTrigger, describeTrigger, hourLabel, MONTHS, WEEKDAYS,
  type CalendarBlock, type CalendarView, type DateRangeTrigger, type Trigger,
} from '../lib/calendar';
import { MAX_CONTENT_WIDTH } from '../lib/layout';
import { useBox } from '../lib/session';
import { useLayout } from '../lib/useLayout';
import { makeStyles, shape, space, TARGET, useTheme } from '../theme';

const monthShort = (m: number) => MONTHS[m - 1].slice(0, 3);

export default function BlockScreen() {
  const { color, type: t } = useTheme();
  const s = useStyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const layout = useLayout();
  const params = useLocalSearchParams<{ channel: string; id: string }>();
  const channel = Number(params.channel);
  const { client, showToast } = useBox();
  const [view, setView] = useState<CalendarView | null>(null);
  const [draft, setDraft] = useState<CalendarBlock | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  const saved = view?.blocks.find((b) => b.id === params.id) ?? null;
  const scan = view?.month?.scans[params.id] ?? null;

  const load = useCallback(async (resetDraft: boolean) => {
    if (!client || !Number.isFinite(channel)) return;
    try {
      const next = await client.calendar(channel);
      setView(next);
      setError(null);
      const block = next.blocks.find((b) => b.id === params.id) ?? null;
      if (!block) setError('That block is no longer on this channel.');
      if (block && resetDraft) setDraft(block);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The block could not be loaded.');
    }
  }, [client, channel, params.id]);

  useEffect(() => { void load(true); }, [load]);

  // A folder scan runs on the box; keep reading until it finishes.
  useEffect(() => {
    if (scan?.state !== 'scanning') return undefined;
    const id = setInterval(() => { void load(false); }, 2000);
    return () => clearInterval(id);
  }, [scan?.state, load]);

  const changes = saved && draft ? changedFields(saved, draft) : {};
  const changeCount = Object.keys(changes).length;

  const save = async () => {
    if (!client || !view || !saved || !changeCount) return;
    setSaving(true);
    try {
      await client.editCalendar(channel, view.revision, [{ op: 'update', id: saved.id, fields: changes }]);
      showToast('Block saved');
      await load(true);
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : 'The box did not take that change.', true);
      await load(false);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!client || !view || !saved) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setSaving(true);
    try {
      await client.editCalendar(channel, view.revision, [{ op: 'remove', id: saved.id }]);
      showToast('Block deleted');
      router.back();
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : 'The box did not delete it.', true);
      setConfirmDelete(false);
      await load(false);
    } finally {
      setSaving(false);
    }
  };

  const setTrigger = (trigger: Trigger) => setDraft((d) => (d ? { ...d, trigger } : d));
  const trigger = draft?.trigger ?? null;
  const today = view?.month?.today ?? { month: 12, day: 1 };

  const body = draft && trigger ? (
    <>
      <Card>
        <SectionHeader eyebrow="WHAT IT’S CALLED" title="NAME" />
        <TextInput style={s.input} value={draft.name} maxLength={80} onChangeText={(name) => setDraft({ ...draft, name })} placeholder={describeTrigger(trigger)} placeholderTextColor={color.outline} />
      </Card>

      <Card>
        <SectionHeader eyebrow="WHEN IT AIRS" title={describeTrigger(trigger)} />
        <Segmented<Trigger['type']>
          compact={layout.isCompact}
          value={trigger.type}
          onChange={(type) => setTrigger(convertTrigger(trigger, type, today))}
          options={[
            { value: 'dateRange', label: 'DATE RANGE', icon: 'calendar-range' },
            { value: 'dayOfWeek', label: 'WEEKLY TIME', icon: 'calendar-clock' },
          ]}
        />
        {trigger.type === 'dateRange' ? <DateRangeFields trigger={trigger} onChange={setTrigger} /> : (
          <>
            <View style={s.row}>
              <Stepper label="FROM" value={trigger.startHour} min={0} max={23} wrap format={hourLabel} onChange={(startHour) => setTrigger({ ...trigger, startHour })} />
              <Stepper label="UNTIL" value={trigger.endHour} min={0} max={23} wrap format={hourLabel} onChange={(endHour) => setTrigger({ ...trigger, endHour })} />
            </View>
            <Text style={[t.label, { marginTop: space.xs }]}>THE SAME HOUR FOR BOTH MEANS ALL DAY. AN END BEFORE THE START RUNS PAST MIDNIGHT.</Text>
          </>
        )}
        <Text style={[t.label, { marginTop: space.md }]}>{trigger.type === 'dateRange' ? 'ONLY ON THESE DAYS (NONE = EVERY DAY)' : 'ON THESE DAYS (NONE = EVERY DAY)'}</Text>
        <View style={s.chips}>
          {WEEKDAYS.map((w, i) => {
            const days = trigger.days ?? [];
            const on = days.includes(i);
            return <Chip key={w} label={w} selected={on} onPress={() => setTrigger({ ...trigger, days: on ? days.filter((d) => d !== i) : [...days, i].sort((a, b) => a - b) } as Trigger)} />;
          })}
        </View>
      </Card>

      <Card>
        <SectionHeader eyebrow="WHEN BLOCKS OVERLAP" title="PRIORITY" />
        <View style={s.row}>
          <Stepper value={draft.priority} min={-100} max={100} accessibilityLabel="priority" onChange={(priority) => setDraft({ ...draft, priority })} />
        </View>
        <Text style={[t.label, { marginTop: space.xs }]}>THE HIGHEST NUMBER WINS. DATE RANGES START AT 10, WEEKLY TIMES AT 0.</Text>
        {trigger.type === 'dateRange' ? (
          <>
            <Text style={[t.label, { marginTop: space.md, marginBottom: space.sm }]}>HOW IT RUNS</Text>
            <Segmented<CalendarBlock['mode']>
              compact={layout.isCompact}
              value={draft.mode}
              onChange={(mode) => setDraft({ ...draft, mode })}
              options={[
                { value: 'loop', label: 'LOOP' },
                { value: 'daily', label: 'ONE A DAY' },
                { value: 'weekly', label: 'ONE A WEEK' },
              ]}
            />
            <Text style={[t.label, { marginTop: space.xs }]}>ONE A DAY OR WEEK COUNTS DOWN THROUGH THE FOLDER, LIKE AN ADVENT CALENDAR. EACH DAY CAN BE OVERRIDDEN ON THE CALENDAR.</Text>
          </>
        ) : null}
      </Card>

      <Card>
        <SectionHeader eyebrow="WHAT IT PLAYS" title="FOLDER" />
        <Text style={t.body} numberOfLines={3}>{saved?.folder ?? 'NO FOLDER YET. THE BLOCK WON’T AIR UNTIL IT HAS ONE.'}</Text>
        {saved?.folder ? <Text style={[t.label, { marginTop: space.xs }]}>{saved.fileCount} VIDEOS</Text> : null}
        {scan ? <Text style={[t.label, { marginTop: space.xs, color: scan.state === 'failed' ? color.error : color.tertiary }]}>{scan.text}</Text> : null}
        <Button icon="folder-search-outline" label={saved?.folder ? 'CHANGE FOLDER' : 'CHOOSE FOLDER'} style={{ marginTop: space.md }}
          disabled={scan?.state === 'scanning'} onPress={() => setBrowsing(!browsing)} />
        {browsing ? (
          <FolderPicker
            onCancel={() => setBrowsing(false)}
            onPick={async (root, path) => {
              if (!client || !saved) return;
              setBrowsing(false);
              try {
                await client.setBlockFolder(channel, saved.id, root, path);
                showToast('Scanning the folder on the box');
                await load(false);
              } catch (e) {
                showToast(e instanceof ApiError ? e.message : 'The box could not use that folder.', true);
              }
            }}
          />
        ) : null}
      </Card>

      <Card>
        <Button icon="delete-outline" label={confirmDelete ? 'TAP AGAIN TO DELETE THIS BLOCK' : 'DELETE BLOCK'} tone="error" disabled={saving} onPress={remove} />
        {confirmDelete ? <Button label="KEEP IT" tone="text" style={{ marginTop: space.sm }} onPress={() => setConfirmDelete(false)} /> : null}
      </Card>
    </>
  ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: color.surface }}>
      <StackHeader
        eyebrow="CALENDAR BLOCK"
        title={draft ? blockTitle(draft) : 'BLOCK'}
        onBack={() => router.back()}
        right={<Button compact label={saving ? 'SAVING…' : changeCount ? `SAVE (${changeCount})` : 'SAVE'} tone="filled" disabled={!changeCount || saving} onPress={save} />}
      />
      <ScrollView
        contentContainerStyle={{ paddingTop: space.md, paddingHorizontal: space.lg + Math.max(insets.left, insets.right), paddingBottom: insets.bottom + space.xxl, alignItems: 'center' }}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <View style={{ width: '100%', maxWidth: Math.min(layout.contentWidth, MAX_CONTENT_WIDTH) }}>
          {error ? (
            <Card>
              <Text style={[t.body, { color: color.error }]}>{error}</Text>
              <Button label="BACK TO THE CALENDAR" tone="filled" onPress={() => router.back()} style={{ marginTop: space.md }} />
            </Card>
          ) : null}
          {!draft && !error ? <Empty text="LOADING THE BLOCK…" /> : null}
          {body}
        </View>
      </ScrollView>
    </View>
  );
}

function DateRangeFields({ trigger, onChange }: { trigger: DateRangeTrigger; onChange(t: Trigger): void }) {
  const { type: t } = useTheme();
  const s = useStyles();
  const thanksgiving = trigger.startRule === 'thanksgiving';
  const narrowed = trigger.startHour != null && trigger.endHour != null;
  const set = (patch: Partial<DateRangeTrigger>) => onChange({ ...trigger, ...patch });
  return (
    <>
      <Text style={[t.label, { marginTop: space.md }]}>STARTS</Text>
      {thanksgiving ? <Text style={[t.body, { marginTop: space.xs }]}>ON THANKSGIVING (THE FOURTH THURSDAY OF NOVEMBER)</Text> : (
        <View style={s.row}>
          <Stepper value={trigger.startMonth} min={1} max={12} wrap format={monthShort} accessibilityLabel="start month"
            onChange={(startMonth) => set({ startMonth, startDay: clampDay(startMonth, trigger.startDay) })} />
          <Stepper value={trigger.startDay} min={1} max={clampDay(trigger.startMonth, 31)} wrap accessibilityLabel="start day" onChange={(startDay) => set({ startDay })} />
        </View>
      )}
      <View style={s.chips}>
        <Chip icon={thanksgiving ? 'checkbox-marked' : 'checkbox-blank-outline'} label="START ON THANKSGIVING" selected={thanksgiving}
          onPress={() => onChange(thanksgiving ? (({ startRule, ...rest }) => rest)(trigger) as DateRangeTrigger : { ...trigger, startRule: 'thanksgiving', startMonth: 11, startDay: 22 })} />
      </View>
      <Text style={[t.label, { marginTop: space.md }]}>ENDS</Text>
      <View style={s.row}>
        <Stepper value={trigger.endMonth} min={1} max={12} wrap format={monthShort} accessibilityLabel="end month"
          onChange={(endMonth) => set({ endMonth, endDay: clampDay(endMonth, trigger.endDay) })} />
        <Stepper value={trigger.endDay} min={1} max={clampDay(trigger.endMonth, 31)} wrap accessibilityLabel="end day" onChange={(endDay) => set({ endDay })} />
      </View>
      <View style={s.chips}>
        <Chip icon={narrowed ? 'checkbox-marked' : 'checkbox-blank-outline'} label="ONLY AT CERTAIN HOURS" selected={narrowed}
          onPress={() => onChange(narrowed ? (({ startHour, endHour, ...rest }) => rest)(trigger) as DateRangeTrigger : { ...trigger, startHour: 18, endHour: 22 })} />
      </View>
      {narrowed ? (
        <View style={s.row}>
          <Stepper label="FROM" value={trigger.startHour ?? 18} min={0} max={23} wrap format={hourLabel} onChange={(startHour) => set({ startHour })} />
          <Stepper label="UNTIL" value={trigger.endHour ?? 22} min={0} max={23} wrap format={hourLabel} onChange={(endHour) => set({ endHour })} />
        </View>
      ) : null}
    </>
  );
}

// Folders the phone may pick from: the channel folders the box already uses
// (GET /api/roots) and what's inside them (GET /api/files).
function FolderPicker({ onPick, onCancel }: { onPick(root: string, path: string): void; onCancel(): void }) {
  const { color, type: t } = useTheme();
  const s = useStyles();
  const { client } = useBox();
  const [roots, setRoots] = useState<{ id: string; label: string }[] | null>(null);
  const [root, setRoot] = useState<{ id: string; label: string } | null>(null);
  const [path, setPath] = useState<string[]>([]);
  const [entries, setEntries] = useState<FolderEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    client.roots().then(setRoots).catch((e) => setError(e instanceof ApiError ? e.message : 'No folders.'));
  }, [client]);

  useEffect(() => {
    if (!client || !root) return;
    setEntries(null);
    client.files(root.id, path.join('/')).then((list) => setEntries(list.filter((e) => e.isDir)))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'That folder could not be read.'));
  }, [client, root, path]);

  return (
    <View style={s.picker}>
      <View style={s.pickerHead}>
        {root ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Up a folder" style={s.up}
            onPress={() => { if (path.length) setPath(path.slice(0, -1)); else { setRoot(null); setEntries(null); } }}>
            <MaterialCommunityIcons name="folder-arrow-up-outline" size={22} color={color.primary} />
          </Pressable>
        ) : null}
        <Text style={[t.label, { flex: 1 }]} numberOfLines={2}>{root ? [root.label, ...path].join(' / ').toUpperCase() : 'YOUR CHANNEL FOLDERS'}</Text>
      </View>
      {error ? <Text style={[t.body, { color: color.error }]}>{error}</Text> : null}
      {!root ? (
        roots == null ? <Empty text="LOADING…" /> : roots.length === 0 ? <Empty text="NO CHANNEL FOLDERS ON THE BOX" /> : roots.map((r) => (
          <FolderRow key={r.id} label={r.label} onPress={() => { setRoot(r); setPath([]); }} />
        ))
      ) : entries == null ? <Empty text="LOADING…" /> : (
        <>
          {entries.length === 0 ? <Text style={[t.label, { paddingVertical: space.sm }]}>NO FOLDERS INSIDE</Text> : null}
          {entries.map((e) => <FolderRow key={e.name} label={e.name} onPress={() => setPath([...path, e.name])} />)}
        </>
      )}
      <View style={s.row}>
        <Button style={s.flex} icon="folder-check-outline" label="USE THIS FOLDER" tone="filled" disabled={!root} onPress={() => { if (root) onPick(root.id, path.join('/')); }} />
        <Button style={s.flex} label="CANCEL" tone="outlined" onPress={onCancel} />
      </View>
    </View>
  );
}

function FolderRow({ label, onPress }: { label: string; onPress(): void }) {
  const { color, type: t } = useTheme();
  const s = useStyles();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${label}`} onPress={onPress} style={({ pressed }) => [s.folder, pressed && { opacity: 0.8 }]}>
      <MaterialCommunityIcons name="folder-outline" size={20} color={color.primary} />
      <Text style={[t.body, { flex: 1 }]} numberOfLines={1}>{label}</Text>
      <MaterialCommunityIcons name="chevron-right" size={20} color={color.onSurfaceVariant} />
    </Pressable>
  );
}

const useStyles = makeStyles((color) => ({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginTop: space.sm },
  flex: { flex: 1, minWidth: 120 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  input: { minHeight: 48, borderRadius: shape.sm, borderWidth: 1, borderColor: color.outline, backgroundColor: color.surfaceDim, color: color.onSurface, paddingHorizontal: space.md, paddingVertical: space.sm, fontSize: 15, fontWeight: '600' },
  picker: { marginTop: space.md, padding: space.md, borderRadius: shape.md, backgroundColor: color.surfaceContainerHigh, borderWidth: 1, borderColor: color.outlineVariant },
  pickerHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  up: { width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center', borderRadius: shape.full },
  folder: { minHeight: TARGET, flexDirection: 'row', alignItems: 'center', gap: space.md, borderBottomWidth: 1, borderBottomColor: color.outlineVariant },
}));
