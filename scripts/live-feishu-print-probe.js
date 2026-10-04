#!/usr/bin/env node
/**
 * Ask Feishu what it accepts for streaming_config print parameters, then push a known character
 * rate into one real card so the typewriter speed can be judged on a phone.
 *
 * Feishu documents neither the unit nor the range of print_frequency_ms / print_step, and
 * `native-streaming.ts` currently hard-codes 70/1 (= 14 characters per second). This probe turns
 * that guess into a measurement instead of picking numbers out of the air.
 *
 * Output is limited to variable *names*, platform codes and IDs — no credential is ever printed or
 * written to disk.
 *
 * Usage:
 *   node scripts/live-feishu-print-probe.js                      # sweep, then one rate test
 *   node scripts/live-feishu-print-probe.js --phase sweep
 *   node scripts/live-feishu-print-probe.js --phase rate --freq 50 --step 20 --frames 8 --chars 300
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@larksuiteoapi/node-sdk';

const TLIVE_HOME = process.env.TLIVE_HOME || join(homedir(), '.tlive');
const SERVER_CONFIG_FILE = join(TLIVE_HOME, 'server.env');
const CHAT_ID_FILE = join(TLIVE_HOME, 'runtime', 'chat-ids.json');
const RESULT_FILE = join(TLIVE_HOME, 'runtime', 'native-print-probe.json');
const ELEMENT_ID = 'probebody0000001';
const CREATE_SPACING_MS = 130;
const FREQ_GRID = [20, 30, 50, 70, 100];
const STEP_GRID = [1, 5, 20, 60, 100];
const SENTINELS = [
  { print_frequency_ms: 1, print_step: 20, print_strategy: 'fast' },
  { print_frequency_ms: 100000, print_step: 20, print_strategy: 'fast' },
  { print_frequency_ms: 50, print_step: 0, print_strategy: 'fast' },
  { print_frequency_ms: 50, print_step: 999999, print_strategy: 'fast' },
  { print_frequency_ms: 50, print_step: 20, print_strategy: 'delay' },
  { print_frequency_ms: 50, print_step: 20, print_strategy: 'instant' },
];

function loadEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const raw = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const key = raw.slice(0, eq).trim();
    let value = raw.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value.replace(/'\\''/g, "'");
  }
  return env;
}

function parseArgs(argv) {
  const numeric = ['freq', 'step', 'frames', 'chars', 'interval', 'tail', 'rate'];
  const options = {
    phase: 'all',
    freq: 50,
    step: 20,
    strategy: 'fast',
    frames: 8,
    chars: 300,
    interval: 1000,
    tail: 8000,
    rate: 300,
    chat: '',
    send: true,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!flag.startsWith('--')) continue;
    const key = flag.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : 'true';
    if (key === 'no-send') options.send = false;
    else if (key === 'chat') options.chat = value;
    else if (key === 'phase') options.phase = value;
    else if (key === 'strategy') options.strategy = value;
    else if (numeric.includes(key)) options[key] = Number(value);
    else throw new Error(`Unknown flag --${key}`);
  }
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Characters per second the client is told to print, per print_step characters every print_frequency_ms. */
function printRate(freq, step) {
  return freq > 0 ? Math.round((1000 * step) / freq) : 0;
}

function probeCard(freq, step, strategy, content) {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      streaming_mode: true,
      streaming_config: {
        print_frequency_ms: { default: freq },
        print_step: { default: step },
        print_strategy: strategy,
      },
    },
    header: {
      title: { tag: 'plain_text', content: 'CardKit 打印速率探针' },
      template: 'blue',
    },
    body: { elements: [{ tag: 'markdown', element_id: ELEMENT_ID, content }] },
  };
}

function codeOf(error, response) {
  const value = response ?? error;
  const code = value?.code ?? value?.response?.data?.code ?? error?.code;
  return Number.isFinite(Number(code)) ? Number(code) : undefined;
}

