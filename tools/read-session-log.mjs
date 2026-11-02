// 解开 DSH 会话日志并统计事件，用于验证与排障。
//
// DSH 的 session 文件是多帧拼接的 zstd（每次 flush 一帧），Node 的 zstdDecompressSync
// 只解第一帧，所以这里按帧魔数切开逐帧解压再拼接。
//
// 用法：node tools/read-session-log.mjs <session.v4.jsonl.zstd>
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const file = process.argv[2];
if (file === undefined) {
  console.error('usage: node tools/read-session-log.mjs <session.v4.jsonl.zstd>');
  process.exit(1);
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 把多帧 zstd 文件解成一份 utf8 文本。 */
function decodeFrames(buffer) {
  const starts = [];
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer[i] === ZSTD_MAGIC[0] && buffer[i + 1] === ZSTD_MAGIC[1]
      && buffer[i + 2] === ZSTD_MAGIC[2] && buffer[i + 3] === ZSTD_MAGIC[3]) starts.push(i);
  }
  starts.push(buffer.length);

  let text = '';
  let frames = 0;
  for (let k = 0; k + 1 < starts.length; k += 1) {
    // 魔数可能出现在压缩数据内部，解压失败的就是误判，跳过即可。
    let out;
    try { out = zstdDecompressSync(buffer.subarray(starts[k], starts[k + 1])); } catch { continue; }
    frames += 1;
    text += out.toString('utf8');
  }
  return { text, frames };
}

/** 把一条消息压成一行便于阅读的文本。 */
function summarizeMessage(message) {
  return (message?.content ?? [])
    .map((block) => (block?.type === 'text' ? block.text : `[${block?.type ?? '?'}]`))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const { text, frames } = decodeFrames(readFileSync(file));
const lines = text.split('\n').filter(Boolean);

const types = new Map();
const sources = new Map();
const endings = new Map();
const prompts = [];
let retrySample;
let errorSample;

for (const line of lines) {
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  const type = ev?.type ?? '(envelope)';
  types.set(type, (types.get(type) ?? 0) + 1);

  if (type === 'user/message') {
    const source = ev.data?.source ?? null;
    const key = JSON.stringify(source);
    sources.set(key, (sources.get(key) ?? 0) + 1);
    // 只列真正发给模型的输入（用户输入 + 插件注入），跳过 runtime-context 这类上下文快照。
    if (source?.kind === 'user') {
      const summary = summarizeMessage(ev.data);
      prompts.push(summary.length > 80 ? `${summary.slice(0, 80)}…` : summary);
    }
  }

  if (type === 'turn/end') {
    const reason = ev.data?.reason;
    const key = reason?.kind ?? '(none)';
    endings.set(key, (endings.get(key) ?? 0) + 1);
    if ((key === 'error' || key === 'aborted') && errorSample === undefined) {
      errorSample = JSON.stringify(reason);
    }
  }

  if (type === 'llm/retry' && retrySample === undefined) retrySample = JSON.stringify(ev.data);
}

console.log('FILE', file);
console.log('FRAMES', frames, 'LINES', lines.length);
console.log('EVENT TYPES', [...types].sort((a, b) => b[1] - a[1]).slice(0, 24));
console.log('USER MESSAGE SOURCES', [...sources]);
console.log('USER PROMPTS', prompts);
console.log('TURN END REASONS', [...endings]);
console.log('LLM RETRY SAMPLE', retrySample);
console.log('TURN ERROR SAMPLE', errorSample);
