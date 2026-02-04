const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');

const TOKEN = process.env.DISCORD_TOKEN;

const MONITOR_CHANNEL_IDS = [
  '907175350348423224', '1391793760354173098', '907175350570717224',
  '808540135666745345', '792178431419744286', '786851062219931693',
  '749645946719174757', '755810466214707220', '749629644277416048'
];

const CHANNEL_MAPPING = {
  '907175350348423224': '1465604933767266422',
  '1391793760354173098': '1465604933767266422',
  '907175350570717224': '1465604933767266422',

  '808540135666745345': '1465604923189231669',
  '792178431419744286': '1465604923189231669',
  '786851062219931693': '1465604923189231669',

  '749645946719174757': '1465604867824291905',
  '755810466214707220': '1465604867824291905',
  '749629644277416048': '1465604867824291905'
};

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const BOT_ID = '298796807323123712';
const VALUE_THRESHOLD = 100000;

let blockedUsers = new Set();
async function fetchBlockedUsers() {
  try {
    const res = await axios.get('https://discord.com/api/v9/users/@me/relationships', {
      headers: { Authorization: TOKEN }
    });
    blockedUsers = new Set(res.data.filter(u => u.type === 2).map(u => u.id));
    console.log('[Monitor] Blocked users loaded:', blockedUsers.size);
  } catch (error) {
    console.error('[Monitor] Error fetching blocked users:', error.message);
  }
}

function normName(s) {
  let t = String(s || '').trim().toLowerCase();
  if (t.startsWith('@')) t = t.slice(1);

  // Normalize "name#0" to "name" (Discord new username era)
  if (t.endsWith('#0')) t = t.slice(0, -2);

  return t;
}

function extractDiscordNameLoose(text) {
  // Accept: name#1234, name#0, or plain name
  const s = String(text || '').replace(/`/g, '').trim();
  if (!s) return '';

  const tagMatch = s.match(/([^\s`]+#\d{1,4})/);
  if (tagMatch) return tagMatch[1];

  // Fallback: first “word-ish” token
  const token = s.split(/\s+/)[0];
  return token || '';
}

function extractRobloxUserIdFromEmbed(embed) {
  for (const field of embed.fields || []) {
    const name = String(field.name || '').toLowerCase();
    const value = String(field.value || '').replace(/`/g, '').trim();
    if (name.includes('roblox user id')) return value.replace(/\D/g, '');
  }
  return '';
}

function extractDiscordNameFromEmbed(embed) {
  // Prefer fields first
  for (const field of embed.fields || []) {
    const name = String(field.name || '').toLowerCase();
    const value = String(field.value || '');

    if (name.includes('discord') && (name.includes('user') || name.includes('username') || name.includes('account'))) {
      const got = extractDiscordNameLoose(value);
      if (got) return got;
    }
    if (name.includes('discord username')) {
      const got = extractDiscordNameLoose(value);
      if (got) return got;
    }
  }

  // Fallback: scan common embed surfaces
  const candidates = [
    embed.title,
    embed.description,
    embed.author?.name,
    ...(embed.footer?.text ? [embed.footer.text] : [])
  ];
  for (const c of candidates) {
    const got = extractDiscordNameLoose(c);
    if (got) return got;
  }

  return '';
}

// LOGS per user whether Roblox API was called + result
async function fetchRobloxRAP(robloxUserId, logPrefix) {
  let rap = 0;
  let cursor = undefined;
  let pages = 0;

  console.log(`${logPrefix} Roblox API CALL -> inventory collectibles START`);

  try {
    while (true) {
      const { data } = await axios.get(
        `https://inventory.roblox.com/v1/users/${robloxUserId}/assets/collectibles`,
        { params: { limit: 100, sortOrder: 'Asc', cursor }, timeout: 2000 }
      );

      pages += 1;

      if (!data || !Array.isArray(data.data) || data.data.length === 0) break;

      for (const entry of data.data) rap += Number(entry.recentAveragePrice || 0);

      if (data.nextPageCursor) cursor = data.nextPageCursor;
      else break;
    }

    console.log(`${logPrefix} Roblox API DONE -> rap=${rap.toLocaleString()} pages=${pages}`);
  } catch (err) {
    console.log(`${logPrefix} Roblox API ERROR -> ${err.message}`);
  }

  return rap;
}

