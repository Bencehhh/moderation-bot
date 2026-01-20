import http from "http";
import crypto from "crypto";
import { Client, GatewayIntentBits } from "discord.js";

// ===== ENV =====
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL; // e.g. https://your-webapp.onrender.com
const WEBAPP_SHARED_SECRET = process.env.WEBAPP_SHARED_SECRET;
const MOD_ROLE_NAME = process.env.MOD_ROLE_NAME || "Moderator";

// Optional: a simple path UptimeRobot can ping (default "/")
const KEEPALIVE_PATH = process.env.KEEPALIVE_PATH || "/";

if (!DISCORD_BOT_TOKEN || !WEBAPP_URL || !WEBAPP_SHARED_SECRET) {
  console.error("Missing env vars: DISCORD_BOT_TOKEN, WEBAPP_URL, WEBAPP_SHARED_SECRET");
  process.exit(1);
}

// ===== KEEP-ALIVE HTTP SERVER =====
// This keeps Replit-like hosts awake when pinged by UptimeRobot.
const PORT = Number(process.env.PORT || 3000);

http
  .createServer((req, res) => {
    if (req.url !== KEEPALIVE_PATH && KEEPALIVE_PATH !== "/") {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  })
  .listen(PORT, () => {
    console.log(`Keep-alive server listening on port ${PORT} (path: ${KEEPALIVE_PATH})`);
  });

// ===== DISCORD CLIENT =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.on("ready", () => console.log(`Bot online as ${client.user.tag}`));

// ===== WEBAPP HELPERS =====
function authHeaders() {
  return {
    "Authorization": WEBAPP_SHARED_SECRET,
    "Content-Type": "application/json",
    "X-Nonce": crypto.randomUUID(),
    "X-Ts": String(Math.floor(Date.now() / 1000))
  };
}

async function postWebapp(path, body) {
  const resp = await fetch(`${WEBAPP_URL}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body)
  });

  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: resp.ok, status: resp.status, text, json };
}

async function getWebapp(path) {
  const resp = await fetch(`${WEBAPP_URL}${path}`, {
    method: "GET",
    headers: {
      "Authorization": WEBAPP_SHARED_SECRET,
      "X-Nonce": crypto.randomUUID(),
      "X-Ts": String(Math.floor(Date.now() / 1000))
    }
  });

  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: resp.ok, status: resp.status, text, json };
}

// ===== PERMISSIONS =====
function hasPermission(msg) {
  const isOwner = msg.guild?.ownerId === msg.author.id;
  const isMod = msg.member?.roles?.cache?.some(r => r.name === MOD_ROLE_NAME) || false;
  return isOwner || isMod;
}

function parseUserIdAndReason(content) {
  const parts = content.trim().split(/\s+/);
  const userId = parts[1];
  const reason = parts.slice(2).join(" ") || "";
  return { userId, reason };
}

// ===== COMMAND HANDLER =====
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (!msg.guild) return;

  const content = msg.content.trim();
  const cmd = content.split(/\s+/)[0]?.toLowerCase();

  if (cmd === "!help") {
    return msg.reply(
      "**Commands**\n" +
      "`!warning <userId> <reason...>`\n" +
      "`!unwarn <userId> <reason...>`\n" +
      "`!kick <userId> <reason...>` (ban + kick)\n" +
      "`!unban <userId> <reason...>`\n" +
      "`!whereis <userId>`"
    );
  }

  // Permission gate for moderation actions
  const protectedCmds = new Set(["!warning", "!unwarn", "!kick", "!unban"]);
  if (protectedCmds.has(cmd) && !hasPermission(msg)) {
    return msg.reply("❌ You don't have permission.");
  }

  // !whereis
  if (cmd === "!whereis") {
    const parts = content.split(/\s+/);
    const userId = parts[1];
    if (!userId || !/^\d+$/.test(userId)) return msg.reply("Usage: `!whereis <userId>`");

    const r = await getWebapp(`/whois/${userId}`);
    if (!r.ok) return msg.reply("Not found in any active server (or mapping expired).");

    const lastSeenSec = Math.floor((Date.now() - r.json.lastSeenMs) / 1000);
    return msg.reply(`User **${userId}** is in server **${r.json.serverId}** (last seen ${lastSeenSec}s ago)`);
  }

  // !warning
  if (cmd === "!warning") {
    const { userId, reason } = parseUserIdAndReason(content);
    if (!userId || !/^\d+$/.test(userId)) return msg.reply("Usage: `!warning <userId> <reason...>`");

    const r = await postWebapp("/command", {
      action: "warn",
      userId,
      reason: reason || "Rule violation",
      moderator: msg.author.tag,
      imageA: "WARNING_A",
      imageB: "WARNING_B",
      interval: 0.35
    });

    if (!r.ok) return msg.reply(`❌ Failed (${r.status}): ${r.text}`);
    return msg.reply(`⚠️ Warned **${userId}** (server: **${r.json.routedServerId}**)`);
  }

  // !unwarn
  if (cmd === "!unwarn") {
    const { userId, reason } = parseUserIdAndReason(content);
    if (!userId || !/^\d+$/.test(userId)) return msg.reply("Usage: `!unwarn <userId> <reason...>`");

    const r = await postWebapp("/command", {
      action: "unwarn",
      userId,
      reason: reason || "Cleared",
      moderator: msg.author.tag
    });

    if (!r.ok) return msg.reply(`❌ Failed (${r.status}): ${r.text}`);
    return msg.reply(`✅ Unwarn queued for **${userId}** (server: **${r.json.routedServerId}**)`);
  }

  // !kick (ban + kick)
  if (cmd === "!kick") {
    const { userId, reason } = parseUserIdAndReason(content);
    if (!userId || !/^\d+$/.test(userId)) return msg.reply("Usage: `!kick <userId> <reason...>`");

    const r = await postWebapp("/command", {
      action: "kick",
      userId,
      reason: reason || "Rule violation",
      moderator: msg.author.tag
    });

    if (!r.ok) return msg.reply(`❌ Failed (${r.status}): ${r.text}`);

    if (r.json?.offline) {
      return msg.reply(`🚫 Banned **${userId}** (offline/global). Reason: ${reason || "Rule violation"}`);
    }
    return msg.reply(`🚫 Kick+Ban queued for **${userId}** (server: **${r.json.routedServerId}**)`);
  }

  // !unban
  if (cmd === "!unban") {
    const { userId, reason } = parseUserIdAndReason(content);
    if (!userId || !/^\d+$/.test(userId)) return msg.reply("Usage: `!unban <userId> <reason...>`");

    const r = await postWebapp("/command", {
      action: "unban",
      userId,
      reason: reason || "Unbanned",
      moderator: msg.author.tag
    });

    if (!r.ok) return msg.reply(`❌ Failed (${r.status}): ${r.text}`);

    if (r.json?.offline) {
      return msg.reply(`✅ Unbanned **${userId}** (offline/global).`);
    }
    return msg.reply(`✅ Unban queued for **${userId}** (server: **${r.json.routedServerId}**)`);
  }
});

client.login(DISCORD_BOT_TOKEN);
