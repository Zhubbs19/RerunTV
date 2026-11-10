// CALENDAR: a channel's schedule calendar, the same month view as the box's
// SCHEDULE › CALENDAR. Each day shows which block (or the channel's own
// folder) airs, overlaps and blocks with no folder; a day opens its detail,
// where a block can be added for that day, opened for editing, or (for a
// daily or weekly block) given that day's override. Every edit goes to the
// box as a calendar operation (POST /api/calendar) and the month reloads.
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StackHeader } from '../components/Screen';
import { Text } from '../components/Text';
import { Button, Card, Chip, Empty, SectionHeader } from '../components/ui';
import { ApiError } from '../lib/api';
import {
  blankOverride, blockTitle, defaultWeeklyTrigger, describeTrigger, monthGrid, MONTHS, oneDayTrigger, shiftMonth, WEEKDAYS,
  type CalendarBlock, type CalendarDay, type CalendarOp, type CalendarView, type DayOverride,
} from '../lib/calendar';
import { formatChannelNumber } from '../lib/pure';
import { MAX_CONTENT_WIDTH } from '../lib/layout';
import { useBox } from '../lib/session';
import { useLayout } from '../lib/useLayout';
import { makeStyles, shape, space, TARGET, useTheme } from '../theme';

export default function CalendarScreen() {
  const { color, type: t } = useTheme();
  const s = useStyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const layout = useLayout();
  const params = useLocalSearchParams<{ channel?: string }>();
  const { client, channels, hasFeature, showToast } = useBox();
  const [channel, setChannel] = useState<number | null>(params.channel ? Number(params.channel) : null);
  const [view, setView] = useState<CalendarView | null>(null);
  const [month, setMonth] = useState<{ year: number; month: number } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const loadSeq = useRef(0);

  // Start on the first channel when none was passed in.
  useEffect(() => {
    if (channel == null && channels.length) setChannel(channels[0].number);
  }, [channel, channels]);

  const load = useCallback(async () => {
    if (!client || channel == null) return;
    const seq = ++loadSeq.current;
    try {
      const next = await client.calendar(channel, month?.year, month?.month);
      if (seq !== loadSeq.current) return;
      setView(next);
      setError(null);
      if (!month && next.month) setMonth({ year: next.month.year, month: next.month.month });
    } catch (e) {
      if (seq === loadSeq.current) setError(e instanceof ApiError ? e.message : 'The calendar is unavailable.');
    }
  }, [client, channel, month]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  // While the box is scanning a folder for a block, keep the month current.
  const scanning = !!view?.month && Object.values(view.month.scans).some((scan) => scan.state === 'scanning');
  useEffect(() => {
    if (!scanning) return undefined;
    const id = setInterval(() => { void load(); }, 2000);
    return () => clearInterval(id);
  }, [scanning, load]);

  const edit = useCallback(async (ops: CalendarOp[], done?: string): Promise<string[] | null> => {
    if (!client || channel == null || !view) return null;
    setSaving(true);
    try {
      const result = await client.editCalendar(channel, view.revision, ops);
      if (done) showToast(done);
      await load();
      return result.created;
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : 'The box did not take that change.', true);
      await load();
      return null;
    } finally {
      setSaving(false);
    }
  }, [client, channel, view, load, showToast]);

  const openBlock = (id: string) => router.push({ pathname: '/block', params: { channel: String(channel), id } });

  const addBlock = async (trigger: CalendarOp & { op: 'create' }) => {
    const created = await edit([trigger], 'Block added');
    if (created && created[0]) openBlock(created[0]);
  };

  const monthData = view?.month ?? null;
  const days = useMemo(() => new Map((monthData?.days ?? []).map((d) => [d.day, d])), [monthData]);
  const blocksById = useMemo(() => new Map((view?.blocks ?? []).map((b) => [b.id, b])), [view]);
  const today = monthData?.today;
  const selectedDay = selected != null ? days.get(selected) ?? null : null;
  const legend = useMemo(() => {
    const seen = new Map<string, { label: string; color: string }>();
    (monthData?.days ?? []).forEach((d) => { if (d.color && !seen.has(d.label)) seen.set(d.label, { label: d.label, color: d.color }); });
    return [...seen.values()];
  }, [monthData]);

  const go = (delta: number) => {
    if (!month) return;
    setSelected(null);
    setMonth(shiftMonth(month.year, month.month, delta));
  };
  const goToday = () => {
    if (!today) return;
    setMonth({ year: today.year, month: today.month });
    setSelected(today.day);
  };

  if (!hasFeature('calendar')) {
    return (
      <View style={{ flex: 1, backgroundColor: color.surface }}>
        <StackHeader eyebrow="SCHEDULE" title="CALENDAR" onBack={() => router.back()} />
        <View style={{ padding: space.lg }}>
          <Card>
            <Text style={t.title}>UPDATE THE BOX</Text>
            <Text style={[t.body, { color: color.onSurfaceVariant, marginTop: space.sm }]}>This box doesn’t share its schedule calendar with the phone yet. Update RerunTV on the box, then open this again.</Text>
          </Card>
        </View>
      </View>
    );
  }

  const grid = month ? monthGrid(month.year, month.month) : [];
  const channelName = view?.channel.name || channels.find((c) => c.number === channel)?.name || '';

  return (
    <View style={{ flex: 1, backgroundColor: color.surface }}>
      <StackHeader eyebrow="SCHEDULE" title="CALENDAR" onBack={() => router.back()} />
      <ScrollView
        contentContainerStyle={{ paddingTop: space.md, paddingHorizontal: space.lg + Math.max(insets.left, insets.right), paddingBottom: insets.bottom + space.xxl, alignItems: 'center' }}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <View style={{ width: '100%', maxWidth: Math.min(layout.contentWidth, MAX_CONTENT_WIDTH) }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingBottom: space.md }}>
            {channels.map((c) => (
              <Chip key={c.number} label={`${formatChannelNumber(c.number)} ${c.name}`.toUpperCase()} selected={c.number === channel}
                onPress={() => { if (c.number !== channel) { setChannel(c.number); setView(null); setSelected(null); } }} />
            ))}
          </ScrollView>

          {error ? (
            <Card>
              <Text style={[t.body, { color: color.error }]}>{error}</Text>
              <Button label="RETRY" tone="filled" onPress={load} style={{ marginTop: space.md }} />
            </Card>
          ) : null}
          {!view && !error ? <Empty text={channel == null ? 'NO CHANNELS YET' : 'LOADING THE CALENDAR…'} /> : null}

          {view ? (
            <>
              <Card>
                <View style={s.monthBar}>
                  <Button compact icon="chevron-left" accessibilityLabel="Previous month" onPress={() => go(-1)} disabled={!month} />
                  <View style={{ flex: 1, alignItems: 'center' }}>
                    <Text style={t.eyebrow}>CH {formatChannelNumber(view.channel.number)} {channelName.toUpperCase()}</Text>
                    <Text style={t.title}>{month ? `${MONTHS[month.month - 1]} ${month.year}` : 'THIS MONTH'}</Text>
                  </View>
                  <Button compact icon="chevron-right" accessibilityLabel="Next month" onPress={() => go(1)} disabled={!month} />
                </View>
                {monthData ? (
                  <>
                    <View style={s.week}>
                      {WEEKDAYS.map((w) => <Text key={w} style={[t.label, s.weekday]}>{w.slice(0, layout.isCompact ? 1 : 3)}</Text>)}
                    </View>
                    {grid.map((row, ri) => (
                      <View key={ri} style={s.week}>
                        {row.map((day, ci) => (day == null
                          ? <View key={`b${ci}`} style={[s.cell, s.cellBlank]} />
                          : (
                            <DayCell
                              key={day}
                              day={days.get(day) ?? null}
                              number={day}
                              // Seven cells a row leave a phone too little room for a label;
                              // the colour bar and the legend carry it there.
                              compact={Math.min(layout.contentWidth, MAX_CONTENT_WIDTH) < 520}
                              isToday={!!today && today.year === month?.year && today.month === month?.month && today.day === day}
                              isSelected={selected === day}
                              onPress={() => setSelected(selected === day ? null : day)}
                            />
                          )))}
                      </View>
                    ))}
                    <View style={s.monthFoot}>
                      <Button compact icon="calendar-today" label="TODAY" tone="outlined" onPress={goToday} />
                    </View>
                    {legend.length ? (
                      <View style={s.legend}>
                        {legend.map((entry) => (
                          <View key={entry.label} style={s.legendItem}>
                            <View style={[s.swatch, { backgroundColor: entry.color }]} />
                            <Text style={t.label} numberOfLines={1}>{entry.label}</Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                  </>
                ) : (
                  <Text style={[t.body, { color: color.onSurfaceVariant }]}>The box isn’t showing its screen, so it can’t work out each day. The blocks below can still be edited.</Text>
                )}
              </Card>

              {selectedDay && month ? (
                <DayDetail
                  day={selectedDay}
                  month={month}
                  block={selectedDay.blockId ? blocksById.get(selectedDay.blockId) ?? null : null}
                  saving={saving}
                  onEditBlock={openBlock}
                  onAddBlock={() => addBlock({ op: 'create', fields: { trigger: oneDayTrigger(month.month, selectedDay.day) } })}
                  onOverride={(blockId, override) => edit([{ op: 'overrideDay', id: blockId, key: selectedDay.key, override }], override ? 'Day override saved' : 'Day override removed')}
                />
              ) : null}

              <Card>
                <SectionHeader eyebrow={`${view.blocks.length} ON THIS CHANNEL`} title="BLOCKS" />
                <Text style={[t.body, { color: color.onSurfaceVariant, marginBottom: space.md }]}>A block takes over from the channel’s own folder whenever its dates or hours match. The highest priority wins when two match.</Text>
                {view.blocks.length === 0 ? <Empty text="NO BLOCKS YET" /> : null}
                {view.blocks.map((block) => (
                  <BlockRow key={block.id} block={block} color={monthData?.colors[block.id] ?? null} scan={monthData?.scans[block.id]?.text ?? null} onPress={() => openBlock(block.id)} />
                ))}
                <View style={s.row}>
                  <Button style={s.flex} icon="calendar-plus" label="DATE RANGE" sub="NEW BLOCK" disabled={saving}
                    onPress={() => { const d = today ?? { month: 12, day: 1 }; void addBlock({ op: 'create', fields: { trigger: oneDayTrigger(d.month, d.day) } }); }} />
                  <Button style={s.flex} icon="calendar-clock" label="WEEKLY TIME" sub="NEW BLOCK" disabled={saving}
                    onPress={() => { void addBlock({ op: 'create', fields: { trigger: defaultWeeklyTrigger() } }); }} />
                </View>
              </Card>
            </>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function DayCell({ day, number, compact, isToday, isSelected, onPress }: {
  day: CalendarDay | null; number: number; compact: boolean; isToday: boolean; isSelected: boolean; onPress(): void;
}) {
  const { color, type: t } = useTheme();
  const s = useStyles();
  const warn = !!day && (day.overlaps.length > 0 || day.emptyBlocks.length > 0);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      accessibilityLabel={`${number}${day ? `, ${day.label}` : ''}${day?.override ? ', overridden' : ''}${warn ? ', needs a look' : ''}`}
      onPress={onPress}
      style={({ pressed }) => [s.cell, isToday && s.cellToday, isSelected && s.cellSelected, pressed && { opacity: 0.8 }]}
    >
      <View style={s.cellTop}>
        <Text style={[t.label, isSelected && { color: color.onTertiaryContainer }, isToday && { color: color.primary }]}>{number}</Text>
        {warn ? <MaterialCommunityIcons name="alert-outline" size={12} color={color.error} /> : day?.override ? <MaterialCommunityIcons name="pencil" size={12} color={color.tertiary} /> : null}
      </View>
      {/* The bar's colour is the box's own colour for this block, so it matches the box's calendar. */}
      {day?.color ? <View style={[s.bar, { backgroundColor: day.color }]} /> : <View style={[s.bar, { backgroundColor: color.outlineVariant }]} />}
      {!compact && day ? <Text style={[s.cellLabel, isSelected && { color: color.onTertiaryContainer }]} numberOfLines={2} ellipsizeMode="tail">{day.label}</Text> : null}
    </Pressable>
  );
}

function BlockRow({ block, color: swatch, scan, onPress }: { block: CalendarBlock; color: string | null; scan: string | null; onPress(): void }) {
  const { color, type: t } = useTheme();
  const s = useStyles();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${blockTitle(block)}`} onPress={onPress} style={({ pressed }) => [s.blockRow, pressed && { opacity: 0.8 }]}>
      <View style={[s.swatch, { backgroundColor: swatch ?? color.outlineVariant, height: 32 }]} />
      <View style={{ flex: 1 }}>
        <Text style={t.body} numberOfLines={1}>{blockTitle(block)}</Text>
        <Text style={t.label} numberOfLines={2}>
          {block.name ? `${describeTrigger(block.trigger)} · ` : ''}PRIORITY {block.priority}{block.mode !== 'loop' ? ` · ${block.mode.toUpperCase()}` : ''} · {block.folder ? `${block.fileCount} VIDEOS` : 'NO FOLDER'}
        </Text>
        {scan ? <Text style={[t.label, { color: color.tertiary }]}>{scan}</Text> : null}
      </View>
      <MaterialCommunityIcons name="chevron-right" size={24} color={color.onSurfaceVariant} />
    </Pressable>
  );
}

function DayDetail({ day, month, block, saving, onEditBlock, onAddBlock, onOverride }: {
  day: CalendarDay; month: { year: number; month: number }; block: CalendarBlock | null; saving: boolean;
  onEditBlock(id: string): void; onAddBlock(): void; onOverride(blockId: string, override: DayOverride | null): Promise<unknown>;
}) {
  const { color, type: t } = useTheme();
  const s = useStyles();
  const date = new Date(month.year, month.month - 1, day.day);
  return (
    <Card>
      <SectionHeader eyebrow={WEEKDAYS[date.getDay()]} title={`${MONTHS[month.month - 1]} ${day.day}, ${month.year}`} />
      <View style={s.detailLine}>
        {day.color ? <View style={[s.swatch, { backgroundColor: day.color }]} /> : null}
        <Text style={[t.body, { flex: 1 }]}>AIRING: {day.label}</Text>
      </View>
      {day.atNoon ? <Text style={[t.label, { marginTop: space.xs }]}>AT NOON: {day.atNoon.toUpperCase()}</Text> : null}
      {day.overlaps.length ? (
        <Text style={[t.label, { color: color.error, marginTop: space.sm }]}>OVERLAPS: {day.overlaps.map((o) => o.label).join(' VS. ')}. THE HIGHEST PRIORITY WINS.</Text>
      ) : null}
      {day.emptyBlocks.length ? (
        <Text style={[t.label, { color: color.error, marginTop: space.sm }]}>NO FOLDER SET, WON’T AIR: {day.emptyBlocks.map((o) => o.label).join(', ')}</Text>
      ) : null}
      <View style={s.row}>
        {block ? <Button style={s.flex} icon="calendar-edit" label="EDIT BLOCK" tone="filled" onPress={() => onEditBlock(block.id)} /> : null}
        {!block ? <Button style={s.flex} icon="calendar-plus" label="ADD BLOCK" sub="FOR THIS DAY" tone="filled" disabled={saving} onPress={onAddBlock} /> : null}
        {day.emptyBlocks.map((b) => <Button key={b.id} style={s.flex} icon="folder-outline" label="SET FOLDER" sub={b.label.slice(0, 18)} onPress={() => onEditBlock(b.id)} />)}
      </View>
      {block && day.isDaily ? <OverrideEditor key={`${block.id}-${day.key}`} block={block} day={day} saving={saving} onSave={(o) => onOverride(block.id, o)} /> : null}
    </Card>
  );
}

// One day's exception on a daily or weekly block: a pinned video, a title,
// an unlock time, skip, and a setup-only note. The same fields as the box's.
function OverrideEditor({ block, day, saving, onSave }: { block: CalendarBlock; day: CalendarDay; saving: boolean; onSave(o: DayOverride | null): Promise<unknown> }) {
  const { color, type: t } = useTheme();
  const s = useStyles();
  const existing = block.dayOverrides[day.key] ?? null;
  const [draft, setDraft] = useState<DayOverride>(existing ?? blankOverride());
  const [fileQuery, setFileQuery] = useState('');
  const files = block.files.filter((f) => !fileQuery || f.title.toLowerCase().includes(fileQuery.toLowerCase())).slice(0, 40);
  if (!existing) {
    return (
      <View style={{ marginTop: space.md }}>
        <Text style={[t.body, { color: color.onSurfaceVariant }]}>{blockTitle(block)} runs {block.mode === 'weekly' ? 'one video a week' : 'one video a day'}. Override this day to pin a video, retitle it, unlock it later or skip it.</Text>
        <Button icon="pencil" label={`OVERRIDE ${Number(day.key.slice(0, 2))}/${day.day}`} disabled={saving} style={{ marginTop: space.sm }} onPress={() => { void onSave(blankOverride()); }} />
      </View>
    );
  }
  const set = (patch: Partial<DayOverride>) => setDraft((d) => ({ ...d, ...patch }));
  return (
    <View style={s.override}>
      <Text style={t.eyebrow}>THIS DAY’S OVERRIDE</Text>
      <Text style={[t.label, { marginTop: space.sm }]}>VIDEO</Text>
      {block.files.length > 8 ? <TextInput style={s.input} value={fileQuery} onChangeText={setFileQuery} placeholder="Find a video" placeholderTextColor={color.outline} /> : null}
      <View style={s.chips}>
        <Chip label="AUTO" selected={!draft.file} onPress={() => set({ file: null })} />
        {files.map((f) => <Chip key={f.path} label={f.title.toUpperCase()} selected={draft.file === f.path} onPress={() => set({ file: f.path })} />)}
      </View>
      <Text style={[t.label, { marginTop: space.sm }]}>TITLE ON SCREEN</Text>
      <TextInput style={s.input} value={draft.title} onChangeText={(title) => set({ title })} placeholder="Title override" placeholderTextColor={color.outline} />
      <Text style={[t.label, { marginTop: space.sm }]}>UNLOCKS AT (HH:MM)</Text>
      <TextInput style={s.input} value={draft.unlockTime} onChangeText={(unlockTime) => set({ unlockTime })} placeholder="e.g. 18:00" keyboardType="numbers-and-punctuation" placeholderTextColor={color.outline} />
      <Text style={[t.label, { marginTop: space.sm }]}>NOTE (SETUP ONLY)</Text>
      <TextInput style={s.input} value={draft.note} onChangeText={(note) => set({ note })} placeholder="Note" placeholderTextColor={color.outline} />
      <View style={s.chips}>
        <Chip icon={draft.skip ? 'checkbox-marked' : 'checkbox-blank-outline'} label="SKIP THIS DAY" selected={draft.skip} onPress={() => set({ skip: !draft.skip })} />
      </View>
      <View style={s.row}>
        <Button style={s.flex} icon="content-save-outline" label="SAVE DAY" tone="filled" disabled={saving} onPress={() => { void onSave(draft); }} />
        <Button style={s.flex} icon="delete-outline" label="REMOVE" tone="error" disabled={saving} onPress={() => { void onSave(null); }} />
      </View>
    </View>
  );
}

const useStyles = makeStyles((color) => ({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  flex: { flex: 1, minWidth: 120 },
  monthBar: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.md },
  monthFoot: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: space.sm },
  week: { flexDirection: 'row', gap: 4, marginBottom: 4 },
  weekday: { flex: 1, textAlign: 'center' },
  cell: { flex: 1, minHeight: 52, borderRadius: shape.sm, backgroundColor: color.surfaceContainerHigh, padding: 4, gap: 3, borderWidth: 1, borderColor: 'transparent' },
  cellBlank: { backgroundColor: 'transparent' },
  cellToday: { borderColor: color.primary },
  cellSelected: { backgroundColor: color.tertiaryContainer },
  cellTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cellLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 0.3, color: color.onSurfaceVariant },
  bar: { height: 6, borderRadius: 3 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginTop: space.md },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: space.xs, maxWidth: '100%' },
  swatch: { width: 12, height: 12, borderRadius: 3 },
  detailLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  blockRow: { minHeight: TARGET + 8, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.outlineVariant },
  override: { marginTop: space.md, padding: space.md, borderRadius: shape.md, backgroundColor: color.surfaceContainerHigh, borderWidth: 1, borderColor: color.outlineVariant },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  input: { marginTop: space.xs, minHeight: 44, borderRadius: shape.sm, borderWidth: 1, borderColor: color.outline, backgroundColor: color.surfaceDim, color: color.onSurface, paddingHorizontal: space.md, paddingVertical: space.sm, fontSize: 15, fontWeight: '600' },
}));
