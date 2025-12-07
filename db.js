// db.js (ESM) — versão atualizada e corrigida
import fs from "fs-extra";
import path from "path";
import YAML from "yaml";

const DATA_DIR = path.resolve("./data");
const JID_MAP_FILE = path.join(DATA_DIR, "jid_map.json");

// garante diretórios
fs.mkdirpSync(DATA_DIR);

// 🔑 Padroniza qualquer JID para "só dígitos" (ex.: 5511999999999)
export function canonicalId(input) {
  if (!input) return "";
  const s = String(input).trim();
  // se já for só dígitos, retorna
  const justDigits = s.replace(/\D/g, "");
  if (justDigits.length > 6) return justDigits; // assume número
  // tira domínio (@...), device suffix (:X) e mantém dígitos
  const beforeAt = s.split("@")[0];
  const bare = beforeAt.split(":")[0];
  const digits = bare.replace(/\D/g, "");
  return digits || bare;
}

function filePathFromKey(key) {
  return path.join(DATA_DIR, `${key}.yml`);
}
function filePath(number) {
  return filePathFromKey(canonicalId(number));
}

/* ---------------- jid_map helpers ---------------- */
async function _ensureJidMap() {
  try {
    if (!await fs.pathExists(JID_MAP_FILE)) {
      await fs.writeJson(JID_MAP_FILE, {}, { spaces: 2 });
      return {};
    }
    const map = await fs.readJson(JID_MAP_FILE).catch(() => ({}));
    return map || {};
  } catch (e) {
    console.error("Erro ao carregar jid_map:", e);
    return {};
  }
}

async function _saveJidMap(map) {
  try {
    await fs.writeJson(JID_MAP_FILE, map, { spaces: 2 });
  } catch (e) {
    console.error("Erro ao salvar jid_map:", e);
  }
}

/**
 * Map a JID variant to a canonical user key.
 * canonicalNumber: already canonical (digits) or any user identifier
 * jidVariant: original JID string seen (will be persisted)
 */
export async function mapJidForUser(canonicalNumber, jidVariant) {
  try {
    const key = canonicalId(canonicalNumber);
    const map = await _ensureJidMap();
    map[String(jidVariant)] = key;
    await _saveJidMap(map);
    return true;
  } catch (e) {
    console.error("mapJidForUser error:", e);
    return false;
  }
}

/**
 * Get a canonical user key for a given JID variant, if mapped.
 * Returns the canonical key (digits) or null.
 */
export async function getMappedCanonicalForJid(jidVariant) {
  try {
    const map = await _ensureJidMap();
    return map[String(jidVariant)] || null;
  } catch (e) {
    console.error("getMappedCanonicalForJid error:", e);
    return null;
  }
}

/* ---------------- User file operations ---------------- */

// 📂 Carrega dados do usuário (com fallback para arquivos antigos)
export async function getUser(number) {
  const key = canonicalId(number);
  const file = filePathFromKey(key);

  if (await fs.pathExists(file)) {
    try {
      const content = await fs.readFile(file, "utf8");
      return YAML.parse(content) || null;
    } catch (err) {
      console.error("⚠️ Erro ao ler YAML de usuário:", err);
      return null;
    }
  }

  // fallback: tente variações (ex.: número@..., numero:1@..., etc)
  // verifica map de JIDs
  try {
    const mapped = await getMappedCanonicalForJid(String(number));
    if (mapped) {
      const mappedFile = filePathFromKey(mapped);
      if (await fs.pathExists(mappedFile)) {
        const content = await fs.readFile(mappedFile, "utf8");
        return YAML.parse(content) || null;
      }
    }
  } catch (e) {
    // ignore
  }

  // fallback: arquivos antigos que ainda tenham @s.whatsapp.net ou @lid
  const raw = String(number);
  const legacyFile = filePathFromKey(raw);
  if (await fs.pathExists(legacyFile)) {
    try {
      const content = await fs.readFile(legacyFile, "utf8");
      const data = YAML.parse(content);
      // 🔄 migra para a chave nova
      try {
        await fs.writeFile(filePathFromKey(key), YAML.stringify(data), "utf8");
        await fs.unlink(legacyFile).catch(()=>{});
        console.log(`🔄 Migrado ${raw} -> ${key}`);
      } catch (e) {
        console.warn("⚠️ Falha ao migrar usuário para formato canônico:", e);
      }
      return data;
    } catch (err) {
      console.error("⚠️ Erro ao ler YAML (fallback) de usuário:", err);
      return null;
    }
  }

  return null;
}

