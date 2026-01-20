import http from "http";
import crypto from "crypto";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

// ===== ENV =====
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL; // e.g. https://your-webapp.onrender.com
const WEBAPP_SHARED_SECRET = process.env.WEBAPP_SHARED_SECRET;
const MOD_ROLE_NAME = process.env.MOD_ROLE_NAME || "Moderator";

// Step 6.2 env vars (NEW)
const BOT_INTERNAL_SECRET = process.env.BOT_INTERNAL_SECRET; // shared with relay
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;           // channel to send embeds

// Optional: a simple path UptimeRobot can ping (default "/")
const KEEPALIVE_PATH = process.env.KEEPALIVE_PATH || "/";

if (!DISCORD_BOT_TOKEN || !WEBAPP_URL || !WEBAPP_SHARED_SECRET) {
  console.error("Missing env vars: DISCORD_BOT_TOKEN, WEBAPP_URL, WEBAPP_SHARED_SECRET");
  process.exit(1);
}

// ===== DISCORD CLIENT =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.on("ready", () => {
  console.log(`Bot online as ${client.user.tag}`);
  // Start HTTP server AFTER bot is ready so it can send embeds
  startHttpServer();
});

// ===== KEEP-ALIVE + INTERNAL LOG SERVER =====
const PORT = Number(process.env.PORT || 3000);

function startHttpServer() {
  http
    .createServer((req, res) => {
      // =========================
      // GET endpoints
      // =========================
      if (req.method === "GET") {
        // ✅ Step 1: dedicated bot ping endpoint
        if (req.url === "/bot/ping") {
          res.writeHead(200, { "Content-Type": "text/plain" });
          return res.end("BOT OK");
        }

        // existing keepalive behavior
        if (req.url !== KEEPALIVE_PATH && KEEPALIVE_PATH !== "/") {
          res.writeHead(404);
          return res.end("Not found");
        }

        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("OK");
      }

      // =========================
      // POST /internal/log (Step 6.2)
      // =========================
      if (req.method === "POST" && req.url === "/internal/log") {
        if (!BOT_INTERNAL_SECRET || !LOG_CHANNEL_ID) {
          res.writeHead(500);
          return res.end("Bot logging not configured");
        }

        const auth = req.headers.authorization || "";
        if (auth !== BOT_INTERNAL_SECRET) {
          res.writeHead(401);
          return res.end("Unauthorized");
        }

        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", async () => {
          try {
            const parsed = JSON.parse(body || "{}");
            const { type, payload } = parsed;

            const channel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
            if (!channel) {
              res.writeHead(500);
              return res.end("Log channel not found");
            }

            // Handle banned join attempt embed
            if (type === "banned_join_attempt") {
              const username = payload?.username || "?";
              const displayName = payload?.displayName || username || "Unknown";
              const userId = payload?.userId ?? "Unknown";
              const reason = payload?.reason || "Rule violation";
              const moderator = payload?.moderator || "Unknown";
              const placeId = payload?.placeId ? String(payload.placeId) : "Unknown";
              const universeId = payload?.universeId ? String(payload.universeId) : "Unknown";
              const serverId = payload?.serverId ? String(payload.serverId) : "Unknown";
              const networkId = payload?.networkId ? String(payload.networkId) : "Unknown";

              const userLine =
                `**${displayName}** (@${username})\n` +
                `UserId: \`${userId}\``;

              const embed = new EmbedBuilder()
                .setTitle("🚫 Banned user attempted to join")
                .addFields(
                  { name: "User", value: userLine, inline: false },
                  { name: "Reason", value: reason, inline: false },
                  { name: "Moderator", value: moderator, inline: true },
                  { name: "Network", value: networkId, inline: true },
                  { name: "PlaceId", value: placeId, inline: true },
                  { name: "UniverseId", value: universeId, inline: true },
                  { name: "Server", value: serverId, inline: true }
                )
                .setTimestamp(new Date());

              await channel.send({ embeds: [embed] });
            } else {
              // Unknown log type (still acknowledge)
              const embed = new EmbedBuilder()
                .setTitle("ℹ️ Moderation Event")
                .setDescription(`Unknown event type: \`${String(type)}\``)
                .setTimestamp(new Date());
              await channel.send({ embeds: [embed] });
            }

            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("OK");
          } catch (e) {
            res.writeHead(400);
            res.end("Bad request");
          }
        });

        return;
      }

      res.writeHead(404);
      res.end("Not found");
    })
    .listen(PORT, () => {
      console.log(`HTTP server listening on port ${PORT} (keepalive path: ${KEEPALIVE_PATH})`);
      console.log("Internal log endpoint: POST /internal/log");
      console.log("Bot ping endpoint: GET /bot/ping");
    });
}

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
