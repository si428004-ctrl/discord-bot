// --- 🟢 Importy a setup --- //
import express from "express";
import dotenv from "dotenv";
import fs from "fs";
dotenv.config();

// --- 📁 Načtení konfiguračního JSONu --- //
let config = JSON.parse(fs.readFileSync("./config.json", "utf8"));

function reloadConfig() {
  try {
    config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
    console.log("♻️ Config reloadnutý.");

    if (client?.user && config.botIdentity?.displayName) {
      client.user.setUsername(config.botIdentity.displayName)
        .then(() => console.log(`💫 Bot přejmenován na: ${config.botIdentity.displayName}`))
        .catch(err => console.warn("⚠️ Nepodařilo se změnit jméno bota:", err.message));
    }

    if (client?.user && config.botIdentity?.statusText) {
      client.user.setPresence({
        activities: [{ name: config.botIdentity.statusText }],
        status: "online"
      });
      console.log(`💬 Status bota nastaven na: ${config.botIdentity.statusText}`);
    }

  } catch (err) {
    console.error("❌ Chyba při reloadu configu:", err.message);
  }
}

// --- 🌐 Mini Express server pro Render --- //
const app = express();
const PORT = process.env.PORT || 10000;

// aby Express uměl číst JSON body z POSTu
app.use(express.json());

// healthcheck
app.get("/", (req, res) => res.send("✅ Bot is running!"));

