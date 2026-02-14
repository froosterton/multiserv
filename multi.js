// ═══════════════════════════════════════════════════════════════
// Discord Trading Monitor — AI-Enhanced
// ═══════════════════════════════════════════════════════════════
//
// Monitors Discord trading channels for users with valuable
// Roblox limited items. Combines:
//   - Gemini Vision AI to analyze posted images for limiteds
//   - Rolimons database for item identification & valuation
//   - Roblox inventory API for total RAP
//   - /discord2roblox (heist) to link Discord → Roblox
//
// npm install discord.js-selfbot-v13 axios @google/generative-ai
// ═══════════════════════════════════════════════════════════════

const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ─── CONFIGURATION ───────────────────────────────────────────

const TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const HEIST_BOT_ID = '1225070865935368265';

// Main logs — ALL alerts go here (channel 1465603913217605704)
const WEBHOOK_MAIN =
  'https://discord.com/api/webhooks/1465603926895235124/Ytb0tM21OCmsqr2TAmkpzd9VxLjP0LApUjkHQBgL_5WHfajsobC2O0CToqbAg13VhLOD';

// Valid logs — only NEW users never logged before (channel 1472280669253144587)
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

// Guild where /discord2roblox is sent (your private server)
const COMMAND_GUILD_ID = '1465604866952007815';

// Map each monitored channel → a whois channel in YOUR guild
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

const WHOIS_CHANNEL_IDS = new Set(Object.values(CHANNEL_MAPPING));

// Channels with previous logs — scanned on startup so we never re-alert
const LOGS_CHANNELS = ['1465603913217605704', '1472280669253144587'];

// ─── GLOBAL STATE ────────────────────────────────────────────

let nameLookup = {};          // normalizedName → { id, data }
let acronymLookup = {};       // lowercaseAcronym → { id, data }
let lastRolimonsRefresh = 0;
let geminiModel = null;

let blockedUsers = new Set();
const processedDiscordIds = new Set();
const processedRobloxIds = new Set();
const inFlightDiscordIds = new Set();
const pendingByDiscordId = new Map();   // discordId → msg payload + promises
const pendingQueue = new Map();         // whoisChannelId → [discordId, …] (FIFO)

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

  // Rebuild blacklist now that we know which acronyms are real items
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
//  ACRONYM BLACKLIST — runtime-filtered against Rolimons
// ═══════════════════════════════════════════════════════════════

