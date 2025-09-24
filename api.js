import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys"
import fs from "fs-extra"
import path from "path"
import YAML from "yaml"
import { execCommand } from "./commands/handler.js"

const DATA_DIR = path.resolve("./data")

async function startBot() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR)

  const { state, saveCreds } = await useMultiFileAuthState("auth_info")

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true
  })

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message) return

    const from = msg.key.remoteJid
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text
    if (!text) return

    console.log("📩 Mensagem recebida:", from, text)

    // Prefixo por menção: ex.: "@bot pay ..."
    // Aqui simplificado: qualquer msg que começar com "!" ou "coin"
    if (text.startsWith("!")) {
      const args = text.slice(1).trim().split(/\s+/)
      const cmd = args.shift().toLowerCase()

      await execCommand(sock, from, cmd, args)
    }
  })

  sock.ev.on("creds.update", saveCreds)
}

startBot()
