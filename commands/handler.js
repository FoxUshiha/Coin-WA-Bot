// commands/handler.js (ESM) — Versão completa e corrigida
import axios from "axios";
import * as userDB from "../db.js";
import * as logic from "../logic.js"; // optional: usamos as funções de logic quando possível

const API_URL = process.env.COIN_API_URL || "http://coin.foxsrv.net:26450";

// Helpers
function apiWithAuth(sessionId) {
  return axios.create({
    baseURL: API_URL,
    headers: sessionId ? { Authorization: `Bearer ${sessionId}` } : {},
    timeout: 10000,
  });
}

function fmt(n) {
  if (n == null) return "0";
  const num = Number(n);
  if (!isFinite(num)) return String(n);
  return Number(num).toFixed(8).replace(/\.?0+$/, "");
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

async function ensureSession(sock, sender, chatId) {
  // sender é a userKey canônica (ex: '554791388455')
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

// Tenta buscar dados de transação por vários endpoints conhecidos
async function fetchTransaction(txId, sessionId = null) {
  const client = sessionId ? apiWithAuth(sessionId) : axios.create({ baseURL: API_URL, timeout: 10000 });

  const endpoints = [
    `/api/transaction/${txId}`,
    `/api/transactions/${txId}`,
    `/api/tx/${txId}`,
    `/api/transaction?id=${txId}`,
    `/api/tx?id=${txId}`,
  ];

  for (const ep of endpoints) {
    try {
      const res = await client.get(ep);
      if (res?.data) return { ok: true, data: res.data, usedEndpoint: ep };
    } catch (e) {
      // ignora e tenta próximo
    }
  }

  // tentar rota POST (algumas APIs usam post /api/transaction/check)
  const postEndpoints = [
    "/api/transaction/check",
    "/api/tx/check",
    "/api/transaction/get",
  ];
  for (const ep of postEndpoints) {
    try {
      const res = await client.post(ep, { id: txId });
      if (res?.data) return { ok: true, data: res.data, usedEndpoint: ep };
    } catch (e) {
      // ignora e tenta próximo
    }
  }

  return { ok: false };
}

// executor de comandos
export async function execCommand(sock, sender, cmd, args = [], chatId, user = null, rawSender = null) {
  try {
    switch ((cmd || "").toLowerCase()) {
      // ------------------- AUTH -------------------
      case "login": {
        if (args.length < 2) {
          return sock.sendMessage(chatId, { text: "❌ Use: `!login <usuario> <senha>`" });
        }
        const [username, password] = args;

        try {
          // se quiser enviar passwordHash em sha256, compute aqui em vez de enviar senha em texto
          // Exemplo:
          // import crypto from 'crypto';
          // const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
          // const { data } = await axios.post(`${API_URL}/api/login`, { username, passwordHash });

          const { data } = await axios.post(`${API_URL}/api/login`, { username, password });

          if (!data?.sessionCreated && !data?.sessionId) {
            return sock.sendMessage(chatId, { text: "❌ Login falhou." });
          }

          // salva a sessão vinculada ao 'sender' CANÔNICO e grava alias rawSender (_lastJidVariant)
          await userDB.setUser(sender, {
            login: username,
            userId: data.userId || data.user_id || null,
            sessionId: data.sessionId || data.session_id || null,
            loginTime: Date.now(),
            _lastJidVariant: rawSender || undefined,
          });

          const saldoTxt = typeof data.saldo !== "undefined" ? fmt(data.saldo) : "0";
          await sock.sendMessage(chatId, {
            text: `✅ Logado como *${username}*\n💰 Saldo: *${saldoTxt}* coins`,
          });
        } catch (err) {
          const msg = err?.response?.data?.error || err?.response?.data?.message || err.message || "Erro";
          await sock.sendMessage(chatId, { text: `⚠️ Erro ao tentar logar: ${msg}` });
        }
        break;
      }

      // ------------------- REGISTER -------------------
      case "register": {
        if (args.length < 2) {
          return sock.sendMessage(chatId, { text: "❌ Use: `!register <usuario> <senha>`" });
        }
        const [username, password] = args;
        try {
          const { data } = await axios.post(`${API_URL}/api/register`, { username, password });
          if (data?.error) {
            return sock.sendMessage(chatId, { text: `⚠️ Erro ao registrar: ${data.error}` });
          }
          await sock.sendMessage(chatId, {
            text:
              `✅ Conta registrada com sucesso!\n\n` +
              `👤 Usuário: *${username}*\n` +
              `🆔 ID: ${data.userId || data.user_id || "?"}\n\n` +
              `Agora faça login usando: \`!login ${username} <senha>\``,
          });
        } catch (err) {
          const msg = err?.response?.data?.error || err?.response?.data?.message || err.message || "Erro";
          await sock.sendMessage(chatId, { text: `⚠️ Erro ao registrar: ${msg}` });
        }
        break;
      }

      // ------------------- BALANCE -------------------
      case "bal":
      case "balance": {
        const u = user ?? (await ensureSession(sock, sender, chatId));
        if (!u) return;
        // preferir usar logic.getBalance se disponível
        try {
          const res = await logic.getBalance(u.sessionId);
          if (res?.success) {
            return sock.sendMessage(chatId, { text: `💰 Saldo: *${fmt(res.balance)}* coins` });
          }
        } catch (e) {
          // fallback para chamada direta
        }

        const api = apiWithAuth(u.sessionId);
        try {
          const { data } = await api.get(`/api/user/${u.userId}/balance`);
          const coins = data?.coins ?? data?.balance ?? data?.amount ?? 0;
          await sock.sendMessage(chatId, { text: `💰 Saldo: *${fmt(coins)}* coins` });
        } catch (err) {
          const msg = err?.response?.data?.error || err?.message || "Erro";
          await sock.sendMessage(chatId, { text: `⚠️ Erro ao buscar saldo: ${msg}` });
        }
        break;
      }

      // ------------------- HISTORY -------------------
      case "history": {
        const u = user ?? (await ensureSession(sock, sender, chatId));
        if (!u) return;
        const page = parseInt(args[0] || "1", 10) || 1;
        try {
          const res = await logic.getTransactions(u.sessionId, page);
          if (res?.success) {
            const rows = (res.transactions || []).slice(0, 25);
            if (!rows.length) return sock.sendMessage(chatId, { text: "🗒️ Sem transações." });
            const txt = rows
              .map((t) => {
                const date = t.date || t.createdAt || t.timestamp || t.time;
                const from = t.from_id || t.from || t.fromUser || "?";
                const to = t.to_id || t.to || t.toUser || "?";
                const amount = t.amount ?? t.value ?? t.coins ?? 0;
                return `• ${new Date(date).toLocaleString()} — ${from} ➜ ${to} : ${fmt(amount)}`;
              })
              .join("\n");
            return sock.sendMessage(chatId, { text: `📜 *Transações (p.${page})*\n${txt}` });
          }
        } catch (e) {
          // fallback api direct
        }

        const api = apiWithAuth((user && user.sessionId) || (await userDB.getUser(sender))?.sessionId);
        try {
          const { data } = await api.get("/api/transactions", { params: { page } });
          const rows = (data.transactions || data.history || []).slice(0, 25);
          if (!rows.length) return sock.sendMessage(chatId, { text: "🗒️ Sem transações." });
          const txt = rows
            .map((t) => {
              const date = t.date || t.createdAt || t.timestamp || t.time;
              const from = t.from_id || t.from || t.fromUser || "?";
              const to = t.to_id || t.to || t.toUser || "?";
              const amount = t.amount ?? t.value ?? t.coins ?? 0;
              return `• ${new Date(date).toLocaleString()} — ${from} ➜ ${to} : ${fmt(amount)}`;
            })
            .join("\n");
          await sock.sendMessage(chatId, { text: `📜 *Transações (p.${data.page || page})*\n${txt}` });
        } catch (err) {
          const msg = err?.response?.data?.error || err?.message || "Erro";
          await sock.sendMessage(chatId, { text: `⚠️ Erro ao buscar histórico: ${msg}` });
        }
        break;
      }

      // ------------------- TRANSFER (PAY) -------------------
      case "pay": {
        if (args.length < 2) {
          return sock.sendMessage(chatId, { text: "❌ Use: `!pay <toId|@usuario> <valor>`" });
        }

        const uPay = user ?? (await ensureSession(sock, sender, chatId));
        if (!uPay) return;
        const api = apiWithAuth(uPay.sessionId);

        let toId = args[0];
        const amount = Number(args[1]);

        if (!isFinite(amount) || amount <= 0) {
          return sock.sendMessage(chatId, { text: "❌ Valor inválido." });
        }

        // Se destino é menção (@numero)
        if (toId.startsWith("@")) {
          const mentionJid = toId.replace("@", "") + "@s.whatsapp.net";
          const targetUser = await userDB.getUser(mentionJid);
          if (!targetUser) {
            return sock.sendMessage(chatId, { text: "❌ Este usuário não fez login ainda!" });
          }
          toId = targetUser.userId;
        }

        if (!/^\d+$/.test(String(toId))) {
          return sock.sendMessage(chatId, { text: "❌ ID inválido." });
        }

        try {
          await api.post("/api/transfer", { toId, amount });
          await sock.sendMessage(chatId, {
            text: `✅ Enviado *${fmt(amount)}* para *${toId}*.`,
          });
        } catch (err) {
          const msg = err?.response?.data?.error || err?.message || "Erro";
          await sock.sendMessage(chatId, { text: `⚠️ Erro na transferência: ${msg}` });
        }
        break;
      }

      // ------------------- CLAIM -------------------
      case "claim": {
        const uCl = user ?? (await ensureSession(sock, sender, chatId));
        if (!uCl) return;
        try {
          const res = await logic.claim(uCl.sessionId);
          if (res?.success) {
            return sock.sendMessage(chatId, { text: `🎁 Claim feito! Você recebeu *${fmt(res.claimed)}* coins.` });
          }
          if (res?.cooldownMs) {
            return sock.sendMessage(chatId, { text: `⏳ Em cooldown. Tente novamente em ${msToHuman(res.cooldownMs)}.` });
          }
        } catch (e) {
          // fallback
        }

        const api = apiWithAuth(uCl.sessionId);
        try {
          const { data } = await api.post("/api/claim");
          const claimed = data?.claimed ?? data?.amount ?? 0;
          await sock.sendMessage(chatId, {
            text: `🎁 Claim feito! Você recebeu *${fmt(claimed)}* coins.`,
          });
        } catch (err) {
          if (err?.response?.status === 429 || err?.response?.status === 400) {
            const left = err?.response?.data?.nextClaimInMs ?? err?.response?.data?.cooldownRemainingMs ?? 0;
            return sock.sendMessage(chatId, {
              text: `⏳ Em cooldown. Tente novamente em ${msToHuman(left)}.`,
            });
          }
          const msg = err?.response?.data?.error || err?.message || "Erro";
          await sock.sendMessage(chatId, { text: `⚠️ Erro no claim: ${msg}` });
        }
        break;
      }

      // ------------------- CARD -------------------
      case "card": {
        const uCard = user ?? (await ensureSession(sock, sender, chatId));
        if (!uCard) return;
        const api = apiWithAuth(uCard.sessionId);

        if (args[0] && args[0].toLowerCase() === "reset") {
          try {
            const { data } = await api.post("/api/card/reset");
            await sock.sendMessage(chatId, {
              text: `🔁 Novo card gerado:\n\`${data?.newCode ?? data?.cardCode ?? "?"}\``,
            });
          } catch (err) {
            const msg = err?.response?.data?.error || err?.message || "Erro";
            await sock.sendMessage(chatId, { text: `⚠️ Erro ao resetar card: ${msg}` });
          }
          return;
        }

        try {
          const { data } = await api.post("/api/card");
          await sock.sendMessage(chatId, {
            text: `💳 Seu card:\n\`${data?.cardCode ?? data?.code ?? "?"}\``,
          });
        } catch (err) {
          const msg = err?.response?.data?.error || err?.message || "Erro";
          await sock.sendMessage(chatId, { text: `⚠️ Erro ao obter card: ${msg}` });
        }
        break;
      }

      // ------------------- BILL (create/list) -------------------
      case "bill": {
        const uBill = user ?? (await ensureSession(sock, sender, chatId));
        if (!uBill) return;
        const api = apiWithAuth(uBill.sessionId);
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

          if (!/^\d+$/.test(String(toId)) || !isFinite(amount) || amount <= 0) {
            return sock.sendMessage(chatId, { text: "❌ Parâmetros inválidos." });
          }

          try {
            const { data } = await api.post("/api/bill/create", {
              fromId: uBill.userId,
              toId,
              amount,
              time,
            });
            await sock.sendMessage(chatId, {
              text: `🧾 Bill criada! ID: \`${data?.billId ?? data?.id ?? "?"}\` — valor *${fmt(amount)}* para *${toId}*`,
            });
          } catch (err) {
            const msg = err?.response?.data?.error || err?.message || "Erro";
            await sock.sendMessage(chatId, { text: `⚠️ Erro ao criar bill: ${msg}` });
          }
          return;
        }

        if (sub === "list") {
          const page = parseInt(args[1] || "1", 10) || 1;
          try {
            const { data } = await api.post("/api/bill/list", { page });
            const toPay = data.toPay || data.to_pay || [];
            const toReceive = data.toReceive || data.to_receive || [];
            const aPagar = toPay
              .slice(0, 10)
              .map((b) => `• ID ${b.id || b.billId || "?"} — pagar ${fmt(b.amount ?? b.value)} para ${b.to_id ?? b.to}`)
              .join("\n");
            const aReceber = toReceive
              .slice(0, 10)
              .map((b) => `• ID ${b.id || b.billId || "?"} — receber ${fmt(b.amount ?? b.value)} de ${b.from_id ?? b.from}`)
              .join("\n");

            await sock.sendMessage(chatId, {
              text:
                `📥 *A pagar* (p.${data.page ?? page})\n${aPagar || "—"}\n\n` +
                `📤 *A receber* (p.${data.page ?? page})\n${aReceber || "—"}`,
            });
          } catch (err) {
            const msg = err?.response?.data?.error || err?.message || "Erro";
            await sock.sendMessage(chatId, { text: `⚠️ Erro ao listar bills: ${msg}` });
          }
          return;
        }

        return sock.sendMessage(chatId, {
          text: "❓ Use:\n• `!bill create <toId> <valor> [tempo]`\n• `!bill list [pagina]`",
        });
      }

      // ------------------- PAYBILL -------------------
      case "paybill": {
        const uPaybill = user ?? (await ensureSession(sock, sender, chatId));
        if (!uPaybill) return;
        const api = apiWithAuth(uPaybill.sessionId);
        if (args.length < 1) {
          return sock.sendMessage(chatId, { text: "❌ Use: `!paybill <billId>`" });
        }
        const billId = args[0];
        try {
          await api.post("/api/bill/pay", { billId });
          await sock.sendMessage(chatId, { text: `✅ Bill \`${billId}\` paga!` });
        } catch (err) {
          const msg = err?.response?.data?.error || err?.message || "Erro";
          await sock.sendMessage(chatId, { text: `⚠️ Erro ao pagar bill: ${msg}` });
        }
        break;
      }

      // ------------------- BACKUP -------------------
      case "backup": {
        const uB = user ?? (await ensureSession(sock, sender, chatId));
        if (!uB) return;
        const api = apiWithAuth(uB.sessionId);

        try {
          await api.post("/api/backup/create");
          const { data } = await api.post("/api/backup/list");
          const codes = data?.backups || data?.codes || [];
          if (!codes.length) {
            return sock.sendMessage(chatId, { text: "⚠️ Nenhum código de backup disponível." });
          }
          const lista = codes.map((c, i) => `${i + 1}. \`${c}\``).join("\n");
          await sock.sendMessage(chatId, { text: `📦 *Seus códigos de backup:*\n\n${lista}` });
        } catch (err) {
          const msg = err?.response?.data?.error || err?.message || "Erro";
          await sock.sendMessage(chatId, { text: `⚠️ Erro ao buscar backups: ${msg}` });
        }
        break;
      }

      // ------------------- RESTORE -------------------
      case "restore": {
        if (args.length < 1) {
          return sock.sendMessage(chatId, { text: "❌ Use: `!restore <código>`" });
        }
        const code = args[0];
        const uR = user ?? (await ensureSession(sock, sender, chatId));
        if (!uR) return;
        const api = apiWithAuth(uR.sessionId);

        try {
          await api.post("/api/backup/restore", { backupId: code });
          const { data: bal } = await api.get(`/api/user/${uR.userId}/balance`);
          const saldo = bal?.coins ?? bal?.balance ?? 0;
          await sock.sendMessage(chatId, {
            text: `♻️ Backup restaurado!\n💰 Saldo atual: *${fmt(saldo)}* coins`,
          });
        } catch (err) {
          const msg = err?.response?.data?.error || err?.message || "Erro";
          await sock.sendMessage(chatId, { text: `⚠️ Erro ao restaurar backup: ${msg}` });
        }
        break;
      }

      // ------------------- VIEW -------------------
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
                `🔑 *Sessão*: ${String(targetUser.sessionId || "").slice(0, 8)}...\n` +
                `💰 *Saldo*: ${saldoTxt} coins`,
            });
          } catch (err) {
            const msg = err?.response?.data?.error || err?.message || "Erro";
            await sock.sendMessage(chatId, { text: `⚠️ Erro ao buscar saldo: ${msg}` });
          }
          break;
        }

        // Caso contrário, mostra info do próprio usuário
        {
          const uV = user ?? (await ensureSession(sock, sender, chatId));
          if (!uV) return;

          const api = apiWithAuth(uV.sessionId);
          try {
            const { data } = await api.get(`/api/user/${uV.userId}/balance`);
            const saldoTxt = typeof data.coins !== "undefined" ? fmt(data.coins) : "0";

            await sock.sendMessage(chatId, {
              text:
                `👤 *Usuário*: ${uV.login}\n` +
                `🆔 *ID*: ${uV.userId}\n` +
                `🔑 *Sessão*: ${String(uV.sessionId || "").slice(0, 8)}...\n` +
                `💰 *Saldo*: ${saldoTxt} coins`,
            });
          } catch (err) {
            const msg = err?.response?.data?.error || err?.message || "Erro";
            await sock.sendMessage(chatId, { text: `⚠️ Erro ao buscar saldo: ${msg}` });
          }
        }
        break;
      }

      // ------------------- RANK -------------------
      case "rank": {
        const uR = user ?? (await ensureSession(sock, sender, chatId));
        if (!uR) return;
        const api = apiWithAuth(uR.sessionId);
        try {
          const { data } = await api.get("/api/rank");
          const top = (data.rankings || data.top || []).slice(0, 25);

          const lines = top.map((r, i) => {
            const nameOrId = (r.username && r.username.trim() !== "" && r.username) || r.id || r.userId || "?";
            return `${i + 1}. ${nameOrId} — ${fmt(r.coins ?? r.value ?? r.amount)}`;
          });

          const total = typeof data.totalCoins !== "undefined" ? fmt(data.totalCoins) : "?";
          await sock.sendMessage(chatId, {
            text:
              `🌎 *Global Rank (Top 25)*\n` +
              lines.join("\n") +
              `\n\n💠 *Total em circulação:* ${total} coins`,
          });
        } catch (err) {
          const msg = err?.response?.data?.error || err?.message || "Erro";
          await sock.sendMessage(chatId, { text: `⚠️ Erro no rank: ${msg}` });
        }
        break;
      }

      // ------------------- GLOBAL -------------------
      case "global": {
        const uG = user ?? (await ensureSession(sock, sender, chatId));
        if (!uG) return;
        const api = apiWithAuth(uG.sessionId);

        try {
          const rankRes = await api.get("/api/rank");
          const totalCoins = rankRes.data?.totalCoins ?? rankRes.data?.total_coins ?? "?";

          let userCount = "?";
          try {
            const usersRes = await api.get("/api/totalusers");
            userCount = usersRes.data?.totalUsers ?? usersRes.data?.total_users ?? userCount;
          } catch (e) {
            // rota opcional
          }

          let cooldownTxt = "✅ Claim disponível!";
          try {
            const claimRes = await api.get("/api/claim/status");
            const msLeft = claimRes.data?.cooldownRemainingMs ?? claimRes.data?.nextClaimInMs ?? 0;
            cooldownTxt = msLeft > 0 ? `⏳ Próximo claim em ${msToHuman(msLeft)}` : "✅ Claim disponível!";
          } catch (e) {
            // ignora
          }

          await sock.sendMessage(chatId, {
            text:
              `🌎 *Estatísticas Globais*\n\n` +
              `💠 Total em circulação: *${fmt(totalCoins)}* coins\n` +
              `👥 Total de usuários: *${userCount}*\n` +
              `${cooldownTxt}`,
          });
        } catch (err) {
          const msg = err?.response?.data?.error || err?.message || "Erro";
          await sock.sendMessage(chatId, { text: `⚠️ Erro em global: ${msg}` });
        }
        break;
      }

      // ------------------- CHECK TRANSACTION -------------------
      case "check": {
        if (args.length < 1) {
          return sock.sendMessage(chatId, { text: "❌ Use: `!check <transactionID>`" });
        }
        const txId = args[0];

        // tenta fetch com session (se disponível) para endpoints autenticados
        const sessionId = (user && user.sessionId) || (await userDB.getUser(sender))?.sessionId || null;

        try {
          const found = await fetchTransaction(txId, sessionId);
          if (!found.ok) {
            return sock.sendMessage(chatId, { text: `❌ Transação não encontrada: ${txId}` });
          }
          const tx = found.data;

          // tenta extrair campos mais comuns
          const txIdOut = tx.id ?? tx.txId ?? tx.transactionId ?? tx._id ?? tx.tx_id ?? tx.txHash ?? tx.hash ?? txId;
          const status = tx.status ?? tx.state ?? tx.confirmations ?? (tx.confirmations > 0 ? "confirmed" : "pending") ?? "unknown";
          const amount = tx.amount ?? tx.value ?? tx.coins ?? tx.amountSats ?? tx.value_sats ?? null;
          const from = tx.from_id ?? tx.from ?? tx.sender ?? tx.fromUser ?? tx.senderId ?? tx.fromId;
          const to = tx.to_id ?? tx.to ?? tx.recipient ?? tx.toUser ?? tx.toId;
          const created = tx.createdAt ?? tx.timestamp ?? tx.time ?? tx.date ?? null;

          let txt = `🔎 *Transação* \`${txIdOut}\`\n`;
          txt += `• Status: *${String(status)}*\n`;
          if (amount != null) txt += `• Valor: *${fmt(amount)}*\n`;
          if (from) txt += `• De: \`${from}\`\n`;
          if (to) txt += `• Para: \`${to}\`\n`;
          if (created) {
            try {
              txt += `• Data: ${new Date(created).toLocaleString()}\n`;
            } catch (e) {
              txt += `• Data: ${String(created)}\n`;
            }
          }

          // adiciona um json compacto com o payload caso queira detalhes
          const compact = JSON.stringify(tx, null, 2);
          if (compact.length < 1500) {
            txt += `\n\`\`\`json\n${compact}\n\`\`\``;
            await sock.sendMessage(chatId, { text: txt });
          } else {
            // se payload grande, envia resumo + arquivo
            await sock.sendMessage(chatId, { text: txt });
            await sock.sendMessage(chatId, { document: Buffer.from(compact, "utf8"), fileName: `tx-${txIdOut}.json`, mimetype: "application/json" });
          }
        } catch (err) {
          console.error("Erro em !check:", err);
          await sock.sendMessage(chatId, { text: `⚠️ Erro ao checar transação: ${err?.message || err}` });
        }
        break;
      }

      // ------------------- HELP / AJUDA -------------------
      case "help":
      case "ajuda": {
        const helpText = `
📖 *Lista de Comandos Coin Bot (WhatsApp)*

🔐 *Autenticação*
• \`!login <usuario> <senha>\` — Fazer login (salva conta para seu número)
• \`!register <usuario> <senha>\` — Registrar nova conta

💰 *Carteira*
• \`!bal\` — Ver saldo atual
• \`!history [página]\` — Histórico de transações
• \`!view [@usuário]\` — Info da conta

📤 *Transações*
• \`!pay <id|@usuário> <valor>\` — Enviar coins
• \`!claim\` — Resgatar diária
• \`!check <transactionID>\` — Ver dados de uma transação

💳 *Cartão*
• \`!card\` — Ver card
• \`!card reset\` — Novo card

🧾 *Bills*
• \`!bill create <id> <valor> [tempo]\`
• \`!bill list [página]\`
• \`!paybill <id>\`

📦 *Backup*
• \`!backup\`
• \`!restore <código>\`

🌍 *Outros*
• \`!rank\`, \`!global\`
• \`!help\` ou \`!ajuda\`
───────────────
📝 *Tutorial*: Logue no privado com \`!login\` (ou no grupo — sua conta é salva pelo número e funciona globalmente).
`;
        await sock.sendMessage(chatId, { text: helpText });
        break;
      }

      default:
        await sock.sendMessage(chatId, { text: "❓ Comando não reconhecido." });
    }
  } catch (err) {
    console.error("execCommand erro:", err);
    try {
      await sock.sendMessage(chatId, { text: "❌ Ocorreu um erro inesperado." });
    } catch (e) {
      console.error("Falha ao avisar o usuário sobre erro:", e);
    }
  }
}