// Base list of common short words that can collide with item acronyms.
// At runtime, any entry that IS a real Rolimons item acronym is removed.
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
  if (text.startsWith('```')) {
    text = text.split('\n').slice(1).join('\n').replace(/```\s*$/, '');
  }
  text = text.trim();

  let arr;
  try { arr = JSON.parse(text); } catch {
    console.log(`[Gemini] JSON parse failed: ${raw.slice(0, 200)}`);
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

  // 1) exact name
  if (nameLookup[norm]) return nameLookup[norm];
  // 2) exact acronym
  if (acronymLookup[lower]) return acronymLookup[lower];
  // 3) prefix — detected name is truncated (e.g. "Dominus Formidulos…")
  if (norm.split(' ').length >= 2 && norm.length >= 8) {
    let best = null, bestLen = 0;
    for (const [k, v] of Object.entries(nameLookup)) {
      if (k.startsWith(norm) && k.length > bestLen) { best = v; bestLen = k.length; }
    }
    if (best) return best;
  }
  // 4) contains — Gemini added extra text (e.g. "Telamon's Chicken Suit (Chicken)")
  //    Check if any Rolimons name (2+ words) is contained WITHIN the detected name
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
      console.log(`[Match]   "${det.name}" → no Rolimons match`);
      continue;
    }
    if (seen.has(m.id)) continue;
    const v = itemValue(m.data);
    if (v < VALUE_THRESHOLD) {
      console.log(`[Match]   "${det.name}" → ${m.data[0]} = R$ ${v.toLocaleString()} (BELOW ${VALUE_THRESHOLD.toLocaleString()} threshold)`);
      continue;
    }
    console.log(`[Match]   "${det.name}" → ${m.data[0]} = R$ ${v.toLocaleString()} (HIT)`);
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
//  IMAGE EXTRACTION FROM DISCORD MESSAGES + FULL ANALYSIS
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
        console.log(`[Gemini]   Detected: ${detected.map(d => d.name).join(', ')}`);
        all.push(...matchItemsRolimonsOnly(detected));
      }
    } catch (e) {
      console.log(`[Gemini]   Image error: ${e.message}`);
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
        `https://inventory.roblox.com/v1/users/${robloxUserId}/assets/collectibles`,
        { params: { limit: 100, sortOrder: 'Asc', cursor }, timeout: 5000 },
      );
      pages++;
      if (!data?.data?.length) break;
      for (const e of data.data) rap += Number(e.recentAveragePrice || 0);
      cursor = data.nextPageCursor;
      if (!cursor) break;
    }
    console.log(`${logPrefix} RAP=R$ ${rap.toLocaleString()} (${pages} pages)`);
  } catch (e) {
    console.log(`${logPrefix} Roblox API error: ${e.message}`);
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
//  HEIST EMBED PARSING
// ═══════════════════════════════════════════════════════════════

function extractRobloxIdFromHeistEmbed(embed) {
  // Fields: look for "UserId"
  for (const f of embed.fields || []) {
    const n = String(f.name || '').replace(/[^a-zA-Z]/g, '').toLowerCase();
    const v = String(f.value || '').trim();
    if (n.includes('userid')) { const d = v.replace(/\D/g, ''); if (d) return d; }
  }
  const desc = String(embed.description || '');
  // "Found: Name (123456)"
  const m1 = desc.match(/Found:\s*.+?\((\d+)\)/);
  if (m1) return m1[1];
  // "UserId: 123456"
  const m2 = desc.match(/UserId[:\s]+(\d+)/i);
  if (m2) return m2[1];
  return '';
}

// ═══════════════════════════════════════════════════════════════
//  RAW SLASH COMMAND — bypasses library permission checks
//  sendSlash fails because the lib checks USE_APPLICATION_COMMANDS
//  locally. For user-installed commands Discord itself allows it,
//  so we POST /interactions directly.
// ═══════════════════════════════════════════════════════════════

let d2rCommandId = null;
let d2rCommandVersion = null;

async function discoverCommand() {
  console.log('[Heist] Fetching /discord2roblox from heist global commands...');
  try {
    const { data } = await axios.get(
      `https://discord.com/api/v9/applications/${HEIST_BOT_ID}/commands`,
      { headers: { Authorization: TOKEN } },
    );
    const match = data.find(c => c.name === 'discord2roblox');
    if (match) {
      d2rCommandId = match.id;
      d2rCommandVersion = match.version;
      console.log(`[Heist] Found: id=${d2rCommandId}  version=${d2rCommandVersion}`);
      return true;
    }
    console.error('[Heist] discord2roblox not in command list!');
  } catch (e) {
    console.error(`[Heist] API error: ${e.response?.status || e.message}`);
  }
  // Hardcoded fallback discovered via API 2026-02-14
  d2rCommandId = '1459400420920262782';
  d2rCommandVersion = '1459400421666979985';
  console.log(`[Heist] Using hardcoded fallback: id=${d2rCommandId}`);
  return true;
}

function generateNonce() {
  return String(
    (BigInt(Date.now() - 1420070400000) << 22n) |
    BigInt(Math.floor(Math.random() * 4194304)),
  );
}

async function sendD2RCommand(whoisChannelId, targetUserId) {
  if (!d2rCommandId) throw new Error('discord2roblox command not discovered');

  // Grab session ID from the live WebSocket shard
  let sessionId = '';
  try {
    const shard = client.ws.shards.first();
    sessionId = shard?.sessionId || shard?.session_id || '';
  } catch { /* fallback empty */ }

  await axios.post(
    'https://discord.com/api/v9/interactions',
    {
      type: 2,
      application_id: HEIST_BOT_ID,
      guild_id: COMMAND_GUILD_ID,
      channel_id: whoisChannelId,
      session_id: sessionId,
      data: {
        version: d2rCommandVersion,
        id: d2rCommandId,
        name: 'discord2roblox',
        type: 1,
        options: [{ type: 6, name: 'user', value: targetUserId }],
      },
      nonce: generateNonce(),
    },
    { headers: { Authorization: TOKEN, 'Content-Type': 'application/json' } },
  );
}

// ═══════════════════════════════════════════════════════════════
//  DISCORD WEBHOOK ALERT
// ═══════════════════════════════════════════════════════════════

async function sendWebhookAlert({ msg, robloxUserId, rap, avatarUrl, geminiItems, textItems }) {
  const jump = `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.messageId}`;
  const rolimons = robloxUserId ? `https://www.rolimons.com/player/${robloxUserId}` : '';

  const embeds = [
    {
      title: 'User Message',
      description:
        `**Message:** ${msg.content || '(no text)'}\n` +
        `**Discord:** <@${msg.discordId}> (${msg.discordTag})\n` +
        `**Discord ID:** \`${msg.discordId}\`\n` +
        `**Channel:** #${msg.channelName}\n` +
        `[Jump to Message](${jump})`,
      color: 0x00ff00,
    },
  ];

  // Only add Roblox embed if we have a valid Roblox user ID
  if (robloxUserId) {
    embeds.push({
      title: 'Roblox & Rolimons',
      description:
        `**RAP:** R$ ${rap.toLocaleString()}\n` +
        `[Roblox Profile](https://www.roblox.com/users/${robloxUserId}/profile) • ` +
        `[Rolimons Profile](${rolimons})`,
      color: 0x00ff00,
      ...(avatarUrl ? { thumbnail: { url: avatarUrl } } : {}),
    });
  } else {
    embeds.push({
      title: 'Roblox Lookup',
      description: '⚠️ Could not resolve Roblox account (heist did not respond)',
      color: 0xFFAA00,
    });
  }

  // Merge and dedupe AI-detected items
  const all = [...(geminiItems || []), ...(textItems || [])];
  const seen = new Set();
  const unique = all.filter(i => { if (seen.has(i.id)) return false; seen.add(i.id); return true; });

  if (unique.length) {
    const bestAi = unique[0]; // already sorted by value desc
    const aiThumb = bestAi?.id ? await fetchItemThumbnail(bestAi.id) : '';
    embeds.push({
      title: 'AI-Detected Items',
      description: unique.map(i => {
        const a = i.acronym ? ` [${i.acronym}]` : '';
        return `**${i.name}**${a} — R$ ${i.value.toLocaleString()}`;
      }).join('\n'),
      color: 0xFF4500,
      ...(aiThumb ? { thumbnail: { url: aiThumb } } : {}),
    });
  }

  const payload = { content: '@everyone', embeds };

  // Send to BOTH webhooks in parallel:
  //   MAIN  = all logs (persistent record)
  //   VALID = new unique users only (already guaranteed by dedup logic)
  const results = await Promise.allSettled([
    axios.post(WEBHOOK_MAIN, payload, { timeout: 10000 }),
    axios.post(WEBHOOK_VALID, payload, { timeout: 10000 }),
  ]);

  if (results[0].status === 'fulfilled') {
    console.log(`[Webhook] Main log sent for ${msg.discordTag} (${msg.discordId})`);
  } else {
    console.error(`[Webhook] Main log error: ${results[0].reason?.message}`);
  }

  if (results[1].status === 'fulfilled') {
    console.log(`[Webhook] Valid log sent for ${msg.discordTag} (${msg.discordId})`);
  } else {
    console.error(`[Webhook] Valid log error: ${results[1].reason?.message}`);
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
      if (!ch) { console.log(`[Startup] Cannot access channel ${chId}, skipping.`); continue; }

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

      console.log(`[Startup] Scanned channel ${chId}`);
    } catch (e) {
      console.error(`[Startup] Error scanning ${chId}:`, e.message);
    }
  }

  console.log(`[Startup] Previous logs loaded: ${robloxCount} Roblox IDs, ${discordCount} Discord IDs — these users will be skipped.`);
}

