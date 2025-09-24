// commands/handler.js
const axios = require("axios");
const userDB = require("../db.js");

// Ajuste aqui se sua API estiver em outro host/porta
const API_URL = process.env.COIN_API_URL || "http://coin.foxsrv.net:26450";

// Helpers
function apiWithAuth(sessionId) {
  return axios.create({
    baseURL: API_URL,
    headers: { Authorization: `Bearer ${sessionId}` },
    timeout: 10000,
  });
}

function fmt(n) {
  return Number(n).toFixed(8).replace(/\.?0+$/, "");
}

function msToHuman(ms) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (ss || parts.length === 0) parts.push(`${ss}s`);
  return parts.join(" ");
}

// checa sessão pelo SENDER (usuário) e responde no CHATID (onde veio o comando)
async function ensureSession(sock, sender, chatId) {
  const user = await userDB.getUser(sender);
  if (!user?.sessionId || !user?.userId) {
    await sock.sendMessage(chatId, {
      text: "🔐 Faça login primeiro: `!login <usuario> <senha>`",
    });
    return null;
  }
  const expired = await userDB.isSessionExpired(user);
  if (expired) {
    await userDB.clearUser(sender);
    await sock.sendMessage(chatId, {
      text: "⏳ Sessão expirou. Faça login novamente! (Use `!login usuario senha`)",
    });
    return null;
  }
  return user;
}

