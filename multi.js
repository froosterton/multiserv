// ═══════════════════════════════════════════════════════════════
// Discord Trading Monitor — AI-Enhanced
// ═══════════════════════════════════════════════════════════════
//
// Monitors Discord trading channels for users with valuable
// Roblox limited items. Combines:
//   - Gemini Vision AI to analyze posted images for limiteds
//   - Rolimons database for item identification & valuation
//   - Roblox inventory API for total RAP
//   - Rover /whois discord + Bloxlink /getinfo discord_user (dual-command)
//
// AI FALLBACK: When no Roblox linked OR value below threshold,
// analyzes images + text for valuable items before skipping.
//
// npm install discord.js-selfbot-v13 axios @google/generative-ai
// ═══════════════════════════════════════════════════════════════

const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ─── CONFIGURATION ───────────────────────────────────────────

const TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const ROVER_BOT_ID = '298796807323123712';
const BLOXLINK_BOT_ID = '426537812993638400';
const BLOXLINK_CHANNEL_ID = '1471499501461176464';

const WEBHOOK_MAIN =
  'https://discord.com/api/webhooks/1465603926895235124/Ytb0tM21OCmsqr2TAmkpzd9VxLjP0LApUjkHQBgL_5WHfajsobC2O0CToqbAg13VhLOD';

const WEBHOOK_VALID =
  'https://discord.com/api/webhooks/1472280693680898170/bIvHzC9oCQwVRx-JqPfPxxPcbK_3rqkAJfNt6HHacPhYtreSQLI1RljyiVMtkJqLVKoq';

const ROLIMONS_API_URL = 'https://www.rolimons.com/itemapi/itemdetails';
const VALUE_THRESHOLD = 100000;
const ROLIMONS_REFRESH_MINS = 30;

const MONITOR_CHANNEL_IDS = [
  '907175350348423224', '1391793760354173098', '907175350570717224',
  '808540135666745345', '792178431419744286', '786851062219931693',
  '749645946719174757', '755810466214707220', '749629644277416048',
];

const COMMAND_GUILD_ID = '1465604866952007815';

const CHANNEL_MAPPING = {
  '907175350348423224':  '1465604933767266422',
  '1391793760354173098': '1465604933767266422',
  '907175350570717224':  '1465604933767266422',

  '808540135666745345': '1465604923189231669',
  '792178431419744286': '1465604923189231669',
  '786851062219931693': '1465604923189231669',

  '749645946719174757': '1465604867824291905',
  '755810466214707220': '1465604867824291905',
  '749629644277416048': '1465604867824291905',
};

const WHOIS_CHANNEL_IDS = new Set([...Object.values(CHANNEL_MAPPING), BLOXLINK_CHANNEL_ID]);

const LOGS_CHANNELS = ['1465603913217605704', '1472280669253144587'];

// ─── GLOBAL STATE ────────────────────────────────────────────

let nameLookup = {};
let acronymLookup = {};
let lastRolimonsRefresh = 0;
let geminiModel = null;

let blockedUsers = new Set();
const processedDiscordIds = new Set();
const processedRobloxIds = new Set();
const inFlightDiscordIds = new Set();
const pendingByDiscordId = new Map();
const pendingQueueRover = new Map();
const pendingQueueBloxlink = [];
const processedBotMessages = new Set();

let roverWhoisCmd = null;
let bloxlinkGetinfoCmd = null;

// ═══════════════════════════════════════════════════════════════
//  ROLIMONS DATABASE
// ═══════════════════════════════════════════════════════════════

async function fetchItemDatabase() {
  console.log('[Rolimons] Fetching item database...');
  const { data } = await axios.get(ROLIMONS_API_URL, {
    headers: { 'User-Agent': 'VisionScanner/1.0' },
    timeout: 15000,
  });
  if (!data?.success) throw new Error('Rolimons API error');
  console.log(`[Rolimons] Loaded ${data.item_count} items.`);
  return data.items;
}

