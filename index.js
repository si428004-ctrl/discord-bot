// --- 🟢 Mini Express server pro Render --- //
import express from "express";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => res.send("✅ Bot is running!"));

app.listen(PORT, () => {
  console.log(`🌐 Mini server běží na portu ${PORT}`);
});


// --- 🤖 Discord bot část --- //
import { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  EmbedBuilder 
} from 'discord.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// ⬇️ Doplň svoje ID kanálů / rolí ⬇️
const WELCOME_CHANNEL_ID = '1428862251162403019';
const JOIN_LOG_CHANNEL_ID = '1428864324474114141';
const VERIFIED_ROLE_ID = '1428624557635407902';
const UNVERIFIED_ROLE_ID = '1428863230217945198';

client.once('ready', () => {
  console.log(`✅ Přihlášen jako ${client.user.tag}`);

  // 🔔 Pošle zprávu do log kanálu po restartu
  const channel = client.channels.cache.get('1421633740689506405');
  if (channel) {
    channel.send('🟢  Bot je zpět online');
  } else {
    console.warn('⚠️ Kanál s ID 1421633740689506405 nebyl nalezen.');
  }
});

client.on('guildMemberAdd', async member => {
  const welcomeChannel = member.guild.channels.cache.get(WELCOME_CHANNEL_ID);
  if (!welcomeChannel) return;

  try {
    // 🟡 Přidat Unverified roli po joinu
    await member.roles.add(UNVERIFIED_ROLE_ID);
    console.log(`👤 ${member.user.tag} dostal roli Unverified`);

    // 📩 Poslat otázku
    const questionMsg = await welcomeChannel.send(
      `Ahoj ${member}, pro schválení potřebujeme tvou odpověď. Kde jsi našel náš server a proč se chceš připojit?`
    );

    // 📨 Collector na odpověď (24 h timeout)
    const filter = m => m.author.id === member.id;
    const collector = welcomeChannel.createMessageCollector({ filter, max: 1, time: 86400000 });

    collector.on('collect', async msg => {
      const logChannel = member.guild.channels.cache.get(JOIN_LOG_CHANNEL_ID);
      if (!logChannel) return;

      // 🔴 Úvodní embed s odpovědí
      const embed = new EmbedBuilder()
        .setTitle(`🆕 Nový člen na serveru`)
        .setDescription(`👤 **Uživatel:** <@${member.id}>\n📝 **Odpověď:**\n\n${msg.content || '*Žádná odpověď*'}`)
        .setColor('#ff0000')
        
      const logMsg = await logChannel.send({ embeds: [embed] });

      // ➕ Reakce pro schválení / odmítnutí
      await logMsg.react('✅');
      await logMsg.react('❌');

      // 🧼 Smazat otázku + odpověď z welcome
      await msg.delete().catch(() => {});
      await questionMsg.delete().catch(() => {});

      // 🎯 Reaction collector pro adminy
      const reactionFilter = (reaction, user) =>
        ['✅', '❌'].includes(reaction.emoji.name) && !user.bot;
      const reactionCollector = logMsg.createReactionCollector({ filter: reactionFilter, max: 1, time: 86400000 });

      reactionCollector.on('collect', async (reaction, user) => {
        if (reaction.emoji.name === '✅') {
          try {
            await member.roles.add(VERIFIED_ROLE_ID);
            await member.roles.remove(UNVERIFIED_ROLE_ID).catch(() => {});
            await logMsg.delete().catch(() => {});

            // 🟢 Schválen embed
            const approvedEmbed = new EmbedBuilder()
              .setDescription(`<@${member.id}> byl schválen uživatelem <@${user.id}> ✅`)
              .setColor('#1df300')
              
            await logChannel.send({ embeds: [approvedEmbed] });
          } catch (e) {
            console.error('Chyba při přidávání role:', e);
          }
        } else if (reaction.emoji.name === '❌') {
          try {
            await member.kick(`Zamítnuto ${user.tag}`);
            await logMsg.delete().catch(() => {});

            // 🔴 Odmítnut embed
            const deniedEmbed = new EmbedBuilder()
              .setDescription(`<@${member.id}> byl odmítnut uživatelem <@${user.id}> ❌`)
              .setColor('#ff0000')
              
            await logChannel.send({ embeds: [deniedEmbed] });
          } catch (e) {
            console.error('Chyba při kicku:', e);
          }
        }
      });
    });

    // ⏰ Timeout – když neodpoví do 24 h, vykopnout
    collector.on('end', async (collected) => {
      if (collected.size === 0) {
        try {
          await member.kick('Neodpověděl na uvítací otázku během 24 hodin');
          console.log(`⏰ ${member.user.tag} byl automaticky vyhozen po timeoutu`);
        } catch (e) {
          console.error('Chyba při timeout kicku:', e);
        }
      }
    });

  } catch (err) {
    console.error('Chyba v guildMemberAdd handleru:', err);
  }
});

