const logic = require("../logic.js")
const crypto = require("crypto")

async function loginCommand(sock, from, args) {
  if (args.length < 2) {
    return sock.sendMessage(from, { text: "❌ Use: !login <user> <senha>" })
  }

  const [username, password] = args
  const passwordHash = crypto.createHash("sha256").update(password).digest("hex")

  try {
    const result = await logic.login(username, passwordHash, from) // from = número do user
    if (!result.sessionCreated) {
      return sock.sendMessage(from, { text: "❌ Login falhou" })
    }

    // salvar no .yml
    await userDB.setUser(from, {
      login: username,
      userId: result.userId,
      sessionId: result.sessionId
    })

    await sock.sendMessage(from, { text: `✅ Logado como ${username}, saldo: ${result.saldo}` })
  } catch (err) {
    console.error(err)
    await sock.sendMessage(from, { text: "⚠️ Erro no login" })
  }
}
