// logic.js (ESM) — camada de integração com a API Coin (atualizada para card flows)
import axios from "axios";

const COIN_API = process.env.COIN_API_URL || "http://coin.foxsrv.net:26450";
const DEFAULT_TIMEOUT = Number(process.env.COIN_API_TIMEOUT_MS || 15000);

function apiClient(sessionId = null) {
  const headers = {};
  if (sessionId) headers.Authorization = `Bearer ${sessionId}`;
  return axios.create({
    baseURL: COIN_API,
    headers,
    timeout: DEFAULT_TIMEOUT,
  });
}

function _errMsg(err) {
  if (!err) return "Erro desconhecido";
  if (err.response?.data) {
    const d = err.response.data;
    // tenta várias chaves comuns
    return d.error || d.message || JSON.stringify(d);
  }
  return err.message || String(err);
}

/* ---------------- AUTH / SESSÃO ---------------- */

export async function login(username, passwordOrHash) {
  try {
    const client = apiClient();
    const res = await client.post("/api/login", { username, password: passwordOrHash });
    const data = res.data || {};
    return {
      success: true,
      sessionCreated: !!(data.sessionId || data.session_id),
      userId: data.userId ?? data.user_id ?? data.user ?? null,
      sessionId: data.sessionId ?? data.session_id ?? null,
      saldo: data.saldo ?? data.balance ?? data.coins ?? 0,
      raw: data,
    };
  } catch (err) {
    return { success: false, error: _errMsg(err) };
  }
}

export async function register(username, password) {
  try {
    const client = apiClient();
    const res = await client.post("/api/register", { username, password });
    const d = res.data || {};
    return { success: true, userId: d.userId ?? d.user_id ?? null, raw: d };
  } catch (err) {
    return { success: false, error: _errMsg(err) };
  }
}

/* ---------------- SALDO / USUÁRIO ---------------- */

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

/* ---------------- TRANSFERÊNCIAS (session) ---------------- */

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

/* ---------------- CLAIM ---------------- */

export async function claim(sessionId) {
  if (!sessionId) return { success: false, error: "sessionId required" };
  try {
    const client = apiClient(sessionId);
    const res = await client.post("/api/claim");
    const d = res.data || {};
    return { success: true, claimed: d.claimed ?? d.amount ?? 0, raw: d };
  } catch (err) {
    const resp = err.response?.data;
    const cooldownMs = resp?.nextClaimInMs ?? resp?.cooldownRemainingMs ?? null;
    return { success: false, error: _errMsg(err), cooldownMs, raw: resp ?? null };
  }
}

/* ---------------- CARD (novas funções) ---------------- */

/**
 * cardPay(fromCard, toCard, amount)
 * - Rota /api/card/pay (card -> card)
 * - Retorna { success, raw, error }
 */
export async function cardPay(fromCard, toCard, amount) {
  if (!fromCard) return { success: false, error: "fromCard required" };
  if (!toCard) return { success: false, error: "toCard required" };
  if (typeof amount !== "number" || !isFinite(amount) || amount <= 0) return { success: false, error: "amount invalid" };
  try {
    const client = apiClient();
    const res = await client.post("/api/card/pay", { fromCard, toCard, amount });
    return { success: true, raw: res.data };
  } catch (err) {
    return { success: false, error: _errMsg(err), raw: err.response?.data ?? null };
  }
}

/**
 * cardInfo(cardCode)
 * - Rota /api/card/info
 * - Retorna { success, cardInfo, raw, error }
 */
export async function cardInfo(cardCode) {
  if (!cardCode) return { success: false, error: "cardCode required" };
  try {
    const client = apiClient();
    const res = await client.post("/api/card/info", { cardCode });
    return { success: true, cardInfo: res.data, raw: res.data };
  } catch (err) {
    return { success: false, error: _errMsg(err), raw: err.response?.data ?? null };
  }
}

/**
 * cardClaim(cardCode)
 * - Rota /api/card/claim
 * - Retorna { success, claimed, raw, error }
 */
export async function cardClaim(cardCode) {
  if (!cardCode) return { success: false, error: "cardCode required" };
  try {
    const client = apiClient();
    const res = await client.post("/api/card/claim", { cardCode });
    const d = res.data || {};
    return { success: true, claimed: d.claimed ?? d.amount ?? 0, raw: d };
  } catch (err) {
    return { success: false, error: _errMsg(err), raw: err.response?.data ?? null };
  }
}

