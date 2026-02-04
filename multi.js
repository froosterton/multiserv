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
    console.log('Blocked users loaded:', blockedUsers.size);
  } catch (error) {
    console.error('Error fetching blocked users:', error.message);
  }
}

function normTag(tag) {
  return String(tag || '').trim().toLowerCase();
}

function extractDiscordTag(text) {
  const s = String(text || '').replace(/`/g, '').trim();
  const m = s.match(/([^\s`]+#\d{1,4})/);
  return m ? m[1] : '';
}

function extractRobloxUserIdFromEmbed(embed) {
  for (const field of embed.fields || []) {
    const name = String(field.name || '').toLowerCase();
    const value = String(field.value || '').replace(/`/g, '').trim();
    if (name.includes('roblox user id')) return value.replace(/\D/g, '');
  }
  return '';
}

function extractDiscordTagFromEmbed(embed) {
  for (const field of embed.fields || []) {
    const name = String(field.name || '').toLowerCase();
    const value = String(field.value || '');

    if (
      name.includes('discord') &&
      (name.includes('user') || name.includes('username') || name.includes('account'))
    ) {
      const tag = extractDiscordTag(value);
      if (tag) return tag;
    }

    if (name.includes('discord username')) {
      const tag = extractDiscordTag(value);
      if (tag) return tag;
    }
  }

  const candidates = [
    embed.title,
    embed.description,
    embed.author?.name,
    ...(embed.footer?.text ? [embed.footer.text] : [])
  ];

  for (const c of candidates) {
    const tag = extractDiscordTag(c);
    if (tag) return tag;
  }

  return '';
}

// Logs per user whether Roblox API was called + result
async function fetchRobloxRAP(robloxUserId, logPrefix = '[Monitor]') {
  let rap = 0;
  let cursor = undefined;
  let pages = 0;

  console.log(`${logPrefix} Roblox API RAP fetch START userId=${robloxUserId}`);

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

    console.log(
      `${logPrefix} Roblox API RAP fetch DONE userId=${robloxUserId} rap=${rap.toLocaleString()} pages=${pages}`
    );
  } catch (error) {
    console.log(
      `${logPrefix} Roblox API RAP fetch ERROR userId=${robloxUserId} message=${error.message}`
    );
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

async function scrapeRolimons(robloxUserId, logPrefix = '[Monitor]') {
  const rolimonsUrl = `https://www.rolimons.com/player/${robloxUserId}`;
  const [rap, avatarUrl] = await Promise.all([
    fetchRobloxRAP(robloxUserId, logPrefix),
    fetchRobloxAvatar(robloxUserId)
  ]);
  return { value: rap, avatarUrl, rolimonsUrl };
}

const client = new Client({ checkUpdate: false });

// Hard dedupe
const processedDiscordIds = new Set();
const inFlightDiscordIds = new Set(); // queued/sent whois, waiting for rover/processing
const webhookSent = new Set();

// Pending info keyed by Discord ID
const pendingByDiscordId = new Map();

// Per-whois-channel pending list (match by embed discordTag)
const pendingByWhoisChannel = new Map(); // whoisChannelId -> Array<{ discordId, discordTagLower }>

client.on('ready', async () => {
  console.log(`[Monitor] Logged in as ${client.user.tag}`);
  await fetchBlockedUsers();
  console.log(`[Monitor] Bot ready and monitoring ${MONITOR_CHANNEL_IDS.length} channels!`);
});

client.on('messageCreate', async (message) => {
  // 1) Monitor messages in source channels
  if (
    message.author?.id &&
    !message.author.bot &&
    !blockedUsers.has(message.author.id) &&
    MONITOR_CHANNEL_IDS.includes(message.channel.id)
  ) {
    const discordId = message.author.id;

    // Prevent same Discord user from being queued/logged multiple times
    if (processedDiscordIds.has(discordId) || inFlightDiscordIds.has(discordId)) return;

    const whoisChannelId = CHANNEL_MAPPING[message.channel.id];
    if (!whoisChannelId) {
      console.log(`[Monitor] No whois channel mapping found for ${message.channel.id}`);
      return;
    }

    inFlightDiscordIds.add(discordId);

    pendingByDiscordId.set(discordId, {
      discordId,
      discordTag: message.author.tag,
      discordTagLower: normTag(message.author.tag),
      content: message.content,
      timestamp: message.createdTimestamp,
      channelId: message.channel.id,
      channelName: message.channel.name,
      messageId: message.id,
      guildId: message.guild?.id,
      whoisChannelId
    });

    if (!pendingByWhoisChannel.has(whoisChannelId)) pendingByWhoisChannel.set(whoisChannelId, []);
    pendingByWhoisChannel.get(whoisChannelId).push({
      discordId,
      discordTagLower: normTag(message.author.tag)
    });

    const whoisChannel = await client.channels.fetch(whoisChannelId);
    if (!whoisChannel) return;

    await whoisChannel.sendSlash(BOT_ID, 'whois discord', discordId);

    console.log(
      `[Monitor] Sent /whois discord for ${message.author.tag} (${discordId}) ` +
      `in #${message.channel.name} -> whois channel ${whoisChannelId}`
    );

    return;
  }

  // 2) Handle RoVer replies in whois channels
  const whoisChannelIds = new Set(Object.values(CHANNEL_MAPPING));

  if (
    message.author?.id !== BOT_ID ||
    !whoisChannelIds.has(message.channel.id) ||
    !message.embeds ||
    message.embeds.length === 0
  ) {
    return;
  }

  const embed = message.embeds[0];
  if (!embed?.fields) return;

  const robloxUserId = extractRobloxUserIdFromEmbed(embed);
  const discordTagFromEmbed = extractDiscordTagFromEmbed(embed);

  if (!robloxUserId || !discordTagFromEmbed) return;

  const queue = pendingByWhoisChannel.get(message.channel.id) || [];
  const targetTagLower = normTag(discordTagFromEmbed);

  const idx = queue.findIndex(x => x.discordTagLower === targetTagLower);
  if (idx === -1) {
    console.log(
      `[Monitor] Rover embed tag ${discordTagFromEmbed} not found in pending queue for whois channel ${message.channel.id}, skipping`
    );
    return;
  }

  const { discordId } = queue.splice(idx, 1)[0];
  const msg = pendingByDiscordId.get(discordId);

  if (!msg) {
    console.log(`[Monitor] No pending entry for Discord ID ${discordId}, skipping`);
    inFlightDiscordIds.delete(discordId);
    return;
  }

  if (processedDiscordIds.has(discordId)) {
    inFlightDiscordIds.delete(discordId);
    pendingByDiscordId.delete(discordId);
    return;
  }

  const logPrefix = `[Monitor][Check ${msg.discordTag} (${discordId})][Roblox ${robloxUserId}]`;

  console.log(`${logPrefix} Starting value check (will call Roblox API for RAP)`);
  const { value, avatarUrl, rolimonsUrl } = await scrapeRolimons(robloxUserId, logPrefix);
  console.log(`${logPrefix} Value check result rap=${value.toLocaleString()} threshold=${VALUE_THRESHOLD.toLocaleString()}`);

  if (value < VALUE_THRESHOLD) {
    console.log(`${logPrefix} Below threshold; marking processed.`);
    processedDiscordIds.add(discordId);
    inFlightDiscordIds.delete(discordId);
    pendingByDiscordId.delete(discordId);
    return;
  }

  if (webhookSent.has(discordId)) {
    console.log(`${logPrefix} Webhook already sent; marking processed.`);
    webhookSent.add(discordId);
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
    console.log(`${logPrefix} Sent webhook (RAP ${value.toLocaleString()}).`);
  } catch (error) {
    console.error(`${logPrefix} Error sending webhook:`, error.message);
    // If webhook fails, allow retry later (do not mark processed)
  } finally {
    inFlightDiscordIds.delete(discordId);
    pendingByDiscordId.delete(discordId);
  }
});

client.on('error', (error) => console.error('Discord client error:', error));
process.on('unhandledRejection', (error) => console.error('Unhandled promise rejection:', error));
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  process.exit(0);
});

client.login(TOKEN).catch(error => {
  console.error('Failed to login:', error);
  process.exit(1);
});