function normalizeName(name) {
  let s = String(name || '').toLowerCase().trim();
  s = s.replace(/\u2019/g, "'").replace(/\u2018/g, "'");
  s = s.replace(/'s/g, 's').replace(/'s/g, 's');
  s = s.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

function buildLookupTables(itemsDb) {
  const nl = {}, al = {};
  for (const [id, d] of Object.entries(itemsDb)) {
    nl[normalizeName(d[0])] = { id, data: d };
    const acr = (d[1] || '').trim().toLowerCase();
    if (acr) al[acr] = { id, data: d };
  }
  nameLookup = nl;
  acronymLookup = al;
  console.log(`[Rolimons] Lookup: ${Object.keys(nl).length} names, ${Object.keys(al).length} acronyms.`);
  rebuildAcronymBlacklist();
}

function itemValue(d) {
  return d[3] && d[3] !== -1 ? d[3] : (d[2] || 0);
}

async function refreshRolimonsIfNeeded() {
  if (Date.now() - lastRolimonsRefresh > ROLIMONS_REFRESH_MINS * 60_000) {
    try {
      const db = await fetchItemDatabase();
      buildLookupTables(db);
      lastRolimonsRefresh = Date.now();
    } catch (e) {
      console.error('[Rolimons] Refresh failed:', e.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  ACRONYM BLACKLIST
// ═══════════════════════════════════════════════════════════════

const BASE_ACRONYM_BLACKLIST = new Set([
  'mm','dc','w','l','f','op','pc','nvm','pm','dm','rn','gg','bb','gl','ty',
  'np','lf','ft','nft','id','da','fb','sc','rt','ep','hb',
  'ci','aa','dh','rs','gw','ac','iv','es','bm',
]);

let acronymBlacklist = new Set();

function rebuildAcronymBlacklist() {
  acronymBlacklist = new Set();
  for (const word of BASE_ACRONYM_BLACKLIST) {
    if (acronymLookup[word]) {
      console.log(`[Blacklist] Keeping "${word.toUpperCase()}" — real item: ${acronymLookup[word].data[0]}`);
    } else {
      acronymBlacklist.add(word);
    }
  }
  console.log(`[Blacklist] ${acronymBlacklist.size} blacklisted, ${BASE_ACRONYM_BLACKLIST.size - acronymBlacklist.size} preserved as real items.`);
}

// ═══════════════════════════════════════════════════════════════
//  GEMINI VISION AI
// ═══════════════════════════════════════════════════════════════

function initGemini() {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  console.log('[Gemini] Initialized (gemini-2.0-flash).');
}

async function downloadImageBase64(url) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  const mime = (resp.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
  return { base64: Buffer.from(resp.data).toString('base64'), mime };
}

async function prescreenImage(base64, mime) {
  const prompt =
    'Look at this image carefully.\n' +
    'Is this image referencing a Roblox limited item? ' +
    'Roblox limited items are special virtual accessories/gear that can be traded ' +
    'between players (hats, faces, gear, etc.).\n\n' +
    'Signs that an image references a limited item:\n' +
    '- A Roblox trade window showing items\n' +
    '- An inventory showing items with RAP/value numbers\n' +
    '- Text mentioning specific Roblox limited item names or acronyms\n' +
    '- A Roblox avatar wearing recognizable limited items\n' +
    '- A Rolimons page or similar value-checking site\n\n' +
    'Answer with ONLY the word: yes or no';

  const res = await geminiModel.generateContent([
    prompt,
    { inlineData: { data: base64, mimeType: mime } },
  ]);
  return res.response.text().trim().toLowerCase().startsWith('yes');
}

async function extractItemsFromImage(base64, mime) {
  const prompt =
    'This image is from a Discord post about Roblox limited items.\n' +
    'Your job is to identify EVERY Roblox limited item name mentioned or shown ' +
    'anywhere in this image.\n\n' +
    'The image could be ANY of these formats:\n' +
    '- A Roblox trade window showing items on both sides\n' +
    '- An inventory or catalog screenshot\n' +
    '- A Rolimons value change notification\n' +
    '- A Rolimons item page or chart\n' +
    '- A text post or meme mentioning item names\n' +
    '- An avatar wearing limited items\n' +
    '- A screenshot of any Roblox-related site or app\n\n' +
    'For each item, extract:\n' +
    '- "name": the full item name exactly as displayed\n' +
    '- "value": highest numerical value shown (RAP, value, price). 0 if none visible.\n\n' +
    'Return ONLY a valid JSON array of objects.\n' +
    'Examples:\n' +
    '  [{"name":"Domino Crown","value":24000000}]\n' +
    '  [{"name":"Bighead","value":5000},{"name":"Goldrow","value":316}]\n\n' +
    'Important:\n' +
    '- Read EXACT item names from the image, do not guess.\n' +
    '- Commas in numbers (4,200,000) → plain number (4200000).\n' +
    '- Look EVERYWHERE in the image.\n' +
    '- If no items found, return: []';

  const res = await geminiModel.generateContent([
    prompt,
    { inlineData: { data: base64, mimeType: mime } },
  ]);
  return res.response.text();
}

function parseGeminiResponse(raw) {
  let text = raw.trim();
  var backtickFence = '`' + '`' + '`';
  if (text.startsWith(backtickFence)) {
    text = text.split('\n').slice(1).join('\n');
    var endIdx = text.lastIndexOf(backtickFence);
    if (endIdx !== -1) text = text.substring(0, endIdx);
  }
  text = text.trim();

  let arr;
  try { arr = JSON.parse(text); } catch {
    console.log('[Gemini] JSON parse failed: ' + raw.slice(0, 200));
    return [];
  }
  if (!Array.isArray(arr)) return [];

  return arr.map(e => {
    if (typeof e === 'string') return { name: e.trim(), value: 0 };
    if (e && typeof e === 'object' && e.name) {
      let v = e.value || 0;
      if (typeof v === 'string') v = parseInt(v.replace(/\D/g, '') || '0', 10);
      return { name: String(e.name).trim(), value: Number(v) || 0 };
    }
    return null;
  }).filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════
//  ITEM MATCHING
// ═══════════════════════════════════════════════════════════════

function matchSingleItem(detectedName) {
  const norm = normalizeName(detectedName);
  const lower = detectedName.trim().toLowerCase();

  if (nameLookup[norm]) return nameLookup[norm];
  if (acronymLookup[lower]) return acronymLookup[lower];

  if (norm.split(' ').length >= 2 && norm.length >= 8) {
    let best = null, bestLen = 0;
    for (const [k, v] of Object.entries(nameLookup)) {
      if (k.startsWith(norm) && k.length > bestLen) { best = v; bestLen = k.length; }
    }
    if (best) return best;
  }

  if (norm.length >= 8) {
    let best = null, bestLen = 0;
    for (const [k, v] of Object.entries(nameLookup)) {
      if (k.split(' ').length >= 2 && k.length >= 8 && norm.includes(k) && k.length > bestLen) {
        best = v; bestLen = k.length;
      }
    }
    if (best) return best;
  }
  return null;
}

function matchItemsRolimonsOnly(detected) {
  const results = [], seen = new Set();
  for (const det of detected) {
    const m = matchSingleItem(det.name);
    if (!m) {
      console.log('[Match]   "' + det.name + '" → no Rolimons match');
      continue;
    }
    if (seen.has(m.id)) continue;
    const v = itemValue(m.data);
    if (v < VALUE_THRESHOLD) {
      console.log('[Match]   "' + det.name + '" → ' + m.data[0] + ' = R$ ' + v.toLocaleString() + ' (BELOW ' + VALUE_THRESHOLD.toLocaleString() + ' threshold)');
      continue;
    }
    console.log('[Match]   "' + det.name + '" → ' + m.data[0] + ' = R$ ' + v.toLocaleString() + ' (HIT)');
    results.push({ id: m.id, name: m.data[0], acronym: m.data[1] || '', value: v, detectedAs: det.name });
    seen.add(m.id);
  }
  results.sort((a, b) => b.value - a.value);
  return results;
}

function findMentionedItems(text) {
  const tLower = text.toLowerCase();
  const tNorm = normalizeName(text);
  const above = [], below = [], seen = new Set();

  for (const [norm, entry] of Object.entries(nameLookup)) {
    if (seen.has(entry.id) || norm.split(' ').length < 2) continue;
    if (tNorm.includes(norm)) {
      const v = itemValue(entry.data);
      const item = { id: entry.id, name: entry.data[0], acronym: entry.data[1] || '', value: v };
      (v >= VALUE_THRESHOLD ? above : below).push(item);
      seen.add(entry.id);
    }
  }

  const words = new Set(tLower.split(/\s+/));
  const origWords = new Set(text.split(/\s+/));
  for (const [acr, entry] of Object.entries(acronymLookup)) {
    if (seen.has(entry.id) || acr.length < 3 || acronymBlacklist.has(acr)) continue;
    if (acr.length <= 3 && !origWords.has(acr.toUpperCase())) continue;
    if (words.has(acr)) {
      const v = itemValue(entry.data);
      const item = { id: entry.id, name: entry.data[0], acronym: entry.data[1] || '', value: v };
      (v >= VALUE_THRESHOLD ? above : below).push(item);
      seen.add(entry.id);
    }
  }

  above.sort((a, b) => b.value - a.value);
  return { above, below };
}

// ═══════════════════════════════════════════════════════════════
//  AI FALLBACK — Run when no Roblox ID or value below threshold
// ═══════════════════════════════════════════════════════════════

async function runAIFallback(pending) {
  if (!geminiModel) return { hasValuableItems: false, geminiItems: [], textItems: [] };
  const geminiItems = await analyzeMessageImages(pending.imageUrls || []);
  const { above: textItems } = findMentionedItems(pending.content || '');
  const hasValuableItems = geminiItems.length > 0 || textItems.length > 0;
  if (hasValuableItems) {
    console.log('[AI Fallback] Found valuable items: ' + [...geminiItems, ...textItems].map(i => i.name).join(', '));
  }
  return { hasValuableItems, geminiItems, textItems };
}

// ═══════════════════════════════════════════════════════════════
//  IMAGE EXTRACTION & ANALYSIS
// ═══════════════════════════════════════════════════════════════

function extractImageUrls(message) {
  const urls = [];
  for (const [, att] of message.attachments) {
    const ct = att.contentType || '';
    if (ct.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp)$/i.test(att.name || '')) {
      urls.push(att.url);
    }
  }
  for (const embed of message.embeds) {
    if (embed.image?.url) urls.push(embed.image.url);
    if (embed.thumbnail?.url) urls.push(embed.thumbnail.url);
  }
  return urls;
}

async function analyzeMessageImages(imageUrls) {
  if (!imageUrls.length || !geminiModel) return [];
  const all = [];
  for (const url of imageUrls) {
    try {
      const { base64, mime } = await downloadImageBase64(url);
      if (!(await prescreenImage(base64, mime))) {
        console.log('[Gemini]   Not a limited item image, skipping.');
        continue;
      }
      console.log('[Gemini]   Relevant image — extracting items...');
      const raw = await extractItemsFromImage(base64, mime);
      const detected = parseGeminiResponse(raw);
      if (detected.length) {
        console.log('[Gemini]   Detected: ' + detected.map(d => d.name).join(', '));
        all.push(...matchItemsRolimonsOnly(detected));
      }
    } catch (e) {
      console.log('[Gemini]   Image error: ' + e.message);
    }
  }
  return all;
}

// ═══════════════════════════════════════════════════════════════
//  ROBLOX API
// ═══════════════════════════════════════════════════════════════

async function fetchRobloxRAP(robloxUserId, logPrefix) {
  let rap = 0, cursor, pages = 0;
  try {
    while (true) {
      const { data } = await axios.get(
        'https://inventory.roblox.com/v1/users/' + robloxUserId + '/assets/collectibles',
        { params: { limit: 100, sortOrder: 'Asc', cursor }, timeout: 5000 },
      );
      pages++;
      if (!data?.data?.length) break;
      for (const e of data.data) rap += Number(e.recentAveragePrice || 0);
      cursor = data.nextPageCursor;
      if (!cursor) break;
    }
    console.log(logPrefix + ' RAP=R$ ' + rap.toLocaleString() + ' (' + pages + ' pages)');
  } catch (e) {
    console.log(logPrefix + ' Roblox API error: ' + e.message);
  }
  return rap;
}

async function fetchRobloxAvatar(robloxUserId) {
  try {
    const { data } = await axios.get('https://thumbnails.roblox.com/v1/users/avatar-headshot', {
      params: { userIds: robloxUserId, size: '150x150', format: 'Png', isCircular: false },
      timeout: 3000,
    });
    return data?.data?.[0]?.imageUrl || '';
  } catch { return ''; }
}

async function fetchItemThumbnail(itemId) {
  try {
    const { data } = await axios.get('https://thumbnails.roblox.com/v1/assets', {
      params: { assetIds: itemId, returnPolicy: 'PlaceHolder', size: '420x420', format: 'Png', isCircular: false },
      timeout: 5000,
    });
    return data?.data?.[0]?.imageUrl || '';
  } catch { return ''; }
}

// ═══════════════════════════════════════════════════════════════
//  ROVER / BLOXLINK EMBED EXTRACTION
// ═══════════════════════════════════════════════════════════════

function extractFromEmbeds(message) {
  const embeds = message.embeds || [];
  if (embeds.length === 0) return null;
  for (const embed of embeds) {
    if (embed.fields) {
      for (const field of embed.fields) {
        if (field.name.toLowerCase().includes('roblox user id')) {
          const id = field.value.replace(/[`\s]/g, '').trim();
          if (/^\d+$/.test(id)) return id;
        }
      }
    }
    if (embed.title) {
      const m = embed.title.match(/\((\d+)\)/);
      if (m) return m[1];
    }
    if (embed.url) {
      const m = embed.url.match(/roblox\.com\/users\/(\d+)/);
      if (m) return m[1];
    }
  }
  return null;
}

function extractFromComponentsV2(rawComponents) {
  if (!rawComponents || !Array.isArray(rawComponents)) return null;
  function searchComponents(components) {
    for (const comp of components) {
      if (comp.type === 10 && comp.content) {
        const urlMatch = comp.content.match(/roblox\.com\/users\/(\d+)/);
        if (urlMatch) return urlMatch[1];
        const idMatch = comp.content.match(/\((\d+)\)/);
        if (idMatch && idMatch[1].length >= 5) return idMatch[1];
      }
      if (comp.components) {
        const found = searchComponents(comp.components);
        if (found) return found;
      }
    }
    return null;
  }
  return searchComponents(rawComponents);
}

async function fetchRawMessages(channelId, limit = 5) {
  const res = await axios.get(
    'https://discord.com/api/v9/channels/' + channelId + '/messages?limit=' + limit,
    { headers: { Authorization: TOKEN }, timeout: 5000 }
  );
  return res.data || [];
}

// ═══════════════════════════════════════════════════════════════
//  ROVER /whois + BLOXLINK /getinfo COMMANDS
// ═══════════════════════════════════════════════════════════════

function generateNonce() {
  return String(BigInt(Date.now() - 1420070400000) << 22n | BigInt(Math.floor(Math.random() * 4194304)));
}

async function sendRoverWhois(channelId, userId) {
  if (!roverWhoisCmd) throw new Error('Rover /whois command not loaded');
  const sessionId = client.ws?.shards?.first()?.sessionId || '';
  await axios.post(
    'https://discord.com/api/v9/interactions',
    {
      type: 2,
      application_id: ROVER_BOT_ID,
      guild_id: COMMAND_GUILD_ID,
      channel_id: channelId,
      session_id: sessionId,
      data: {
        version: roverWhoisCmd.version,
        id: roverWhoisCmd.id,
        name: 'whois',
        type: 1,
        options: [{
          type: 1,
          name: 'discord',
          options: [{ type: 6, name: 'user', value: userId }]
        }]
      },
      nonce: generateNonce()
    },
    { headers: { Authorization: TOKEN, 'Content-Type': 'application/json' } }
  );
}

async function sendBloxlinkGetinfo(channelId, userId) {
  if (!bloxlinkGetinfoCmd) throw new Error('Bloxlink /getinfo command not loaded');
  const sessionId = client.ws?.shards?.first()?.sessionId || '';
  const payload = {
    type: 2,
    application_id: BLOXLINK_BOT_ID,
    guild_id: COMMAND_GUILD_ID,
    channel_id: channelId,
    session_id: sessionId,
    data: {
      version: bloxlinkGetinfoCmd.version,
      id: bloxlinkGetinfoCmd.id,
      name: 'getinfo',
      type: 1,
      options: [{ type: 6, name: 'discord_user', value: String(userId) }]
    },
    nonce: generateNonce()
  };
  const res = await axios.post(
    'https://discord.com/api/v9/interactions',
    payload,
    { headers: { Authorization: TOKEN, 'Content-Type': 'application/json' }, validateStatus: () => true }
  );
  if (res.status !== 204) {
    const errMsg = res.data?.message || (res.data?.errors ? JSON.stringify(res.data.errors) : res.statusText);
    throw new Error('Bloxlink ' + res.status + ': ' + errMsg);
  }
}

// ═══════════════════════════════════════════════════════════════
//  DISCORD WEBHOOK ALERT
// ═══════════════════════════════════════════════════════════════

async function sendWebhookAlert({ msg, robloxUserId, rap, avatarUrl, geminiItems, textItems }) {
  const jump = 'https://discord.com/channels/' + msg.guildId + '/' + msg.channelId + '/' + msg.messageId;
  const rolimons = robloxUserId ? 'https://www.rolimons.com/player/' + robloxUserId : '';

  const embeds = [
    {
      title: 'User Message',
      description:
        '**Message:** ' + (msg.content || '(no text)') + '\n' +
        '**Discord:** <@' + msg.discordId + '> (' + msg.discordTag + ')\n' +
        '**Discord ID:** `' + msg.discordId + '`\n' +
        '**Channel:** #' + msg.channelName + '\n' +
        '[Jump to Message](' + jump + ')',
      color: 0x00ff00,
    },
  ];

  if (robloxUserId) {
    embeds.push({
      title: 'Roblox & Rolimons',
      description:
        '**RAP:** R$ ' + rap.toLocaleString() + '\n' +
        '[Roblox Profile](https://www.roblox.com/users/' + robloxUserId + '/profile) • ' +
        '[Rolimons Profile](' + rolimons + ')',
      color: 0x00ff00,
      ...(avatarUrl ? { thumbnail: { url: avatarUrl } } : {}),
    });
  } else {
    embeds.push({
      title: 'Roblox Lookup',
      description: 'Could not resolve Roblox account (Rover/Bloxlink did not respond) — AI fallback triggered',
      color: 0xFFAA00,
    });
  }

  const all = [...(geminiItems || []), ...(textItems || [])];
  const seen = new Set();
  const unique = all.filter(i => { if (seen.has(i.id)) return false; seen.add(i.id); return true; });

  if (unique.length) {
    const bestAi = unique[0];
    const aiThumb = bestAi?.id ? await fetchItemThumbnail(bestAi.id) : '';
    embeds.push({
      title: 'AI-Detected Items',
      description: unique.map(i => {
        const a = i.acronym ? ' [' + i.acronym + ']' : '';
        return '**' + i.name + '**' + a + ' — R$ ' + i.value.toLocaleString();
      }).join('\n'),
      color: 0xFF4500,
      ...(aiThumb ? { thumbnail: { url: aiThumb } } : {}),
    });
  }

  const payload = { content: '@everyone', embeds };

  const results = await Promise.allSettled([
    axios.post(WEBHOOK_MAIN, payload, { timeout: 10000 }),
    axios.post(WEBHOOK_VALID, payload, { timeout: 10000 }),
  ]);

  if (results[0].status === 'fulfilled') {
    console.log('[Webhook] Main log sent for ' + msg.discordTag + ' (' + msg.discordId + ')');
  } else {
    console.error('[Webhook] Main log error: ' + results[0].reason?.message);
  }

  if (results[1].status === 'fulfilled') {
    console.log('[Webhook] Valid log sent for ' + msg.discordTag + ' (' + msg.discordId + ')');
  } else {
    console.error('[Webhook] Valid log error: ' + results[1].reason?.message);
  }
}

// ═══════════════════════════════════════════════════════════════
//  STARTUP — LOAD PREVIOUS LOGS FOR DEDUP
// ═══════════════════════════════════════════════════════════════

async function loadPreviousLogs(cl) {
  let robloxCount = 0, discordCount = 0;

  for (const chId of LOGS_CHANNELS) {
    try {
      const ch = await cl.channels.fetch(chId);
      if (!ch) { console.log('[Startup] Cannot access channel ' + chId + ', skipping.'); continue; }

      let lastId = null;
      while (true) {
        const opts = { limit: 100 };
        if (lastId) opts.before = lastId;
        const msgs = await ch.messages.fetch(opts);
        if (!msgs.size) break;

        for (const [, m] of msgs) {
          for (const emb of m.embeds) {
            const d = String(emb.description || '');

            const rx = d.match(/roblox\.com\/users\/(\d+)/i);
            if (rx) { processedRobloxIds.add(rx[1]); robloxCount++; }

            const dx = d.match(/Discord ID:\s*`?(\d{17,20})`?/i);
            if (dx) { processedDiscordIds.add(dx[1]); discordCount++; }

            const mx = d.match(/<@!?(\d{17,20})>/);
            if (mx && !processedDiscordIds.has(mx[1])) {
              processedDiscordIds.add(mx[1]); discordCount++;
            }
          }
        }

        lastId = msgs.last().id;
        if (msgs.size < 100) break;
      }

      console.log('[Startup] Scanned channel ' + chId);
    } catch (e) {
      console.error('[Startup] Error scanning ' + chId + ':', e.message);
    }
  }

  console.log('[Startup] Previous logs loaded: ' + robloxCount + ' Roblox IDs, ' + discordCount + ' Discord IDs — these users will be skipped.');
}

async function fetchBlockedUsers() {
  try {
    const res = await axios.get('https://discord.com/api/v9/users/@me/relationships', {
      headers: { Authorization: TOKEN },
    });
    blockedUsers = new Set(res.data.filter(u => u.type === 2).map(u => u.id));
    console.log('[Startup] Blocked users: ' + blockedUsers.size);
  } catch (e) {
    console.error('[Startup] Blocked users error:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
//  STARTUP — SEED RECENT USERS SO WE DON'T RE-ALERT ON THEM
// ═══════════════════════════════════════════════════════════════

async function seedRecentUsers() {
  console.log('[Startup] Seeding recent users from monitored channels...');
  let seeded = 0;

  for (const channelId of MONITOR_CHANNEL_IDS) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel) continue;

      const messages = await channel.messages.fetch({ limit: 50 });
      for (const [, msg] of messages) {
        if (msg.author?.id && !msg.author.bot) {
          processedDiscordIds.add(msg.author.id);
          seeded++;
        }
      }
    } catch (e) {
      console.error('[Startup] Error seeding channel ' + channelId + ':', e.message);
    }
  }

  console.log('[Startup] Seeded ' + seeded + ' user(s) — will only process NEW messages from now on.');
}

// ═══════════════════════════════════════════════════════════════
//  CLIENT & EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════

const client = new Client({ checkUpdate: false });

function cleanup(discordId) {
  inFlightDiscordIds.delete(discordId);
  pendingByDiscordId.delete(discordId);
}

// ─── READY ───────────────────────────────────────────────────

client.on('ready', async () => {
  console.log('[Monitor] Logged in as ' + client.user.tag);

  await fetchBlockedUsers();
  initGemini();

  try {
    const db = await fetchItemDatabase();
    buildLookupTables(db);
    lastRolimonsRefresh = Date.now();
  } catch (e) {
    console.error('[Startup] Rolimons load failed:', e.message);
    process.exit(1);
  }

  console.log('[Monitor] Fetching guild command index...');
  try {
    const { data } = await axios.get(
      'https://discord.com/api/v9/guilds/' + COMMAND_GUILD_ID + '/application-command-index',
      { headers: { Authorization: TOKEN } }
    );
    roverWhoisCmd = data.application_commands?.find(c => c.name === 'whois' && c.application_id === ROVER_BOT_ID);
    bloxlinkGetinfoCmd = data.application_commands?.find(c => c.name === 'getinfo' && c.application_id === BLOXLINK_BOT_ID);
    console.log('[Monitor] Rover /whois: ' + (roverWhoisCmd ? 'LOADED' : 'NOT FOUND'));
    console.log('[Monitor] Bloxlink /getinfo: ' + (bloxlinkGetinfoCmd ? 'LOADED' : 'NOT FOUND'));
  } catch (e) {
    console.error('[Startup] Command index failed:', e.message);
  }

  await loadPreviousLogs(client);
  await seedRecentUsers();

  console.log('[Monitor] Ready — watching ' + MONITOR_CHANNEL_IDS.length + ' channels.\n');
});

// ─── HANDLER 1: SOURCE CHANNEL MESSAGES ──────────────────────

client.on('messageCreate', async (message) => {
  if (!message.author?.id || message.author.bot) return;
  if (blockedUsers.has(message.author.id)) return;
  if (!MONITOR_CHANNEL_IDS.includes(message.channel.id)) return;

  const discordId = message.author.id;
  if (processedDiscordIds.has(discordId) || inFlightDiscordIds.has(discordId)) return;

  const whoisChannelId = CHANNEL_MAPPING[message.channel.id];
  if (!whoisChannelId) return;

  inFlightDiscordIds.add(discordId);
  await refreshRolimonsIfNeeded();

  const discordTag = message.author.tag;
  const content = message.content || '';
  const imageUrls = extractImageUrls(message);

  console.log('\n[Monitor] ' + discordTag + ' (' + discordId + ') in #' + message.channel.name);

  const msgData = {
    discordId, discordTag, content,
    timestamp: message.createdTimestamp,
    channelId: message.channel.id,
    channelName: message.channel.name,
    messageId: message.id,
    guildId: message.guild?.id,
    whoisChannelId,
    imageUrls,
  };

  pendingByDiscordId.set(discordId, {
    ...msgData,
    phase: 'whois',
    whoisRobloxId: null,
    getinfoRobloxId: null,
  });

  if (!pendingQueueRover.has(whoisChannelId)) pendingQueueRover.set(whoisChannelId, []);
  pendingQueueRover.get(whoisChannelId).push(discordId);

  try {
    console.log('[Monitor]   /whois discord → ' + discordTag + ' (whois: ' + whoisChannelId + ')');
    await sendRoverWhois(whoisChannelId, discordId);
  } catch (e) {
    console.error('[Monitor]   /whois error: ' + (e.response?.data?.message || e.message));
    const q = pendingQueueRover.get(whoisChannelId) || [];
    const idx = q.indexOf(discordId);
    if (idx !== -1) q.splice(idx, 1);
    // AI fallback when /whois fails (no Roblox lookup possible)
    const ai = await runAIFallback(msgData);
    if (ai.hasValuableItems) {
      await sendWebhookAlert({ msg: msgData, robloxUserId: null, rap: 0, avatarUrl: '', geminiItems: ai.geminiItems, textItems: ai.textItems });
      processedDiscordIds.add(discordId);
    }
    cleanup(discordId);
  }
});

// ─── HANDLER 2: ROVER + BLOXLINK RESPONSES → DUAL-COMMAND FLOW ────

async function handleBotResponse(message, isUpdate) {
  const watchedChannels = [...Object.values(CHANNEL_MAPPING), BLOXLINK_CHANNEL_ID];
  if (!watchedChannels.includes(message.channel.id)) return;
  if (message.author.id !== ROVER_BOT_ID && message.author.id !== BLOXLINK_BOT_ID) return;
  if (processedBotMessages.has(message.id)) return;

  const isRover = message.author.id === ROVER_BOT_ID;
  const channelId = message.channel.id;

  let discordId = null;
  if (isRover) {
    const queue = pendingQueueRover.get(channelId) || [];
    if (!queue.length) return;
    discordId = queue.shift();
  } else {
    if (!pendingQueueBloxlink.length) return;
    discordId = pendingQueueBloxlink.shift();
  }

  const pending = pendingByDiscordId.get(discordId);
  if (!pending) return;

  let robloxUserId = null;
  if (isRover) {
    robloxUserId = extractFromEmbeds(message);
    if (!robloxUserId && isUpdate) {
      await new Promise(r => setTimeout(r, 500));
      const rawMsgs = await fetchRawMessages(channelId, 3);
      const raw = rawMsgs.find(m => m.id === message.id);
      if (raw) {
        robloxUserId = extractFromEmbeds({ embeds: raw.embeds || [] }) || extractFromComponentsV2(raw.components);
      }
    }
  } else {
    if (!isUpdate) return;
    await new Promise(r => setTimeout(r, 1000));
    const rawMsgs = await fetchRawMessages(channelId, 3);
    const raw = rawMsgs.find(m => m.id === message.id);
    if (raw) {
      robloxUserId = extractFromComponentsV2(raw.components);
    }
  }

  processedBotMessages.add(message.id);

  if (isRover) {
    if (!robloxUserId) {
      console.log('[Rover] No Roblox ID for ' + pending.discordTag + ' — trying /getinfo');
      pending.phase = 'getinfo_after_whois_none';
      pendingQueueBloxlink.push(discordId);
      try {
        await sendBloxlinkGetinfo(pending.whoisChannelId, discordId);
        console.log('[Monitor]   /getinfo discord_user → ' + pending.discordTag);
      } catch (e) {
        console.error('[Monitor]   /getinfo error:', e.message);
        // AI fallback when no Roblox ID and /getinfo fails
        const ai = await runAIFallback(pending);
        if (ai.hasValuableItems) {
          await sendWebhookAlert({ msg: pending, robloxUserId: null, rap: 0, avatarUrl: '', geminiItems: ai.geminiItems, textItems: ai.textItems });
          processedDiscordIds.add(discordId);
        }
        cleanup(discordId);
      }
      return;
    }

    pending.whoisRobloxId = robloxUserId;
    if (processedRobloxIds.has(robloxUserId)) {
      console.log('[Rover] Roblox ' + robloxUserId + ' previously logged — skipping');
      processedDiscordIds.add(discordId);
      cleanup(discordId);
      return;
    }
    const lp = '[Rover][' + pending.discordTag + '][Roblox ' + robloxUserId + ']';
    const [rap, avatarUrl] = await Promise.all([
      fetchRobloxRAP(robloxUserId, lp),
      fetchRobloxAvatar(robloxUserId),
    ]);

    if (rap >= VALUE_THRESHOLD) {
      console.log(lp + ' RAP HIT → R$ ' + rap.toLocaleString());
      await sendWebhookAlert({ msg: pending, robloxUserId, rap, avatarUrl, geminiItems: [], textItems: [] });
      processedDiscordIds.add(discordId);
      processedRobloxIds.add(robloxUserId);
      cleanup(discordId);
      return;
    }

    if (pending.phase === 'whois_after_getinfo_low') {
      console.log(lp + ' RAP below threshold (vice versa) — skipping');
      // AI fallback when value below threshold
      const ai = await runAIFallback(pending);
      if (ai.hasValuableItems) {
        await sendWebhookAlert({ msg: pending, robloxUserId, rap, avatarUrl, geminiItems: ai.geminiItems, textItems: ai.textItems });
      }
      processedDiscordIds.add(discordId);
      processedRobloxIds.add(robloxUserId);
      cleanup(discordId);
      return;
    }

    console.log(lp + ' RAP below threshold — trying /getinfo');
    pending.phase = 'getinfo_after_whois_low';
    pendingQueueBloxlink.push(discordId);
    try {
      await sendBloxlinkGetinfo(pending.whoisChannelId, discordId);
      console.log('[Monitor]   /getinfo discord_user → ' + pending.discordTag);
    } catch (e) {
      console.error('[Monitor]   /getinfo error:', e.message);
      // AI fallback when value below threshold and /getinfo fails
      const ai = await runAIFallback(pending);
      if (ai.hasValuableItems) {
        await sendWebhookAlert({ msg: pending, robloxUserId, rap, avatarUrl, geminiItems: ai.geminiItems, textItems: ai.textItems });
        processedDiscordIds.add(discordId);
        processedRobloxIds.add(robloxUserId);
      }
      cleanup(discordId);
    }
    return;
  }

  if (!robloxUserId) {
    if (pending.phase === 'getinfo_after_whois_none') {
      console.log('[Bloxlink] No Roblox ID for ' + pending.discordTag + ' — AI fallback');
    }
    // AI fallback when no Roblox linked
    const ai = await runAIFallback(pending);
    if (ai.hasValuableItems) {
      await sendWebhookAlert({ msg: pending, robloxUserId: null, rap: 0, avatarUrl: '', geminiItems: ai.geminiItems, textItems: ai.textItems });
    }
    processedDiscordIds.add(discordId);
    cleanup(discordId);
    return;
  }

  pending.getinfoRobloxId = robloxUserId;
  if (processedRobloxIds.has(robloxUserId)) {
    console.log('[Bloxlink] Roblox ' + robloxUserId + ' previously logged — skipping');
    processedDiscordIds.add(discordId);
    cleanup(discordId);
    return;
  }
  const lp = '[Bloxlink][' + pending.discordTag + '][Roblox ' + robloxUserId + ']';
  const [rap, avatarUrl] = await Promise.all([
    fetchRobloxRAP(robloxUserId, lp),
    fetchRobloxAvatar(robloxUserId),
  ]);

  if (rap >= VALUE_THRESHOLD) {
    console.log(lp + ' RAP HIT → R$ ' + rap.toLocaleString());
    await sendWebhookAlert({ msg: pending, robloxUserId, rap, avatarUrl, geminiItems: [], textItems: [] });
    processedDiscordIds.add(discordId);
    processedRobloxIds.add(robloxUserId);
    cleanup(discordId);
    return;
  }

  if (pending.phase === 'getinfo_after_whois_none') {
    console.log(lp + ' RAP below threshold — trying /whois (vice versa)');
    pending.phase = 'whois_after_getinfo_low';
    if (!pendingQueueRover.has(pending.whoisChannelId)) pendingQueueRover.set(pending.whoisChannelId, []);
    pendingQueueRover.get(pending.whoisChannelId).push(discordId);
    try {
      await sendRoverWhois(pending.whoisChannelId, discordId);
      console.log('[Monitor]   /whois discord (vice versa) → ' + pending.discordTag);
    } catch (e) {
      console.error('[Monitor]   /whois error:', e.message);
      // AI fallback when value below threshold and /whois fails
      const ai = await runAIFallback(pending);
      if (ai.hasValuableItems) {
        await sendWebhookAlert({ msg: pending, robloxUserId, rap, avatarUrl, geminiItems: ai.geminiItems, textItems: ai.textItems });
      }
      processedDiscordIds.add(discordId);
      processedRobloxIds.add(robloxUserId);
      cleanup(discordId);
    }
    return;
  }

  // RAP below threshold — AI fallback
  console.log(lp + ' RAP below threshold — AI fallback');
  const ai = await runAIFallback(pending);
  if (ai.hasValuableItems) {
    await sendWebhookAlert({ msg: pending, robloxUserId, rap, avatarUrl, geminiItems: ai.geminiItems, textItems: ai.textItems });
  }
  processedDiscordIds.add(discordId);
  processedRobloxIds.add(robloxUserId);
  cleanup(discordId);
}

client.on('messageCreate', (msg) => handleBotResponse(msg, false));
client.on('messageUpdate', (_, msg) => handleBotResponse(msg, true));

// ═══════════════════════════════════════════════════════════════
//  ERROR HANDLING & LOGIN
// ═══════════════════════════════════════════════════════════════

client.on('error', (e) => console.error('[Client]', e));
process.on('unhandledRejection', (e) => console.error('[Unhandled]', e));

client.login(TOKEN).catch(e => {
  console.error('[Login] Failed:', e);
  process.exit(1);
});
