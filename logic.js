// logic.js (ESM) — camada de integração com a API Coin
// Fornece funções reutilizáveis e com retornos padronizados para o handler.
// Requer: axios instalado. Variável de ambiente COIN_API_URL opcional.

import axios from "axios";

const COIN_API = process.env.COIN_API_URL || "http://coin.foxsrv.net:26450";
const DEFAULT_TIMEOUT = 10000;

// Cria um cliente axios com (opcional) autenticação por sessionId
function apiClient(sessionId = null) {
  const headers = {};
  if (sessionId) headers.Authorization = `Bearer ${sessionId}`;
  return axios.create({
    baseURL: COIN_API,
    headers,
    timeout: DEFAULT_TIMEOUT,
  });
}

// Internal: normaliza erro para string amigável
function _errMsg(err) {
  if (!err) return "Erro desconhecido";
  if (err.response?.data) {
    // tenta várias chaves comuns
    const d = err.response.data;
    return d.error || d.message || JSON.stringify(d);
  }
  return err.message || String(err);
}

// ----------------- AUTH / SESSÃO -----------------

/**
 * login(username, passwordOrHash, rawSender)
 * - Faz POST /api/login com { username, password } (ou passwordHash)
 * - Retorna objeto: { sessionCreated: boolean, userId, sessionId, saldo, rawResponse }
 */
export async function login(username, passwordOrHash) {
  try {
    const client = apiClient();
    const res = await client.post("/api/login", {
      username,
      password: passwordOrHash,
    });
    const data = res.data || {};
    return {
      sessionCreated: !!(data.sessionId || data.session_id),
      userId: data.userId ?? data.user_id ?? data.user ?? null,
      sessionId: data.sessionId ?? data.session_id ?? null,
      saldo: data.saldo ?? data.balance ?? data.coins ?? 0,
      raw: data,
    };
  } catch (err) {
    return { sessionCreated: false, error: _errMsg(err) };
  }
}

/**
 * register(username, password)
 * - Registra conta (POST /api/register) se existir endpoint
 * - Retorna { success: boolean, userId?, raw? , error? }
 */
export async function register(username, password) {
  try {
    const client = apiClient();
    const res = await client.post("/api/register", { username, password });
    const data = res.data || {};
    return { success: true, userId: data.userId ?? data.user_id ?? null, raw: data };
  } catch (err) {
    return { success: false, error: _errMsg(err) };
  }
}

// ----------------- SALDO / USUÁRIO -----------------

/**
 * getBalance(sessionId)
 * - Retorna { success, balance, raw, error }
 */
export async function getBalance(sessionId) {
  if (!sessionId) return { success: false, error: "sessionId required" };
  try {
    const client = apiClient(sessionId);
    const res = await client.get("/api/me/balance");
    const d = res.data || {};
    return { success: true, balance: d.balance ?? d.coins ?? d.amount ?? 0, raw: d };
  } catch (err) {
    return { success: false, error: _errMsg(err) };
  }
}

/**
 * getUserBalanceById(sessionId, userId)
 * - Pega saldo de um usuário pelo ID (quando a API oferece rota)
 */
export async function getUserBalanceById(sessionId, userId) {
  if (!sessionId) return { success: false, error: "sessionId required" };
  if (!userId) return { success: false, error: "userId required" };
  try {
    const client = apiClient(sessionId);
    const res = await client.get(`/api/user/${userId}/balance`);
    const d = res.data || {};
    return { success: true, balance: d.balance ?? d.coins ?? d.amount ?? 0, raw: d };
  } catch (err) {
    return { success: false, error: _errMsg(err) };
  }
}

// ----------------- TRANSFERÊNCIAS -----------------

/**
 * transfer(sessionId, toId, amount, meta = {})
 * - Executa transferência da conta da sessão para toId
 * - Retorna { success, raw, error }
 */
export async function transfer(sessionId, toId, amount, meta = {}) {
  if (!sessionId) return { success: false, error: "sessionId required" };
  if (!toId) return { success: false, error: "toId required" };
  if (typeof amount !== "number" || !isFinite(amount) || amount <= 0) return { success: false, error: "amount invalid" };
  try {
    const client = apiClient(sessionId);
    const body = { toId, amount, ...meta };
    const res = await client.post("/api/transfer", body);
    return { success: true, raw: res.data };
  } catch (err) {
    return { success: false, error: _errMsg(err) };
  }
}

// ----------------- CLAIM / FOSSIL -----------------

/**
 * claim(sessionId)
 * - Faz o claim diário ou de cooldown; retorna { success, claimedAmount?, cooldownMs?, raw, error }
 */
export async function claim(sessionId) {
  if (!sessionId) return { success: false, error: "sessionId required" };
  try {
    const client = apiClient(sessionId);
    const res = await client.post("/api/claim");
    const d = res.data || {};
    return { success: true, claimed: d.claimed ?? d.amount ?? 0, raw: d };
  } catch (err) {
    // se for cooldown, a API costuma retornar 4xx e um campo de tempo
    const resp = err.response?.data;
    const cooldownMs = resp?.nextClaimInMs ?? resp?.cooldownRemainingMs ?? null;
    return { success: false, error: _errMsg(err), cooldownMs, raw: resp ?? null };
  }
}

// ----------------- CARD -----------------

export async function createCard(sessionId) {
  if (!sessionId) return { success: false, error: "sessionId required" };
  try {
    const client = apiClient(sessionId);
    const res = await client.post("/api/card");
    return { success: true, card: res.data, raw: res.data };
  } catch (err) {
    return { success: false, error: _errMsg(err) };
  }
}

