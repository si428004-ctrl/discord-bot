// --- 🟢 Importy a setup --- //
import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import multer from "multer";
import fetch from "node-fetch";
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

dotenv.config();

// --- 🖼 Multer setup pro upload avataru --- //
const upload = multer({ storage: multer.memoryStorage() });

// --- 📁 Načtení konfiguračního JSONu --- //
let config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
// použij hodnotu z config.json (pokud tam není, true fallback)
let verifyEnabled = !!config.verifyEnabled;


// =====================
// 📝 LOG BUFFER
// =====================

// budeme držet posledních třeba 200 řádků logu v paměti
const LOG_LIMIT = 200;
let logBuffer = [];

// helper na push do bufferu
function pushLog(level, msg) {
  const line =
    `[${new Date().toISOString()}] [${level}] ` +
    (typeof msg === "string" ? msg : JSON.stringify(msg));

  logBuffer.push(line);
  if (logBuffer.length > LOG_LIMIT) {
    logBuffer.splice(0, logBuffer.length - LOG_LIMIT);
  }
}

// obalíme konzole, ale zároveň pořád logujeme do normální konzole Renderu
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

console.log = (...args) => {
  origLog(...args);
  pushLog("INFO", args.join(" "));
};
console.warn = (...args) => {
  origWarn(...args);
  pushLog("WARN", args.join(" "));
};
console.error = (...args) => {
  origError(...args);
  pushLog("ERROR", args.join(" "));
};

// --- 🤖 Discord Bot klient --- //
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

// --- 🧠 Anti-dupe zámky / helpery --- //
const processedJoins = new Set();
const processedReactions = new Set();
const lastEvent = new Map();

function withShortLock(set, key, ttlMs) {
  if (set.has(key)) return true;
  set.add(key);
  setTimeout(() => set.delete(key), ttlMs);
  return false;
}

// === [2] SADA HERNÍCH ROLÍ PRO STATISTIKY + TLAČÍTKA ===
const GAME_ROLE_IDS = [
  "1433504172296245278", // WildRift
  "1433504443269255399", // Others
  "1433504552140673105", // Warzone
  "1433504646357586062", // Metin2
  "1433504694529167360", // CS:2
  "1442591687833550961", // Roblox
  "1428813333192118396", // Valorant
  "1442591285109067816", // Fornite
  "1400578107823489024", // Creator  
];

// Pro mapování tlačítek -> role
const BUTTON_ROLE_MAP = {
  "pickgame:wildrift": "1433504172296245278",
  "pickgame:warzone": "1433504552140673105",
  "pickgame:metin2": "1433504646357586062",
  "pickgame:cs2": "1433504694529167360",
  "pickgame:fortnite": "1442591285109067816",
  "pickgame:valorant": "1428813333192118396",
  "pickgame:roblox": "1442591687833550961",
  "pickgame:others": "1433504443269255399",
};

// === [3] RANK ROLE MAP (emoji -> roleId) ===
const RANK_EMOJI_ROLE_MAP = {
  "<:iron:1426288101604593846>":       "1437499734775562341",
  "<:bronze:1426287955227574472>":     "1437500038564544654",
  "<:silver:1426288167807615207>":     "1437490677771403515",
  "<:gold:1426288055240753272>":       "1437499870545182720",
  "<:platinum:1426288148886851704>":   "1437499938044116992",
  "<:emerald:1426288014845546576>":    "1437500189400371201",
  "<:diamond:1426287985145544817>":    "1437500095669997749",
  "<:master:1426288128607653888>":     "1437500235680186428",
  "<:grandmaster:1426288034382352544>":"1437500283596050715",
  "<:challenger:1426288082507923467>": "1437500351375867945",
  "<:sovereign:1426288186375667812>":  "1437500382313054432",
};


// postaví mapu emoji -> roleId z config.reactionRoles.emojiRoleMap
function buildEmojiRoleMap() {
  const map = {};
  for (const entry of (config.reactionRoles?.emojiRoleMap || [])) {
    if (entry.emoji && entry.roleId) {
      map[entry.emoji] = entry.roleId;
    }
  }
  return map;
}

// rozbalí templaty typu {USER}, {ANSWER}, {MOD}, ...
function fillTemplate(str, vars) {
  if (!str) return "";
  return str
    .replace(/\{USER\}/g, vars.USER ?? "")
    .replace(/\{MOD\}/g, vars.MOD ?? "")
    .replace(/\{ANSWER\}/g, vars.ANSWER ?? "")
    .replace(/\{REASON\}/g, vars.REASON ?? "")
    .replace(/\{USER_ID\}/g, vars.USER_ID ?? "");
}

