// index.js
const { default: makeWASocket, useMultiFileAuthState, jidNormalizedUser } = require("@whiskeysockets/baileys");
const fs = require("fs-extra");
const path = require("path");
const qrcode = require("qrcode-terminal");
const { execCommand } = require("./commands/handler.js");

const DATA_DIR = path.resolve("./data");

// -------- Helpers --------
function unwrapMessage(message) {
  // Desempacota mensagens efêmeras / view once
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

function introMessage() {
  return (
`Opa! Sou o bot ATM Coin no WhatsApp via API!
Fui criado pelo FoxOficial.

Use *!ajuda* ou *!help* para ver a lista de comandos.

Sistema Coin é uma moeda global digital semelhante ao Bitcoin, só que não envolve dinheiro real;

O intuito do Coin é ser uma moeda digital usada em comunidades, plataformas e jogos para gerar uma comunidade mais ativa e engajada;

É possível ser usado para fazer trocas, envios, transações, compras e vendas com Coins sem usar dinheiro real.

Temos suporte para:

- WhatsApp (esse bot);
- Discord: https://discord.com/oauth2/authorize?client_id=1391067775077978214
- Minecraft: https://www.spigotmc.org/resources/coin.127344/
- E futuramente em mais lugares!

Tem como acessar via site também! Fique a vontade:
http://coin.foxsrv.net:26450/`
  );
}

// -------- Main --------
async function startBot() {
  // garante que a pasta data exista
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // vamos exibir com qrcode-terminal
  });

  // QR code
  sock.ev.on("connection.update", (update) => {
    const { qr, connection } = update;
    if (qr) {
      console.log("📲 Escaneie o QR abaixo para conectar:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp com sucesso!");
    }
  });

  // Mensagens
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      try {
        if (!msg?.message) continue;
        if (msg.key.fromMe) continue; // ignora mensagens do próprio bot

        const chatId = msg.key.remoteJid; // grupo ou DM
        if (!chatId || chatId.endsWith("@status")) continue; // ignora status

        // remetente real (em grupo vem em participant)
        let sender = chatId;
        if (msg.key.participant) {
          sender = msg.key.participant;
        }

        const text = extractText(msg);
        if (!text) continue;

        // Proteção simples contra "trava-zap"
        if (text.length > 4000) {
          console.warn(`⚠️ Mensagem muito grande ignorada (${text.length} chars) de ${sender}`);
          continue;
        }

        console.log("📩 Mensagem recebida de", sender, "em", chatId, ":", text);

        // 1) Comandos (começam com !)
        if (text.startsWith("!")) {
          const args = text.slice(1).trim().split(/\s+/);
          const cmd = args.shift().toLowerCase();

          try {
            await execCommand(sock, sender, cmd, args, chatId);
          } catch (err) {
            console.error("⚠️ Erro ao executar comando:", err);
            await sock.sendMessage(chatId, { text: "❌ Ocorreu um erro ao executar o comando." });
          }
          continue;
        }

        // 2) Mensagem padrão (intro) — DM sempre, grupo apenas se mencionado
        const isDM = chatId.endsWith("@s.whatsapp.net");
        if (isDM) {
          // DM (privado): sempre responde com a intro
          await sock.sendMessage(chatId, { text: introMessage() });
          continue;
        }

        // Grupo: responde somente se for mencionado
        // calcula JID do bot normalizado
        const rawId = sock.user?.id || "";
        const botBare = rawId.split(":")[0] + "@s.whatsapp.net";
        const botJid = jidNormalizedUser ? jidNormalizedUser(botBare) : botBare;

        const mentioned = getMentionedJids(msg).map(jidNormalizedUser);
        const isMentioned = mentioned.includes(botJid);

        if (isMentioned) {
          await sock.sendMessage(chatId, { text: introMessage() });
        }
        // caso contrário, ignora mensagem normal em grupo
      } catch (e) {
        console.error("Erro no handler de mensagem:", e);
      }
    }
  });

  // Salva sessão
  sock.ev.on("creds.update", saveCreds);

  console.log("🤖 Bot WhatsApp iniciado, aguardando QR code...");
}

startBot();
