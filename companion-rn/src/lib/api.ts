// The box's companion HTTP API (plugins/companion-app/main.js). Pairing trades
// the 8-digit code for a bearer token (main/lan/security.js); every later
// request carries it. Nothing here touches React.
import { parseTarget, type LineupRow } from './pure';

export interface Session {
  baseUrl: string;
  token: string;
  scope: string;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface PcShutdownStatus {
  allowed: boolean;
  pending: boolean;
  at: number | null;
}

export interface RemoteState {
  number: number | null;
  name: string | null;
  powered?: boolean;
  muted?: boolean;
  volume?: number;
  volumeMax?: number;
  crt?: boolean;
  pictureMode?: string;
  aspectMode?: string;
  audioMode?: string;
  timeMachineOn?: boolean;
  shuttleDir?: number;
  timeOffsetMin?: number;
  recent?: { number: number; name: string | null }[];
  quickJumpSlots?: Record<string, unknown>;
  onAir?: 'content' | 'break';
  breakKind?: string | null;
  nowEndsAtMs?: number | null;
  nextTitle?: string;
  sleepEndsAtMs?: number | null;
  pcShutdown?: PcShutdownStatus | null;
}

const TIMEOUT_MS = 6000;

async function send(url: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    throw new ApiError(0, controller.signal.aborted ? 'The box did not answer in time.' : 'Could not reach the box.');
  } finally {
    clearTimeout(timer);
  }
}

// Exchange a pairing code for a session. The box answers JSON when asked to.
export async function pair(baseUrl: string, code: string): Promise<Session> {
  const target = parseTarget(baseUrl);
  if (!target) throw new ApiError(0, 'That address does not look right.');
  const url = `${target.baseUrl}/?pair=${encodeURIComponent(code)}`;
  const response = await send(url, { headers: { Accept: 'application/json' } });
  if (response.status === 423) throw new ApiError(423, 'Too many wrong codes. Wait a few minutes and try again.');
  if (response.status === 401) throw new ApiError(401, 'That pairing code was not accepted.');
  if (!response.ok) throw new ApiError(response.status, `The box refused pairing (${response.status}).`);
  const body = (await response.json()) as { token?: string; scope?: string };
  if (!body.token) throw new ApiError(500, 'The box did not return a session.');
  return { baseUrl: target.baseUrl, token: body.token, scope: body.scope ?? 'view' };
}

export interface Client {
  state(): Promise<RemoteState>;
  channels(): Promise<LineupRow[]>;
  command(key: string, mods?: { shift?: boolean; ctrl?: boolean; alt?: boolean }): Promise<void>;
  action(action: 'watch-tv' | 'shutdown-pc' | 'cancel-pc-shutdown'): Promise<void>;
  tune(number: number): Promise<void>;
  setFlag(number: number, field: 'favorite' | 'quickAccess', value: boolean): Promise<void>;
  news(headline: string): Promise<void>;
  trivia(): Promise<void>;
  ticker(text: string, enabled: boolean): Promise<void>;
}

export function createClient(session: Session, onUnauthorized: () => void): Client {
  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await send(`${session.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${session.token}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (response.status === 401) {
      onUnauthorized();
      throw new ApiError(401, 'This phone is no longer paired.');
    }
    if (response.status === 429) throw new ApiError(429, 'Slow down. The box is limiting requests.');
    if (!response.ok) throw new ApiError(response.status, `The box answered ${response.status}.`);
    return response;
  }
  const post = (path: string, body: unknown) => call(path, { method: 'POST', body: JSON.stringify(body) }).then(() => undefined);
  return {
    state: async () => (await call('/state')).json() as Promise<RemoteState>,
    channels: async () => {
      const rows = await (await call('/channels')).json();
      return Array.isArray(rows) ? (rows as LineupRow[]) : [];
    },
    command: (key, mods = {}) => post('/command', { key, shift: !!mods.shift, ctrl: !!mods.ctrl, alt: !!mods.alt }),
    action: (action) => post('/command', { action }),
    tune: (number) => post('/tune', { number }),
    setFlag: (number, field, value) => post('/channel/flag', { number, field, value }),
    news: (headline) => post('/news/trigger', { headline }),
    trivia: () => post('/party/trivia/start', {}),
    ticker: (text, enabled) => post('/ticker/set', { text, enabled }),
  };
}