async function fetchBlockedUsers() {
  try {
    const res = await axios.get('https://discord.com/api/v9/users/@me/relationships', {
      headers: { Authorization: TOKEN },
    });
    blockedUsers = new Set(res.data.filter(u => u.type === 2).map(u => u.id));
    console.log(`[Startup] Blocked users: ${blockedUsers.size}`);
  } catch (e) {
    console.error('[Startup] Blocked users error:', e.message);
  }
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
  console.log(`[Monitor] Logged in as ${client.user.tag}`);

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

  // Discover /discord2roblox command ID (needed for raw API calls)
  const cmdFound = await discoverCommand();
  if (!cmdFound) {
    console.error('[Startup] WARNING: /discord2roblox not found — Roblox lookups will fail!');
  }

  await loadPreviousLogs(client);

  console.log(`[Monitor] Ready — watching ${MONITOR_CHANNEL_IDS.length} channels.\n`);
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

  console.log(`\n[Monitor] ${discordTag} (${discordId}) in #${message.channel.name}`);

  // Save message data for later use
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

  pendingByDiscordId.set(discordId, msgData);
  if (!pendingQueue.has(whoisChannelId)) pendingQueue.set(whoisChannelId, []);
  pendingQueue.get(whoisChannelId).push(discordId);

  // ── STEP 1: Send /discord2roblox ──
  try {
    console.log(`[Monitor]   /discord2roblox → ${discordTag} (whois: ${whoisChannelId})`);
    await sendD2RCommand(whoisChannelId, discordId);
  } catch (e) {
    console.error(`[Monitor]   /discord2roblox error: ${e.response?.data?.message || e.message}`);
    const q = pendingQueue.get(whoisChannelId) || [];
    const idx = q.indexOf(discordId);
    if (idx !== -1) q.splice(idx, 1);
    // heist failed — fall through to AI fallback below
  }
});

