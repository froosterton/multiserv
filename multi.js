const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');

// Use environment variable for token (more secure)
const TOKEN = process.env.DISCORD_TOKEN;

// Monitor channels for each guild
// Guild 907175349706706974: channels 907175350348423224, 1391793760354173098, 907175350570717224
// Guild 786851062219931690: channels 808540135666745345, 792178431419744286, 786851062219931693
// Guild 749629643836882975: channels 749645946719174757, 755810466214707220, 749629644277416048
const MONITOR_CHANNEL_IDS = [
  '907175350348423224', '1391793760354173098', '907175350570717224', // Guild 907175349706706974
  '808540135666745345', '792178431419744286', '786851062219931693', // Guild 786851062219931690
  '749645946719174757', '755810466214707220', '749629644277416048'  // Guild 749629643836882975
];

// Map monitor channels to their corresponding whois/command channels (all in guild 1465604866952007815)
const CHANNEL_MAPPING = {
  // Guild 907175349706706974 -> whois channel 1465604933767266422
  '907175350348423224': '1465604933767266422',
  '1391793760354173098': '1465604933767266422',
  '907175350570717224': '1465604933767266422',
  // Guild 786851062219931690 -> whois channel 1465604923189231669
  '808540135666745345': '1465604923189231669',
  '792178431419744286': '1465604923189231669',
  '786851062219931693': '1465604923189231669',
  // Guild 749629643836882975 -> whois channel 1465604867824291905
  '749645946719174757': '1465604867824291905',
  '755810466214707220': '1465604867824291905',
  '749629644277416048': '1465604867824291905'
};

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const BOT_ID = '298796807323123712';

// Value threshold
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

// FAST: Use Roblox API for RAP (much faster than scraping)
async function fetchRobloxRAP(robloxUserId) {
  let rap = 0;
  let cursor = undefined;

  try {
    while (true) {
      const { data } = await axios.get(
        `https://inventory.roblox.com/v1/users/${robloxUserId}/assets/collectibles`,
        {
          params: { limit: 100, sortOrder: 'Asc', cursor },
          timeout: 2000
        }
      );

      if (!data || !Array.isArray(data.data) || data.data.length === 0) break;

      for (const entry of data.data) {
        rap += Number(entry.recentAveragePrice || 0);
      }

      if (data.nextPageCursor) cursor = data.nextPageCursor;
      else break;
    }
  } catch (error) {
    console.log(`[Monitor] Error fetching RAP: ${error.message}`);
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
  } catch (error) {
    return '';
  }
}

// OPTIMIZED: Fast path - get RAP and avatar
async function scrapeRolimons(robloxUserId) {
  const rolimonsUrl = `https://www.rolimons.com/player/${robloxUserId}`;

  const [rap, avatarUrl] = await Promise.all([
    fetchRobloxRAP(robloxUserId),
    fetchRobloxAvatar(robloxUserId)
  ]);

  return {
    value: rap,
    avatarUrl,
    rolimonsUrl
  };
}

const client = new Client({ checkUpdate: false });

let processedUsers = new Set();
let pendingRoblox = new Map();
let webhookSent = new Set();
// per-whois-channel FIFO queue of discordIds (fallback only)
let pendingByWhoisChannel = new Map();

client.on('ready', async () => {
  console.log(`[Monitor] Logged in as ${client.user.tag}`);
  await fetchBlockedUsers();
  console.log(`[Monitor] Bot ready and monitoring ${MONITOR_CHANNEL_IDS.length} channels!`);
  console.log(`[Monitor] Channels: ${MONITOR_CHANNEL_IDS.join(', ')}`);
  console.log(`[Monitor] Channel mapping:`, CHANNEL_MAPPING);
});

