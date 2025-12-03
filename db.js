// db.js (ESM)
import fs from "fs-extra";
import path from "path";
import YAML from "yaml";

const DATA_DIR = path.resolve("./data");

// 🔑 Padroniza qualquer JID para "só dígitos" (ex.: 5511999999999)
export function canonicalId(input) {
  if (!input) return "";
  const s = String(input);
  // tira domínio (@s.whatsapp.net, @lid, etc) e device suffix (:X)
  const beforeAt = s.split("@")[0];
  const bare = beforeAt.split(":")[0];
  // mantém só dígitos
  const digits = bare.replace(/\D/g, "");
  return digits || bare;
}

function filePathFromKey(key) {
  return path.join(DATA_DIR, `${key}.yml`);
}

function filePath(number) {
  return filePathFromKey(canonicalId(number));
}

// 📂 Carrega dados do usuário (com fallback para arquivos antigos)
export async function getUser(number) {
  const key = canonicalId(number);
  let file = filePathFromKey(key);

  if (fs.existsSync(file)) {
    const content = await fs.readFile(file, "utf8");
    try {
      return YAML.parse(content);
    } catch (err) {
      console.error("⚠️ Erro ao ler YAML de usuário:", err);
      return null;
    }
  }

  // fallback: arquivos antigos que ainda tenham @s.whatsapp.net ou @lid
  const raw = String(number);
  file = filePathFromKey(raw);
  if (fs.existsSync(file)) {
    const content = await fs.readFile(file, "utf8");
    try {
      const data = YAML.parse(content);
      // 🔄 migra para a chave nova
      try {
        await fs.writeFile(filePathFromKey(key), YAML.stringify(data), "utf8");
        await fs.unlink(file);
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

// 💾 Salva/atualiza dados do usuário
export async function setUser(number, data) {
  const key = canonicalId(number);
  const file = filePathFromKey(key);

  const userData = {
    number: key, // sempre no formato canônico
    login: data.login || null,
    userId: data.userId || null,
    sessionId: data.sessionId || null,
    card: data.card || null,
    loginTime: data.loginTime || Date.now(),
  };

  try {
    await fs.writeFile(file, YAML.stringify(userData), "utf8");
  } catch (err) {
    console.error("⚠️ Erro ao salvar YAML de usuário:", err);
  }
}

// 🗑️ Remove usuário (logout/reset)
export async function clearUser(number) {
  const key = canonicalId(number);
  const file = filePathFromKey(key);
  try {
    if (fs.existsSync(file)) {
      await fs.unlink(file);
      console.log(`🗑️ Usuário ${key} removido do banco local.`);
    }
  } catch (err) {
    console.error("⚠️ Erro ao remover YAML de usuário:", err);
  }
}

// ⏳ Verifica expiração de sessão (24h = 86400000 ms)
export async function isSessionExpired(user) {
  if (!user?.loginTime) return true;
  return Date.now() - user.loginTime > 86400000;
}