// ─── HANDLER 2: HEIST RESPONSE → RAP CHECK → AI FALLBACK ────
// Heist sends a deferred reply (embeds=0) then edits it.
// We detect the empty message and re-fetch after a delay.

client.on('messageCreate', async (message) => {
  if (message.author?.id !== HEIST_BOT_ID) return;
  if (!WHOIS_CHANNEL_IDS.has(message.channel.id)) return;
  if (!pendingQueue.has(message.channel.id) || !pendingQueue.get(message.channel.id).length) return;

  // ── Wait for embed (heist deferred reply) ──
  let embed = null;
  if (message.embeds?.length) {
    embed = message.embeds[0];
  } else {
    console.log(`[Heist] Deferred reply detected, waiting for edit...`);
    for (let attempt = 1; attempt <= 5; attempt++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const updated = await message.channel.messages.fetch(message.id);
        if (updated.embeds?.length) {
          embed = updated.embeds[0];
          console.log(`[Heist] Embed appeared after ${attempt * 2}s`);
          break;
        }
      } catch (e) {
        console.log(`[Heist] Re-fetch error: ${e.message}`);
        break;
      }
    }
  }

  const queue = pendingQueue.get(message.channel.id) || [];
  if (!queue.length) return;
  const discordId = queue.shift();
  const pending = pendingByDiscordId.get(discordId);
  if (!pending) { inFlightDiscordIds.delete(discordId); return; }

  // ── Extract Roblox user ID ──
  let robloxUserId = null;
  if (embed) robloxUserId = extractRobloxIdFromHeistEmbed(embed);

  if (!robloxUserId) {
    console.log(`[Heist] No Roblox ID for ${pending.discordTag} — falling through to AI`);
  } else {
    console.log(`[Heist] ${pending.discordTag} → Roblox ${robloxUserId}`);

    // Already logged?
    if (processedRobloxIds.has(robloxUserId)) {
      console.log(`[Heist] Roblox ${robloxUserId} previously logged — skipping`);
      processedDiscordIds.add(discordId);
      cleanup(discordId);
      return;
    }

    // ── STEP 2: RAP check ──
    const lp = `[Check][${pending.discordTag}][Roblox ${robloxUserId}]`;
    const [rap, avatarUrl] = await Promise.all([
      fetchRobloxRAP(robloxUserId, lp),
      fetchRobloxAvatar(robloxUserId),
    ]);

    if (rap >= VALUE_THRESHOLD) {
      console.log(`${lp} RAP HIT → R$ ${rap.toLocaleString()} — sending to BOTH webhooks`);
      await sendWebhookAlert({
        msg: pending, robloxUserId, rap, avatarUrl,
        geminiItems: [], textItems: [],
      });
      processedDiscordIds.add(discordId);
      processedRobloxIds.add(robloxUserId);
      cleanup(discordId);
      return;
    }

    console.log(`${lp} RAP below threshold (R$ ${rap.toLocaleString()}) — checking AI fallback...`);
  }

  // ── STEP 3: AI FALLBACK (RAP < 100k OR heist didn't return Roblox ID) ──
  // Only runs if the user's RAP wasn't enough on its own
  const imageUrls = pending.imageUrls || [];
  const textContent = pending.content || '';

  // Skip AI fallback for obvious buyer/spam posts — these aren't sellers
  const textLower = textContent.toLowerCase();
  const BUYER_KEYWORDS = [
    'buying your', 'i buy', 'we buy', 'dm me with',
    'paying with', 'will buy', 'looking to buy',
    'buying all', 'buying any', 'i purchase',
  ];
  if (BUYER_KEYWORDS.some(kw => textLower.includes(kw))) {
    console.log(`[AI Fallback] Skipped ${pending.discordTag} — buyer/spam post detected`);
    processedDiscordIds.add(discordId);
    if (robloxUserId) processedRobloxIds.add(robloxUserId);
    cleanup(discordId);
    return;
  }

  let geminiItems = [];
  if (imageUrls.length) {
    console.log(`[AI Fallback] Analyzing ${imageUrls.length} image(s) for ${pending.discordTag}...`);
    try {
      geminiItems = await analyzeMessageImages(imageUrls);
    } catch (e) {
      console.log(`[AI Fallback] Gemini error: ${e.message}`);
    }
  }

  let textItems = [];
  if (textContent.trim()) {
    const { above } = findMentionedItems(textContent);
    textItems = above;
  }

  if (geminiItems.length > 0 || textItems.length > 0) {
    // Check dedup again
    if (processedDiscordIds.has(discordId)) { cleanup(discordId); return; }

    const allItems = [...geminiItems, ...textItems];
    const itemNames = allItems.map(i => `${i.name} (R$ ${i.value.toLocaleString()})`).join(', ');
    console.log(`[AI Fallback] HIT for ${pending.discordTag} → ${itemNames} — sending to VALID webhook`);

    // Fetch thumbnail for the highest-value item
    const bestItem = allItems.sort((a, b) => b.value - a.value)[0];
    const thumbUrl = bestItem?.id ? await fetchItemThumbnail(bestItem.id) : '';

    // AI fallback alerts go to VALID webhook only
    const jump = `https://discord.com/channels/${pending.guildId}/${pending.channelId}/${pending.messageId}`;
    const embeds = [
      {
        title: 'AI-Detected High-Value Items',
        description:
          `**Discord:** <@${pending.discordId}> (${pending.discordTag})\n` +
          `**Discord ID:** \`${pending.discordId}\`\n` +
          `**Channel:** #${pending.channelName}\n` +
          `[Jump to Message](${jump})`,
        color: 0xFF4500,
        ...(thumbUrl ? { thumbnail: { url: thumbUrl } } : {}),
      },
      {
        title: 'Detected Items',
        description: allItems.map(i => {
          const a = i.acronym ? ` [${i.acronym}]` : '';
          return `**${i.name}**${a} — R$ ${i.value.toLocaleString()}`;
        }).join('\n'),
        color: 0xFF4500,
      },
    ];

    if (robloxUserId) {
      embeds.splice(1, 0, {
        title: 'Roblox (below RAP threshold)',
        description: `[Roblox Profile](https://www.roblox.com/users/${robloxUserId}/profile) • [Rolimons](https://www.rolimons.com/player/${robloxUserId})`,
        color: 0xFFAA00,
      });
    }

    try {
      await axios.post(WEBHOOK_VALID, { content: '@everyone', embeds }, { timeout: 10000 });
      console.log(`[AI Fallback] Sent to VALID webhook for ${pending.discordTag}`);
    } catch (e) {
      console.error(`[AI Fallback] Webhook error: ${e.message}`);
    }

    processedDiscordIds.add(discordId);
    if (robloxUserId) processedRobloxIds.add(robloxUserId);
  } else {
    console.log(`[AI Fallback] No high-value items found for ${pending.discordTag} — skipping`);
    processedDiscordIds.add(discordId);
    if (robloxUserId) processedRobloxIds.add(robloxUserId);
  }

  cleanup(discordId);
});

// ═══════════════════════════════════════════════════════════════
//  ERROR HANDLING & LOGIN
// ═══════════════════════════════════════════════════════════════

client.on('error', (e) => console.error('[Client]', e));
process.on('unhandledRejection', (e) => console.error('[Unhandled]', e));

client.login(TOKEN).catch(e => {
  console.error('[Login] Failed:', e);
  process.exit(1);
});