/**
 * cardTransfer(fromCard, toUserId, amount)
 * - Caso a API ofereça uma rota para pagar por card para um userId (card -> id)
 * - Tenta /api/card/transfer ou fallback para /api/transfer com extra
 */
export async function cardTransfer(fromCard, toUserId, amount) {
  if (!fromCard) return { success: false, error: "fromCard required" };
  if (!toUserId) return { success: false, error: "toUserId required" };
  if (typeof amount !== "number" || !isFinite(amount) || amount <= 0) return { success: false, error: "amount invalid" };

  // tenta rota específica
  try {
    const client = apiClient();
    const res = await client.post("/api/card/transfer", { fromCard, toUserId, amount });
    return { success: true, raw: res.data };
  } catch (err) {
    // fallback: se API não existir, devolve erro claro
    return { success: false, error: _errMsg(err), raw: err.response?.data ?? null };
  }
}

/* ---------------- BILLS ---------------- */

export async function billCreate(sessionId, fromId, toId, amount, time = null) {
  if (!sessionId) return { success: false, error: "sessionId required" };
  if (!fromId || !toId) return { success: false, error: "fromId and toId required" };
  try {
    const client = apiClient(sessionId);
    const res = await client.post("/api/bill/create", { fromId, toId, amount, time });
    return { success: true, bill: res.data, raw: res.data };
  } catch (err) {
    return { success: false, error: _errMsg(err), raw: err.response?.data ?? null };
  }
}

export async function billList(sessionId, page = 1) {
  if (!sessionId) return { success: false, error: "sessionId required" };
  try {
    const client = apiClient(sessionId);
    const res = await client.post("/api/bill/list", { page });
    return { success: true, data: res.data, raw: res.data };
  } catch (err) {
    return { success: false, error: _errMsg(err), raw: err.response?.data ?? null };
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
    return { success: false, error: _errMsg(err), raw: err.response?.data ?? null };
  }
}

/* ---------------- TRANSAÇÕES / CHECK ---------------- */

export async function getTransaction(sessionId, txId) {
  if (!txId) return { success: false, error: "txId required" };
  try {
    const client = sessionId ? apiClient(sessionId) : apiClient();
    const res = await client.get(`/api/transaction/${txId}`).catch(() => null);
    if (res && res.data) return { success: true, tx: res.data, raw: res.data };
    // fallback try alternative path
    const alt = await client.get(`/api/transactions/${txId}`).catch(() => null);
    if (alt && alt.data) return { success: true, tx: alt.data, raw: alt.data };
    return { success: false, error: "not_found" };
  } catch (err) {
    return { success: false, error: _errMsg(err), raw: err.response?.data ?? null };
  }
}

/* ---------------- UTIL genérica ---------------- */

export async function requestPath(sessionId, method, path, body = {}) {
  try {
    const client = apiClient(sessionId);
    const m = String(method || "get").toLowerCase();
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
    return { success: false, error: "invalid_method" };
  } catch (err) {
    return { success: false, error: _errMsg(err), raw: err.response?.data ?? null };
  }
}

/* ---------------- EXPORTS ---------------- */

export default {
  login,
  register,
  getBalance,
  getUserBalanceById,
  transfer,
  claim,
  createCard: async (sessionId) => {
    if (!sessionId) return { success: false, error: "sessionId required" };
    try {
      const client = apiClient(sessionId);
      const res = await client.post("/api/card");
      return { success: true, raw: res.data };
    } catch (err) {
      return { success: false, error: _errMsg(err), raw: err.response?.data ?? null };
    }
  },
  resetCard: async (sessionId) => {
    if (!sessionId) return { success: false, error: "sessionId required" };
    try {
      const client = apiClient(sessionId);
      const res = await client.post("/api/card/reset");
      return { success: true, raw: res.data };
    } catch (err) {
      return { success: false, error: _errMsg(err), raw: err.response?.data ?? null };
    }
  },
  cardPay,
  cardInfo,
  cardClaim,
  cardTransfer,
  billCreate,
  billList,
  billPay,
  getTransaction,
  requestPath,
};
