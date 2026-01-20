import { Client, GatewayIntentBits } from "discord.js";
import crypto from "crypto";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL; // https://yourapp.onrender.com
const WEBAPP_SHARED_SECRET = process.env.WEBAPP_SHARED_SECRET;
const MOD_ROLE_NAME = process.env.MOD_ROLE_NAME || "Moderator";

if (!DISCORD_BOT_TOKEN || !WEBAPP_URL || !WEBAPP_SHARED_SECRET) {
  console.error("Missing env vars: DISCORD_BOT_TOKEN, WEBAPP_URL, WEBAPP_SHARED_SECRET");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.on("ready", () => console.log(`Bot online as ${client.user.tag}`));

async function postWebapp(path, body) {
  const nonce = crypto.randomUUID();
  const ts = Math.floor(Date.now() / 1000);

  const resp = await fetch(`${WEBAPP_URL}${path}`, {
    method: "POST",
    headers: {
      "Authorization": WEBAPP_SHARED_SECRET,
      "Content-Type": "application/json",
      "X-Nonce": nonce,
      "X-Ts": String(ts)
    },
    body: JSON.stringify(body)
  });

  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: resp.ok, status: resp.status, text, json };
}

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (!msg.guild) return;

  if (!msg.content.startsWith("!warning")) return;

  const isMod = msg.member.roles.cache.some(r => r.name === MOD_ROLE_NAME);
  if (!isMod) return msg.reply("❌ You don’t have permission.");

  const parts = msg.content.trim().split(/\s+/);
  const userId = parts[1];
  const reason = parts.slice(2).join(" ") || "Rule violation";

  if (!userId || !/^\d+$/.test(userId)) {
    return msg.reply("Usage: `!warning <userId> <reason...>`");
  }

  const result = await postWebapp("/command", {
    action: "warn",
    userId,
    reason,
    imageKey: "WARNING_1"
  });

  if (!result.ok) {
    return msg.reply(`❌ Failed (${result.status}): ${result.text}`);
  }

  msg.reply(`⚠️ Warned **${userId}** (server: **${result.json.routedServerId}**)`);
});

client.login(DISCORD_BOT_TOKEN);
