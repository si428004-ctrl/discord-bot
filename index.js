// --- 🟢 Mini Express server pro Render --- //
import express from "express";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("✅ Bot is running!"));
app.listen(PORT, () => console.log(`🌐 Mini server běží na portu ${PORT}`));

// --- 🤖 Discord bot část --- //
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits
} from "discord.js";
import fetch from "node-fetch";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
    Partials.User,
    Partials.GuildMember
  ]
});

// --- 📌 IDčka ---
const WELCOME_CHANNEL_ID = '1428862251162403019';
const JOIN_LOG_CHANNEL_ID = '1428864324474114141';
const VERIFIED_ROLE_ID = '1428624557635407902';
const UNVERIFIED_ROLE_ID = '1428863230217945198';
const ROLE_SELECT_CHANNEL_ID = "1409197870518636554";
const LEAVE_BAN_CHANNEL_ID = "1428817792991363103";
const MEMBER_STATS_CHANNEL_ID = "1429158078980423913";
const UNVERIFIED_STATS_CHANNEL_ID = "1429189687288926379";
const GUILD_ID = "1400568910176194600";
const FALLEN_PHOENIX_ID = "1428857086304850051";

// --- 🧠 Anti-dupe ochrana ---
const processedJoins = new Set();

// === 🟢 Nový člen ===
client.on("guildMemberAdd", async member => {
  try {
    if (member.user.bot) return;
    if (processedJoins.has(member.id)) return;
    processedJoins.add(member.id);
    setTimeout(() => processedJoins.delete(member.id), 120000);

    await member.roles.add(UNVERIFIED_ROLE_ID).catch(() => {});
    console.log(`👤 ${member.user.tag} dostal roli Unverified`);

    const welcomeEmbedChannel = member.guild.channels.cache.get("1400569915437748254");
    if (welcomeEmbedChannel) {
      const welcomeEmbed = new EmbedBuilder()
        .setTitle("N A Z D A R !")
        .setDescription(`Vítej ${member}! Nechovej se tu jako píča prosím. Díky! 🤍\nA skoč si vybrat roli do 🌀︱ʀᴏʟᴇ-sᴇʟᴇᴄᴛɪᴏɴ!`)
        .setColor("#FF0000")
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }));
      await welcomeEmbedChannel.send({ embeds: [welcomeEmbed] });
    }

    const verifyChannel = member.guild.channels.cache.get(WELCOME_CHANNEL_ID);
    if (!verifyChannel) return;
    const questionMsg = await verifyChannel.send(
      `Ahoj ${member}, pro schválení potřebujeme tvou odpověď. Kde jsi našel náš server a proč se chceš připojit?`
    );

    const filter = m => m.author.id === member.id;
    const collector = verifyChannel.createMessageCollector({ filter, max: 1, time: 86400000 });

    collector.on("collect", async msg => {
      const logChannel = member.guild.channels.cache.get(JOIN_LOG_CHANNEL_ID);
      if (!logChannel) return;

      const embed = new EmbedBuilder()
        .setTitle("🆕 Nový člen na serveru")
        .setDescription(`👤 **Uživatel:** <@${member.id}>\n📝 **Odpověď:**\n\n${msg.content || "*Žádná odpověď*"}`)
        .setColor("#ff0000");

      const logMsg = await logChannel.send({ embeds: [embed] });
      await logMsg.react("✅");
      await logMsg.react("❌");

      await msg.delete().catch(() => {});
      await questionMsg.delete().catch(() => {});
    });

    collector.on("end", async collected => {
      if (collected.size === 0) {
        await member.kick("Neodpověděl na uvítací otázku během 24 hodin").catch(() => {});
      }
    });
  } catch (err) {
    console.error("❌ Chyba v guildMemberAdd:", err);
  }
});

