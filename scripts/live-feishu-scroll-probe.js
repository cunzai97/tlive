#!/usr/bin/env node
/**
 * Ask one question with one real card: does a fixed-height collapsible_panel clip streaming text and
 * keep the newest line in view on its own, or does the client leave the reader to scroll?
 *
 * The production thinking block lives inside a collapsible_panel with no height limit, so a long
 * thought either grows the card forever or gets re-cut — and a re-cut is a rewrite Feishu animates by
 * wiping the block. If a bounded panel scrolls by itself, the body can stay append-only and the
 * typewriter keeps running, which is the only combination that looks like scrolling.
 *
 * One card carries three panels fed the identical growing text: A=300px, B=150px, C=no max_height.
 * Whether the platform *accepts* the field is measurable here; whether it *honours* it is a phone
 * judgement, because Feishu validates neither unknown nor known card fields.
 *
 * Output is limited to variable *names*, platform codes and IDs — no credential is ever printed or
 * written to disk.
 *
 * Usage:
 *   node scripts/live-feishu-scroll-probe.js                       # field sweep, then the A/B/C card
 *   node scripts/live-feishu-scroll-probe.js --phase sweep
 *   node scripts/live-feishu-scroll-probe.js --phase scroll --frames 8 --chars 300 --interval 1000
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@larksuiteoapi/node-sdk';

const TLIVE_HOME = process.env.TLIVE_HOME || join(homedir(), '.tlive');
const SERVER_CONFIG_FILE = join(TLIVE_HOME, 'server.env');
const CHAT_ID_FILE = join(TLIVE_HOME, 'runtime', 'chat-ids.json');
const RESULT_FILE = join(TLIVE_HOME, 'runtime', 'native-scroll-probe.json');
const OP_SPACING_MS = 130;

/** Mirrors the production print settings, so the animation being judged is the one actually shipping. */
const PRINT = { frequencyMs: 10, step: 4, strategy: 'delay' };

const PANELS = [
  { id: 'probescrollA300px', role: 'A', height: '300px', title: 'A · max_height 300px' },
  { id: 'probescrollB150px', role: 'B', height: '150px', title: 'B · max_height 150px' },
  { id: 'probescrollCcontro', role: 'C', height: undefined, title: 'C · 无 max_height（现状对照）' },
];

