// The paired box: the saved session, a client for it, and the live state the
// whole app renders from (polled while the app is in the foreground).
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { ApiError, createClient, type Client, type RemoteState, type Session } from './api';
import type { LineupRow } from './pure';

// Storage failures are survivable (the session still works) but should not vanish silently in development.
function warnDev(what: string, error: unknown): void {
  if (__DEV__) console.warn(`[session] ${what}`, error);
}

const STORE_KEY = 'reruntv_session';
const POLL_MS = 1500;
const POLL_OFFLINE_MS = 4000;

export type Connection = 'connecting' | 'online' | 'offline';

interface Keys { shift?: boolean; ctrl?: boolean; alt?: boolean }

interface Ctx {
  loaded: boolean;
  session: Session | null;
  client: Client | null;
  state: RemoteState | null;
  connection: Connection;
  channels: LineupRow[];
  signIn(session: Session): Promise<void>;
  signOut(): Promise<void>;
  refreshChannels(): Promise<void>;
  press(key: string, mods?: Keys): Promise<void>;
  tune(number: number): Promise<void>;
  /** Run a client call with failure feedback; returns whether it worked. */
  run(label: string, fn: (client: Client) => Promise<void>): Promise<boolean>;
  toast: string | null;
  showToast(message: string, isError?: boolean): void;
  toastIsError: boolean;
}

const SessionContext = createContext<Ctx | null>(null);

export function useBox(): Ctx {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useBox outside SessionProvider');
  return ctx;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<RemoteState | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [channels, setChannels] = useState<LineupRow[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [toastIsError, setToastIsError] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollNow = useRef<() => void>(() => {});

  useEffect(() => {
    SecureStore.getItemAsync(STORE_KEY)
      .then((raw) => { if (raw) setSession(JSON.parse(raw) as Session); })
      .catch((e) => warnDev('could not read the saved pairing', e))
      .finally(() => setLoaded(true));
  }, []);

  const signOut = useCallback(async () => {
    setSession(null); setState(null); setChannels([]); setConnection('connecting');
    await SecureStore.deleteItemAsync(STORE_KEY).catch((e) => warnDev('could not forget the saved pairing', e));
  }, []);

  const signIn = useCallback(async (next: Session) => {
    // Failing to remember the pairing must not stop this session from working.
    await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(next)).catch((e) => warnDev('could not remember the pairing', e));
    setSession(next);
  }, []);

  const client = useMemo(() => (session ? createClient(session, () => { void signOut(); }) : null), [session, signOut]);

  const showToast = useCallback((message: string, isError = false) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message); setToastIsError(isError);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  // Poll /state while the app is in front.
  useEffect(() => {
    if (!client) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active = AppState.currentState === 'active';
    const tick = async () => {
      if (stopped || !active) return;
      let delay = POLL_MS;
      try {
        const next = await client.state();
        if (stopped) return;
        setState(next); setConnection('online');
      } catch (e) {
        if (stopped) return;
        setConnection('offline');
        delay = POLL_OFFLINE_MS;
      }
      if (!stopped && active) timer = setTimeout(tick, delay);
    };
    pollNow.current = () => { if (timer) clearTimeout(timer); void tick(); };
    void tick();
    const sub = AppState.addEventListener('change', (status) => {
      active = status === 'active';
      if (active) pollNow.current(); else if (timer) clearTimeout(timer);
    });
    return () => { stopped = true; if (timer) clearTimeout(timer); sub.remove(); };
  }, [client]);

  const refreshChannels = useCallback(async () => {
    if (!client) return;
    try { setChannels(await client.channels()); } catch { /* the lineup keeps its last good copy */ }
  }, [client]);

  useEffect(() => { void refreshChannels(); }, [refreshChannels]);
  // The lineup carries what is on each channel, so refresh it on its own slow clock.
  useEffect(() => {
    if (!client) return undefined;
    const id = setInterval(() => { void refreshChannels(); }, 60000);
    return () => clearInterval(id);
  }, [client, refreshChannels]);

  const run = useCallback(async (label: string, fn: (c: Client) => Promise<void>) => {
    if (!client) return false;
    try {
      await fn(client);
      setTimeout(() => pollNow.current(), 250);
      return true;
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : `${label} failed.`, true);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      return false;
    }
  }, [client, showToast]);

  const press = useCallback(async (key: string, mods?: Keys) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    await run('Button', (c) => c.command(key, mods));
  }, [run]);

  const tune = useCallback(async (number: number) => {
    void Haptics.selectionAsync().catch(() => {});
    await run('Tune', (c) => c.tune(number));
  }, [run]);

  const value = useMemo<Ctx>(() => ({
    loaded, session, client, state, connection, channels, signIn, signOut, refreshChannels, press, tune, run, toast, showToast, toastIsError,
  }), [loaded, session, client, state, connection, channels, signIn, signOut, refreshChannels, press, tune, run, toast, showToast, toastIsError]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