async function fetchRobloxAvatar(robloxUserId) {
  try {
    const { data } = await axios.get('https://thumbnails.roblox.com/v1/users/avatar-headshot', {
      params: { userIds: robloxUserId, size: '150x150', format: 'Png', isCircular: false },
      timeout: 1500
    });
    return (data?.data?.[0]?.imageUrl) || '';
  } catch {
    return '';
  }
}

async function scrapeRolimons(robloxUserId, logPrefix) {
  const rolimonsUrl = `https://www.rolimons.com/player/${robloxUserId}`;

  const [rap, avatarUrl] = await Promise.all([
    fetchRobloxRAP(robloxUserId, logPrefix),
    fetchRobloxAvatar(robloxUserId)
  ]);

  return { value: rap, avatarUrl, rolimonsUrl };
}

const client = new Client({ checkUpdate: false });

// Dedup per Discord ID (from monitored messages)
const processedDiscordIds = new Set();
const inFlightDiscordIds = new Set();
const webhookSent = new Set();

const pendingByDiscordId = new Map();
// whoisChannelId -> Array<{ discordId, discordNameNorm }>
const pendingByWhoisChannel = new Map();

client.on('ready', async () => {
  console.log(`[Monitor] Logged in as ${client.user.tag}`);
  await fetchBlockedUsers();
  console.log(`[Monitor] Bot ready and monitoring ${MONITOR_CHANNEL_IDS.length} channels!`);
});

// 1) Monitor user messages in source channels
client.on('messageCreate', async (message) => {
  if (!message.author?.id) return;
  if (message.author.bot) return;
  if (blockedUsers.has(message.author.id)) return;
  if (!MONITOR_CHANNEL_IDS.includes(message.channel.id)) return;

  const discordId = message.author.id;

  if (processedDiscordIds.has(discordId) || inFlightDiscordIds.has(discordId)) return;

  const whoisChannelId = CHANNEL_MAPPING[message.channel.id];
  if (!whoisChannelId) {
    console.log(`[Monitor] No whois mapping for monitor channel ${message.channel.id}`);
    return;
  }

  inFlightDiscordIds.add(discordId);

  const discordTag = message.author.tag; // might be name#0 etc
  const discordNameNorm = normName(discordTag);

  pendingByDiscordId.set(discordId, {
    discordId,
    discordTag,
    discordNameNorm,
    content: message.content,
    timestamp: message.createdTimestamp,
    channelId: message.channel.id,
    channelName: message.channel.name,
    messageId: message.id,
    guildId: message.guild?.id,
    whoisChannelId
  });

  if (!pendingByWhoisChannel.has(whoisChannelId)) pendingByWhoisChannel.set(whoisChannelId, []);
  pendingByWhoisChannel.get(whoisChannelId).push({ discordId, discordNameNorm });

  const whoisChannel = await client.channels.fetch(whoisChannelId);
  if (!whoisChannel) return;

  console.log(`[Monitor] Captured user ${discordTag} (${discordId}) -> sending /whois discord`);
  await whoisChannel.sendSlash(BOT_ID, 'whois discord', discordId);
  console.log(`[Monitor] Sent /whois discord for ${discordTag} (${discordId}) -> whois channel ${whoisChannelId}`);
});