export async function resetCard(sessionId) {
  if (!sessionId) return { success: false, error: "sessionId required" };
  try {
    const client = apiClient(sessionId);
    const res = await client.post("/api/card/reset");
    return { success: true, raw: res.data };
  } catch (err) {
    return { success: false, error: _errMsg(err) };
  }
}

// ----------------- BILLS -----------------

export async function billCreate(sessionId, fromId, toId, amount, time) {
  if (!sessionId) return { success: false, error: "sessionId required" };
  if (!fromId || !toId) return { success: false, error: "fromId and toId required" };
  try {
    const client = apiClient(sessionId);
    const res = await client.post("/api/bill/create", { fromId, toId, amount, time });
    return { success: true, bill: res.data, raw: res.data };
  } catch (err) {
    return { success: false, error: _errMsg(err) };
  }
}

export async function billList(sessionId, page = 1) {
  if (!sessionId) return { success: false, error: "sessionId required" };
  try {
    const client = apiClient(sessionId);
    const res = await client.post("/api/bill/list", { page });
    return { success: true, data: res.data, raw: res.data };
  } catch (err) {
    return { success: false, error: _errMsg(err) };
  }
}

export async function billPay(sessionId, billId) {
  if (!sessionId) return { success: false, error: "sessionId required" };
  if (!billId) return { success: false, error: "billId required" };
  try {
    const client = apiClient(sessionId);
    const res = await client.post("/api/bill/pay", { billId });
    return { success: true, raw: res.data };
  } catch (err) {
    return { success: false, error: _errMsg(err) };
  }
}

// ----------------- BACKUP -----------------

export async function backupCreate(sessionId) {
  if (!sessionId) return { success: false, error: "sessionId required" };
  try {
    const client = apiClient(sessionId);
    const res = await client.post("/api/backup/create");
    return { success: true, raw: res.data };
  } catch (err) {
    return { success: false, error: _errMsg(err) };
  }
}

export async function backupList(sessionId) {
  if (!sessionId) return { success: false, error: "sessionId required" };
  try {
    const client = apiClient(sessionId);
    const res = await client.post("/api/backup/list");
    return { success: true, backups: res.data?.backups ?? res.data?.codes ?? [], raw: res.data };
  } catch (err) {
    return { success: false, error: _errMsg(err) };
  }
}

export async function backupRestore(sessionId, code) {
  if (!sessionId) return { success: false, error: "sessionId required" };
  if (!code) return { success: false, error: "code required" };
  try {
    const client = apiClient(sessionId);
    const res = await client.post("/api/backup/restore", { backupId: code });
    return { success: true, raw: res.data };
  } catch (err) {
    return { success: false, error: _errMsg(err) };
  }
}

// ----------------- TRANSACTIONS / HISTORY -----------------

export async function getTransactions(sessionId, page = 1) {
  if (!sessionId) return { success: false, error: "sessionId required" };
  try {
    const client = apiClient(sessionId);
    const res = await client.get("/api/transactions", { params: { page } });
    return { success: true, transactions: res.data?.transactions ?? res.data?.history ?? [], raw: res.data };
  } catch (err) {
    return { success: false, error: _errMsg(err) };
  }
}

// ----------------- RANK / GLOBAL STATS -----------------

export async function getRank(sessionId) {
  if (!sessionId) return { success: false, error: "sessionId required" };
  try {
    const client = apiClient(sessionId);
    const res = await client.get("/api/rank");
    return { success: true, rank: res.data, raw: res.data };
  } catch (err) {
    return { success: false, error: _errMsg(err) };
  }
}

export async function getGlobalStats(sessionId) {
  if (!sessionId) return { success: false, error: "sessionId required" };
  try {
    const client = apiClient(sessionId);
    const resRank = await client.get("/api/rank");
    const resUsers = await client.get("/api/totalusers").catch(() => null);
    const resClaim = await client.get("/api/claim/status").catch(() => null);

    const rank = resRank?.data ?? null;
    const users = resUsers?.data ?? null;
    const claim = resClaim?.data ?? null;

    return { success: true, rank, users, claim, raw: { rank, users, claim } };
  } catch (err) {
    return { success: false, error: _errMsg(err) };
  }
}

// ----------------- UTIL: requestPath genérico -----------------

/**
 * requestPath(sessionId, method, path, body)
 * - wrapper genérico para chamadas arbitrárias (p.ex. rota nova)
 */
export async function requestPath(sessionId, method, path, body = {}) {
  try {
    const client = apiClient(sessionId);
    const m = method.toLowerCase();
    if (m === "get") {
      const res = await client.get(path, { params: body });
      return { success: true, raw: res.data };
    }
    if (m === "post") {
      const res = await client.post(path, body);
      return { success: true, raw: res.data };
    }
    if (m === "put") {
      const res = await client.put(path, body);
      return { success: true, raw: res.data };
    }
    if (m === "delete") {
      const res = await client.delete(path, { data: body });
      return { success: true, raw: res.data };
    }
    return { success: false, error: "Invalid method" };
  } catch (err) {
    return { success: false, error: _errMsg(err) };
  }
}

// ----------------- EXPORTS -----------------
export default {
  login,
  register,
  getBalance,
  getUserBalanceById,
  transfer,
  claim,
  createCard,
  resetCard,
  billCreate,
  billList,
  billPay,
  backupCreate,
  backupList,
  backupRestore,
  getTransactions,
  getRank,
  getGlobalStats,
  requestPath,
};
