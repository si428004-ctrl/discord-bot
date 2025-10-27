// --- 🟢 Importy a setup --- //
import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import fetch from "node-fetch";
dotenv.config();

// --- 📁 Načtení konfiguračního JSONu --- //
let config = JSON.parse(fs.readFileSync("./config.json", "utf8"));

// --- 🔁 Reload configu + update bota --- //
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

// --- 🌐 Express server --- //
const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json());

// --- ✅ Healthcheck --- //
app.get("/", (req, res) => res.send("✅ Bot is running!"));

// --- 🧩 GET /config – pošle celý config dashboardu --- //
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

// --- 💾 POST /save-welcome --- //
app.post("/save-welcome", (req, res) => {
  try {
    const incoming = req.body;
    config.welcomeFlow = incoming;
    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");
    reloadConfig();
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /save-welcome error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 💾 POST /save-botsettings --- //
app.post("/save-botsettings", (req, res) => {
  try {
    const { displayName, statusText } = req.body;
    if (!displayName || !displayName.trim())
      return res.status(400).json({ ok: false, error: "Missing displayName" });

    if (!config.botIdentity) config.botIdentity = {};
    config.botIdentity.displayName = displayName.trim();
    config.botIdentity.statusText = statusText?.trim() || "";
    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");
    reloadConfig();
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /save-botsettings error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 💾 POST /save-ids --- //
app.post("/save-ids", (req, res) => {
  try {
    config.channelsAndRoles = req.body;
    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /save-ids error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 💾 POST /save-reactionroles --- //
app.post("/save-reactionroles", (req, res) => {
  try {
    config.reactionRoles = req.body;
    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /save-reactionroles error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 💾 POST /save-leaveban --- //
app.post("/save-leaveban", (req, res) => {
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
app.post("/save-banlog", (req, res) => {
  try {
    config.banCommandLog = req.body;
    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /save-banlog error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- ⚙️ /reload-config --- //
app.post("/reload-config", (req, res) => {
  reloadConfig();
  res.json({ ok: true, message: "Config reloadnutý." });
});

// --- 🧠 /admin – dashboard --- //
app.get("/admin", (req, res) => {
  try {
    const html = fs.readFileSync("./discordbot.html", "utf8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    console.error("❌ Nemůžu načíst dashboard:", err);
    res.status(500).send("Dashboard se nepodařilo načíst.");
  }
});

app.listen(PORT, () =>
  console.log(`🌐 Mini server běží na portu ${PORT}`)
);

// --- 🤖 Discord Bot --- //
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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember]
});

// 💤 Keepalive ping
setInterval(() => {
  fetch("https://discord-bot-i4hx.onrender.com")
    .then(() => console.log("💓 Keepalive ping"))
    .catch(e => console.error("⚠️ Keepalive error:", e.message));
}, 5 * 60 * 1000);

client.login(process.env.BOT_TOKEN);