// === 🧩 Jeden sjednocený posluchač reakcí ===
client.on("messageReactionAdd", async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch().catch(() => {});

    const message = reaction.message;
    if (!message.guild) return;

    // 1️⃣ Reaction Roles
    if (message.channelId === ROLE_SELECT_CHANNEL_ID) {
      const EMOJI_ROLE_MAP = {
        "<:adc:1423344369523495023>": "1423292319150506066",
        "<:top_:1423344343527198790>": "1423293095319048202",
        "<:support:1423344317979951256>": "1423292503112814662",
        "<:jgl:1423344292407279647>": "1423292924925575280",
        "<:mid:1423344256076091402>": "1423292659572674570"
      };
      const emojiKey = reaction.emoji.toString();
      const roleId = EMOJI_ROLE_MAP[emojiKey];
      if (roleId) {
        const member = await message.guild.members.fetch(user.id).catch(() => null);
        if (member) await member.roles.add(roleId).catch(() => {});
      }
      return;
    }

    // 2️⃣ Schvalování uživatelů
    if (message.channelId === JOIN_LOG_CHANNEL_ID) {
      const embed = message.embeds?.[0];
      if (!embed?.title?.includes("Nový člen")) return;

      const match = embed.description?.match(/<@(\d+)>/);
      if (!match) return;

      const memberId = match[1];
      const guild = message.guild;
      const member = await guild.members.fetch(memberId).catch(() => null);
      if (!member) return;

      if (reaction.emoji.name === "✅") {
        await member.roles.add(VERIFIED_ROLE_ID).catch(() => {});
        await member.roles.remove(UNVERIFIED_ROLE_ID).catch(() => {});
        await message.delete().catch(() => {});
        await message.channel.send({
          embeds: [new EmbedBuilder().setDescription(`<@${member.id}> byl schválen <@${user.id}> ✅`).setColor("#00FF00")]
        });
      } else if (reaction.emoji.name === "❌") {
        await member.kick(`Zamítnuto ${user.tag}`).catch(() => {});
        await message.delete().catch(() => {});
        await message.channel.send({
          embeds: [new EmbedBuilder().setDescription(`<@${member.id}> byl odmítnut <@${user.id}> ❌`).setColor("#FF0000")]
        });
      }
    }
  } catch (err) {
    console.error("⚠️ Chyba při messageReactionAdd:", err);
  }
});

// === 🔴 Leave & Ban ===
const lastEvent = new Map();
client.on("guildMemberRemove", async member => {
  const now = Date.now(), last = lastEvent.get(member.id) || 0;
  if (now - last < 3000) return;
  lastEvent.set(member.id, now);
  const ch = member.guild.channels.cache.get(LEAVE_BAN_CHANNEL_ID);
  if (ch) ch.send({ embeds: [new EmbedBuilder().setDescription(`${member.user} opustil server.`).setColor("#FFD700")] });
});
client.on("guildBanAdd", async ban => {
  const now = Date.now(), last = lastEvent.get(ban.user.id) || 0;
  if (now - last < 3000) return;
  lastEvent.set(ban.user.id, now);
  const ch = ban.guild.channels.cache.get(LEAVE_BAN_CHANNEL_ID);
  if (ch) ch.send({ embeds: [new EmbedBuilder().setDescription(`${ban.user} dostal BAN!`).setColor("#FF0000")] });
});

// === 🧮 Counters ===
let lastMemberCount = -1, lastUnverifiedCount = -1;
setInterval(async () => {
  const guild = client.guilds.cache.first();
  if (!guild) return;
  await guild.members.fetch();
  const memberCount = guild.members.cache.filter(m => !m.user.bot && m.id !== FALLEN_PHOENIX_ID && !m.roles.cache.has(UNVERIFIED_ROLE_ID)).size;
  if (memberCount !== lastMemberCount) {
    const ch = guild.channels.cache.get(MEMBER_STATS_CHANNEL_ID);
    if (ch) await ch.setName(`🔢︱Mᴇᴍʙᴇʀs: ${memberCount}`).catch(() => {});
    lastMemberCount = memberCount;
  }
}, 30000);

setInterval(async () => {
  const guild = client.guilds.cache.first();
  if (!guild) return;
  await guild.members.fetch();
  const count = guild.members.cache.filter(m => !m.user.bot && m.roles.cache.has(UNVERIFIED_ROLE_ID)).size;
  if (count !== lastUnverifiedCount) {
    const ch = guild.channels.cache.get(UNVERIFIED_STATS_CHANNEL_ID);
    if (ch) await ch.setName(`❔︱Uɴᴠᴇʀɪғɪᴇᴅ: ${count}`).catch(() => {});
    lastUnverifiedCount = count;
  }
}, 35000);

// === 🧹 /clear ===
client.once("ready", async () => {
  console.log(`✅ Přihlášen jako ${client.user.tag}`);
  const logCh = client.channels.cache.get('1421633740689506405');
  if (logCh) logCh.send('🟢 Bot je zpět online');

  const commands = [
    new SlashCommandBuilder()
      .setName("clear")
      .setDescription("🧹 Smaže poslední zprávy v tomto kanálu.")
      .addIntegerOption(o => o.setName("pocet").setDescription("1–100").setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON()
  ];

  const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
  console.log("✅ Slash command /clear zaregistrován.");
});

client.on("interactionCreate", async i => {
  if (!i.isChatInputCommand() || i.commandName !== "clear") return;
  const count = i.options.getInteger("pocet");
  const deleted = await i.channel.bulkDelete(count, true);
  await i.reply({ content: `✅ Smazáno ${deleted.size} zpráv`, flags: 64 });
  setTimeout(() => i.deleteReply().catch(() => {}), 1000);
});

// === 💤 Keepalive ===
setInterval(() => {
  fetch("https://discord-bot-i4hx.onrender.com")
    .then(() => console.log("💓 Keepalive ping"))
    .catch(e => console.error("⚠️ Keepalive error:", e.message));
}, 5 * 60 * 1000);

client.login(process.env.BOT_TOKEN);
