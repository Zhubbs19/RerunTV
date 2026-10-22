// Finding a RerunTV box on the local network without typing its address.
//
// Two methods run side by side:
//  1. UDP broadcast: the box listens on port 41234 and answers a one-line
//     request with its name and ports (main/lan/discovery-server.js). Needs a
//     native module, so it only works in a development or release build, and
//     iOS may restrict broadcast sockets. It is tried and skipped quietly when
//     unavailable.
//  2. Subnet scan: ask every address on the phone's /24 whether the companion
//     port answers with the box's pairing page. Plain HTTP, so it works
//     everywhere including Expo Go. It takes a few seconds.
export const COMPANION_PORT = 8725;
export const DISCOVERY_PORT = 41234;
export const DISCOVERY_MAGIC = 'RETRO_CABLE_BOX_DISCOVER';
export const DISCOVERY_REPLY_MAGIC = 'RETRO_CABLE_BOX_HELLO';

export interface FoundBox {
  host: string;
  port: number;
  name: string | null;
  via: 'udp' | 'scan';
}

// ---------- pure helpers ----------

export function isIPv4(text: string): boolean {
  const parts = text.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

// Every other address on the same /24 as `ip`, nearest first (boxes are often
// close to the phone's own address on a home router).
export function subnetCandidates(ip: string): string[] {
  if (!isIPv4(ip)) return [];
  const parts = ip.split('.');
  const own = Number(parts[3]);
  const prefix = parts.slice(0, 3).join('.');
  const hosts: number[] = [];
  for (let i = 1; i <= 254; i += 1) if (i !== own) hosts.push(i);
  hosts.sort((a, b) => Math.abs(a - own) - Math.abs(b - own));
  return hosts.map((n) => `${prefix}.${n}`);
}

// What an unpaired GET / on the companion port looks like.
export function looksLikeCompanionPairing(status: number, body: string): boolean {
  if (status !== 200 && status !== 401) return false;
  return /Companion pairing/i.test(body) && /RerunTV/i.test(body);
}

export function parseDiscoveryReply(text: string, address: string): FoundBox | null {
  try {
    const reply = JSON.parse(text) as { magic?: string; companionPort?: number | null; name?: string };
    if (reply.magic !== DISCOVERY_REPLY_MAGIC) return null;
    if (typeof reply.companionPort !== 'number') return null; // the box has its companion service switched off
    return { host: address, port: reply.companionPort, name: reply.name ?? null, via: 'udp' };
  } catch {
    return null;
  }
}

// Same box found twice (UDP and scan) collapses to one row, keeping the named one.
export function mergeFound(list: FoundBox[], next: FoundBox): FoundBox[] {
  const existing = list.find((b) => b.host === next.host && b.port === next.port);
  if (!existing) return [...list, next];
  if (existing.name || !next.name) return list;
  return list.map((b) => (b === existing ? { ...b, name: next.name } : b));
}

// ---------- subnet scan ----------

export interface ScanOptions {
  port?: number;
  concurrency?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onFound?: (box: FoundBox) => void;
  onProgress?: (done: number, total: number) => void;
  fetchImpl?: typeof fetch;
}

async function probe(host: string, port: number, timeoutMs: number, fetchImpl: typeof fetch, outer?: AbortSignal): Promise<FoundBox | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  outer?.addEventListener('abort', onAbort);
  try {
    const response = await fetchImpl(`http://${host}:${port}/`, { signal: controller.signal, headers: { Accept: 'text/html' } });
    const body = await response.text();
    return looksLikeCompanionPairing(response.status, body) ? { host, port, name: null, via: 'scan' } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

export async function scanHosts(hosts: string[], options: ScanOptions = {}): Promise<FoundBox[]> {
  const { port = COMPANION_PORT, concurrency = 48, timeoutMs = 900, signal, onFound, onProgress, fetchImpl = fetch } = options;
  const found: FoundBox[] = [];
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < hosts.length && !signal?.aborted) {
      const host = hosts[next];
      next += 1;
      const box = await probe(host, port, timeoutMs, fetchImpl, signal);
      done += 1;
      onProgress?.(done, hosts.length);
      if (box) { found.push(box); onFound?.(box); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return found;
}

// ---------- UDP (native module, best effort) ----------

interface UdpSocket {
  bind(port: number, cb?: () => void): void;
  on(event: string, cb: (...args: any[]) => void): void;
  setBroadcast(flag: boolean): void;
  send(msg: unknown, offset: number, length: number, port: number, address: string, cb?: (err?: Error) => void): void;
  close(): void;
}

export async function udpBroadcast(onFound: (box: FoundBox) => void, listenMs = 2500, signal?: AbortSignal): Promise<boolean> {
  let dgram: { createSocket(options: { type: 'udp4' }): UdpSocket } | null = null;
  let BufferImpl: { from(text: string): unknown } | null = null;
  try {
    // Absent in Expo Go; present once a development build includes react-native-udp.
    dgram = require('react-native-udp'); // eslint-disable-line @typescript-eslint/no-require-imports
    BufferImpl = require('buffer').Buffer; // eslint-disable-line @typescript-eslint/no-require-imports
  } catch {
    return false;
  }
  if (!dgram || !BufferImpl || typeof dgram.createSocket !== 'function') return false;
  return new Promise<boolean>((resolve) => {
    let socket: UdpSocket;
    const finish = (ok: boolean) => {
      try { socket.close(); } catch { /* already closed */ }
      resolve(ok);
    };
    try {
      socket = dgram!.createSocket({ type: 'udp4' });
      socket.on('error', () => finish(false));
      socket.on('message', (msg: { toString(enc?: string): string }, rinfo: { address: string }) => {
        const box = parseDiscoveryReply(msg.toString('utf8'), rinfo.address);
        if (box) onFound(box);
      });
      socket.bind(0, () => {
        try {
          socket.setBroadcast(true);
          const payload = BufferImpl!.from(DISCOVERY_MAGIC) as { length: number };
          socket.send(payload, 0, payload.length, DISCOVERY_PORT, '255.255.255.255', (err) => { if (err) finish(false); });
          signal?.addEventListener('abort', () => finish(true));
          setTimeout(() => finish(true), listenMs);
        } catch {
          finish(false);
        }
      });
    } catch {
      resolve(false);
    }
  });
}

// ---------- everything together ----------

export interface DiscoverOptions {
  signal?: AbortSignal;
  onFound(box: FoundBox): void;
  onProgress?(done: number, total: number): void;
  /** Called once with how the search is going: which methods ran. */
  onMethods?(methods: { udp: boolean; scan: boolean; localIp: string | null }): void;
}

export async function discoverBoxes(options: DiscoverOptions): Promise<void> {
  const { signal, onFound, onProgress, onMethods } = options;
  let localIp: string | null = null;
  try {
    const Network = await import('expo-network');
    const ip = await Network.getIpAddressAsync();
    localIp = ip && isIPv4(ip) && ip !== '0.0.0.0' ? ip : null;
  } catch {
    localIp = null;
  }
  const udp = udpBroadcast(onFound, 2500, signal);
  const scan = localIp ? scanHosts(subnetCandidates(localIp), { signal, onFound, onProgress }) : Promise.resolve(null);
  const [udpRan] = await Promise.all([udp, scan]);
  onMethods?.({ udp: udpRan, scan: localIp !== null, localIp });
}