// Monitor user messages
client.on('messageCreate', async (message) => {
  if (blockedUsers.has(message.author.id)) return;
  if (!MONITOR_CHANNEL_IDS.includes(message.channel.id)) return;
  if (message.author.bot) return;
  if (processedUsers.has(message.author.id)) return;

  // Role filtering removed - monitor all users

  // Get the corresponding whois channel for this monitor channel
  const whoisChannelId = CHANNEL_MAPPING[message.channel.id];
  if (!whoisChannelId) {
    console.log(`[Monitor] No whois channel mapping found for ${message.channel.id}`);
    return;
  }

  // Store the message info keyed by Discord ID
  pendingRoblox.set(message.author.id, {
    discordId: message.author.id,
    discordTag: message.author.tag,
    content: message.content,
    timestamp: message.createdTimestamp,
    channelId: message.channel.id,
    channelName: message.channel.name,
    messageId: message.id,
    guildId: message.guild.id,
    whoisChannelId
  });

  // Enqueue this Discord ID for that whois channel (fallback if embed has no Discord ID)
  if (!pendingByWhoisChannel.has(whoisChannelId)) {
    pendingByWhoisChannel.set(whoisChannelId, []);
  }
  pendingByWhoisChannel.get(whoisChannelId).push(message.author.id);

  const whoisChannel = await client.channels.fetch(whoisChannelId);
  if (!whoisChannel) return;
  await whoisChannel.sendSlash(BOT_ID, 'whois discord', message.author.id);
  console.log(
    `[Monitor] Sent /whois discord for ${message.author.tag} (${message.author.id}) ` +
    `in #${message.channel.name} -> whois channel ${whoisChannelId}`
  );
});

// Listen for RoVer bot responses globally
client.on('messageCreate', async (message) => {
  const whoisChannelIds = Object.values(CHANNEL_MAPPING);

  if (
    message.author.id === BOT_ID &&
    whoisChannelIds.includes(message.channel.id) &&
    message.embeds &&
    message.embeds.length > 0 &&
    message.embeds[0].fields
  ) {
    let robloxUserId = '';
    let discordIdFromEmbed = '';

    for (const field of message.embeds[0].fields) {
      const name = field.name.toLowerCase();
      const value = (field.value || '').replace(/`/g, '').trim();

      if (name.includes('roblox user id')) {
        robloxUserId = value;
      }
      // RoVer embed often has "Discord User ID" or similar; value can be raw ID or <@123> mention
      if ((name.includes('discord') && name.includes('id')) || name === 'discord user id') {
        const extracted = value.replace(/\D/g, '');
        if (extracted.length >= 17) discordIdFromEmbed = extracted;
      }
    }

    if (!robloxUserId) return;

    // Match by Discord ID from embed so we pair the correct user with the correct Roblox data
    let discordId = discordIdFromEmbed;
    if (discordId) {
      const queue = pendingByWhoisChannel.get(message.channel.id) || [];
      const idx = queue.indexOf(discordId);
      if (idx !== -1) queue.splice(idx, 1);
    } else {
      // Fallback: FIFO (can still mismatch if RoVer responds out of order)
      const queue = pendingByWhoisChannel.get(message.channel.id) || [];
      discordId = queue.shift();
      if (discordId) {
        console.log(`[Monitor] No Discord ID in RoVer embed, using FIFO fallback for ${discordId}`);
      }
    }

    if (!discordId) return;

    const msg = pendingRoblox.get(discordId);
    if (!msg || processedUsers.has(discordId)) {
      if (!msg) console.log(`[Monitor] No pending entry for Discord ID ${discordId}, skipping RoVer response`);
      return;
    }

    // Scrape Rolimons and check value
    const { value, avatarUrl, rolimonsUrl } = await scrapeRolimons(robloxUserId);
    console.log(`[Monitor] Scraped value: ${value} for ${msg.discordTag} (${discordId})`);

    if (value >= VALUE_THRESHOLD) {
      if (webhookSent.has(discordId)) {
        console.log(`[Monitor] Webhook already sent for ${msg.discordTag}, skipping...`);
        processedUsers.add(discordId);
        pendingRoblox.delete(discordId);
        return;
      }

      const jumpToMessageUrl =
        `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.messageId}`;

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

        processedUsers.add(discordId);
        webhookSent.add(discordId);
        pendingRoblox.delete(discordId);
        console.log(
          `[Monitor] Sent webhook for ${msg.discordTag} with RAP ${value.toLocaleString()} ` +
          `from #${msg.channelName}!`
        );
      } catch (error) {
        console.error('Error sending webhook:', error.message);
        // don't mark as processed on failure
      }
    } else {
      console.log(
        `[Monitor] User ${msg.discordTag} did not meet value requirement (${value} < ${VALUE_THRESHOLD}).`
      );
      processedUsers.add(discordId);
      pendingRoblox.delete(discordId);
    }
  }
});

// Error handling
client.on('error', (error) => {
  console.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  process.exit(0);
});

// Start the bot
client.login(TOKEN).catch(error => {
  console.error('Failed to login:', error);
  process.exit(1);
});
