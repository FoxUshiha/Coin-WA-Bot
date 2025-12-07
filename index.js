// index.js — Bot WhatsApp (ESM) integrado ao handler/db/logic atualizados
import makeWASocket, { useMultiFileAuthState, jidNormalizedUser } from "@whiskeysockets/baileys";
import fs from "fs-extra";
import path from "path";
import qrcode from "qrcode-terminal";
import YAML from "yaml";

import { execCommand } from "./commands/handler.js";
import * as userDB from "./db.js";

const ROOT = path.resolve(".");
const DATA_DIR = path.join(ROOT, "data");
const AUTH_DIR = path.join(ROOT, "auth_info");
const CONFIG_FILE = path.join(ROOT, "config.yml");

fs.mkdirpSync(DATA_DIR);

// carrega config.yml (se não existir, usa defaults)
let CONFIG = {
  download_price: 0.00000064,
  download_receiver_card: '1f6c293c3951',
  ytdlp_path: "yt-dlp.exe",
  ffmpeg_path: "ffmpeg.exe",
  upload_limit_mb: 8,
};
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = YAML.parse(raw);
    CONFIG = {
      ...CONFIG,
      ...(parsed || {}),
    };
  } else {
    console.warn("⚠️ config.yml não encontrado. Usando valores padrões embutidos.");
  }
} catch (e) {
  console.error("⚠️ Falha ao ler config.yml:", e);
}

// small helpers
function unwrapMessage(m) {
  let msg = m;
  if (!msg) return msg;
  if (msg?.ephemeralMessage) msg = msg.ephemeralMessage.message;
  if (msg?.viewOnceMessageV2) msg = msg.viewOnceMessageV2.message;
  return msg;
}
function extractText(message) {
  const m = unwrapMessage(message);
  return m?.conversation
    || m?.extendedTextMessage?.text
    || m?.imageMessage?.caption
    || m?.videoMessage?.caption
    || m?.documentMessage?.caption
    || null;
}
function normalizeJid(jid) {
  if (!jid) return jid;
  const bare = String(jid).split(":")[0];
  return jidNormalizedUser ? jidNormalizedUser(bare) : bare;
}
function getMentionedJids(m) {
  const msg = unwrapMessage(m);
  const ctxs = [
    msg?.extendedTextMessage?.contextInfo,
    msg?.imageMessage?.contextInfo,
    msg?.videoMessage?.contextInfo,
    msg?.documentMessage?.contextInfo,
    msg?.audioMessage?.contextInfo,
    msg?.stickerMessage?.contextInfo,
  ].filter(Boolean);
  const all = [];
  for (const c of ctxs) {
    if (Array.isArray(c?.mentionedJid)) all.push(...c.mentionedJid);
  }
  return all;
}

// resolveSenderRaw: extrai JID canônico do remetente (mesma lógica do handler)
function resolveSenderRaw(msg) {
  const rawPart = (msg?.key?.participant) || (msg?.key?.remoteJid) || "";
  if (!rawPart) return "";
  if (/@s\.whatsapp\.net|@g\.us|@c\.us|@lid/i.test(rawPart)) {
    const digits = String(rawPart).replace(/\D/g, "");
    if (digits.length >= 8) return `${digits}@s.whatsapp.net`;
    return String(rawPart);
  }
  const digitsOnly = String(rawPart).replace(/\D/g, "");
  if (digitsOnly.length >= 8) return `${digitsOnly}@s.whatsapp.net`;
  return String(rawPart);
}

async function safeSend(sock, chatId, message) {
  try {
    return await sock.sendMessage(chatId, message);
  } catch (e) {
    console.error("safeSend fail:", e?.message || e);
    return null;
  }
}

