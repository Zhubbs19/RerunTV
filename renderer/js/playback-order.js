import { hashString, mulberry32 } from './util.js';

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function naturalFileOrder(files) {
  return files.slice().sort((a, b) => naturalCollator.compare(a.title || a.path || '', b.title || b.path || ''));
}

export function folderFileOrder(files, folders) {
  const rank = new Map((folders || []).map((folder, index) => [typeof folder === 'string' ? folder : folder.id, index]));
  return files.slice().sort((a, b) =>
    (rank.get(a.folder) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.folder) ?? Number.MAX_SAFE_INTEGER) ||
    naturalCollator.compare(a.path || '', b.path || ''));
}

export function seededFileOrder(files, seed) {
  const out = files.slice();
  const random = mulberry32(hashString(String(seed || 'reruntv')));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function fileAtOrder(files, anchor, atMs) {
  const total = files.reduce((sum, file) => sum + Math.max(0, file.duration || 0), 0);
  if (!files.length || !anchor || !total) return null;
  const elapsed = ((((atMs - anchor) / 1000) % total) + total) % total;
  let cursor = 0;
  for (const file of files) {
    if (elapsed < cursor + (file.duration || 0)) return file;
    cursor += file.duration || 0;
  }
  return files[0];
}