function messageOf(error, response) {
  const value = response ?? error;
  const text = String(value?.msg ?? value?.message ?? error?.message ?? error ?? '');
  return text.replace(/\s+/g, ' ').slice(0, 200);
}

async function createEntity(client, card, probe, results) {
  const label = `${probe.kind} freq=${probe.freq} step=${probe.step} strategy=${probe.strategy}`;
  let entry;
  try {
    const response = await client.cardkit.v1.card.create({
      data: { type: 'card_json', data: JSON.stringify(card) },
    });
    const code = codeOf(undefined, response);
    entry = { label, ...probe, code, message: messageOf(undefined, response), cardId: response?.data?.card_id };
  } catch (error) {
    entry = { label, ...probe, code: codeOf(error), message: messageOf(error) };
  }
  results.push(entry);
  console.log(
    `${entry.code === 0 ? '接受  ' : '拒绝  '} ${label.padEnd(52)} rate=${String(printRate(entry.freq, entry.step)).padStart(6)}/s code=${entry.code ?? 'n/a'} ${entry.cardId ?? ''} ${entry.message ?? ''}`,
  );
  await sleep(CREATE_SPACING_MS);
  return entry;
}

async function sweep(client, results) {
  console.log('\n== 第 1 步：问平台接受哪些 print 取值（只建实体，不发消息） ==');
  for (const freq of FREQ_GRID) {
    for (const step of STEP_GRID) {
      await createEntity(
        client,
        probeCard(freq, step, 'fast', '探测中…'),
        { kind: 'grid', freq, step, strategy: 'fast' },
        results,
      );
    }
  }
  for (const sentinel of SENTINELS) {
    await createEntity(
      client,
      probeCard(sentinel.print_frequency_ms, sentinel.print_step, sentinel.print_strategy, '探测中…'),
      {
        kind: 'sentinel',
        freq: sentinel.print_frequency_ms,
        step: sentinel.print_step,
        strategy: sentinel.print_strategy,
      },
      results,
    );
  }
}

function bestAccepted(results, wantedRate) {
  const accepted = results.filter((item) => item.code === 0 && item.kind === 'grid');
  const enough = accepted.filter((item) => printRate(item.freq, item.step) >= wantedRate);
  const ranked = enough.length ? enough : accepted;
  return ranked.sort((a, b) => printRate(b.freq, b.step) - printRate(a.freq, a.step))[0];
}

async function rateTest(client, options, chatId, results) {
  const rate = printRate(options.freq, options.step);
  console.log(`\n== 第 2 步：真机量速率 freq=${options.freq} step=${options.step} strategy=${options.strategy} → 声称 ${rate} 字符/秒 ==`);
  const entry = await createEntity(
    client,
    probeCard(options.freq, options.step, options.strategy, '等待第一帧…'),
    { kind: 'rate-test', freq: options.freq, step: options.step, strategy: options.strategy },
    results,
  );
  if (!entry.cardId) {
    console.log('实体创建失败，无法继续速率测试。');
    return;
  }
  if (!options.send) {
    console.log(`--no-send：只建实体 ${entry.cardId}，不发送到聊天。`);
    return;
  }
  const sent = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify({ type: 'card', data: { card_id: entry.cardId } }),
    },
  });
  const messageId = sent?.data?.message_id;
  console.log(`已发送测试卡 code=${sent?.code} message_id=${messageId ?? ''} card_id=${entry.cardId}`);
  if (!messageId) throw new Error('发送测试卡未返回 message_id');

  let cumulative = '';
  for (let frame = 1; frame <= options.frames; frame++) {
    const stamp = new Date().toISOString().slice(11, 23);
    let chunk = '';
    while (chunk.length < options.chars) {
      chunk += `[F${String(frame).padStart(2, '0')}] 第${frame}帧 ${Math.random().toString(36).slice(2, 12)} 探测字符段 `;
    }
    cumulative += chunk.slice(0, options.chars);
    const response = await client.cardkit.v1.cardElement.content({
      path: { card_id: entry.cardId, element_id: ELEMENT_ID },
      data: { content: cumulative, sequence: frame, uuid: randomUUID() },
    });
    console.log(
      `${stamp} 帧 ${frame}/${options.frames} 累计 ${cumulative.length} 字 code=${codeOf(undefined, response) ?? 'n/a'} ${messageOf(undefined, response)}`,
    );
    await sleep(options.interval);
  }
  console.log(
    `\n注入已结束：${options.frames} 帧 × ${options.chars} 字符 = ${cumulative.length} 字，每 ${options.interval}ms 一帧。`,
  );
  console.log(
    `若打印速率真的够，最后一帧应在约 ${rate > 0 ? Math.ceil((options.chars / rate) * 1000) : '∞'}ms 内打完；等 ${Math.round(options.tail / 1000)}s 后看卡片是否已经停在全文。`,
  );
  await sleep(options.tail);
  const closed = await client.cardkit.v1.card.settings({
    path: { card_id: entry.cardId },
    data: {
      settings: JSON.stringify({ config: { streaming_mode: false } }),
      sequence: options.frames + 1,
      uuid: randomUUID(),
    },
  });
  console.log(`已关闭流式 code=${codeOf(undefined, closed) ?? 'n/a'} ${messageOf(undefined, closed)}`);
  entry.totalChars = cumulative.length;
  entry.messageId = String(messageId);
}