/** Does the platform take max_height on other containers, and in what value shape? */
const FIELD_PROBES = [
  { where: 'collapsible_panel', value: '300px' },
  { where: 'collapsible_panel', value: '300' },
  { where: 'collapsible_panel', value: 300 },
  { where: 'collapsible_panel', value: '300em' },
  { where: 'collapsible_panel', value: '-1' },
  { where: 'markdown', value: '300px' },
  { where: 'body', value: '300px' },
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
  const numeric = ['frames', 'chars', 'interval', 'tail'];
  const options = {
    phase: 'all',
    frames: 8,
    chars: 300,
    interval: 1000,
    tail: 30000,
    chat: '',
    panels: '',
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
    else if (key === 'panels') options.panels = value.toUpperCase().replace(/[^AB]/g, '');
    else if (numeric.includes(key)) options[key] = Number(value);
    else throw new Error(`Unknown flag --${key}`);
  }
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cardConfig() {
  return {
    update_multi: true,
    streaming_mode: true,
    streaming_config: {
      print_frequency_ms: { default: PRINT.frequencyMs },
      print_step: { default: PRINT.step },
      print_strategy: PRINT.strategy,
    },
  };
}

function panelNode(panel, content) {
  const node = {
    tag: 'collapsible_panel',
    expanded: true,
    header: { title: { tag: 'plain_text', content: panel.title } },
    elements: [{ tag: 'markdown', element_id: panel.id, content }],
  };
  if (panel.height !== undefined) node.max_height = panel.height;
  return node;
}

/** Panels actually rendered: `--panels` narrows it, because the default is a local run and one card is enough. */
let ACTIVE = PANELS;

function scrollCard() {
  return {
    schema: '2.0',
    config: cardConfig(),
    header: { title: { tag: 'plain_text', content: `定高面板滚动探针 ${ACTIVE.map((panel) => panel.role).join('/')}` }, template: 'blue' },
    body: { elements: ACTIVE.map((panel) => panelNode(panel, '等待第一帧…')) },
  };
}

function fieldCard({ where, value }) {
  const markdown = { tag: 'markdown', element_id: 'probefieldmark01', content: '探测中…' };
  const panel = {
    tag: 'collapsible_panel',
    expanded: true,
    header: { title: { tag: 'plain_text', content: where } },
    elements: [where === 'markdown' ? { ...markdown, max_height: value } : markdown],
  };
  const card = {
    schema: '2.0',
    config: cardConfig(),
    header: { title: { tag: 'plain_text', content: 'max_height 取值探针' }, template: 'grey' },
    body: { elements: where === 'body' ? [panel] : [panel] },
  };
  if (where === 'body') card.body.max_height = value;
  return card;
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

async function createEntity(client, card, label, results) {
  let entry;
  try {
    const response = await client.cardkit.v1.card.create({
      data: { type: 'card_json', data: JSON.stringify(card) },
    });
    entry = { label, code: codeOf(undefined, response), message: messageOf(undefined, response), cardId: response?.data?.card_id };
  } catch (error) {
    entry = { label, code: codeOf(error), message: messageOf(error) };
  }
  results.push(entry);
  console.log(
    `${entry.code === 0 ? '接受  ' : '拒绝  '} ${label.padEnd(36)} code=${entry.code ?? 'n/a'} ${entry.cardId ?? ''} ${entry.message ?? ''}`,
  );
  await sleep(OP_SPACING_MS);
  return entry;
}

async function sweep(client, results) {
  console.log('\n== 第 1 步：max_height 放在哪、取什么形状才不被拒（只建实体，不发消息） ==');
  console.log('注意：飞书对卡片字段基本不校验，code=0 只能证明“没报错”，定高是否生效要看手机。');
  for (const probe of FIELD_PROBES) {
    await createEntity(client, fieldCard(probe), `${probe.where}=${JSON.stringify(probe.value)}`, results);
  }
}

async function scrollTest(client, options, chatId, results) {
  console.log('\n== 第 2 步：发一张 A/B/C 对照卡，三段同样的文字同时打字 ==');
  const entry = await createEntity(client, scrollCard(), 'A/B/C 对照卡', results);
  if (!entry.cardId) {
    console.log('实体创建失败，无法继续。');
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
  console.log(`已发送 code=${sent?.code} message_id=${messageId ?? ''} card_id=${entry.cardId}`);
  if (!messageId) throw new Error('发送测试卡未返回 message_id');

  const bodies = new Map(ACTIVE.map((panel) => [panel.id, '']));
  let sequence = 0;
  for (let frame = 1; frame <= options.frames; frame++) {
    let chunk = '';
    while (chunk.length < options.chars) {
      chunk += `[F${String(frame).padStart(2, '0')}] 第${frame}帧滚动探针，看顶部旧字是否被顶出可视区 `;
    }
    const stamp = new Date().toISOString().slice(11, 23);
    for (const panel of ACTIVE) {
      bodies.set(panel.id, (bodies.get(panel.id) + chunk.slice(0, options.chars)).slice(0, options.frames * options.chars));
      const response = await client.cardkit.v1.cardElement.content({
        path: { card_id: entry.cardId, element_id: panel.id },
        data: { content: bodies.get(panel.id), sequence: ++sequence, uuid: randomUUID() },
      });
      console.log(
        `${stamp} ${panel.role}${panel.height ?? '   '} 累计 ${String(bodies.get(panel.id).length).padStart(4)} 字 code=${codeOf(undefined, response) ?? 'n/a'} ${messageOf(undefined, response)}`,
      );
      await sleep(OP_SPACING_MS);
    }
    await sleep(Math.max(0, options.interval - ACTIVE.length * OP_SPACING_MS));
  }
  console.log(
    `\n注入结束：${options.frames} 帧 × ${options.chars} 字 = ${bodies.get(ACTIVE[0].id).length} 字，每 ${options.interval}ms 一帧，各段完全同步。`,
  );
  console.log(
    '请在手机上看这张卡，逐条回答：① A/B 是否被压在固定高度里（还是照样把卡撑高）；② 面板内能不能自己滚，需不需要手指滑；③ 打字时 newest 行是否始终可见（顶部旧字被顶出去）；④ 有没有哪一段出现整块擦掉重打；⑤ C 段作为现状对照，观感是否仍优于 A/B。',
  );
  await sleep(options.tail);
  const closed = await client.cardkit.v1.card.settings({
    path: { card_id: entry.cardId },
    data: { settings: JSON.stringify({ config: { streaming_mode: false } }), sequence: ++sequence, uuid: randomUUID() },
  });
  console.log(`已关闭流式 code=${codeOf(undefined, closed) ?? 'n/a'} ${messageOf(undefined, closed)}`);
  entry.messageId = String(messageId);
  entry.totalChars = bodies.get(ACTIVE[0].id).length;
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
console.log(`打印设置：${PRINT.step} 字 / ${PRINT.frequencyMs}ms（${Math.round((1000 * PRINT.step) / PRINT.frequencyMs)} 字/秒），strategy=${PRINT.strategy}`);
console.log(`目标会话 ${chatId}`);

if (options.phase === 'all' || options.phase === 'sweep') await sweep(client, results);
if (options.panels) {
  ACTIVE = PANELS.filter((panel) => options.panels.includes(panel.role));
  if (!ACTIVE.length) throw new Error(`--panels ${options.panels} matched nothing`);
  console.log(`只渲染 ${ACTIVE.map((panel) => panel.role).join('/')} 段。`);
}
if (options.phase === 'all' || options.phase === 'scroll') await scrollTest(client, options, chatId, results);

writeFileSync(RESULT_FILE, `${JSON.stringify({ ranAt: new Date().toISOString(), options, results }, null, 2)}\n`);
console.log(`\n汇总：尝试 ${results.length} 项，接受 ${results.filter((item) => item.code === 0).length} 项；明细见 ${RESULT_FILE}`);