// --- 🔥 Extra moduly: Reaction Roles, Welcome/Farewell, Server Stats --- //

import { Colors } from "discord.js";

// ========== 🟢 Reaction Roles ==========
const ROLE_SELECT_CHANNEL_ID = "1409197870518636554";
const ROLE_SELECT_MESSAGE_TITLE = "Jakou linku mainíš?";
const ROLE_SELECT_MESSAGE_DESC = "Vyber si dole z reakcí svou linku\na dostaň přidělenou roli!";
const ROLE_SELECT_COLOR = "#29AC5F";
const ROLE_SELECT_THUMB = "https://upload.wikimedia.org/wikipedia/commons/thumb/6/64/League_of_Legends_Wild_Rift_logo.svg/1280px-League_of_Legends_Wild_Rift_logo.svg.png";
const ROLE_SELECT_IMG = "https://www.metasrc.com/legacy/images/lanes/mid_icon.png";

// ✅ Tvoje emoji + jejich role
const EMOJI_ROLE_MAP = {
  "<:adc:1423344369523495023>": "1423292319150506066",
  "<:top_:1423344343527198790>": "1423293095319048202",
  "<:support:1423344317979951256>": "1423292503112814662",
  "<:jgl:1423344292407279647>": "1423292924925575280",
  "<:mid:1423344256076091402>": "1423292659572674570"
};

client.once("ready", async () => {
  const channel = await client.channels.fetch(ROLE_SELECT_CHANNEL_ID).catch(() => null);
  if (!channel) return console.warn("⚠️ Reaction role kanál nenalezen");

  // 💡 Získání všech emoji z guildy (nutné pro custom emoji)
  const guild = client.guilds.cache.first();
  if (guild) {
    await guild.emojis.fetch().catch(() => {});
    console.log(`🎨 Načteno ${guild.emojis.cache.size} emoji`);
  }

  // 🧠 Hledáme existující zprávu
  const messages = await channel.messages.fetch({ limit: 10 }).catch(() => null);
  const existing = messages?.find(m => m.author.id === client.user.id && m.embeds?.[0]?.title === ROLE_SELECT_MESSAGE_TITLE);
  if (existing) return console.log("ℹ️ Reaction role embed už existuje, přeskočeno.");

  const embed = new EmbedBuilder()
    .setTitle(ROLE_SELECT_MESSAGE_TITLE)
    .setDescription(ROLE_SELECT_MESSAGE_DESC)
    .setColor(ROLE_SELECT_COLOR)
    .setThumbnail(ROLE_SELECT_THUMB)
    .setImage(ROLE_SELECT_IMG);

  const msg = await channel.send({ embeds: [embed] });

// 💡 Získání všech emoji z guildy (nutné pro custom emoji)
const guildEmoji = client.guilds.cache.first();
if (guildEmoji) {
  await guildEmoji.emojis.fetch().catch(() => {});
  console.log(`🎨 Načteno ${guildEmoji.emojis.cache.size} emoji`);
}

  // 🧩 Přidáme všechny custom emoji
  for (const emoji of Object.keys(EMOJI_ROLE_MAP)) {
    await msg.react(emoji).catch(err => console.warn("⚠️ Reakce se nepodařila:", emoji, err.message));
  }

  console.log("✅ Reaction role embed odeslán + přidány emoji");
});

// 🎯 Role přidávání/odebírání
client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  if (reaction.message.channelId !== ROLE_SELECT_CHANNEL_ID) return;

  const emojiKey = reaction.emoji.toString();
  const roleId = EMOJI_ROLE_MAP[emojiKey];
  if (!roleId) return;

  const member = await reaction.message.guild.members.fetch(user.id).catch(() => null);
  if (!member) return;
  await member.roles.add(roleId).catch(() => {});
});

client.on("messageReactionRemove", async (reaction, user) => {
  if (user.bot) return;
  if (reaction.message.channelId !== ROLE_SELECT_CHANNEL_ID) return;

  const emojiKey = reaction.emoji.toString();
  const roleId = EMOJI_ROLE_MAP[emojiKey];
  if (!roleId) return;

  const member = await reaction.message.guild.members.fetch(user.id).catch(() => null);
  if (!member) return;
  await member.roles.remove(roleId).catch(() => {});
});