function prettyIntroMessage() {
  // insere o valor do download (com formatação)
  const amount = typeof CONFIG.download_price === "number" ? CONFIG.download_price : Number(CONFIG.download_price || 0);
  const amountStr = (Number.isFinite(amount) ? amount : 0).toString();
  // Mensagem estilosa em PT-BR com emojis
  return [
    "👋 Olá — eu sou o Robô do sistema *Coin* para WhatsApp!",
    "",
    "Tenho diversas utilidades.",
    "",
    "Fazer transferências de coins e também, baixar músicas e vídeos do YouTube! 🎵",
    "",
    "Use !download link ou !video link",
    "",
    "💳 *Como fazer login*",
    "Use: `!card SEU-CARD` — com isso o seu card será salvo e você poderá operar com ele.",
    "Obtenha seu cartão aqui: http://coin.foxsrv.net:26450",
    "Ou pelo robô do Discord: https://discord.com/oauth2/authorize?client_id=1391067775077978214",
    "",
    "✨ *Comandos úteis*",
    "`!card CardID` — registrar / mostrar seu card",
    "`!pay ID ou @usuario <valor>` — pagar usando seu card ou sessão",
    "`!bal` — ver saldo (se estiver com sessão)",
    "`!bill` — criar/listar bills",
    "`!paybill <billId>` — pagar bill",
    "`!claim` — fazer claim (session ou card)",
    "`!check <ID_Transação>` — verificar transação",
    "",
    "*O que é coin?*",
    "",
    "Coin é uma moeda digital de API para ser utilizada como moeda de troca em diversos aplicativos e robôs na internet para melhorar a vida do usuário e ao mesmo tempo ser acessível para todos!",
    "",
    "🤖 Qualquer dúvida, responda essa mensagem e eu te ajudo."
  ].join("\n");
}

async function startBot() {
  console.log("🤖 Iniciando bot (WhatsApp)...");
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    // pode ajustar outras opções conforme seu ambiente
  });

  sock.ev.on("connection.update", (update) => {
    try {
      const { qr, connection, lastDisconnect } = update;
      if (qr) {
        console.log("📲 QR gerado — escaneie com seu WhatsApp:");
        qrcode.generate(qr, { small: true });
      }
      if (connection === "open") {
        console.log("✅ Conectado ao WhatsApp!");
      }
      if (lastDisconnect) {
        console.warn("⚠️ lastDisconnect:", lastDisconnect.error?.output || lastDisconnect.error?.message || lastDisconnect.error);
      }
    } catch (e) {
      console.error("connection.update erro:", e);
    }
  });

  // mensagens recebidas
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      try {
        if (!msg?.message) continue;
        if (msg.key?.fromMe) continue; // não responde mensagens que o bot enviou

        const chatId = msg.key.remoteJid;
        if (!chatId || chatId.endsWith?.("@status")) continue;

        const isGroup = chatId.endsWith?.("@g.us");
        const rawSender = resolveSenderRaw(msg);
        if (!rawSender) {
          console.warn("Não foi possível resolver remetente:", msg.key);
          continue;
        }
        const userKey = userDB.canonicalId(rawSender); // ex: '5511999999999'

        const text = extractText(msg.message);
        if (!text) continue;

        // Comando: inicia com '!'
        if (text.trim().startsWith("!")) {
          const parts = text.trim().slice(1).trim().split(/\s+/).filter(Boolean);
          const cmd = (parts.shift() || "").toLowerCase();
          const args = parts;

          // tenta obter usuário salvo (qualquer JID)
          let savedUser = null;
          try {
            if (typeof userDB.getUserByAnyJid === "function") {
              savedUser = await userDB.getUserByAnyJid(rawSender);
            }
            if (!savedUser) savedUser = await userDB.getUser(userKey);
          } catch (e) {
            // ignore
          }

          // execute handler (passando rawSender também)
          try {
            await execCommand(sock, userKey, cmd, args, chatId, savedUser, rawSender);
          } catch (e) {
            console.error("Erro executando comando:", e);
            await safeSend(sock, chatId, { text: "❌ Ocorreu um erro ao processar seu comando." });
          }
          continue;
        }

        // Mensagem privada que NÃO é comando -> enviar a intro bonita
        const isDM = chatId.endsWith?.("@s.whatsapp.net");
        if (isDM) {
          await safeSend(sock, chatId, {
            text: prettyIntroMessage()
          });
          continue;
        }

        // Em grupos: só responda se mencionarem o bot
        const botId = sock.user?.id || "";
        const botBare = botId.split?.(":")?.[0] ? `${botId.split(":")[0]}@s.whatsapp.net` : null;
        const mentioned = getMentionedJids(msg.message).map(normalizeJid);
        const isMentioned = botBare ? mentioned.includes(normalizeJid(botBare)) : false;
        if (isMentioned) {
          await safeSend(sock, chatId, {
            text: "👋 Olá! Eu sou o bot Coin. Para ver comandos use `!help`. Faça login no privado com `!card SEU-CARD`."
          });
        }
      } catch (err) {
        console.error("Erro no messages.upsert handler:", err);
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  console.log("🤖 Bot iniciado e aguardando mensagens. (Privado -> envia a mensagem de boas-vindas)");
}

startBot().catch((e) => {
  console.error("Erro ao iniciar bot:", e);
  process.exit(1);
});
