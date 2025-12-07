// commands/handler.js — versão completa com suporte a !video (720p MP4)
// Substitua seu arquivo atual por este.
// Usa: sock.sendMessage(..., { text, edit: statusMsgKey })

import axios from "axios";
// IMPORTS AJUSTADOS: subir um nível para achar db.js e logic.js na raiz do projeto
import * as userDB from "../db.js";
import * as logic from "../logic.js";

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import { spawn } from "child_process";

const API_URL = process.env.COIN_API_URL || "http://coin.foxsrv.net:26450"; // ajuste se necessário
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const QUEUE_FILE = path.join(DATA_DIR, "download-queue.json");

const CONFIG = {
  download_price: Number(process.env.DOWNLOAD_PRICE || 0.00000064),
  download_receiver_card: process.env.DOWNLOAD_RECEIVER_CARD || "1f6c293c3951",
  ytdlp_path: process.env.YTDLP_PATH || "yt-dlp",
  ffmpeg_path: process.env.FFMPEG_PATH || "ffmpeg",
  upload_limit_mb: Number(35),
  concurrent_downloads: Number(process.env.CONCURRENT_DOWNLOADS || 4),
  tmp_dir: process.env.TMP_DIR || path.join(os.tmpdir(), "coinbot-downloads"),
  queue_poll_ms: Number(process.env.QUEUE_POLL_MS || 2000),
  axios_timeout_ms: Number(process.env.API_TIMEOUT_MS || 20000),
  // throttle em ms para edições de status (ajuste se quiser mais rápido)
  status_update_throttle_ms: Number(process.env.STATUS_UPDATE_THROTTLE_MS || 700),
};

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CONFIG.tmp_dir)) fs.mkdirSync(CONFIG.tmp_dir, { recursive: true });

// ----------------- Helpers -----------------
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
function cryptoRandomId() {
  try {
    return (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 24);
  } catch (e) {
    return String(Date.now());
  }
}

// ----------------- Queue (simple JSON) - usado só pelo worker local -----------------
async function readQueue() {
  try {
    const raw = await fsp.readFile(QUEUE_FILE, "utf8");
    return JSON.parse(raw || "[]");
  } catch (e) {
    return [];
  }
}
async function writeQueue(q) {
  await fsp.writeFile(QUEUE_FILE, JSON.stringify(q || [], null, 2), "utf8");
}
async function enqueueJob(job) {
  const q = await readQueue();
  q.push(job);
  await writeQueue(q);
  return job;
}
async function dequeueJob() {
  const q = await readQueue();
  if (!q || q.length === 0) return null;
  const job = q.shift();
  await writeQueue(q);
  return job;
}

// ----------------- API wrappers (direto para endpoints corretos) -----------------

async function cardPay(fromCard, toCard, amount) {
  try {
    const res = await axios.post(`${API_URL}/api/card/pay`, { fromCard, toCard, amount }, { timeout: CONFIG.axios_timeout_ms });
    if (res?.data?.success || res.status === 200) {
      return { success: true, raw: res.data };
    }
    return { success: false, raw: res.data };
  } catch (err) {
    return { success: false, error: err?.response?.data?.error || err?.message || String(err), raw: err?.response?.data };
  }
}

async function cardInfo(cardCode) {
  try {
    const res = await axios.post(`${API_URL}/api/card/info`, { cardCode }, { timeout: CONFIG.axios_timeout_ms });
    if (res?.data?.success || res.status === 200) return { success: true, raw: res.data };
    return { success: false, raw: res.data };
  } catch (err) {
    return { success: false, error: err?.response?.data?.error || err?.message || String(err), raw: err?.response?.data };
  }
}

async function cardClaim(cardCode) {
  try {
    const res = await axios.post(`${API_URL}/api/card/claim`, { cardCode }, { timeout: CONFIG.axios_timeout_ms });
    if (res?.data?.success || res.status === 200) return { success: true, raw: res.data };
    return { success: false, raw: res.data };
  } catch (err) {
    return { success: false, error: err?.response?.data?.error || err?.message || String(err), raw: err?.response?.data };
  }
}

