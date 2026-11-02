// throwaway probe: split concatenated zstd frames by magic and decode each, then summarize a DSH session log
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const file = process.argv[2];
const buf = readFileSync(file);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const starts = [];
for (let i = 0; i + 4 <= buf.length; i++) if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i);
starts.push(buf.length);
let text = '';
let frames = 0;
for (let k = 0; k + 1 < starts.length; k++) {
  const slice = buf.subarray(starts[k], starts[k + 1]);
  let out;
  try { out = zstdDecompressSync(slice); } catch { continue; }
  frames++;
  text += out.toString('utf8');
}
const lines = text.split('\n').filter(Boolean);
const types = new Map();
const sources = new Map();
const endings = new Map();
let retrySample;
let errorSample;
for (const line of lines) {
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  const type = ev?.type ?? '(envelope)';
  types.set(type, (types.get(type) ?? 0) + 1);
  if (type === 'user/message') {
    const key = JSON.stringify(ev.data?.source ?? null);
    sources.set(key, (sources.get(key) ?? 0) + 1);
  }
  if (type === 'turn/end') {
    const r = ev.data?.reason;
    const key = r?.kind ?? '(none)';
    endings.set(key, (endings.get(key) ?? 0) + 1);
    if ((key === 'error' || key === 'aborted') && !errorSample) errorSample = JSON.stringify(r);
  }
  if (type === 'llm/retry' && !retrySample) retrySample = JSON.stringify(ev.data);
}
console.log('FILE', file);
console.log('FRAMES', frames, 'LINES', lines.length);
console.log('EVENT TYPES', [...types].sort((a, b) => b[1] - a[1]).slice(0, 24));
console.log('USER MESSAGE SOURCES', [...sources]);
console.log('TURN END REASONS', [...endings]);
console.log('LLM RETRY SAMPLE', retrySample);
console.log('TURN ERROR SAMPLE', errorSample);
