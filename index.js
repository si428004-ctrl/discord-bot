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
        .setTimestamp();

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
              .setTimestamp();

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
              .setTimestamp();

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

client.login(process.env.BOT_TOKEN);

// --- 💤 Keepalive ping každých 5 minut --- //
import fetch from "node-fetch";

setInterval(() => {
  const url = "https://discord-bot-i4hx.onrender.com"; // URL tvé služby na Renderu
  fetch(url)
    .then(() => console.log("💓 Keepalive ping odeslán"))
    .catch((err) => console.error("⚠️ Chyba keepalive pingu:", err.message));
}, 5 * 60 * 1000); // každých 5 minut

