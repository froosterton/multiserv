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

// Map monitor channels to their corresponding whois channels
// Command guild: 1465604866952007815
// Channel 1465604867824291905 handles commands for guild 749629643836882975
// Channel 1465604923189231669 handles commands for guild 786851062219931690
// Channel 1465604933767266422 handles commands for guild 907175349706706974
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
  
  // Get RAP and avatar in parallel (FASTEST - ~200-500ms)
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
let webhookSent = new Set(); // Track which users we've already sent webhooks for

client.on('ready', async () => {
  console.log(`[Monitor] Logged in as ${client.user.tag}`);
  await fetchBlockedUsers();
  console.log(`[Monitor] Bot ready and monitoring ${MONITOR_CHANNEL_IDS.length} channels!`);
  console.log(`[Monitor] Channels: ${MONITOR_CHANNEL_IDS.join(', ')}`);
  console.log(`[Monitor] Channel mapping:`, CHANNEL_MAPPING);
});

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

  // Store the message info keyed by Discord ID (same pattern as working code)
  pendingRoblox.set(message.author.id, {
    discordId: message.author.id,
    discordTag: message.author.tag,
    content: message.content,
    timestamp: message.createdTimestamp,
    channelId: message.channel.id,
    channelName: message.channel.name,
    messageId: message.id,
    guildId: message.guild.id,
    whoisChannelId: whoisChannelId
  });
  
  const whoisChannel = await client.channels.fetch(whoisChannelId);
  if (!whoisChannel) return;
  await whoisChannel.sendSlash(BOT_ID, 'whois discord', message.author.id);
  console.log(`[Monitor] Sent /whois discord for ${message.author.tag} (${message.author.id}) in #${message.channel.name} -> whois channel ${whoisChannelId}`);
});

// Listen for bot responses globally
client.on('messageCreate', async (message) => {
  // Check if this is a bot response in any of our whois channels
  const whoisChannelIds = Object.values(CHANNEL_MAPPING);
  if (
    message.author.id === BOT_ID &&
    whoisChannelIds.includes(message.channel.id) &&
    message.embeds &&
    message.embeds.length > 0 &&
    message.embeds[0].fields
  ) {
    let robloxUserId = '';
    for (const field of message.embeds[0].fields) {
      if (field.name.toLowerCase().includes('roblox user id')) {
        robloxUserId = field.value.replace(/`/g, '').trim();
        break;
      }
    }
    if (!robloxUserId) return;

    // Same matching flow as the working script
    for (const [discordId, msg] of pendingRoblox.entries()) {
      if (processedUsers.has(discordId)) continue;
      
      // Scrape Rolimons and check value
      const { value, avatarUrl, rolimonsUrl } = await scrapeRolimons(robloxUserId);
      console.log(`[Monitor] Scraped value: ${value}`);
      
      if (value >= VALUE_THRESHOLD) {
        // Check if we've already sent a webhook for this user
        if (webhookSent.has(discordId)) {
          console.log(`[Monitor] Webhook already sent for ${msg.discordTag}, skipping...`);
          processedUsers.add(discordId);
          pendingRoblox.delete(discordId);
          continue;
        }
        
        // Create jump to message link
        const jumpToMessageUrl = `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.messageId}`;
        
        try {
          await axios.post(WEBHOOK_URL, {
            content: '@everyone',
            embeds: [
              {
                title: 'User Message',
                description: `**Message:** ${msg.content}\n**Discord:** ${msg.discordTag}\n**Channel:** #${msg.channelName}\n[Jump to Message](${jumpToMessageUrl})`,
                color: 0x00ff00
              },
              {
                title: 'Roblox & Rolimons',
                description: `**RAP:** ${value.toLocaleString()}\n[Roblox Profile](https://www.roblox.com/users/${robloxUserId}/profile) • [Rolimons Profile](${rolimonsUrl})`,
                color: 0x00ff00,
                thumbnail: { url: avatarUrl }
              }
            ]
          });
          
          // Mark this user as processed and webhook sent
          processedUsers.add(discordId);
          webhookSent.add(discordId);
          pendingRoblox.delete(discordId);
          console.log(`[Monitor] Sent webhook for ${msg.discordTag} with RAP ${value.toLocaleString()} from #${msg.channelName}!`);
          break; // Only process the first match
        } catch (error) {
          console.error('Error sending webhook:', error.message);
          // Don't mark as processed if webhook failed
        }
      } else {
        console.log(`[Monitor] User did not meet value requirement (${value} < ${VALUE_THRESHOLD}).`);
        processedUsers.add(discordId);
        pendingRoblox.delete(discordId);
      }
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
