// ── Telegram bot ─────────────────────────────────────────────────
// Sends notifications to one chat (TELEGRAM_CHAT_ID) and, when
// TELEGRAM_COMMANDS=on, takes commands from that same chat by long polling.
// Messages from any other chat are ignored.
//
// Telegram hands a bot's incoming messages to a single listener, so command
// listening needs a bot no other program reads updates from.

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT = String(process.env.TELEGRAM_CHAT_ID || '');

class TelegramError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

async function api(method, params = {}, timeoutMs = 15000) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new TelegramError(data.description || `HTTP ${res.status}`, data.error_code || res.status);
  return data.result;
}

async function sendMessage(text) {
  if (!TOKEN || !CHAT) return false;
  try {
    // Telegram's limit is 4096 characters per message.
    for (let i = 0; i < text.length; i += 4000) {
      await api('sendMessage', { chat_id: CHAT, text: text.slice(i, i + 4000), disable_web_page_preview: true });
    }
    return true;
  } catch (e) {
    console.error('[telegram] send failed:', e.message);
    return false;
  }
}

// Bots may upload files up to 50 MB.
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

async function sendDocument(filePath, caption = '') {
  if (!TOKEN || !CHAT) return false;
  const form = new FormData();
  form.set('chat_id', CHAT);
  if (caption) form.set('caption', caption.slice(0, 1024));
  form.set('document', await fs.openAsBlob(filePath), path.basename(filePath));
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, {
    method: 'POST', body: form, signal: AbortSignal.timeout(10 * 60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new TelegramError(data.description || `HTTP ${res.status}`, data.error_code || res.status);
  return true;
}

// commands: { name: { help, run(args) -> reply text } }. Runs until the
// process exits. Commands older than 2 minutes (sent while the server was
// down) are dropped rather than run late.
function startCommands(commands) {
  if (!TOKEN || !CHAT) return false;
  const menu = Object.entries(commands).map(([command, c]) => ({ command, description: c.help }));
  // Only for this chat, so a bot shared with other programs keeps its menu.
  api('setMyCommands', { commands: menu, scope: { type: 'chat', chat_id: CHAT } })
    .catch(e => console.error('[telegram] setMyCommands failed:', e.message));

  (async () => {
    let offset = 0, conflictLogged = false;
    for (;;) {
      try {
        const updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] }, 65000);
        conflictLogged = false;
        for (const u of updates) {
          offset = u.update_id + 1;
          const m = u.message;
          if (!m || !m.text || String(m.chat.id) !== CHAT) continue;
          if (Date.now() / 1000 - m.date > 120) continue;
          const [first, ...args] = m.text.trim().split(/\s+/);
          const name = first.replace(/^\//, '').split('@')[0].toLowerCase();
          const cmd = commands[name];
          let reply;
          try {
            reply = cmd ? await cmd.run(args) : `Unknown command. Send /help for the list.`;
          } catch (e) {
            reply = `⚠️ ${name} failed: ${e.message}`;
          }
          if (reply) await sendMessage(reply);
        }
      } catch (e) {
        if (e.code === 409) {
          if (!conflictLogged) console.error('[telegram] another program is reading this bot\'s updates; commands paused until it stops');
          conflictLogged = true;
          await new Promise(r => setTimeout(r, 60000));
        } else {
          console.error('[telegram] polling failed:', e.message);
          await new Promise(r => setTimeout(r, 10000));
        }
      }
    }
  })();
  return true;
}

module.exports = { sendMessage, sendDocument, MAX_DOCUMENT_BYTES, startCommands };