// ========== 🔴 Leave & Ban Embedy ==========
const LEAVE_BAN_CHANNEL_ID = "1428817792991363103";

client.on("guildMemberRemove", async member => {
  const channel = member.guild.channels.cache.get(LEAVE_BAN_CHANNEL_ID);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setDescription(`${member.user} to nezvládl a opustil server.`)
    .setColor("#F8E71C")
  await channel.send({ embeds: [embed] });
});

client.on("guildBanAdd", async (ban) => {
  const channel = ban.guild.channels.cache.get(LEAVE_BAN_CHANNEL_ID);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setDescription(`${ban.user} dostal BAN!`)
    .setColor("#FF0000")
  await channel.send({ embeds: [embed] });
});


// ========== 🟠 Join Embed (Dyno styl) ==========
const JOIN_ANNOUNCE_CHANNEL_ID = "1400569915437748254";

client.on("guildMemberAdd", async member => {
  // 🔒 Ignoruj bota (ať sám sobě neposílá welcome)
  if (member.user.bot) return;

  const channel = member.guild.channels.cache.get(JOIN_ANNOUNCE_CHANNEL_ID);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle("N A Z D A R !")
    .setDescription(
      `Vítej ${member}! Nechovej se tu jako píča prosím. Díky! 🤍\nA skoč si vybrat roli do 🌀︱ʀᴏʟᴇ-sᴇʟᴇᴄᴛɪᴏɴ!`
    )
    .setColor("#FF0000")
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }));
    // ❌ odstraněno .setTimestamp()

  await channel.send({ embeds: [embed] });
});

// ========== 🧮 AUTO COUNTER SYNC (nová, jednoduchá verze) ==========
const MEMBER_STATS_CHANNEL_ID = "1429158078980423913"; // Members kanál
const UNVERIFIED_STATS_CHANNEL_ID = "1429189687288926379"; // Unverified kanál
const FALLEN_PHOENIX_ID = "1428857086304850051"; // ID bota

let lastMemberCount = -1;
let lastUnverifiedCount = -1;

// === Members counter (každých 30 s) ===
setInterval(async () => {
  try {
    const guild = client.guilds.cache.first();
    if (!guild) return;

    await guild.members.fetch();

    const memberCount = guild.members.cache.filter(
      m => !m.user.bot && m.id !== FALLEN_PHOENIX_ID && !m.roles.cache.has(UNVERIFIED_ROLE_ID)
    ).size;

    if (memberCount !== lastMemberCount) {
      const memberChannel = guild.channels.cache.get(MEMBER_STATS_CHANNEL_ID);
      if (memberChannel) {
        await memberChannel.setName(`🔢︱Mᴇᴍʙᴇʀs: ${memberCount}`).catch(() => {});
        console.log(`📊 Zjištěna změna – aktualizace Members → ${memberCount}`);
      }
      lastMemberCount = memberCount;
    }
  } catch (err) {
    console.error("⚠️ Chyba při update Members:", err.message);
  }
}, 30 * 1000);

// === Unverified counter (každých 35 s) ===
setInterval(async () => {
  try {
    const guild = client.guilds.cache.first();
    if (!guild) return;

    await guild.members.fetch();

    const unverifiedCount = guild.members.cache.filter(
      m => !m.user.bot && m.roles.cache.has(UNVERIFIED_ROLE_ID)
    ).size;

    if (unverifiedCount !== lastUnverifiedCount) {
      const unverifiedChannel = guild.channels.cache.get(UNVERIFIED_STATS_CHANNEL_ID);
      if (unverifiedChannel) {
        await unverifiedChannel.setName(`❔︱Uɴᴠᴇʀɪғɪᴇᴅ: ${unverifiedCount}`).catch(() => {});
        console.log(`📊 Zjištěna změna – aktualizace Unverified → ${unverifiedCount}`);
      }
      lastUnverifiedCount = unverifiedCount;
    }
  } catch (err) {
    console.error("⚠️ Chyba při update Unverified:", err.message);
  }
}, 35 * 1000);

client.login(process.env.BOT_TOKEN);

// --- 💤 Keepalive ping každých 5 minut --- //
import fetch from "node-fetch";

setInterval(() => {
  const url = "https://discord-bot-i4hx.onrender.com"; // URL tvé služby na Renderu
  fetch(url)
    .then(() => console.log("💓 Keepalive ping odeslán"))
    .catch((err) => console.error("⚠️ Chyba keepalive pingu:", err.message));
}, 5 * 60 * 1000); // každých 5 minut


