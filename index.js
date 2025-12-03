// index.js (ESM) - Versão corrigida e 100% funcional
import makeWASocket, { useMultiFileAuthState, jidNormalizedUser } from "@whiskeysockets/baileys";
import fs from "fs-extra";
import path from "path";
import qrcode from "qrcode-terminal";
import { execCommand } from "./commands/handler.js";
import * as userDB from "./db.js";

const DATA_DIR = path.resolve("./data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------- Helpers ----------------
function unwrapMessage(message) {
  let m = message;
  if (m?.ephemeralMessage) m = m.ephemeralMessage.message;
  if (m?.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
  return m || message;
}

function extractText(msg) {
  const m = unwrapMessage(msg.message);
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    m?.documentMessage?.caption ||
    null
  );
}

function getMentionedJids(msg) {
  const m = unwrapMessage(msg.message);
  const ctxs = [
    m?.extendedTextMessage?.contextInfo,
    m?.imageMessage?.contextInfo,
    m?.videoMessage?.contextInfo,
    m?.documentMessage?.contextInfo,
    m?.audioMessage?.contextInfo,
    m?.stickerMessage?.contextInfo,
  ].filter(Boolean);
  const all = [];
  for (const c of ctxs) {
    if (Array.isArray(c?.mentionedJid)) all.push(...c.mentionedJid);
  }
  return all;
}

function normalizeJid(jid) {
  if (!jid) return jid;
  const bare = String(jid).split(":")[0];
  return jidNormalizedUser ? jidNormalizedUser(bare) : bare;
}

// ---------- resolveSenderRaw ----------
// Recebe o objeto 'msg' (Baileys message) e retorna um JID "limpo" representando o remetente,
// preferindo extrair número telefônico quando possível.
// Ex.: "102130128056502:87@lid" -> "102130128056502@s.whatsapp.net"
//       "554791388455@s.whatsapp.net" -> mantém
function resolveSenderRaw(msg) {
  const rawPart = (msg?.key?.participant) || (msg?.key?.remoteJid) || "";
  if (!rawPart) return "";

  // se já contém domínio padrão do WhatsApp ou g.us (grupo) ou lid, tenta extrair dígitos
  if (/@s\.whatsapp\.net|@g\.us|@c\.us|@lid/i.test(rawPart)) {
    // extrai sequência de dígitos contidos na string (se houver)
    const digits = String(rawPart).replace(/\D/g, "");
    // heurística: se temos 8+ dígitos, consideramos número telefônico
    if (digits.length >= 8) {
      return `${digits}@s.whatsapp.net`;
    }
    // se não possui dígitos significativos, retorna versão normalizada do rawPart
    // (p.ex. pode ser um id interno)
    return String(rawPart);
  }

  // se não contém domínio, tentar extrair dígitos e adicionar domínio padrão
  const digitsOnly = String(rawPart).replace(/\D/g, "");
  if (digitsOnly.length >= 8) {
    return `${digitsOnly}@s.whatsapp.net`;
  }

  // fallback: retorna rawPart simples
  return String(rawPart);
}

function userKeyFromRaw(raw) {
  return userDB.canonicalId(raw);
}

async function safeSend(sock, chatId, message) {
  try {
    return await sock.sendMessage(chatId, message);
  } catch (err) {
    // não propaga e evita crash; log detalhado
    console.error(`Falha ao enviar mensagem para ${chatId}:`, err?.output || err?.message || err);
    return null;
  }
}

function introMessage() {
  return (
`Olá! Sou o bot Coin (WhatsApp).
Use \`!help\` para ver os comandos.
Faça login com \`!login <usuario> <senha>\` — sua conta será vinculada ao seu número e poderá ser usada em grupos.`
  );
}

// ---------------- Main ----------------
async function startBot() {
  // garante diretório data
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  // QR & connection
  sock.ev.on("connection.update", (update) => {
    try {
      const { qr, connection, lastDisconnect } = update;
      if (qr) {
        console.log("📲 QR gerado — escaneie com seu WhatsApp:");
        qrcode.generate(qr, { small: true });
      }
      if (connection === "open") {
        console.log("✅ Conectado ao WhatsApp com sucesso!");
      }
      if (lastDisconnect) {
        console.warn("⚠️ lastDisconnect:", lastDisconnect.error?.output || lastDisconnect.error?.message || lastDisconnect.error);
      }
    } catch (e) {
      console.error("Erro no evento connection.update:", e);
    }
  });

  // messages.upsert
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      try {
        if (!msg?.message) continue;
        if (msg.key?.fromMe) continue;

        const chatId = msg.key.remoteJid;
        if (!chatId || chatId.endsWith?.("@status")) continue;

        const isGroup = chatId.endsWith?.("@g.us");

        // resolve remetente robustamente
        const rawSender = resolveSenderRaw(msg); // ex: "554791388455@s.whatsapp.net"
        if (!rawSender) {
          console.warn("Não foi possível resolver remetente para mensagem:", msg.key);
          continue;
        }
        const userKey = userKeyFromRaw(rawSender); // ex: "554791388455"

        // texto
        const text = extractText(msg);
        if (!text) continue;

        if (text.length > 8000) {
          console.warn(`Mensagem muito grande ignorada (${text.length} chars) de ${rawSender}`);
          await safeSend(sock, chatId, { text: "⚠️ Mensagem muito grande — não posso processar." });
          continue;
        }

        console.log(`📩 Msg de ${rawSender} => key ${userKey} no chat ${chatId} : ${text}`);

        // Comandos: prefix '!'
        if (text.trim().startsWith("!")) {
          const args = text.trim().slice(1).trim().split(/\s+/).filter(Boolean);
          const cmd = (args.shift() || "").toLowerCase();

          // Obter usuário salvo: tenta por alias (qualquer JID) antes de usar canonical
          let savedUser = null;
          try {
            if (typeof userDB.getUserByAnyJid === "function") {
              savedUser = await userDB.getUserByAnyJid(rawSender);
            }
          } catch (e) {
            // ignore; fallback below
          }
          if (!savedUser) {
            try {
              savedUser = await userDB.getUser(userKey);
            } catch (e) {
              // ignore
            }
          }

          // Executive call: passamos sender = userKey (canônico), e rawSender adicional
          try {
            await execCommand(sock, userKey, cmd, args, chatId, savedUser, rawSender);
          } catch (err) {
            console.error("Erro ao executar comando:", err);
            await safeSend(sock, chatId, { text: "❌ Ocorreu um erro ao executar o comando." });
          }

          continue; // next message
        }

        // mensagens não-comando
        const isDM = chatId.endsWith?.("@s.whatsapp.net");
        if (isDM) {
          await safeSend(sock, chatId, { text: introMessage() });
          continue;
        }

        // em grupos, só responde se for mencionado
        const botRawId = sock.user?.id || "";
        const botBare = botRawId.split?.(":")?.[0] + "@s.whatsapp.net";
        const botJid = normalizeJid(botBare);
        const mentioned = getMentionedJids(msg).map(normalizeJid);
        const isMentioned = mentioned.includes(botJid);

        if (isMentioned) {
          await safeSend(sock, chatId, {
            text:
              "Olá! Use `!help` para ver comandos. Faça login no privado com `!login <usuario> <senha>` ou faça login aqui no grupo (sua sessão será vinculada ao seu número).",
          });
        }
      } catch (err) {
        console.error("Erro no handler de mensagem:", err);
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  console.log("🤖 Bot WhatsApp iniciado, aguardando QR code...");
}

// start
startBot().catch((e) => {
  console.error("Falha ao iniciar bot:", e);
});