// 2) Handle RoVer replies (THIS is where Roblox gets called and logged)
client.on('messageCreate', async (message) => {
  const whoisChannelIds = new Set(Object.values(CHANNEL_MAPPING));

  if (message.author?.id !== BOT_ID) return;
  if (!whoisChannelIds.has(message.channel.id)) return;
  if (!message.embeds?.length) return;

  const embed = message.embeds[0];
  if (!embed?.fields) return;

  const robloxUserId = extractRobloxUserIdFromEmbed(embed);
  const discordNameFromEmbed = extractDiscordNameFromEmbed(embed);

  const basePrefix = `[Monitor][RoVer][whois=${message.channel.id}]`;
  console.log(`${basePrefix} Embed received -> robloxUserId=${robloxUserId || 'MISSING'} discord=${discordNameFromEmbed || 'MISSING'}`);

  if (!robloxUserId) return;

  const logPrefix = `[Monitor][Check][Roblox ${robloxUserId}]`;

  console.log(`${logPrefix} Starting value check (Roblox API call will run now)`);
  const { value, avatarUrl, rolimonsUrl } = await scrapeRolimons(robloxUserId, logPrefix);
  console.log(`${logPrefix} Value computed -> rap=${value.toLocaleString()} threshold=${VALUE_THRESHOLD.toLocaleString()}`);

  if (value < VALUE_THRESHOLD) {
    console.log(`${logPrefix} Below threshold -> SKIP`);
    return;
  }

  console.log(`${logPrefix} ABOVE threshold -> extracting Discord username from embed: ${discordNameFromEmbed || 'MISSING'}`);

  // Try to match to a pending monitored message so we can include the jump link/message.
  const targetNorm = normName(discordNameFromEmbed);
  const queue = pendingByWhoisChannel.get(message.channel.id) || [];
  const idx = queue.findIndex(x => x.discordNameNorm === targetNorm);

  if (idx === -1) {
    console.log(`${logPrefix} No pending monitored user matched embed discord="${discordNameFromEmbed}" (norm="${targetNorm}") -> cannot link original message`);
    // Still above threshold, but we have nothing to attach to. If you want, I can send webhook anyway with just the embed username + Roblox links.
    return;
  }

  const { discordId } = queue.splice(idx, 1)[0];
  const msg = pendingByDiscordId.get(discordId);

  if (!msg) {
    console.log(`${logPrefix} Matched discordId=${discordId} but pending entry missing -> abort`);
    inFlightDiscordIds.delete(discordId);
    return;
  }

  if (processedDiscordIds.has(discordId)) {
    console.log(`${logPrefix} discordId=${discordId} already processed -> skip`);
    inFlightDiscordIds.delete(discordId);
    pendingByDiscordId.delete(discordId);
    return;
  }

  if (webhookSent.has(discordId)) {
    console.log(`${logPrefix} webhook already sent for discordId=${discordId} -> skip`);
    processedDiscordIds.add(discordId);
    inFlightDiscordIds.delete(discordId);
    pendingByDiscordId.delete(discordId);
    return;
  }

  const jumpToMessageUrl = `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.messageId}`;

  try {
    await axios.post(WEBHOOK_URL, {
      content: '@everyone',
      embeds: [
        {
          title: 'User Message',
          description:
            `**Message:** ${msg.content}\n` +
            `**Discord:** ${msg.discordTag}\n` +
            `**Channel:** #${msg.channelName}\n` +
            `[Jump to Message](${jumpToMessageUrl})`,
          color: 0x00ff00
        },
        {
          title: 'Roblox & Rolimons',
          description:
            `**RAP:** ${value.toLocaleString()}\n` +
            `[Roblox Profile](https://www.roblox.com/users/${robloxUserId}/profile) • ` +
            `[Rolimons Profile](${rolimonsUrl})`,
          color: 0x00ff00,
          thumbnail: { url: avatarUrl }
        }
      ]
    });

    webhookSent.add(discordId);
    processedDiscordIds.add(discordId);
    console.log(`${logPrefix} Webhook SENT for ${msg.discordTag} (${discordId})`);
  } catch (err) {
    console.error(`${logPrefix} Webhook ERROR -> ${err.message}`);
  } finally {
    inFlightDiscordIds.delete(discordId);
    pendingByDiscordId.delete(discordId);
  }
});

client.on('error', (error) => console.error('[Monitor] Discord client error:', error));
process.on('unhandledRejection', (error) => console.error('[Monitor] Unhandled promise rejection:', error));

client.login(TOKEN).catch(error => {
  console.error('[Monitor] Failed to login:', error);
  process.exit(1);
});