// Agora recebe: (sock, sender, cmd, args, chatId)
async function execCommand(sock, sender, cmd, args, chatId) {
  try {
    switch (cmd) {
      // AUTH
      case "login": {
        if (args.length < 2) {
          return sock.sendMessage(chatId, { text: "❌ Use: `!login <usuario> <senha>`" });
        }
        const [username, password] = args;

        try {
          const { data } = await axios.post(`${API_URL}/api/login`, {
            username,
            password,
          });

          if (!data?.sessionCreated) {
            return sock.sendMessage(chatId, { text: "❌ Login falhou." });
          }

          await userDB.setUser(sender, {
            number: sender,
            login: username,
            userId: data.userId,
            sessionId: data.sessionId,
            loginTime: Date.now(),
          });

          const saldoTxt = typeof data.saldo !== "undefined" ? fmt(data.saldo) : "0";
          await sock.sendMessage(chatId, {
            text: `✅ Logado como *${username}*\n💰 Saldo: *${saldoTxt}* coins`,
          });
        } catch (err) {
          const msg = err.response?.data?.error || err.message || "Erro";
          await sock.sendMessage(chatId, { text: `⚠️ Erro ao tentar logar: ${msg}` });
        }
        break;
      }

      // SALDO
      case "bal": {
        const user = await ensureSession(sock, sender, chatId);
        if (!user) return;
        const api = apiWithAuth(user.sessionId);
        try {
          const { data } = await api.get(`/api/user/${user.userId}/balance`);
          await sock.sendMessage(chatId, {
            text: `💰 Saldo: *${fmt(data.coins)}* coins`,
          });
        } catch (err) {
          const msg = err.response?.data?.error || err.message;
          await sock.sendMessage(chatId, { text: `⚠️ Erro ao buscar saldo: ${msg}` });
        }
        break;
      }


// BACKUP — lista (garante 12 códigos e mostra para o usuário)
case "backup": {
  const user = await ensureSession(sock, sender, chatId);
  if (!user) return;
  const api = apiWithAuth(user.sessionId);

  try {
    // opcional: garante que existam até 12 códigos
    await api.post("/api/backup/create");

    // lista os códigos de backup
    const { data } = await api.post("/api/backup/list");
    const codes = data?.backups || [];

    if (!codes.length) {
      return sock.sendMessage(chatId, { text: "⚠️ Nenhum código de backup disponível." });
    }

    const lista = codes.map((c, i) => `${i + 1}. \`${c}\``).join("\n");
    await sock.sendMessage(chatId, { text: `📦 *Seus 12 códigos de backup:*\n\n${lista}` });
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    await sock.sendMessage(chatId, { text: `⚠️ Erro ao buscar backups: ${msg}` });
  }
  break;
}


// RESTORE — !restore <código> (restaura e mostra saldo atualizado)
case "restore": {
  if (args.length < 1) {
    return sock.sendMessage(chatId, { text: "❌ Use: `!restore <código>`" });
  }
  const code = args[0];

  const user = await ensureSession(sock, sender, chatId);
  if (!user) return;
  const api = apiWithAuth(user.sessionId);

  try {
    // restaura pelo código
    await api.post("/api/backup/restore", { backupId: code });

    // pega saldo atualizado
    const { data: bal } = await api.get(`/api/user/${user.userId}/balance`);
    const saldo = (bal && typeof bal.coins !== "undefined") ? bal.coins : 0;

    await sock.sendMessage(chatId, {
      text: `♻️ Backup restaurado!\n💰 Saldo atual: *${Number(saldo).toFixed(8).replace(/\\.?0+$/, "")}* coins`
    });
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    await sock.sendMessage(chatId, { text: `⚠️ Erro ao restaurar backup: ${msg}` });
  }
  break;
}


// HELP / AJUDA
case "help":
case "ajuda": {
  const helpText = `
📖 *Lista de Comandos Coin Bot (WhatsApp)*

🔐 *Autenticação*
• \`!login <usuario> <senha>\` — Fazer login
• \`!register <usuario> <senha>\` — Fazer registro (cooldown global de 1 conta cada 24h na API)

💰 *Carteira*
• \`!bal\` — Ver saldo atual
• \`!history [página]\` — Ver histórico de transações
• \`!view\` — Ver informações da conta

📤 *Transações*
• \`!pay <id> <valor>\` — Enviar coins para outro usuário
• \`!claim\` — Resgatar recompensa diária

💳 *Cartão*
• \`!card\` — Mostrar código do card
• \`!card reset\` — Gerar um novo card

🧾 *Bills (contas)*
• \`!bill create <id> <valor> [tempo]\` — Criar cobrança
• \`!bill list [página]\` — Listar cobranças
• \`!paybill <id>\` — Pagar cobrança

📦 *Backup*
• \`!backup\` — Listar seus 12 códigos de backup
• \`!restore <código>\` — Restaurar backup pelo código

🌍 *Outros*
• \`!rank\` / \`!global\` — Ranking global
• \`!help\` ou \`!ajuda\` — Mostrar esta mensagem

──────────────────────────────
📝 *Tutorial rápido*:
1. Use \`!login usuario senha\` no privado (DM) para se conectar.
2. Depois pode usar os comandos em qualquer grupo ou no privado.
3. Se sua sessão expirar (24h), basta logar novamente.
4. É possível entrar via site: http://coin.foxsrv.net:26450 .
  `;

  await sock.sendMessage(chatId, { text: helpText });
  break;
}



// RANK
case "rank": {
  const user = await ensureSession(sock, sender, chatId);
  if (!user) return;
  const api = apiWithAuth(user.sessionId);
  try {
    const { data } = await api.get("/api/rank");
    const top = (data.rankings || []).slice(0, 25);

    const lines = top.map((r, i) => {
      // pega username se existir, senão usa id, ou userId, ou até "?" como último recurso
      const nameOrId =
        (r.username && r.username.trim() !== "" && r.username) ||
        r.id ||
        r.userId ||
        "?";

      return `${i + 1}. ${nameOrId} — ${fmt(r.coins)}`;
    });

    const total = typeof data.totalCoins !== "undefined" ? fmt(data.totalCoins) : "?";
    await sock.sendMessage(chatId, {
      text:
        `🌎 *Global Rank (Top 25)*\n` +
        lines.join("\n") +
        `\n\n💠 *Total em circulação:* ${total} coins`,
    });
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    await sock.sendMessage(chatId, { text: `⚠️ Erro no rank: ${msg}` });
  }
  break;
}


// GLOBAL
case "global": {
  const user = await ensureSession(sock, sender, chatId);
  if (!user) return;
  const api = apiWithAuth(user.sessionId);

  try {
    // 1) total de coins (vem do rank)
    const rankRes = await api.get("/api/rank");
    const totalCoins = rankRes.data?.totalCoins || "?";

    // 2) total de usuários (nova rota)
    const { data: usersData } = await api.get("/api/totalusers");
    const userCount = usersData?.totalUsers || "?";

    // 3) cooldown do claim
    const claimRes = await api.get("/api/claim/status");
    const msLeft = claimRes.data?.cooldownRemainingMs ?? 0;

    const cooldownTxt =
      msLeft > 0 ? `⏳ Próximo claim em ${msToHuman(msLeft)}` : "✅ Claim disponível!";

    // resposta final
    await sock.sendMessage(chatId, {
      text:
        `🌎 *Estatísticas Globais*\n\n` +
        `💠 Total em circulação: *${fmt(totalCoins)}* coins\n` +
        `👥 Total de usuários: *${userCount}*\n` +
        `${cooldownTxt}`
    });
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    await sock.sendMessage(chatId, { text: `⚠️ Erro em global: ${msg}` });
  }
  break;
}


// REGISTER
case "register": {
  if (args.length < 2) {
    return sock.sendMessage(chatId, { text: "❌ Use: `!register <usuario> <senha>`" });
  }

  const [username, password] = args;

  try {
    const { data } = await axios.post(`${API_URL}/api/register`, {
      username,
      password,
    });

    if (data.error) {
      return sock.sendMessage(chatId, { text: `⚠️ Erro ao registrar: ${data.error}` });
    }

    await sock.sendMessage(chatId, {
      text:
        `✅ Conta registrada com sucesso!\n\n` +
        `👤 Usuário: *${username}*\n` +
        `🆔 ID: ${data.userId}\n\n` +
        `Agora faça login usando: \`!login ${username} <senha>\``,
    });
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    await sock.sendMessage(chatId, { text: `⚠️ Erro ao registrar: ${msg}` });
  }
  break;
}




      // HISTORY
      case "history": {
        const user = await ensureSession(sock, sender, chatId);
        if (!user) return;
        const api = apiWithAuth(user.sessionId);
        const page = parseInt(args[0] || "1", 10);
        try {
          const { data } = await api.get("/api/transactions", { params: { page } });
          const rows = (data.transactions || []).slice(0, 10);
          if (!rows.length) {
            return sock.sendMessage(chatId, { text: "🗒️ Sem transações." });
          }
          const txt = rows
            .map(
              (t) =>
                `• ${new Date(t.date).toLocaleString()} — ` +
                `${t.from_id} ➜ ${t.to_id} : ${fmt(t.amount)}`
            )
            .join("\n");
          await sock.sendMessage(chatId, { text: `📜 *Transações (p.${data.page})*\n${txt}` });
        } catch (err) {
          const msg = err.response?.data?.error || err.message;
          await sock.sendMessage(chatId, { text: `⚠️ Erro ao buscar histórico: ${msg}` });
        }
        break;
      }

// TRANSFER
case "pay": {
  if (args.length < 2) {
    return sock.sendMessage(chatId, { text: "❌ Use: `!pay <toId|@usuário> <valor>`" });
  }

  const user = await ensureSession(sock, sender, chatId);
  if (!user) return;
  const api = apiWithAuth(user.sessionId);

  let toId = args[0];
  const amount = Number(args[1]);

  if (!isFinite(amount) || amount <= 0) {
    return sock.sendMessage(chatId, { text: "❌ Valor inválido." });
  }

  // 🔎 Se o destino começa com "@" → menção
  if (toId.startsWith("@")) {
    // Normaliza JID do WhatsApp
    const mentionJid = toId.replace("@", "") + "@s.whatsapp.net";
    const targetUser = await userDB.getUser(mentionJid);

    if (!targetUser) {
      return sock.sendMessage(chatId, { text: "❌ Este usuário não fez login ainda!" });
    }

    toId = targetUser.userId; // usa o ID salvo no banco
  }

  // Validação caso ainda seja numérico
  if (!/^\d+$/.test(toId)) {
    return sock.sendMessage(chatId, { text: "❌ ID inválido." });
  }

  try {
    await api.post("/api/transfer", { toId, amount });
    await sock.sendMessage(chatId, {
      text: `✅ Enviado *${fmt(amount)}* para *${toId}*.`,
    });
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    await sock.sendMessage(chatId, { text: `⚠️ Erro na transferência: ${msg}` });
  }
  break;
}


      // CLAIM
      case "claim": {
        const user = await ensureSession(sock, sender, chatId);
        if (!user) return;
        const api = apiWithAuth(user.sessionId);
        try {
          const { data } = await api.post("/api/claim");
          await sock.sendMessage(chatId, {
            text: `🎁 Claim feito! Você recebeu *${fmt(data.claimed)}* coins.`,
          });
        } catch (err) {
          if (err.response?.status === 429) {
            const left = err.response.data?.nextClaimInMs ?? 0;
            return sock.sendMessage(chatId, {
              text: `⏳ Em cooldown. Tente novamente em ${msToHuman(left)}.`,
            });
          }
          const msg = err.response?.data?.error || err.message;
          await sock.sendMessage(chatId, { text: `⚠️ Erro no claim: ${msg}` });
        }
        break;
      }

      // CARD
      case "card": {
        const user = await ensureSession(sock, sender, chatId);
        if (!user) return;
        const api = apiWithAuth(user.sessionId);

        if (args[0] && args[0].toLowerCase() === "reset") {
          try {
            const { data } = await api.post("/api/card/reset");
            await sock.sendMessage(chatId, {
              text: `🔁 Novo card gerado:\n\`${data.newCode}\``,
            });
          } catch (err) {
            const msg = err.response?.data?.error || err.message;
            await sock.sendMessage(chatId, { text: `⚠️ Erro ao resetar card: ${msg}` });
          }
          return;
        }

        try {
          const { data } = await api.post("/api/card");
          await sock.sendMessage(chatId, {
            text: `💳 Seu card:\n\`${data.cardCode}\``,
          });
        } catch (err) {
          const msg = err.response?.data?.error || err.message;
          await sock.sendMessage(chatId, { text: `⚠️ Erro ao obter card: ${msg}` });
        }
        break;
      }

      // BILL
      case "bill": {
        const user = await ensureSession(sock, sender, chatId);
        if (!user) return;
        const api = apiWithAuth(user.sessionId);
        const sub = (args[0] || "").toLowerCase();

        if (sub === "create") {
          if (args.length < 3) {
            return sock.sendMessage(chatId, {
              text: "❌ Use: `!bill create <toId> <valor> [tempo]`",
            });
          }
          const toId = args[1];
          const amount = Number(args[2]);
          const time = args[3];

          if (!/^\d+$/.test(toId) || !isFinite(amount) || amount <= 0) {
            return sock.sendMessage(chatId, { text: "❌ Parâmetros inválidos." });
          }

          try {
            const { data } = await api.post("/api/bill/create", {
              fromId: user.userId,
              toId,
              amount,
              time,
            });
            await sock.sendMessage(chatId, {
              text: `🧾 Bill criada! ID: \`${data.billId}\` — valor *${fmt(amount)}* para *${toId}*`,
            });
          } catch (err) {
            const msg = err.response?.data?.error || err.message;
            await sock.sendMessage(chatId, { text: `⚠️ Erro ao criar bill: ${msg}` });
          }
          return;
        }

        if (sub === "list") {
          const page = parseInt(args[1] || "1", 10);
          try {
            const { data } = await api.post("/api/bill/list", { page });
            const toPay = data.toPay || [];
            const toReceive = data.toReceive || [];
            const aPagar = toPay
              .slice(0, 5)
              .map((b) => `• ID ${b.id} — pagar ${fmt(b.amount)} para ${b.to_id}`)
              .join("\n");
            const aReceber = toReceive
              .slice(0, 5)
              .map((b) => `• ID ${b.id} — receber ${fmt(b.amount)} de ${b.from_id}`)
              .join("\n");

            await sock.sendMessage(chatId, {
              text:
                `📥 *A pagar* (p.${data.page})\n${aPagar || "—"}\n\n` +
                `📤 *A receber* (p.${data.page})\n${aReceber || "—"}`,
            });
          } catch (err) {
            const msg = err.response?.data?.error || err.message;
            await sock.sendMessage(chatId, { text: `⚠️ Erro ao listar bills: ${msg}` });
          }
          return;
        }

        return sock.sendMessage(chatId, {
          text: "❓ Use:\n• `!bill create <toId> <valor> [tempo]`\n• `!bill list [pagina]`",
        });
      }

      // PAYBILL
      case "paybill": {
        const user = await ensureSession(sock, sender, chatId);
        if (!user) return;
        const api = apiWithAuth(user.sessionId);
        if (args.length < 1) {
          return sock.sendMessage(chatId, { text: "❌ Use: `!paybill <billId>`" });
        }
        const billId = args[0];
        try {
          await api.post("/api/bill/pay", { billId });
          await sock.sendMessage(chatId, { text: `✅ Bill \`${billId}\` paga!` });
        } catch (err) {
          const msg = err.response?.data?.error || err.message;
          await sock.sendMessage(chatId, { text: `⚠️ Erro ao pagar bill: ${msg}` });
        }
        break;
      }

// VIEW
case "view": {
  // Se o user marcou alguém
  if (args.length >= 1 && args[0].startsWith("@")) {
    const mentionJid = args[0].replace("@", "") + "@s.whatsapp.net";
    const targetUser = await userDB.getUser(mentionJid);

    if (!targetUser) {
      await sock.sendMessage(chatId, { text: "❌ Esse usuário ainda não fez login!" });
      break;
    }

    const api = apiWithAuth(targetUser.sessionId);
    try {
      const { data } = await api.get(`/api/user/${targetUser.userId}/balance`);
      const saldoTxt = typeof data.coins !== "undefined" ? fmt(data.coins) : "0";

      await sock.sendMessage(chatId, {
        text:
          `👤 *Usuário*: ${targetUser.login}\n` +
          `🆔 *ID*: ${targetUser.userId}\n` +
          `🔑 *Sessão*: ${targetUser.sessionId.slice(0, 8)}...\n` +
          `💰 *Saldo*: ${saldoTxt} coins`,
      });
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      await sock.sendMessage(chatId, { text: `⚠️ Erro ao buscar saldo: ${msg}` });
    }
    break;
  }

  // Caso contrário, mostra info do próprio usuário
  const user = await ensureSession(sock, sender, chatId);
  if (!user) return;

  const api = apiWithAuth(user.sessionId);
  try {
    const { data } = await api.get(`/api/user/${user.userId}/balance`);
    const saldoTxt = typeof data.coins !== "undefined" ? fmt(data.coins) : "0";

    await sock.sendMessage(chatId, {
      text:
        `👤 *Usuário*: ${user.login}\n` +
        `🆔 *ID*: ${user.userId}\n` +
        `🔑 *Sessão*: ${user.sessionId.slice(0, 8)}...\n` +
        `💰 *Saldo*: ${saldoTxt} coins`,
    });
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    await sock.sendMessage(chatId, { text: `⚠️ Erro ao buscar saldo: ${msg}` });
  }
  break;
}


      default:
        await sock.sendMessage(chatId, { text: "❓ Comando não reconhecido." });
    }
  } catch (err) {
    console.error(err);
    await sock.sendMessage(chatId, { text: "❌ Ocorreu um erro inesperado." });
  }
}


module.exports = { execCommand };