// --- 🧲 Sync reaction-role embed zprávy v kanálu --- //
async function syncReactionRoleMessage() {
  try {
    const channelId = config.channelsAndRoles?.roleSelectChannelId;
    if (!channelId) {
      console.warn("⚠️ syncReactionRoleMessage: chybí roleSelectChannelId");
      return;
    }

    // zkus najít kanál
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      console.warn("⚠️ syncReactionRoleMessage: channel nenalezen");
      return;
    }

    // config pro embed
    const rrEmbedCfg = config.reactionRoles?.embed;
    if (!rrEmbedCfg) {
      console.warn("⚠️ syncReactionRoleMessage: chybí reactionRoles.embed v configu");
      return;
    }

    // stáhnem posledních pár zpráv v kanálu
    const recentMessages = await channel.messages.fetch({ limit: 10 }).catch(() => null);

    // snažíme se najít, jestli už tam NÁŠ embed existuje: autor = náš bot, stejný title
    const existing = recentMessages?.find(
      m =>
        m.author.id === client.user.id &&
        m.embeds?.[0]?.title === rrEmbedCfg.title
    );

    // postav nový embed podle configu
    const embed = new EmbedBuilder()
  .setTitle(rrEmbedCfg.title || "Role výběr")
  .setDescription(rrEmbedCfg.description || "")
  .setColor(rrEmbedCfg.color || "#3a3838")
  .setThumbnail(rrEmbedCfg.thumbnailUrl || "");

   // if (rrEmbedCfg.imageUrl) {
   // embed.setImage(rrEmbedCfg.imageUrl);
   // }

    if (existing) {
  // porovnej jen podstatné části embedu a edituj JEN když se liší
  const cur = existing.embeds?.[0];

  // aktuální hodnoty v existující zprávě
  const curTitle = cur?.title || "";
  const curDesc  = cur?.description || "";
  const curThumb = cur?.thumbnail?.url || "";
  const curImg   = cur?.image?.url || "";
  const curColor = (cur?.color ?? null); // číslo (int) nebo null

  // požadované hodnoty
  const wantTitle = rrEmbedCfg.title || "Role výběr";
  const wantDesc  = rrEmbedCfg.description || "";
  const wantThumb = rrEmbedCfg.thumbnailUrl || "";
  const wantImg   = rrEmbedCfg.imageUrl || "";
  const wantColorHex = (rrEmbedCfg.color || "#3a3838").replace("#","");
  const wantColorInt = parseInt(wantColorHex, 16);

  const needsUpdate =
    curTitle !== wantTitle ||
    curDesc  !== wantDesc  ||
    curThumb !== wantThumb ||
    curImg   !== wantImg   ||
    (typeof curColor === "number" ? curColor : null) !== wantColorInt;

  if (needsUpdate) {
    await existing.edit({ embeds: [embed] }).catch(err => {
      console.warn("⚠️ syncReactionRoleMessage: nemůžu editnout message:", err.message);
    });
    console.log("🔁 Reaction role embed aktualizován (edit, změna zjištěna).");
  } else {
    console.log("👌 Reaction role embed beze změny – žádný edit neproběhl.");
  }

  // doplnit případně chybějící reakce, ale nereagovat duplicitně
  const needed = (config.reactionRoles.emojiRoleMap || []).map(e => e.emoji).filter(Boolean);
  for (const e of needed) {
    const already = existing.reactions?.cache?.some(r =>
      r.emoji.toString() === e
    );
    if (!already) {
      await existing.react(e).catch(() => {});
    }
  }

} else {
  // žádná naše zpráva → pošleme novou
  const sent = await channel.send({ embeds: [embed] });
  for (const entry of config.reactionRoles.emojiRoleMap || []) {
    const e = entry.emoji;
    if (!e) continue;
    await sent.react(e).catch(err => {
      console.warn("⚠️ Reakce se nepodařila:", e, err.message);
    });
  }
  console.log("✅ Reaction role embed poslán + emoji přidány.");
}

  } catch (err) {
    console.warn("⚠️ syncReactionRoleMessage fail:", err.message);
  }
}