async function billCreateByCard(fromCard, toCard, amount, time = null) {
  try {
    const res = await axios.post(`${API_URL}/api/bill/create/card`, { fromCard, toCard, amount, time }, { timeout: CONFIG.axios_timeout_ms });
    if (res?.data) return { success: true, raw: res.data };
    return { success: false, raw: res.data };
  } catch (err) {
    return { success: false, error: err?.response?.data?.error || err?.message || String(err), raw: err?.response?.data };
  }
}

async function billPayByCard(cardCode, billId) {
  try {
    const res = await axios.post(`${API_URL}/api/bill/pay/card`, { cardCode, billId }, { timeout: CONFIG.axios_timeout_ms });
    if (res?.data && (res.data.success || res.status === 200)) return { success: true, raw: res.data };
    return { success: false, raw: res.data };
  } catch (err) {
    return { success: false, error: err?.response?.data?.error || err?.message || String(err), raw: err?.response?.data };
  }
}

async function refundToUser(userCard, botCard, amount) {
  try {
    const res = await cardPay(botCard, userCard, amount);
    return res;
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

// ----------------- Download worker -----------------
let workerRunning = false;
let activeCount = 0;
async function startDownloadWorker(sock) {
  if (workerRunning) return;
  workerRunning = true;

  async function loop() {
    try {
      if (activeCount >= CONFIG.concurrent_downloads) {
        await new Promise((r) => setTimeout(r, CONFIG.queue_poll_ms));
        return;
      }
      const job = await dequeueJob();
      if (!job) {
        await new Promise((r) => setTimeout(r, CONFIG.queue_poll_ms));
        return;
      }
      activeCount++;
      processDownloadJob(sock, job).catch(async (e) => {
        console.error("Erro processando job:", e);
        try { await sock.sendMessage(job.chatId, { text: `❌ Erro interno: ${String(e)}` }); } catch (_) {}
      }).finally(() => { activeCount--; });
    } catch (e) {
      console.error("Worker loop error:", e);
    } finally {
      setImmediate(loop);
    }
  }
  setImmediate(loop);
}

async function processDownloadJob(sock, job) {
  const { id, chatId, fromJid, card, url, chargedAmount } = job;
  const botCard = CONFIG.download_receiver_card;
  const tmpDir = path.join(CONFIG.tmp_dir, id);
  await fsp.mkdir(tmpDir, { recursive: true });

  // helpers para status (mesma lógica que você já tem)
  let statusMsgKey = null;
  let lastStatusText = "";
  let lastStatusTime = 0;
  async function updateStatus(text, force = false) {
    try {
      const now = Date.now();
      if (!force && text === lastStatusText && (now - lastStatusTime) < CONFIG.status_update_throttle_ms) return;
      if (!force && (now - lastStatusTime) < CONFIG.status_update_throttle_ms) return;
      lastStatusText = text;
      lastStatusTime = now;

      if (!statusMsgKey) {
        const sent = await sock.sendMessage(chatId, { text });
        statusMsgKey = sent?.key ?? null;
      } else {
        try {
          await sock.sendMessage(chatId, { text, edit: statusMsgKey });
        } catch (e) {
          console.warn("Falha ao editar status, fallback:", e?.message || e);
          try { await sock.sendMessage(chatId, { delete: statusMsgKey }); } catch (_) {}
          const sent = await sock.sendMessage(chatId, { text });
          statusMsgKey = sent?.key ?? null;
        }
      }
    } catch (e) {
      console.error("updateStatus error:", e?.message || e);
    }
  }

  async function handleFailureAndRefund(reason) {
    console.error("Job failed:", id, reason);
    try { await updateStatus(`❌ Falha (${reason}) — efetuando reembolso...`, true); } catch (_) {}
    try {
      const r = await refundToUser(card, botCard, chargedAmount);
      if (r?.success) {
        await updateStatus(`↩️ Reembolso de ${fmt(chargedAmount)} efetuado para o seu card.`, true);
      } else {
        await updateStatus(`⚠️ Falha ao reembolsar automaticamente: ${r?.error || JSON.stringify(r?.raw)}`, true);
      }
    } catch (e) {
      await updateStatus(`⚠️ Erro no reembolso: ${String(e)}`, true);
    }
    try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }

  // função utilitária para sanitizar nomes de arquivo
  function sanitizeFilename(name) {
    if (!name) return "file";
    // remove control chars, barras, dois-pontos, etc. limita tamanho pra 120 chars
    const cleaned = String(name)
      .replace(/[\x00-\x1f\x80-\x9f]/g, "")
      .replace(/[\/\\?%*:|"<>]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    return cleaned || "file";
  }

  // decide comportamento: video ou audio
  const isVideo = job.type === "video";

  // 1) Baixar com yt-dlp pedindo título no template
  // usamos %(title)s para que o arquivo salve com o título do vídeo
  const outTemplate = path.join(tmpDir, "%(title)s.%(ext)s");
  const ytdlpArgs = isVideo
    ? ["-f", "bestvideo[height<=720]+bestaudio/best[height<=720]", "--merge-output-format", "mp4", "--newline", "--no-playlist", "-o", outTemplate, url]
    : ["-f", "bestaudio", "--newline", "--no-playlist", "-o", outTemplate, url];

  await updateStatus(`⬇️ Iniciando download...`);
  try {
    await new Promise((resolve, reject) => {
      const ytdlp = spawn(CONFIG.ytdlp_path, ytdlpArgs, { stdio: ["ignore", "pipe", "pipe"] });

      ytdlp.stdout.on("data", (chunk) => {
        const s = String(chunk.toString()).trim();
        const m = s.match(/(\d{1,3}\.\d)%/);
        if (m) {
          const perc = Math.min(100, parseFloat(m[1]));
          const barLen = 20;
          const filled = Math.round((perc / 100) * barLen);
          const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
          updateStatus(`⬇️ Baixando: [${bar}] ${perc.toFixed(1)}%\n🔗 ${url}`);
        } else {
          if (s.length < 200) updateStatus(`⬇️ ${s}`);
        }
      });

      ytdlp.stderr.on("data", ()=>{ /* ignora stderr aqui */ });

      ytdlp.on("error", (err) => reject(err));
      ytdlp.on("close", (code) => {
        if (code === 0) return resolve();
        return reject(new Error("yt-dlp exit code " + code));
      });
    });
  } catch (e) {
    await handleFailureAndRefund(`Erro no download: ${e.message || e}`);
    return;
  }

  // localizar arquivo baixado (deve possuir título no nome)
  let downloadedFiles = await fsp.readdir(tmpDir).catch(()=>[]);
  downloadedFiles = downloadedFiles.filter((f)=>!f.endsWith(".part") && !f.endsWith(".tmp"));
  if (!downloadedFiles || downloadedFiles.length === 0) {
    await handleFailureAndRefund("Arquivo não encontrado após yt-dlp.");
    return;
  }

  // pega primeiro arquivo válido
  const downloadedFile = path.join(tmpDir, downloadedFiles[0]);
  const baseName = path.basename(downloadedFile);
  const titleRaw = baseName.replace(/\.[^/.]+$/, ""); // remove extensão -> fica o título
  const titleSan = sanitizeFilename(titleRaw);

  // Se for vídeo: NÃO converter — checa tamanho e envia como .mp4
  if (isVideo) {
    // assegura extensão mp4 (yt-dlp com merge-output-format mp4 deve gerar mp4)
    const outPath = downloadedFile;
    try {
      const stat = await fsp.stat(outPath);
      const sizeMb = stat.size / (1024*1024);
      if (sizeMb > CONFIG.upload_limit_mb) {
        await handleFailureAndRefund(`Arquivo ${sizeMb.toFixed(2)}MB excede limite de ${CONFIG.upload_limit_mb}MB.`);
        return;
      }
    } catch (e) {
      await handleFailureAndRefund(`Erro ao verificar arquivo final: ${e.message}`);
      return;
    }

    // enviar como documento (pra evitar compressão automática)
    try {
      await updateStatus("📤 Enviando vídeo...");
      const fileBuffer = await fsp.readFile(outPath);
      await sock.sendMessage(chatId, {
        document: fileBuffer,
        fileName: `${titleSan}.mp4`,
        mimetype: "video/mp4",
      });
      await updateStatus(`✅ Enviado: ${titleSan}.mp4`, true);
      await fsp.rm(tmpDir, { recursive: true, force: true });
      return;
    } catch (e) {
      console.error("Erro ao enviar vídeo:", e);
      await handleFailureAndRefund(`Erro ao enviar arquivo: ${String(e)}`);
      return;
    }
  }

  // ---------- Caso padrão (Áudio) - mantém sua lógica atual de conversão para MP3 ----------
  const outMp3 = path.join(tmpDir, `${titleSan}.mp3`);

  // 2) Converter para mp3 (mostrando progresso)
  await updateStatus(`🔁 Iniciando conversão para MP3: ${titleSan} ...`);
  try {
    await new Promise((resolve, reject) => {
      const args = ["-i", downloadedFile, "-vn", "-ab", "192k", "-ar", "44100", "-y", outMp3];
      const ff = spawn(CONFIG.ffmpeg_path, args, { stdio: ["ignore", "pipe", "pipe"] });

      let durationSec = null;
      let lastReported = 0;

      ff.stderr.on("data", (chunk) => {
        const s = String(chunk.toString());
        if (!durationSec) {
          const dm = s.match(/Duration:\s(\d+):(\d+):(\d+\.\d+)/);
          if (dm) {
            const hh = Number(dm[1]), mm = Number(dm[2]), ss = Number(dm[3]);
            durationSec = hh*3600 + mm*60 + ss;
          }
        }
        const tm = s.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (tm && durationSec) {
          const hh = Number(tm[1]), mm = Number(tm[2]), ss = Number(tm[3]);
          const tSec = hh*3600 + mm*60 + ss;
          const perc = Math.min(100, (tSec / durationSec) * 100);
          const barLen = 20;
          const filled = Math.round((perc / 100) * barLen);
          const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
          const now = Date.now();
          if ((perc - lastReported) >= 0.9 || (now - lastStatusTime) >= CONFIG.status_update_throttle_ms) {
            lastReported = perc;
            updateStatus(`🔁 Convertendo: [${bar}] ${perc.toFixed(1)}% — ${titleSan}`);
          }
        } else {
          const line = s.split("\n").find(Boolean);
          if (line && line.length < 200) updateStatus(`🔁 ${line}`);
        }
      });

      ff.on("error", (err) => reject(err));
      ff.on("close", (code) => {
        if (code === 0) return resolve();
        return reject(new Error("ffmpeg exit code " + code));
      });
    });
  } catch (e) {
    await handleFailureAndRefund(`Erro na conversão: ${e.message || e}`);
    return;
  }

  // 3) checar tamanho final
  try {
    const stat = await fsp.stat(outMp3);
    const sizeMb = stat.size / (1024*1024);
    if (sizeMb > CONFIG.upload_limit_mb) {
      await handleFailureAndRefund(`Arquivo ${sizeMb.toFixed(2)}MB excede limite de ${CONFIG.upload_limit_mb}MB.`);
      return;
    }
  } catch (e) {
    await handleFailureAndRefund(`Erro ao verificar arquivo final: ${e.message}`);
    return;
  }

  // 4) enviar usando o título como nome do arquivo
  try {
    await updateStatus("📤 Enviando MP3...");
    const fileBuffer = await fsp.readFile(outMp3);
    // envia com o nome do vídeo (sanitizado)
    await sock.sendMessage(chatId, {
      document: fileBuffer,
      fileName: `${titleSan}.mp3`,
      mimetype: "audio/mpeg",
    });
    await updateStatus(`✅ Enviado: ${titleSan}.mp3`, true);
    await fsp.rm(tmpDir, { recursive: true, force: true });
  } catch (e) {
    console.error("Erro ao enviar MP3:", e);
    await handleFailureAndRefund(`Erro ao enviar arquivo: ${String(e)}`);
    return;
  }
}


// ----------------- Executor de comandos (CARD-only) -----------------
async function ensureCardExists(sock, sender, chatId) {
  const local = await (userDB.getUserByAnyJid ? userDB.getUserByAnyJid(sender) : userDB.getUser(sender));
  if (!local || !local.card) {
    await sock.sendMessage(chatId, { text: "🔐 Você não tem um *card* salvo. Use `!card <cardCode>` para registrar seu card." });
    return null;
  }
  return local;
}

export async function execCommand(sock, sender, cmd, args = [], chatId, user = null, rawSender = null) {
  try {
    switch ((cmd || "").toLowerCase()) {

      // ------------------- CARD -------------------
      case "card": {
        const local = await (userDB.getUserByAnyJid ? userDB.getUserByAnyJid(sender) : userDB.getUser(sender)) || {};

        if (args[0]) {
          const newCard = args[0].trim();
          const prev = local || {};
          prev.card = newCard;
          await userDB.setUser(sender, prev);
          return sock.sendMessage(chatId, { text: `✅ Card salvo: \`${newCard}\`. Agora comandos que usam card vão operar com este card.` });
        }

        if (local?.card) {
          try {
            const info = await cardInfo(local.card);
            if (info?.success && info.raw) {
              const bal = (info.raw && (info.raw.coins ?? info.raw.balance ?? info.raw.saldo)) ?? "??";
              return sock.sendMessage(chatId, { text: `💳 Card salvo: \`${local.card}\`\nSaldo: ${fmt(bal)}` });
            }
          } catch (e) { /* ignore */ }
          return sock.sendMessage(chatId, { text: `💳 Card salvo: \`${local.card}\`\n(Informações da API indisponíveis no momento)` });
        }

        return sock.sendMessage(chatId, { text: "💳 Você não tem card salvo. Use `!card <cardCode>` para registrar." });
      }

      // ------------------- PAY -------------------
      case "pay": {
        if (args.length < 2) return sock.sendMessage(chatId, { text: "❌ Use: `!pay <toCard|@usuario> <valor>` (todos via card)." });

        const uPay = await ensureCardExists(sock, sender, chatId);
        if (!uPay) return;

        let toId = args[0];
        const amount = Number(args[1]);
        if (!isFinite(amount) || amount <= 0) return sock.sendMessage(chatId, { text: "❌ Valor inválido." });

        if (toId.startsWith("@")) {
          const mentionJid = toId.replace("@", "") + "@s.whatsapp.net";
          const targetUser = await (userDB.getUserByAnyJid ? userDB.getUserByAnyJid(mentionJid) : userDB.getUser(mentionJid));
          if (!targetUser || !targetUser.card) {
            return sock.sendMessage(chatId, { text: "❌ Este usuário não registrou um card. Peça para ele usar `!card <cardCode>`." });
          }
          await sock.sendMessage(chatId, { text: `🔁 Tentando pagar ${fmt(amount)} do seu card para o card do usuário...` });
          const payRes = await cardPay(uPay.card, targetUser.card, amount);
          if (!payRes?.success) {
            const errMsg = payRes?.error || JSON.stringify(payRes?.raw) || "Pagamento falhou";
            return sock.sendMessage(chatId, { text: `❌ Pagamento falhou: ${errMsg}` });
          }
          return sock.sendMessage(chatId, { text: `✅ Pagamento realizado: ${fmt(amount)} (card -> card).` });
        }

        if (/^[0-9a-fA-F]+$/.test(toId)) {
          await sock.sendMessage(chatId, { text: `🔁 Tentando pagar ${fmt(amount)} do seu card para ${toId}...` });
          const r = await cardPay(uPay.card, toId, amount);
          if (!r?.success) {
            const errMsg = r?.error || JSON.stringify(r?.raw) || "Pagamento falhou";
            return sock.sendMessage(chatId, { text: `❌ Pagamento falhou: ${errMsg}` });
          }
          return sock.sendMessage(chatId, { text: `✅ Pagamento realizado: ${fmt(amount)} (card -> ${toId}).` });
        }

        return sock.sendMessage(chatId, { text: "❌ Destino inválido. Em modo *card-only* você deve usar `@usuario` (o destinatário precisa ter card salvo) ou passar o código do card (hex)." });
      }

      // ------------------- BILL CREATE -------------------
      case "bill": {
        if (args.length < 2) return sock.sendMessage(chatId, { text: "❌ Use: `!bill <toCard|@usuario> <valor> [tempo]` (criar boleto via card)." });

        const local = await ensureCardExists(sock, sender, chatId);
        if (!local) return;

        const toArg = args[0];
        const amount = Number(args[1]);
        const time = args[2] || null;
        if (!isFinite(amount) || amount <= 0) return sock.sendMessage(chatId, { text: "❌ Valor inválido." });

        let toCard = null;
        if (toArg.startsWith("@")) {
          const mentionJid = toArg.replace("@", "") + "@s.whatsapp.net";
          const targetUser = await (userDB.getUserByAnyJid ? userDB.getUserByAnyJid(mentionJid) : userDB.getUser(mentionJid));
          if (!targetUser || !targetUser.card) {
            return sock.sendMessage(chatId, { text: "❌ Destinatário não registrou card." });
          }
          toCard = targetUser.card;
        } else if (/^[0-9a-fA-F]+$/.test(toArg)) {
          toCard = toArg;
        } else {
          return sock.sendMessage(chatId, { text: "❌ Destino inválido. Use @usuario (com card) ou código do card (hex)." });
        }

        try {
          const res = await billCreateByCard(local.card, toCard, amount, time);
          if (res?.success || (res?.raw && res.raw.success)) {
            const body = res.raw ?? res;
            return sock.sendMessage(chatId, { text: `✅ Boleto criado com sucesso.\n${JSON.stringify(body).slice(0,600)}` });
          } else {
            const err = res?.error || JSON.stringify(res?.raw) || "Erro desconhecido";
            return sock.sendMessage(chatId, { text: `⚠️ Resposta da API: ${err}` });
          }
        } catch (err) {
          const msg = err?.message || String(err);
          return sock.sendMessage(chatId, { text: `❌ Erro criando bill via card: ${msg}` });
        }
      }

      // ------------------- PAYBILL -------------------
      case "paybill": {
        if (args.length < 1) return sock.sendMessage(chatId, { text: "❌ Use: `!paybill <billId>`" });
        const billId = args[0];
        const local = await ensureCardExists(sock, sender, chatId);
        if (!local) return;

        try {
          const res = await billPayByCard(local.card, billId);
          if (res?.success || (res?.raw && res.raw.success)) {
            return sock.sendMessage(chatId, { text: `✅ Boleto ${billId} pago com sucesso.` });
          } else {
            const err = res?.error || JSON.stringify(res?.raw) || "Erro desconhecido";
            return sock.sendMessage(chatId, { text: `⚠️ Resposta da API: ${err}` });
          }
        } catch (err) {
          const msg = err?.message || String(err);
          return sock.sendMessage(chatId, { text: `❌ Erro ao pagar bill: ${msg}` });
        }
      }

      // ------------------- CLAIM -------------------
      case "claim": {
        const local = await ensureCardExists(sock, sender, chatId);
        if (!local) return;
        try {
          const res = await cardClaim(local.card);
          if (res?.success || (res?.raw && res.raw.success)) {
            const claimed = (res?.raw && res.raw.claimed) ?? undefined;
            return sock.sendMessage(chatId, { text: `✅ Claim bem sucedido${claimed ? `: ${String(claimed)}` : "."}` });
          } else {
            const err = res?.error || (res?.raw && (res.raw.error || JSON.stringify(res.raw))) || "Erro desconhecido";
            if (res?.raw?.error === "COOLDOWN_ACTIVE" || err === "COOLDOWN_ACTIVE") {
              const nextMs = res?.raw?.nextClaimInMs ?? null;
              const extra = nextMs ? `\n⏱️ Próximo claim em: ${msToHuman(Number(nextMs))}` : "";
              return sock.sendMessage(chatId, { text: `⏳ Você está em cooldown. ${extra}` });
            }
            return sock.sendMessage(chatId, { text: `❌ Erro no claim: ${err}` });
          }
        } catch (err) {
          const msg = err?.message || String(err);
          return sock.sendMessage(chatId, { text: `❌ Erro no claim: ${msg}` });
        }
      }

      // ------------------- BALANCE -------------------
      case "balance":
      case "bal":
      case "saldo": {
        const local = await ensureCardExists(sock, sender, chatId);
        if (!local) return;
        try {
          const info = await cardInfo(local.card);
          if (info?.success && info.raw) {
            const bal = (info.raw && (info.raw.coins ?? info.raw.balance ?? info.raw.saldo)) ?? "??";
            return sock.sendMessage(chatId, { text: `💳 Card: \`${local.card}\`\nSaldo: ${fmt(bal)}` });
          }
          return sock.sendMessage(chatId, { text: `💳 Card: \`${local.card}\`\n(Informação indisponível)` });
        } catch (e) {
          return sock.sendMessage(chatId, { text: `⚠️ Erro ao consultar card: ${String(e)}` });
        }
      }

      // ------------------- DOWNLOAD (Áudio) -------------------
      case "download": {
        if (args.length < 1) return sock.sendMessage(chatId, { text: "❌ Use: `!download <url>`" });
        const url = args[0];
        const local = await ensureCardExists(sock, sender, chatId);
        if (!local) return;

        const price = CONFIG.download_price;
        try {
          const charge = await cardPay(local.card, CONFIG.download_receiver_card, price);
          if (!charge?.success) {
            return sock.sendMessage(chatId, { text: `❌ Falha ao cobrar ${fmt(price)} do seu card: ${charge?.error || JSON.stringify(charge?.raw)}` });
          }
        } catch (e) {
          return sock.sendMessage(chatId, { text: `❌ Erro ao cobrar do seu card: ${String(e)}` });
        }

        const job = {
          id: cryptoRandomId(),
          chatId,
          fromJid: sender,
          card: local.card,
          url,
          chargedAmount: price
        };
        await enqueueJob(job);
        startDownloadWorker(sock);
        return sock.sendMessage(chatId, { text: `⏱️ Download enfileirado. Cobrança de ${fmt(price)} efetuada.` });
      }

      // ------------------- VIDEO (720p MP4 sem conversão) -------------------
      case "video": {
        if (args.length < 1) return sock.sendMessage(chatId, { text: "❌ Use: `!video <url>`" });
        const url = args[0];
        const local = await ensureCardExists(sock, sender, chatId);
        if (!local) return;

        // mesmo preço do áudio/download
        const price = CONFIG.download_price;
        try {
          const charge = await cardPay(local.card, CONFIG.download_receiver_card, price);
          if (!charge?.success) {
            return sock.sendMessage(chatId, { text: `❌ Falha ao cobrar ${fmt(price)} do seu card: ${charge?.error || JSON.stringify(charge?.raw)}` });
          }
        } catch (e) {
          return sock.sendMessage(chatId, { text: `❌ Erro ao cobrar do seu card: ${String(e)}` });
        }

        const job = {
          id: cryptoRandomId(),
          chatId,
          fromJid: sender,
          card: local.card,
          url,
          chargedAmount: price,
          type: "video" // sinaliza para o worker usar fluxo de vídeo (720p MP4)
        };
        await enqueueJob(job);
        startDownloadWorker(sock);
        return sock.sendMessage(chatId, { text: `⏱️ Download de vídeo enfileirado. Cobrança de ${fmt(price)} efetuada.` });
      }

      // ------------------- DEFAULT -------------------
      default:
        return sock.sendMessage(chatId, { text: "❓ Comando desconhecido." });
    }
  } catch (e) {
    console.error("execCommand error:", e && e.stack ? e.stack : e);
    try { await sock.sendMessage(chatId, { text: `⚠️ Erro interno: ${String(e)}` }); } catch (_) {}
  }
}

export default {
  execCommand,
};