const options = parseArgs(process.argv.slice(2));
const configEnv = loadEnvFile(SERVER_CONFIG_FILE);
const appId = configEnv.TL_FS_APP_ID || process.env.TL_FS_APP_ID;
const appSecret = configEnv.TL_FS_APP_SECRET || process.env.TL_FS_APP_SECRET;
for (const [name, value] of Object.entries({ TL_FS_APP_ID: appId, TL_FS_APP_SECRET: appSecret })) {
  if (!value) throw new Error(`${name} is missing from ${SERVER_CONFIG_FILE}`);
}
const chatId =
  options.chat ||
  (existsSync(CHAT_ID_FILE) ? JSON.parse(readFileSync(CHAT_ID_FILE, 'utf-8')).feishu : '') ||
  '';
if (!chatId) throw new Error(`No chat id: pass --chat oc_... or populate ${CHAT_ID_FILE}`);

const client = new Client({ appId, appSecret });
const results = [];
console.log(`应用身份来自 ${SERVER_CONFIG_FILE}（变量名 TL_FS_APP_ID / TL_FS_APP_SECRET，取值不打印）`);
console.log(`目标会话 ${chatId}`);

let runRate = options.phase === 'rate';
if (options.phase === 'all' || options.phase === 'sweep') {
  await sweep(client, results);
  const best = bestAccepted(results, options.rate);
  if (best) {
    options.freq = best.freq;
    options.step = best.step;
    options.strategy = best.strategy;
    runRate = options.phase === 'all';
    console.log(
      `\n第 1 步结论：接受档位里速率最高的是 freq=${best.freq} step=${best.step}（${printRate(best.freq, best.step)} 字符/秒，目标 ≥${options.rate}），速率测试用这一档。`,
    );
  } else {
    console.log('\n第 1 步没有任何一档被接受，速率测试跳过。');
  }
}
if (runRate) await rateTest(client, options, chatId, results);

const accepted = results.filter((item) => item.code === 0);
console.log('\n== 汇总 ==');
console.log(
  `尝试 ${results.length} 档，接受 ${accepted.length} 档；接受档位里最高速率 ${Math.max(
    0,
    ...accepted.map((item) => printRate(item.freq, item.step)),
  )} 字符/秒。`,
);
console.log(
  '若所有档位（含 freq=1、step=999999 这类哨兵）都被接受，说明服务端不校验取值，真实范围只能靠手机观察。',
);
writeFileSync(RESULT_FILE, `${JSON.stringify({ ranAt: new Date().toISOString(), options, results }, null, 2)}\n`);
console.log(`明细已写入 ${RESULT_FILE}`);