// --- 🔁 Reload configu + update identity bota --- //
function reloadConfig() {
  try {
    config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
    console.log("♻️ Config reloadnutý.");

    // --- důležité: aktualizovat runtime proměnnou verifyEnabled
    verifyEnabled = !!config.verifyEnabled;
    console.log(`🔁 runtime verifyEnabled = ${verifyEnabled}`);

    if (client?.user && config.botIdentity?.displayName) {
      client.user
        .setUsername(config.botIdentity.displayName)
        .then(() =>
          console.log(`💫 Bot přejmenován na: ${config.botIdentity.displayName}`)
        )
        .catch(err =>
          console.warn("⚠️ Nepodařilo se změnit jméno bota:", err.message)
        );
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


// --- 🌐 Express server --- //
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.post("/api/verify-toggle", express.json(), (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ ok: false, error: "enabled must be boolean" });
    }

    // aktualizuj config objekt i soubor
    if (!config) config = {};
    config.verifyEnabled = enabled;
    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");

    // applicate runtime a reload
    verifyEnabled = !!config.verifyEnabled;
    try { reloadConfig(); } catch (e) {}

    console.log(`🔔 /api/verify-toggle -> verifyEnabled = ${verifyEnabled}`);
    return res.json({ ok: true, verifyEnabled });
  } catch (err) {
    console.error("❌ /api/verify-toggle error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 🔒 Basic auth middleware --- //
function requireAdminAuth(req, res, next) {
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Restricted Area"');
    return res.status(401).send("Auth required");
  }

  const base64 = auth.replace("Basic ", "").trim();
  let decoded = "";
  try {
    decoded = Buffer.from(base64, "base64").toString("utf8");
  } catch (e) {
    console.warn("⚠️ Basic auth decode fail:", e.message);
  }

  const sepIndex = decoded.indexOf(":");
  const user = decoded.substring(0, sepIndex);
  const pass = decoded.substring(sepIndex + 1);

  const okUser = process.env.ADMIN_USER;
  const okPass = process.env.ADMIN_PASS;

  if (user === okUser && pass === okPass) {
    return next();
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Restricted Area"');
  return res.status(401).send("Not authorized");
}

// --- ✅ Healthcheck (veřejné kvůli Renderu) --- //
app.get("/", (req, res) => res.send("✅ Bot is running!"));

// --- 🧩 GET /config – dashboard načte aktuální stav --- //
app.get("/config", requireAdminAuth, (req, res) => {
  try {
    const raw = fs.readFileSync("./config.json", "utf8");
    const json = JSON.parse(raw);
    res.json(json);
  } catch (err) {
    console.error("❌ Chyba při čtení configu:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 🧾 GET /logs – dashboard si vytáhne runtime logy --- //
app.get("/logs", requireAdminAuth, (req, res) => {
  try {
    // vrátíme jako text/plain, ať to můžeš hodit do <pre>
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(logBuffer.join("\n"));
  } catch (err) {
    console.error("❌ /logs error:", err);
    res
      .status(500)
      .send("Nepodařilo se načíst logy z paměti serveru.");
  }
});

// --- 💾 POST /save-welcome --- //
app.post("/save-welcome", requireAdminAuth, (req, res) => {
  try {
    const incoming = req.body;
    if (!config.welcomeFlow) config.welcomeFlow = {};

    // greetingEmbed
    if (!config.welcomeFlow.greetingEmbed)
      config.welcomeFlow.greetingEmbed = {};
    config.welcomeFlow.greetingEmbed.title =
      incoming.greetingEmbed?.title ?? config.welcomeFlow.greetingEmbed.title;
    config.welcomeFlow.greetingEmbed.color =
      incoming.greetingEmbed?.color ?? config.welcomeFlow.greetingEmbed.color;
    config.welcomeFlow.greetingEmbed.description =
      incoming.greetingEmbed?.description ??
      config.welcomeFlow.greetingEmbed.description;

    // verify / timeoutKickReason
    config.welcomeFlow.verifyQuestionText =
      incoming.verifyQuestionText ?? config.welcomeFlow.verifyQuestionText;
    config.welcomeFlow.timeoutKickReason =
      incoming.timeoutKickReason ?? config.welcomeFlow.timeoutKickReason;

    // modLogEmbed
    if (!config.welcomeFlow.modLogEmbed)
      config.welcomeFlow.modLogEmbed = {};
    config.welcomeFlow.modLogEmbed.title =
      incoming.modLogEmbed?.title ?? config.welcomeFlow.modLogEmbed.title;
    config.welcomeFlow.modLogEmbed.color =
      incoming.modLogEmbed?.color ?? config.welcomeFlow.modLogEmbed.color;
    config.welcomeFlow.modLogEmbed.descriptionTemplate =
      incoming.modLogEmbed?.descriptionTemplate ??
      config.welcomeFlow.modLogEmbed.descriptionTemplate;

    // approveMessage
    if (!config.welcomeFlow.modLogEmbed.approveMessage)
      config.welcomeFlow.modLogEmbed.approveMessage = {};
    config.welcomeFlow.modLogEmbed.approveMessage.textTemplate =
      incoming.modLogEmbed?.approveMessage?.textTemplate ??
      config.welcomeFlow.modLogEmbed.approveMessage.textTemplate;
    config.welcomeFlow.modLogEmbed.approveMessage.color =
      incoming.modLogEmbed?.approveMessage?.color ??
      config.welcomeFlow.modLogEmbed.approveMessage.color;

    // rejectMessage
    if (!config.welcomeFlow.modLogEmbed.rejectMessage)
      config.welcomeFlow.modLogEmbed.rejectMessage = {};
    config.welcomeFlow.modLogEmbed.rejectMessage.textTemplate =
      incoming.modLogEmbed?.rejectMessage?.textTemplate ??
      config.welcomeFlow.modLogEmbed.rejectMessage.textTemplate;
    config.welcomeFlow.modLogEmbed.rejectMessage.color =
      incoming.modLogEmbed?.rejectMessage?.color ??
      config.welcomeFlow.modLogEmbed.rejectMessage.color;

    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");

    reloadConfig();
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /save-welcome error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 💾 POST /save-botsettings --- //
app.post("/save-botsettings", requireAdminAuth, (req, res) => {
  try {
    const { displayName, statusText } = req.body;
    if (!displayName || !displayName.trim()) {
      return res.status(400).json({ ok: false, error: "Missing displayName" });
    }

    if (!config.botIdentity) config.botIdentity = {};
    config.botIdentity.displayName = displayName.trim();
    config.botIdentity.statusText = statusText?.trim() || "";

    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");

    reloadConfig(); // nastaví username + presence

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /save-botsettings error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 💾 POST /save-verify --- //
app.post("/save-verify", requireAdminAuth, (req, res) => {
  try {
    const incoming = req.body;
    if (typeof incoming.verifyEnabled !== "boolean") {
      return res.status(400).json({ ok: false, error: "verifyEnabled must be boolean" });
    }

    if (!config) config = {};
    config.verifyEnabled = incoming.verifyEnabled;

    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");

    // aktualizovat runtime a reloadnout
    verifyEnabled = !!config.verifyEnabled;
    try { reloadConfig(); } catch (e) {}

    console.log(`🔔 /save-verify -> verifyEnabled = ${verifyEnabled}`);
    return res.json({ ok: true, verifyEnabled });
  } catch (err) {
    console.error("❌ /save-verify error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 💾 POST /upload-avatar --- //
app.post(
  "/upload-avatar",
  requireAdminAuth,
  upload.single("avatarFile"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ ok: false, error: "Chybí soubor." });
      }

      if (!client?.user) {
        return res
          .status(500)
          .json({ ok: false, error: "Bot client není připraven." });
      }

      const buffer = req.file.buffer;

      await client.user.setAvatar(buffer);
      console.log("🖼 Avatar bota aktualizován.");

      // preview do configu
      const base64 = `data:${req.file.mimetype};base64,${buffer.toString(
        "base64"
      )}`;
      config.avatarPreviewUrl = base64;
      fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");

      res.json({ ok: true });
    } catch (err) {
      console.error("❌ /upload-avatar error:", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// --- 💾 POST /save-ids --- //
app.post("/save-ids", requireAdminAuth, (req, res) => {
  try {
    config.channelsAndRoles = req.body;

    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");

    // přenačteme config do bota
    reloadConfig();

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /save-ids error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 💾 POST /save-reactionroles --- //
app.post("/save-reactionroles", requireAdminAuth, async (req, res) => {
  try {
    config.reactionRoles = req.body;

    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");

    reloadConfig();

    // 💥 hned po uložení syncni/aktuální message v kanálu
    await syncReactionRoleMessage();

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /save-reactionroles error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 💾 POST /save-leaveban --- //
app.post("/save-leaveban", requireAdminAuth, (req, res) => {
  try {
    config.leaveBanLogs = req.body;
    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /save-leaveban error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 💾 POST /save-banlog --- //
app.post("/save-banlog", requireAdminAuth, (req, res) => {
  try {
    config.banCommandLog = req.body;
    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /save-banlog error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 🧠 GET /admin – dashboard HTML --- //
app.get("/admin", requireAdminAuth, (req, res) => {
  try {
    const html = fs.readFileSync("./discordbot.html", "utf8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    console.error("❌ Nemůžu načíst dashboard:", err);
    res.status(500).send("Dashboard se nepodařilo načíst.");
  }
});

// --- 🌍 Start Express --- //
app.listen(PORT, () =>
  console.log(`🌐 Mini server běží na portu ${PORT}`)
);

// =====================
// 🤖 DISCORD BOT LOGIKA
// =====================

// === READY EVENT ===
client.once("clientReady", async () => {
  console.log(`✅ Přihlášen jako ${client.user.tag}`);

  // po přihlášení ping do onlineLogChannelId
  {
    const chId = config.channelsAndRoles?.onlineLogChannelId;
    const logCh = chId ? client.channels.cache.get(chId) : null;
    if (logCh) {
      logCh.send("🟢 Bot je zpět online");
    }
  }

  // zaregistruj slash commands /clear a /ban
  const commands = [
    new SlashCommandBuilder()
      .setName("clear")
      .setDescription("🧹 Smaže poslední zprávy v tomto kanálu.")
      .addIntegerOption(o =>
        o
          .setName("pocet")
          .setDescription("1–100")
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("ban")
      .setDescription(
        "🔨 Zabanovat uživatele podle ID (i když není na serveru)"
      )
      .addStringOption(o =>
        o
          .setName("userid")
          .setDescription("ID uživatele k banu")
          .setRequired(true)
      )
      .addStringOption(o =>
        o
          .setName("duvod")
          .setDescription("Důvod banu (volitelné)")
          .setRequired(false)
      )
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

  // 🔁 Syncni / refreshni reaction role embed teď při startu
  await syncReactionRoleMessage();

  // 🔹 RANK SELECTION EMBED – druhá embed zpráva v roleSelectChannel
  try {
    const roleSelectChannelId = config.channelsAndRoles?.roleSelectChannelId;
    if (roleSelectChannelId) {
      const roleSelectChannel = await client.channels
        .fetch(roleSelectChannelId)
        .catch(() => null);

      if (roleSelectChannel) {
        // koukneme, jestli už tam není naše rank zpráva (podle title)
        const recent = await roleSelectChannel.messages
          .fetch({ limit: 20 })
          .catch(() => null);

        const existingRankMsg = recent?.find(
          m =>
            m.author.id === client.user.id &&
            m.embeds?.[0]?.title === "HIGHEST ACHIEVED RANK"
        );

        if (!existingRankMsg) {
          const rankEmbed = new EmbedBuilder()
  .setTitle("HIGHEST ACHIEVED RANK")
  .setDescription(
    ":flag_cz: Vyber si svůj nejvýš dosažený rank, je jedno jaká season.\n:flag_us: Pick your highest achieved rank, no matter which season.\n\n" + // ⬅ dvakrát \n = prázdný řádek
    "<:iron:1426288101604593846> <@&1437499734775562341>\n" +
    "<:bronze:1426287955227574472> <@&1437500038564544654>\n" +
    "<:silver:1426288167807615207> <@&1437490677771403515>\n" +
    "<:gold:1426288055240753272> <@&1437499870545182720>\n" +
    "<:platinum:1426288148886851704> <@&1437499938044116992>\n" +
    "<:emerald:1426288014845546576> <@&1437500189400371201>\n" +
    "<:diamond:1426287985145544817> <@&1437500095669997749>\n" +
    "<:master:1426288128607653888> <@&1437500235680186428>\n" +
    "<:grandmaster:1426288034382352544> <@&1437500283596050715>\n" +
    "<:challenger:1426288082507923467> <@&1437500351375867945>\n" +
    "<:sovereign:1426288186375667812> <@&1437500382313054432>"
  )
            .setColor("#3a3838")
            .setThumbnail("https://static.wikia.nocookie.net/leagueoflegends/images/3/38/Season_2019_-_Unranked.png/revision/latest/scale-to-width-down/250?cb=20190908074432"); 

          const sentRankMsg = await roleSelectChannel.send({
            embeds: [rankEmbed],
          });

          // 🎯 Reakce pro všechny rank emoji (MUSÍ sedět na RANK_EMOJI_ROLE_MAP výše)
          await sentRankMsg.react("<:iron:1426288101604593846>");
          await sentRankMsg.react("<:bronze:1426287955227574472>");
          await sentRankMsg.react("<:silver:1426288167807615207>");
          await sentRankMsg.react("<:gold:1426288055240753272>");
          await sentRankMsg.react("<:platinum:1426288148886851704>");
          await sentRankMsg.react("<:emerald:1426288014845546576>");
          await sentRankMsg.react("<:diamond:1426287985145544817>");
          await sentRankMsg.react("<:master:1426288128607653888>");
          await sentRankMsg.react("<:grandmaster:1426288034382352544>");
          await sentRankMsg.react("<:challenger:1426288082507923467>");
          await sentRankMsg.react("<:sovereign:1426288186375667812>");
        }
      }
    }
  } catch (err) {
    console.warn("⚠️ Nepodařilo se odeslat rank výběr embed:", err.message);
  }
});


// === 🟢 Nový člen join (upraveno pro verifyEnabled) ===
// === 🟢 Nový člen join (always welcome, verify controlled by verifyEnabled) ===
client.on("guildMemberAdd", async member => {
  try {
    if (member.user.bot) return;

    // lock proti duplikátům
    if (withShortLock(processedJoins, member.id, 2 * 60 * 1000)) {
      console.log(`⚠️ Lock: skipping duplicate join for ${member.user.tag}`);
      return;
    }

    // --- 1) always: veřejný welcome embed (pokud existuje kanál) ---
    {
      const welcomeChannelIdHard = "1400569915437748254";
      const welcomeEmbedChannel =
        member.guild.channels.cache.get(welcomeChannelIdHard) ||
        member.guild.channels.cache.get(config.channelsAndRoles?.nazdarChannelId);

      if (welcomeEmbedChannel) {
        const rawDesc = config.welcomeFlow?.greetingEmbed?.description ||
  `:flag_cz: Vítej {USER}!\nVyber si kliknutím na tlačítko hru, kvůli které jsi tu!\n\n:flag_us: Welcome {USER}!`;

const embed = new EmbedBuilder()
  .setTitle(config.welcomeFlow?.greetingEmbed?.title || "W E L C O M E !")
  .setDescription(fillTemplate(rawDesc, { USER: `<@${member.id}>` }))
  .setColor(config.welcomeFlow?.greetingEmbed?.color || "#3a3838")
  .setThumbnail(member.user.displayAvatarURL({ dynamic: true }));

// --- nové tlačítka ---
const btnFortnite = new ButtonBuilder()
  .setCustomId("pickgame:fortnite")
  .setLabel("Fortnite")
  .setEmoji({ id: "1442580400202584228", name: "fortnite" })
  .setStyle(ButtonStyle.Secondary);

const btnValorant = new ButtonBuilder()
  .setCustomId("pickgame:valorant")
  .setLabel("Valorant")
  .setEmoji({ id: "1442580564170510418", name: "valorant" })
  .setStyle(ButtonStyle.Secondary);

const btnRoblox = new ButtonBuilder()
  .setCustomId("pickgame:roblox")
  .setLabel("Roblox")
  .setEmoji({ id: "1442580463460941997", name: "roblox" })
  .setStyle(ButtonStyle.Secondary);

// --- 1. řada (WildRift → Fortnite → Warzone → Valorant → Roblox) ---
const row1 = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setCustomId("pickgame:wildrift")
    .setLabel("WildRift")
    .setEmoji({ id: "1442583007931269262", name: "wildrift" })
    .setStyle(ButtonStyle.Secondary),

  btnFortnite,

  new ButtonBuilder()
    .setCustomId("pickgame:warzone")
    .setLabel("Warzone")
    .setEmoji({ id: "1442582053618192456", name: "warzone" })
    .setStyle(ButtonStyle.Secondary),

  btnValorant,

  btnRoblox
);

// --- 2. řada (CS2 → Metin2 → Others) ---
const row2 = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setCustomId("pickgame:cs2")
    .setLabel("CS:2")
    .setEmoji({ id: "1421649819621134356", name: "cs2" })
    .setStyle(ButtonStyle.Secondary),

  new ButtonBuilder()
    .setCustomId("pickgame:metin2")
    .setLabel("Metin2")
    .setEmoji({ id: "1442579930234884116", name: "metin2" })
    .setStyle(ButtonStyle.Secondary),

  new ButtonBuilder()
    .setCustomId("pickgame:others")
    .setLabel("Others")
    .setEmoji({ id: "1442600123606503494", name: "others" })
    .setStyle(ButtonStyle.Primary)
);

// --- poslání embedu ---
await welcomeEmbedChannel
  .send({ embeds: [embed], components: [row1, row2] })
  .catch(() => {});
     }
   }

    // IDs z configu
    const unverifiedRoleId = config.channelsAndRoles?.unverifiedRoleId;
    const verifiedRoleId = config.channelsAndRoles?.verifiedRoleId;
    const verifyChannel = member.guild.channels.cache.get(config.channelsAndRoles?.welcomeChannelId);

    // --- 2) verify flow závislý jen na verifyEnabled ---
    if (verifyEnabled) {
      // přiřadit unverified roli (pokud je)
      if (unverifiedRoleId) {
        await member.roles.add(unverifiedRoleId).catch(() => {});
        console.log(`👤 ${member.user.tag} dostal roli Unverified (verifyEnabled=true)`);
      }

      // poslat otázku (pokud je configured verifyChannel a text)
      if (verifyChannel) {
        const questionText = fillTemplate(
          config.welcomeFlow?.verifyQuestionText || "Napiš sem odpověď pro ověření:",
          { USER: `${member}` }
        );

        const questionMsg = await verifyChannel.send(questionText).catch(() => null);
        if (!questionMsg) return;

        const filter = m => m.author.id === member.id;
        const collector = verifyChannel.createMessageCollector({
          filter,
          max: 1,
          time: 24 * 60 * 60 * 1000 // 24h
        });

        collector.on("collect", async msg => {
          const logChannel = member.guild.channels.cache.get(config.channelsAndRoles?.joinLogChannelId);
          if (!logChannel) return;

          const modLogCfg = config.welcomeFlow?.modLogEmbed || {};
          const embed = new EmbedBuilder()
            .setTitle(modLogCfg.title || "Nový člen")
            .setDescription(
              fillTemplate(modLogCfg.descriptionTemplate || "<@{USER}> odpověděl: {ANSWER}", {
                USER: `${member.id}`,
                ANSWER: msg.content || "*Žádná odpověď*"
              })
            )
            .setColor(modLogCfg.color || "#3a3838");

          const logMsg = await logChannel.send({ embeds: [embed] }).catch(() => null);
          if (logMsg) {
            await logMsg.react("✅").catch(() => {});
            await logMsg.react("❌").catch(() => {});
          }

          await msg.delete().catch(() => {});
          await questionMsg.delete().catch(() => {});
        });

        collector.on("end", async collected => {
          if (collected.size === 0) {
            // kick po timeoutu (pokud je nastaven reason)
            await member.kick(config.welcomeFlow.timeoutKickReason || "Timeout ověření").catch(() => {});
console.log(`⏰ ${member.user.tag} byl automaticky vyhozen po timeoutu`);

// uvolnit lock
processedJoins.delete(member.id);
console.log(`🔓 processedJoins cleared for ${member.user.tag} after timeout kick`);

          }
        });
      }
    } else {
      // verify disabled → rovnou verified role
      if (verifiedRoleId) {
  await member.roles.add(verifiedRoleId).catch(() => {});
  console.log(`✅ ${member.user.tag} automaticky VERIFIED (verifyEnabled=false)`);
  // uvolnit lock
  processedJoins.delete(member.id);
  console.log(`🔓 processedJoins cleared for ${member.user.tag} after auto-verify`);
}

    }

  } catch (err) {
    console.error("❌ Chyba v guildMemberAdd:", err);
  }
});

// === 🧩 Reaction Add ===
client.on("messageReactionAdd", async (reaction, user) => {
  try {
    if (user.bot) return;

    // pokud partial, fetchni
    if (reaction.partial) {
  try {
    await reaction.fetch();
  } catch (e) {
    console.warn("⚠️ Cannot fetch reaction:", e.message);
    return;
  }
}

let message = reaction.message;
// sometimes message is partial too — try fetch
if (message.partial) {
  try {
    message = await message.fetch();
  } catch (e) {
    console.warn("⚠️ Cannot fetch message for reaction:", e.message);
    return;
  }
}

if (!message.guild) return;

// debug log (pomůže ověřit, že handler přišel)
console.log(`🔁 reactionAdd: msg=${message.id} ch=${message.channelId} emoji=${reaction.emoji.toString()} by=${user.tag}`);

    // --- reaction roles (roleSelectChannel) --- (pokud to máš)
    if (message.channelId === config.channelsAndRoles?.roleSelectChannelId) {
      const emojiKey = reaction.emoji.toString();
      const EMOJI_ROLE_MAP = buildEmojiRoleMap();
      const roleId = EMOJI_ROLE_MAP[emojiKey] || RANK_EMOJI_ROLE_MAP[emojiKey];
      if (!roleId) return;
      const member = await message.guild.members.fetch(user.id).catch(() => null);
      if (member) await member.roles.add(roleId).catch(() => {});
      return;
    }

    // --- approve / reject v joinLogChannel ---
    if (message.channelId === config.channelsAndRoles?.joinLogChannelId) {
      const embed = message.embeds?.[0];
      if (!embed) return;

      // Lepší rozpoznání: když titulek obsahuje "Nový člen" nebo jiný modLogCfg.title
      const title = embed.title || "";
      // pokud title vypadá jako náš mod log
      if (!title.toLowerCase().includes((config.welcomeFlow?.modLogEmbed?.title || "nový člen").toLowerCase())) {
        return;
      }

      // Zkus najít ID člena v embedu (podpora <@123>, <@!123> i čisté číslo)
      let memberId = null;
      const desc = embed.description || "";
      const m1 = desc.match(/<@!?(\d{17,19})>/);
      if (m1) memberId = m1[1];
      if (!memberId) {
        const m2 = desc.match(/(\d{17,19})/);
        if (m2) memberId = m2[1];
      }

      if (!memberId) {
        console.warn("⚠️ approve handler: nenašlo se memberId v embedu:", embed.description);
        return;
      }

      // načíst člena
      const guild = message.guild;
      const member = await guild.members.fetch(memberId).catch(() => null);
      if (!member) {
        console.warn("⚠️ approve handler: member nenalezen:", memberId);
        return;
      }

      // Rozlišení emoji: používáme .toString() (řeší i custom/unicode)
      const emojiKey = reaction.emoji.toString();

      // schválení
      if (emojiKey === "✅" || emojiKey === "✅\uFE0F") {
        // permissions check
        const botMember = guild.members.cache.get(client.user.id);
        const verifiedRoleId = config.channelsAndRoles?.verifiedRoleId;
        const unverifiedRoleId = config.channelsAndRoles?.unverifiedRoleId;

        if (!verifiedRoleId) {
          console.warn("⚠️ approve: verifiedRoleId není v configu");
          return;
        }

        // check bot can manage roles and role position
        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
  console.warn("⚠️ Bot nemá ManageRoles permission (nebo role je níže než target role)");
  return;
}

        // try assign/remove
        try {
  await member.roles.add(verifiedRoleId);
  console.log(`✅ Přidána verified role ${verifiedRoleId} uživateli ${member.user.tag}`);
} catch (err) {
  console.warn("⚠️ add verified failed:", err && err.message ? err.message : err);
}

if (unverifiedRoleId) {
  try {
    await member.roles.remove(unverifiedRoleId);
    console.log(`➖ Odebrána unverified role ${unverifiedRoleId} uživateli ${member.user.tag}`);
  } catch (err) {
    console.warn("⚠️ remove unverified failed:", err && err.message ? err.message : err);
  }
}
// Uvolnit lock — umožní okamžitý rejoin
processedJoins.delete(member.id);
console.log(`🔓 processedJoins cleared for ${member.user.tag} after approve`);

        // odpověď do kanálu
        const approveCfg = config.welcomeFlow?.modLogEmbed?.approveMessage;
        if (approveCfg) {
          await message.channel.send({
            embeds: [
              new EmbedBuilder()
                .setDescription(
                  fillTemplate(approveCfg.textTemplate || "<@{USER}> schválen(a) {MOD}", { USER: `<@${member.id}>`, MOD: `<@${user.id}>` })
                )
                .setColor(approveCfg.color || "#00FF00")
            ]
          }).catch(() => {});
        }

        await message.delete().catch(() => {});
        return;
      }

      // odmítnutí
      if (emojiKey === "❌" || emojiKey === "❌\uFE0F") {
        await member.kick(`Zamítnuto ${user.tag}`).catch(err => console.warn("⚠️ kick failed:", err.message));
// uvolnit lock
processedJoins.delete(member.id);
console.log(`🔓 processedJoins cleared for ${member.user.tag} after reject/kick`);

        const rejectCfg = config.welcomeFlow?.modLogEmbed?.rejectMessage;
        if (rejectCfg) {
          await message.channel.send({
            embeds: [
              new EmbedBuilder()
                .setDescription(fillTemplate(rejectCfg.textTemplate || "<@{USER}> zamítnut {MOD}", { USER: `<@${member.id}>`, MOD: `<@${user.id}>` }))
                .setColor(rejectCfg.color || "#FF0000")
            ]
          }).catch(() => {});
        }

        await message.delete().catch(() => {});
        return;
      }

    } // end joinLogChannel check

  } catch (err) {
    console.error("⚠️ Chyba v messageReactionAdd:", err);
  }
});

// === 🧩 Reaction Remove ===
client.on("messageReactionRemove", async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        return;
      }
    }
    const message = reaction.message;
    if (!message.guild) return;
    if (
      message.channelId !==
      config.channelsAndRoles.roleSelectChannelId
    )
      return;

        const emojiKey = reaction.emoji.toString();
    const EMOJI_ROLE_MAP = buildEmojiRoleMap();
    const roleId =
      EMOJI_ROLE_MAP[emojiKey] || RANK_EMOJI_ROLE_MAP[emojiKey];
    if (!roleId) return;

    const member = await message.guild.members
      .fetch(user.id)
      .catch(() => null);
    if (member) await member.roles.remove(roleId).catch(() => {});

  } catch (err) {
    console.error("⚠️ Chyba při messageReactionRemove:", err);
  }
});

// === 🔴 Leave & Ban ===
client.on("guildMemberRemove", async member => {
  const now = Date.now(),
    last = lastEvent.get(member.id) || 0;
  if (now - last < 3000) return;
  lastEvent.set(member.id, now);

  const ch = member.guild.channels.cache.get(
    config.channelsAndRoles.leaveBanChannelId
  );
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
  const now = Date.now(),
    last = lastEvent.get(ban.user.id) || 0;
  if (now - last < 3000) return;
  lastEvent.set(ban.user.id, now);

  const ch = ban.guild.channels.cache.get(
    config.channelsAndRoles.leaveBanChannelId
  );
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
let lastMemberCount = -1,
  lastUnverifiedCount = -1;

setInterval(async () => {
  try {
    const guild = client.guilds.cache.first();
    if (!guild) return;

    // 🔇 Tichý fetch s fallbackem
    try {
      await guild.members.fetch();
    } catch (err) {
      if (err.message?.includes("Members didn't arrive in time")) {
        console.warn("⏱️ [Members] Timeout při fetchi – používám cache.");
      } else {
        console.warn("⚠️ [Members] Fetch error:", err.message);
      }
    }

    // [2] NOVÁ LOGIKA: počítat uživatele s alespoň jednou z pěti „game“ rolí
    const memberCount = guild.members.cache.filter(m => {
      if (m.user.bot) return false;
      if (m.id === config.channelsAndRoles.fallenPhoenixId) return false;
      return GAME_ROLE_IDS.some(rid => m.roles.cache.has(rid));
    }).size;

    if (memberCount !== lastMemberCount) {
      const ch = guild.channels.cache.get(
        config.channelsAndRoles.memberStatsChannelId // = 1429158078980423913
      );
      if (ch) {
        await ch
          .setName(`🔢︱Mᴇᴍʙᴇʀs: ${memberCount}`)
          .catch(() => {});
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

    // 🔇 Tichý fetch s fallbackem
try {
  await guild.members.fetch();
} catch (err) {
  // Pokud timeout → prostě ticho a fallback na cache
  if (err.message?.includes("Members didn't arrive in time")) {
    // ticho
  } else {
    // a i ostatní chyby ignorujeme, není důvod to logovat
  }
}

    const count = guild.members.cache.filter(m => {
      return (
        !m.user.bot &&
        m.roles.cache.has(config.channelsAndRoles.unverifiedRoleId)
      );
    }).size;

    if (count !== lastUnverifiedCount) {
      const ch = guild.channels.cache.get(
        config.channelsAndRoles.unverifiedStatsChannelId
      );
      if (ch) {
        await ch
          .setName(`❔︱Uɴᴠᴇʀɪғɪᴇᴅ: ${count}`)
          .catch(() => {});
      }
      lastUnverifiedCount = count;
    }
  } catch (err) {
    console.error("⚠️ Chyba při update Unverified:", err.message);
  }
}, 35000);

// === /clear + /ban + [3] BUTTON HANDLER ===
client.on("interactionCreate", async i => {
  if (i.isChatInputCommand()) {
    // /clear
    if (i.commandName === "clear") {
      const count = i.options.getInteger("pocet");
      if (count < 1 || count > 100) {
        return i.reply({
          content: "⚠️ Zadej číslo 1–100!",
          flags: 64
        });
      }

      try {
        const deleted = await i.channel.bulkDelete(count, true);
        await i.reply({
          content: `✅ Smazáno ${deleted.size} zpráv`,
          flags: 64
        });
        setTimeout(() => i.deleteReply().catch(() => {}), 1000);
      } catch (err) {
        if (err.code === 10008) {
          console.log(
            "⚠️ Některé zprávy už byly smazány dřív, přeskočeno."
          );
        } else {
          console.error("❌ Chyba při mazání zpráv:", err);
        }
      }
    }

    // /ban
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

        // log do onlineLogChannelId
        const logCh = guild.channels.cache.get(
          config.channelsAndRoles.onlineLogChannelId
        );
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

    return; // konec chat input commandů
  }

  // [3] Button handler – výběr hry/role (povolený jen 1 výběr)
  if (i.isButton() && i.customId.startsWith("pickgame:")) {
    try {
      const roleId = BUTTON_ROLE_MAP[i.customId];
      if (!roleId) {
        await i.reply({ content: "⚠️ Neznámé tlačítko.", ephemeral: true });
        setTimeout(() => i.deleteReply().catch(() => {}), 1500);
        return;
      }

      const member = await i.guild.members.fetch(i.user.id).catch(() => null);
      if (!member) {
        await i.reply({ content: "⚠️ Nepodařilo se načíst tvůj profil.", ephemeral: true });
        setTimeout(() => i.deleteReply().catch(() => {}), 1500);
        return;
      }

      // Pokud už má některou z „game“ rolí, další výběr nepovolíme
      const alreadyHasAny = GAME_ROLE_IDS.some(r => member.roles.cache.has(r));
      if (alreadyHasAny) {
        await i.reply({
          content: "❗ Už sis jednou vybral/a. Další změna není povolená.",
          ephemeral: true
        });
        setTimeout(() => i.deleteReply().catch(() => {}), 1500);
        return;
      }

      // Přidat vybranou roli a pro jistotu odebrat ostatní z téhle pětice (mělo by být zbytečné, ale ať je to čisté)
      await member.roles.add(roleId).catch(() => {});
      for (const rid of GAME_ROLE_IDS) {
        if (rid !== roleId && member.roles.cache.has(rid)) {
          await member.roles.remove(rid).catch(() => {});
        }
      }

// Odebrat „zámek“ roli po výběru (aby už viděl zbytek serveru)
await member.roles.remove("1428624557635407902").catch(() => {});

      // Ephemeral potvrzení a rychlý autodelete jako u příkazů
      await i.reply({
        content: "✅ Role byla přidělena.",
        ephemeral: true
      });
      setTimeout(() => i.deleteReply().catch(() => {}), 1000);

// 🧹 Odstranit tlačítka a změnit text embedu po výběru
const oldEmbed = i.message.embeds[0];
if (oldEmbed) {
  const updatedEmbed = EmbedBuilder.from(oldEmbed)
    .setDescription(
      `:flag_cz: Vítej ${member}!\nNechovej se tu jako píča prosím. Díky! 🤍\n\n:flag_us: Welcome ${member}!\nPlease don’t act like a pussy here, thanks! 🤍`
    );

  await i.message
    .edit({ embeds: [updatedEmbed], components: [] })
    .catch(() => {});
}

      // Tlačítka „skrýt po kliknutí“ pouze pro jednoho usera Discord neumí.
      // (Nelze skrýt komponenty jen pro konkrétního uživatele bez smazání celé zprávy.)
      // Funkčně je ale zajištěno: po 1. volbě už další kliky neprojdou.

    } catch (err) {
      console.error("❌ Button handler error:", err);
      if (!i.replied) {
        await i.reply({ content: "⚠️ Něco se pokazilo.", ephemeral: true });
        setTimeout(() => i.deleteReply().catch(() => {}), 1500);
      }
    }
  }
});

// === 💤 Keepalive ping co 5 minut ===
setInterval(() => {
  fetch("https://discord-bot-i4hx.onrender.com")
    .then(() => console.log("💓 Keepalive ping"))
    .catch(e => console.error("⚠️ Keepalive error:", e.message));
}, 5 * 60 * 1000);

// === Přihlášení bota ===
client.login(process.env.BOT_TOKEN);