/**
 * Busca um usuário por qualquer variante de JID:
 * - primeiro tenta canonicalId(jidLike)
 * - depois tenta lata/jid_map.json
 */
export async function getUserByAnyJid(jidLike) {
  if (!jidLike) return null;
  const direct = await getUser(jidLike);
  if (direct) return direct;
  const mapped = await getMappedCanonicalForJid(String(jidLike));
  if (mapped) {
    const u = await getUser(mapped);
    if (u) return u;
  }
  // try also by plain canonical digits
  const digits = canonicalId(jidLike);
  if (digits) {
    const u2 = await getUser(digits);
    if (u2) return u2;
  }
  return null;
}

// 💾 Salva/atualiza dados do usuário
export async function setUser(number, data = {}) {
  const key = canonicalId(number);
  const file = filePathFromKey(key);

  // Carrega existente pra mesclar campos (não sobrescrever campos extras)
  // CORREÇÃO: inicializar existing como objeto vazio para evitar erros ao acessar propriedades
  let existing = {};
  if (await fs.pathExists(file)) {
    try {
      existing = YAML.parse(await fs.readFile(file, "utf8")) || {};
    } catch (e) { existing = {}; }
  }

  const merged = {
    // campos padrão
    number: key,
    login: data.login ?? existing.login ?? null,
    userId: data.userId ?? existing.userId ?? null,
    sessionId: data.sessionId ?? existing.sessionId ?? null,
    card: data.card ?? existing.card ?? null,
    loginTime: data.loginTime ?? existing.loginTime ?? Date.now(),
    // meta: manter último jid variante se fornecido (útil ao logar)
    _lastJidVariant: data._lastJidVariant ?? existing._lastJidVariant ?? null,
    // preserva quaisquer campos extras fornecidos (ex.: earned_amount)
    ...existing,
    ...data,
  };

  try {
    // sobrescreve com merged (garantindo campos padrão atualizados)
    await fs.writeFile(file, YAML.stringify(merged), "utf8");
    // se foi passada uma variante de JID (ex.: rawSender), mapeia para o canonical
    if (data._lastJidVariant) {
      try { await mapJidForUser(key, data._lastJidVariant); } catch (e) { /* ignore */ }
    }
  } catch (err) {
    console.error("⚠️ Erro ao salvar YAML de usuário:", err);
    throw err;
  }
}

// 🗑️ Remove usuário (logout/reset)
export async function clearUser(number) {
  const key = canonicalId(number);
  const file = filePathFromKey(key);
  try {
    if (await fs.pathExists(file)) {
      await fs.unlink(file);
      console.log(`🗑️ Usuário ${key} removido do banco local.`);
    }
    // também remove entradas no jid_map que apontem para esse key
    try {
      const map = await _ensureJidMap();
      let changed = false;
      for (const k of Object.keys(map)) {
        if (map[k] === key) {
          delete map[k];
          changed = true;
        }
      }
      if (changed) await _saveJidMap(map);
    } catch (e) {
      // ignore
    }
  } catch (err) {
    console.error("⚠️ Erro ao remover YAML de usuário:", err);
    throw err;
  }
}

// ⏳ Verifica expiração de sessão (24h = 86400000 ms)
export async function isSessionExpired(user) {
  if (!user) return true;
  if (!user?.loginTime) return true;
  // opcional: se houver campo sessionTTL em ms no usuário, use ele (flex)
  const ttl = user.sessionTTL ?? 86400000;
  return Date.now() - user.loginTime > ttl;
}

/* ---------------- Extra utilities ---------------- */

// retorna lista com todos os usuários (útil para debug/inspeção)
export async function getAllUsers() {
  try {
    const files = await fs.readdir(DATA_DIR);
    const users = [];
    for (const f of files) {
      if (!f.endsWith(".yml")) continue;
      try {
        const raw = await fs.readFile(path.join(DATA_DIR, f), "utf8");
        const obj = YAML.parse(raw);
        users.push(obj);
      } catch (e) { /* ignore */ }
    }
    return users;
  } catch (e) {
    return [];
  }
}

export default {
  canonicalId,
  getUser,
  getUserByAnyJid,
  setUser,
  clearUser,
  isSessionExpired,
  mapJidForUser,
  getAllUsers,
};
