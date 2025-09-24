const fs = require("fs-extra")
const path = require("path")
const YAML = require("yaml")

const DATA_DIR = path.resolve("./data")

function filePath(number) {
  return path.join(DATA_DIR, `${number}.yml`)
}

// Carrega dados do usuário
async function getUser(number) {
  const file = filePath(number)
  if (!fs.existsSync(file)) return null
  const content = await fs.readFile(file, "utf8")
  try {
    return YAML.parse(content)
  } catch (err) {
    console.error("⚠️ Erro ao ler YAML de usuário:", err)
    return null
  }
}

// Salva/atualiza dados do usuário
async function setUser(number, data) {
  const file = filePath(number)

  const userData = {
    number,
    login: data.login || null,
    userId: data.userId || null,
    sessionId: data.sessionId || null,
    card: data.card || null,
    loginTime: data.loginTime || Date.now() // salva timestamp de login
  }

  try {
    await fs.writeFile(file, YAML.stringify(userData), "utf8")
  } catch (err) {
    console.error("⚠️ Erro ao salvar YAML de usuário:", err)
  }
}

// Remove os dados do usuário (logout/reset)
async function clearUser(number) {
  const file = filePath(number)
  try {
    if (fs.existsSync(file)) {
      await fs.unlink(file)
      console.log(`🗑️ Usuário ${number} removido do banco local.`)
    }
  } catch (err) {
    console.error("⚠️ Erro ao remover YAML de usuário:", err)
  }
}

// Verifica se a sessão expirou (24h = 86400000 ms)
async function isSessionExpired(user) {
  if (!user?.loginTime) return true
  return Date.now() - user.loginTime > 86400000
}

module.exports = { getUser, setUser, clearUser, isSessionExpired }