// uloží Welcome / Verify / approve-deny texty z dashboardu do config.json
app.post("/save-welcome", (req, res) => {
  try {
    const incoming = req.body;

    // welcome embed
    config.welcomeFlow.greetingEmbed.title = incoming.greetingEmbed.title;
    config.welcomeFlow.greetingEmbed.color = incoming.greetingEmbed.color;
    config.welcomeFlow.greetingEmbed.description = incoming.greetingEmbed.description;

    // otázka pro verify a kick reason
    config.welcomeFlow.verifyQuestionText = incoming.verifyQuestionText;
    config.welcomeFlow.timeoutKickReason = incoming.timeoutKickReason;

    // embed do mod logu
    config.welcomeFlow.modLogEmbed.title = incoming.modLogEmbed.title;
    config.welcomeFlow.modLogEmbed.color = incoming.modLogEmbed.color;
    config.welcomeFlow.modLogEmbed.descriptionTemplate =
      incoming.modLogEmbed.descriptionTemplate;

    // approve zpráva
    config.welcomeFlow.modLogEmbed.approveMessage.textTemplate =
      incoming.modLogEmbed.approveMessage.textTemplate;
    config.welcomeFlow.modLogEmbed.approveMessage.color =
      incoming.modLogEmbed.approveMessage.color;

    // reject zpráva
    config.welcomeFlow.modLogEmbed.rejectMessage.textTemplate =
      incoming.modLogEmbed.rejectMessage.textTemplate;
    config.welcomeFlow.modLogEmbed.rejectMessage.color =
      incoming.modLogEmbed.rejectMessage.color;

    // uložit na disk
    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");

    // přenačíst config + propsat do bota
    reloadConfig();

    // odpověď pro dashboard
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /save-welcome error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// uloží nastavení bota (displayName) a přejmenuje bota
app.post("/save-botsettings", (req, res) => {
  try {
    const { displayName, statusText } = req.body;

    if (!displayName || !displayName.trim()) {
      return res.status(400).json({ ok: false, error: "Missing displayName" });
    }

    // zajistíme, že botIdentity existuje
    if (!config.botIdentity) config.botIdentity = {};

    // update v configu v paměti
    config.botIdentity.displayName = displayName.trim();
    config.botIdentity.statusText = statusText?.trim() || "";

    // uložit config.json na disk
    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");

    // reloadConfig() → přejmenuje bota a můžeme přidat i status
    reloadConfig();

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /save-botsettings error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/config", (req, res) => {
  try {
    const raw = fs.readFileSync("./config.json", "utf8");
    const json = JSON.parse(raw);
    res.json(json);
  } catch (err) {
    console.error("❌ Chyba při čtení configu:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// admin panel stránka (dashboard)
app.get("/admin", (req, res) => {
  try {
    const html = fs.readFileSync("./discordbot.html", "utf8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    console.error("❌ Nemůžu načíst dashboard (discordbot.html):", err);
    res.status(500).send("Dashboard se nepodařilo načíst.");
  }
});

// manuální reload (furt můžeš nechat)
app.post("/reload-config", (req, res) => {
  reloadConfig();
  res.json({ ok: true, message: "Config reloadnutý." });
});

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

// --- 🧠 Anti-dupe zámky ---
const processedJoins = new Set();
const processedReactions = new Set();
const lastEvent = new Map();

function withShortLock(set, key, ttlMs) {
  if (set.has(key)) return true;
  set.add(key);
  setTimeout(() => set.delete(key), ttlMs);
  return false;
}

// Helper: postaví mapu emoji -> roleId z configu
function buildEmojiRoleMap() {
  const map = {};
  for (const entry of (config.reactionRoles?.emojiRoleMap || [])) {
    if (entry.emoji && entry.roleId) {
      map[entry.emoji] = entry.roleId;
    }
  }
  return map;
}

// Helper: nahradí placeholdery {USER} {MOD} {ANSWER} {REASON} {USER_ID}
function fillTemplate(str, vars) {
  if (!str) return "";
  return str
    .replace(/\{USER\}/g, vars.USER ?? "")
    .replace(/\{MOD\}/g, vars.MOD ?? "")
    .replace(/\{ANSWER\}/g, vars.ANSWER ?? "")
    .replace(/\{REASON\}/g, vars.REASON ?? "")
    .replace(/\{USER_ID\}/g, vars.USER_ID ?? "");
}

// === 🟢 READY ===
client.once("ready", async () => {
  console.log(`✅ Přihlášen jako ${client.user.tag}`);

  // Po přihlášení ping do online log kanálu
  {
    const chId = config.channelsAndRoles.onlineLogChannelId;
    const logCh = client.channels.cache.get(chId);
    if (logCh) logCh.send("🟢 Bot je zpět online");
  }

  // Registrace /clear a /ban
  const commands = [
    new SlashCommandBuilder()
      .setName("clear")
      .setDescription("🧹 Smaže poslední zprávy v tomto kanálu.")
      .addIntegerOption(o => o.setName("pocet").setDescription("1–100").setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("ban")
      .setDescription("🔨 Zabanovat uživatele podle ID (i když není na serveru)")
      .addStringOption(o => o.setName("userid").setDescription("ID uživatele k banu").setRequired(true))
      .addStringOption(o => o.setName("duvod").setDescription("Důvod banu (volitelné)").setRequired(false))
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(
      client.user.id,
      config.channelsAndRoles.guildId
    ),
    { body: commands }
  );
  console.log("✅ Slash commands /clear a /ban zaregistrovány.");

  // Reaction Roles – vytvoření embedu pokud neexistuje
  try {
    const channel = await client.channels.fetch(config.channelsAndRoles.roleSelectChannelId).catch(() => null);
    if (!channel) {
      console.warn("⚠️ Reaction role kanál nenalezen");
    } else {
      const guild = client.guilds.cache.first();
      if (guild) await guild.emojis.fetch().catch(() => {});
      const messages = await channel.messages.fetch({ limit: 10 }).catch(() => null);

      const rrEmbedCfg = config.reactionRoles.embed;
      const ROLE_SELECT_MESSAGE_TITLE = rrEmbedCfg.title;

      const existing = messages?.find(
        m =>
          m.author.id === client.user.id &&
          m.embeds?.[0]?.title === ROLE_SELECT_MESSAGE_TITLE
      );

      if (!existing) {
        const embed = new EmbedBuilder()
          .setTitle(rrEmbedCfg.title)
          .setDescription(rrEmbedCfg.description)
          .setColor(rrEmbedCfg.color || "#29AC5F");

        if (rrEmbedCfg.thumbnailUrl)
          embed.setThumbnail(rrEmbedCfg.thumbnailUrl);

        if (rrEmbedCfg.imageUrl)
          embed.setImage(rrEmbedCfg.imageUrl);

        const msg = await channel.send({ embeds: [embed] });

        for (const entry of config.reactionRoles.emojiRoleMap) {
          const e = entry.emoji;
          if (!e) continue;
          await msg.react(e).catch(err =>
            console.warn("⚠️ Reakce se nepodařila:", e, err.message)
          );
        }

        console.log("✅ Reaction role embed odeslán + přidány emoji");
      } else {
        console.log("ℹ️ Reaction role embed už existuje, přeskočeno.");
      }
    }
  } catch (e) {
    console.warn("⚠️ Init reaction roles selhal:", e.message);
  }
});

// === 🟢 Nový člen ===
client.on("guildMemberAdd", async member => {
  try {
    if (member.user.bot) return;

    const unverifiedRoleId = config.channelsAndRoles.unverifiedRoleId;
    const verifiedRoleId = config.channelsAndRoles.verifiedRoleId;

    // Anti-dupe join
    if (member.roles.cache.has(unverifiedRoleId)) {
      console.log(`⚠️ Duplicitní guildMemberAdd pro ${member.user.tag} — přeskočeno.`);
      return;
    }
    if (withShortLock(processedJoins, member.id, 2 * 60 * 1000)) return;

    // Přidat unverified roli
    await member.roles.add(unverifiedRoleId).catch(() => {});
    console.log(`👤 ${member.user.tag} dostal roli Unverified`);

    // 1) Poslat veřejné přivítání do nazdarChannelId
    {
      const welcomeCfg = config.welcomeFlow.greetingEmbed;
      const welcomeEmbedChannel = member.guild.channels.cache.get(config.channelsAndRoles.nazdarChannelId);
      if (welcomeEmbedChannel) {
        const welcomeEmbed = new EmbedBuilder()
          .setTitle(welcomeCfg.title)
          .setDescription(
            fillTemplate(welcomeCfg.description, {
              USER: `${member}`
            })
          )
          .setColor(welcomeCfg.color || "#FF0000")
          .setThumbnail(member.user.displayAvatarURL({ dynamic: true }));

        await welcomeEmbedChannel.send({ embeds: [welcomeEmbed] });
      }
    }

    // 2) Verifikační otázka v welcomeChannelId
    const verifyChannel = member.guild.channels.cache.get(config.channelsAndRoles.welcomeChannelId);
    if (!verifyChannel) return;

    const questionText = fillTemplate(config.welcomeFlow.verifyQuestionText, {
      USER: `${member}`
    });

    const questionMsg = await verifyChannel.send(questionText);

    const filter = m => m.author.id === member.id;
    const collector = verifyChannel.createMessageCollector({
      filter,
      max: 1,
      time: 86400000 // 24h
    });

    collector.on("collect", async msg => {
      const logChannel = member.guild.channels.cache.get(config.channelsAndRoles.joinLogChannelId);
      if (!logChannel) return;

      const modLogCfg = config.welcomeFlow.modLogEmbed;

      // embed do mod log kanálu
      const embed = new EmbedBuilder()
        .setTitle(modLogCfg.title)
        .setDescription(
          fillTemplate(modLogCfg.descriptionTemplate, {
            USER: `<@${member.id}>`,
            ANSWER: msg.content || "*Žádná odpověď*"
          })
        )
        .setColor(modLogCfg.color || "#ff0000");

      const logMsg = await logChannel.send({ embeds: [embed] });

      await logMsg.react("✅");
      await logMsg.react("❌");

      // uklid
      await msg.delete().catch(() => {});
      await questionMsg.delete().catch(() => {});
    });

    collector.on("end", async collected => {
      if (collected.size === 0) {
        // Kick po timeoutu
        await member
          .kick(config.welcomeFlow.timeoutKickReason || "Timeout ověření")
          .catch(() => {});
        console.log(`⏰ ${member.user.tag} byl automaticky vyhozen po timeoutu`);
      }
    });
  } catch (err) {
    console.error("❌ Chyba v guildMemberAdd:", err);
  }
});

// === 🧩 Reaction Add ===
client.on("messageReactionAdd", async (reaction, user) => {
  try {
    if (user.bot) return;

    // partial fix
    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }

    const message = reaction.message;
    if (!message.guild) return;

    // anti-dupe lock
    const rk = `add:${message.id}:${reaction.emoji.identifier}:${user.id}`;
    if (withShortLock(processedReactions, rk, 2000)) return;

    // 1) Reaction roles
    if (message.channelId === config.channelsAndRoles.roleSelectChannelId) {
      const emojiKey = reaction.emoji.toString();
      const EMOJI_ROLE_MAP = buildEmojiRoleMap();
      const roleId = EMOJI_ROLE_MAP[emojiKey];
      if (!roleId) return;

      const member = await message.guild.members.fetch(user.id).catch(() => null);
      if (member) await member.roles.add(roleId).catch(() => {});
      return;
    }

    // 2) Approve / Reject z mod panelu
    if (message.channelId === config.channelsAndRoles.joinLogChannelId) {
      const embed = message.embeds?.[0];
      if (!embed?.title?.includes("Nový člen")) return;

      const match = embed.description?.match(/<@(\d+)>/);
      if (!match) return;
      const memberId = match[1];

      const guild = message.guild;
      const member = await guild.members.fetch(memberId).catch(() => null);
      if (!member) return;

      if (reaction.emoji.name === "✅") {
        await member.roles.add(config.channelsAndRoles.verifiedRoleId).catch(() => {});
        await member.roles.remove(config.channelsAndRoles.unverifiedRoleId).catch(() => {});
        await message.delete().catch(() => {});

        const approveCfg = config.welcomeFlow.modLogEmbed.approveMessage;
        await message.channel.send({
          embeds: [
            new EmbedBuilder()
              .setDescription(
                fillTemplate(approveCfg.textTemplate, {
                  USER: `<@${member.id}>`,
                  MOD: `<@${user.id}>`
                })
              )
              .setColor(approveCfg.color || "#00FF00")
          ]
        });
      } else if (reaction.emoji.name === "❌") {
        await member.kick(`Zamítnuto ${user.tag}`).catch(() => {});
        await message.delete().catch(() => {});

        const rejectCfg = config.welcomeFlow.modLogEmbed.rejectMessage;
        await message.channel.send({
          embeds: [
            new EmbedBuilder()
              .setDescription(
                fillTemplate(rejectCfg.textTemplate, {
                  USER: `<@${member.id}>`,
                  MOD: `<@${user.id}>`
                })
              )
              .setColor(rejectCfg.color || "#FF0000")
          ]
        });
      }
    }
  } catch (err) {
    console.error("⚠️ Chyba při messageReactionAdd:", err);
  }
});

// === 🧩 Reaction Remove ===
client.on("messageReactionRemove", async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }
    const message = reaction.message;
    if (!message.guild) return;
    if (message.channelId !== config.channelsAndRoles.roleSelectChannelId) return;

    const emojiKey = reaction.emoji.toString();
    const EMOJI_ROLE_MAP = buildEmojiRoleMap();
    const roleId = EMOJI_ROLE_MAP[emojiKey];
    if (!roleId) return;

    const member = await message.guild.members.fetch(user.id).catch(() => null);
    if (member) await member.roles.remove(roleId).catch(() => {});
  } catch (err) {
    console.error("⚠️ Chyba při messageReactionRemove:", err);
  }
});

// === 🔴 Leave & Ban ===
client.on("guildMemberRemove", async member => {
  const now = Date.now(), last = lastEvent.get(member.id) || 0;
  if (now - last < 3000) return;
  lastEvent.set(member.id, now);

  const ch = member.guild.channels.cache.get(config.channelsAndRoles.leaveBanChannelId);
  if (ch) {
    const leaveCfg = config.leaveBanLogs.leave;
    await ch.send({
      embeds: [
        new EmbedBuilder()
          .setDescription(
            fillTemplate(leaveCfg.textTemplate, {
              USER: `${member.user}`
            })
          )
          .setColor(leaveCfg.color || "#FFD700")
      ]
    });
  }
});

client.on("guildBanAdd", async ban => {
  const now = Date.now(), last = lastEvent.get(ban.user.id) || 0;
  if (now - last < 3000) return;
  lastEvent.set(ban.user.id, now);

  const ch = ban.guild.channels.cache.get(config.channelsAndRoles.leaveBanChannelId);
  if (ch) {
    const banCfg = config.leaveBanLogs.ban;
    await ch.send({
      embeds: [
        new EmbedBuilder()
          .setDescription(
            fillTemplate(banCfg.textTemplate, {
              USER: `${ban.user}`
            })
          )
          .setColor(banCfg.color || "#FF0000")
      ]
    });
  }
});

// === 🧮 Counters ===
let lastMemberCount = -1, lastUnverifiedCount = -1;

setInterval(async () => {
  try {
    const guild = client.guilds.cache.first();
    if (!guild) return;
    await guild.members.fetch();

    const memberCount = guild.members.cache.filter(m =>
      !m.user.bot &&
      m.id !== config.channelsAndRoles.fallenPhoenixId &&
      !m.roles.cache.has(config.channelsAndRoles.unverifiedRoleId)
    ).size;

    if (memberCount !== lastMemberCount) {
      const ch = guild.channels.cache.get(config.channelsAndRoles.memberStatsChannelId);
      if (ch) {
        await ch.setName(`🔢︱Mᴇᴍʙᴇʀs: ${memberCount}`).catch(() => {});
      }
      lastMemberCount = memberCount;
    }
  } catch (err) {
    console.error("⚠️ Chyba při update Members:", err.message);
  }
}, 30000);

setInterval(async () => {
  try {
    const guild = client.guilds.cache.first();
    if (!guild) return;
    await guild.members.fetch();

    const count = guild.members.cache.filter(m =>
      !m.user.bot &&
      m.roles.cache.has(config.channelsAndRoles.unverifiedRoleId)
    ).size;

    if (count !== lastUnverifiedCount) {
      const ch = guild.channels.cache.get(config.channelsAndRoles.unverifiedStatsChannelId);
      if (ch) {
        await ch.setName(`❔︱Uɴᴠᴇʀɪғɪᴇᴅ: ${count}`).catch(() => {});
      }
      lastUnverifiedCount = count;
    }
  } catch (err) {
    console.error("⚠️ Chyba při update Unverified:", err.message);
  }
}, 35000);

// === 🧹 /clear + /ban ===
client.on("interactionCreate", async i => {
  if (!i.isChatInputCommand()) return;

  // 🧹 /clear
  if (i.commandName === "clear") {
    const count = i.options.getInteger("pocet");
    if (count < 1 || count > 100) {
      return i.reply({ content: "⚠️ Zadej číslo 1–100!", flags: 64 });
    }

    try {
      const deleted = await i.channel.bulkDelete(count, true);
      await i.reply({ content: `✅ Smazáno ${deleted.size} zpráv`, flags: 64 });
      setTimeout(() => i.deleteReply().catch(() => {}), 1000);
    } catch (err) {
      if (err.code === 10008) {
        console.log("⚠️ Některé zprávy už byly smazány dřív, přeskočeno.");
      } else {
        console.error("❌ Chyba při mazání zpráv:", err);
      }
    }
  }

  // 🔨 /ban
  if (i.commandName === "ban") {
    const userId = i.options.getString("userid");
    const reason = i.options.getString("duvod") || "Bez důvodu";
    try {
      const guild = i.guild;
      await guild.bans.create(userId, { reason });

      await i.reply({
        content: `✅ Uživatel <@${userId}> byl zabanován.`,
        flags: 64
      });
      setTimeout(() => i.deleteReply().catch(() => {}), 1000);

      // log do ONLINE_LOG_CHANNEL_ID
      const logCh = guild.channels.cache.get(config.channelsAndRoles.onlineLogChannelId);
      if (logCh) {
        const banLogCfg = config.banCommandLog;
        const embed = new EmbedBuilder()
          .setTitle(banLogCfg.title)
          .setDescription(
            fillTemplate(banLogCfg.descriptionTemplate, {
              USER: `<@${userId}>`,
              USER_ID: userId,
              MOD: `<@${i.user.id}>`,
              REASON: reason
            })
          )
          .setColor(banLogCfg.color || "#FF0000");

        await logCh.send({ embeds: [embed] });
      }
    } catch (err) {
      console.error("❌ Chyba při /ban:", err);
      await i.reply({
        content: `⚠️ Nepodařilo se zabanovat uživatele s ID ${userId}`,
        flags: 64
      });
      setTimeout(() => i.deleteReply().catch(() => {}), 2000);
    }
  }
});

// === 💤 Keepalive ===
setInterval(() => {
  fetch("https://discord-bot-i4hx.onrender.com")
    .then(() => console.log("💓 Keepalive ping"))
    .catch(e => console.error("⚠️ Keepalive error:", e.message));
}, 5 * 60 * 1000);

client.login(process.env.BOT_TOKEN);
