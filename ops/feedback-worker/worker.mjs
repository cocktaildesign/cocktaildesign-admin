import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createOrderWorker } from "./orders.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function configuration(env) {
  const base = new URL(env.FEEDBACK_API_URL || "https://api.cocktaildesign.ru/api/");
  if (base.protocol !== "https:" || base.hostname !== "api.cocktaildesign.ru" || base.port || base.username || base.password || base.search || base.hash || base.pathname !== "/api/") {
    throw new Error("invalid_api_address");
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(env.FEEDBACK_WORKER_TOKEN || "")) throw new Error("invalid_worker_token");
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,60}$/.test(env.TELEGRAM_BOT_TOKEN || "")) throw new Error("invalid_bot_token");
  if (!/^[1-9]\d{4,15}$/.test(env.TELEGRAM_CHAT_ID || "")) throw new Error("invalid_private_chat");
  if (env.TELEGRAM_EXPECTED_USERNAME !== "DK_cocktaildesign") throw new Error("unexpected_recipient");
  const extraOrderRecipients = JSON.parse(env.ORDER_TELEGRAM_EXTRA_RECIPIENTS || "[]");
  if (!Array.isArray(extraOrderRecipients) || extraOrderRecipients.length > 4) throw new Error("invalid_order_recipients");
  const chatIds = new Set([env.TELEGRAM_CHAT_ID]), usernames = new Set([env.TELEGRAM_EXPECTED_USERNAME.toLowerCase()]);
  for (const recipient of extraOrderRecipients) {
    if (!recipient || typeof recipient.chatId !== "string" || !/^[1-9]\d{4,15}$/.test(recipient.chatId) ||
        typeof recipient.username !== "string" || !/^[A-Za-z0-9_]{5,32}$/.test(recipient.username) ||
        chatIds.has(recipient.chatId) || usernames.has(recipient.username.toLowerCase())) throw new Error("invalid_order_recipient");
    chatIds.add(recipient.chatId); usernames.add(recipient.username.toLowerCase());
  }
  return {
    apiUrl: base.href, workerToken: env.FEEDBACK_WORKER_TOKEN,
    botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID,
    username: env.TELEGRAM_EXPECTED_USERNAME,
    extraOrderRecipients,
    stateDir: resolve(env.FEEDBACK_STATE_DIR || "/app/state"),
  };
}

export function validItem(item) {
  return item && Number.isSafeInteger(item.id) && item.id > 0 && UUID.test(item.requestId) && UUID.test(item.leaseToken) &&
    typeof item.message === "string" && item.message.length > 0 && item.message.length <= 3000 &&
    (item.email === null || (typeof item.email === "string" && item.email.length <= 254)) &&
    typeof item.page === "string" && /^\/(?!\/)[^\s?#\\]*$/.test(item.page) && item.page.length <= 250;
}

export function formatNotification(item) {
  return ["Новое обращение с сайта Cocktail Design", "", "Текст посетителя:", item.message, "",
    `Email для ответа: ${item.email || "не указан"}`,
    `Страница: https://new.cocktaildesign.ru${item.page}`,
    `Номер обращения: ${item.id}`].join("\n");
}

export function fileReceipts(directory) {
  function file(requestId) {
    if (!UUID.test(requestId)) throw new Error("invalid_request_id");
    return join(directory, `${requestId}.json`);
  }
  return {
    async get(requestId) {
      try {
        const data = JSON.parse(await readFile(file(requestId), "utf8"));
        if (!/^\d{1,20}$/.test(data.messageId)) throw new Error("invalid_receipt");
        return data.messageId;
      } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    },
    async put(requestId, messageId) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const handle = await open(file(requestId), "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ messageId })); await handle.sync(); }
      finally { await handle.close(); }
      // Persist the new directory entry before acknowledging it to the website.
      if (process.platform !== "win32") {
        const directoryHandle = await open(directory, "r");
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      }
    },
    async remove(requestId) {
      try { await unlink(file(requestId)); } catch (error) { if (error.code !== "ENOENT") throw error; }
    },
  };
}

export function createWorker(config, { fetchImpl = fetch, receipts = fileReceipts(config.stateDir) } = {}) {
  let verifiedUntil = 0;
  async function telegram(method, body) {
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/${method}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.ok !== true) return {
        ok: false, error: `telegram_http_${response.status}`, retryAfter: Number(data?.parameters?.retry_after || 0),
      };
      return { ok: true, result: data.result };
    } catch { return { ok: false, error: "telegram_unavailable", retryAfter: 0 }; }
  }
  async function api(path, body) {
    // Never surface fetch errors/URLs: Telegram URLs carry the bot token.
    const response = await fetchImpl(new URL(`feedback-delivery/${path}`, config.apiUrl), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${config.workerToken}` },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok || data?.ok !== true) throw new Error("website_request_failed");
    return data;
  }
  async function verifyRecipient() {
    const bot = await telegram("getMe", {});
    if (!bot.ok || String(bot.result?.username).toLowerCase() !== "cd_order_bot") throw new Error("bot_verification_failed");
    const chat = await telegram("getChat", { chat_id: config.chatId });
    if (!chat.ok || chat.result?.type !== "private" || String(chat.result.id) !== config.chatId ||
        String(chat.result.username).toLowerCase() !== config.username.toLowerCase()) throw new Error("recipient_verification_failed");
    verifiedUntil = Date.now() + 600_000;
  }
  return {
    verifyRecipient,
    ensureRecipient: () => Date.now() < verifiedUntil ? Promise.resolve() : verifyRecipient(),
    async runOnce() {
      if (Date.now() >= verifiedUntil) await verifyRecipient();
      const { item } = await api("claim", {});
      if (item === null) return "empty";
      if (!validItem(item)) throw new Error("invalid_queued_message");
      let messageId = await receipts.get(item.requestId);
      if (!messageId) {
        const sent = await telegram("sendMessage", {
          chat_id: config.chatId, text: formatNotification(item),
          link_preview_options: { is_disabled: true },
        });
        if (!sent.ok) {
          await api("complete", { id: item.id, leaseToken: item.leaseToken, ok: false, error: sent.error, retryAfter: sent.retryAfter });
          return "retry_scheduled";
        }
        messageId = String(sent.result?.message_id);
        if (!/^\d{1,20}$/.test(messageId)) throw new Error("invalid_telegram_result");
        await receipts.put(item.requestId, messageId);
      }
      // If acknowledgement was lost, the durable receipt avoids a second send.
      await api("complete", { id: item.id, leaseToken: item.leaseToken, ok: true, messageId });
      await receipts.remove(item.requestId);
      return "delivered";
    },
  };
}

async function main() {
  if (process.env.FEEDBACK_DELIVERY_ENABLED !== "true") {
    console.log("[feedback-worker] disabled");
    return;
  }
  const config = configuration(process.env);
  const worker = createWorker(config);
  let stopping = false;
  const orderWorker = process.env.ORDER_NOTIFICATIONS_ENABLED === "true" ? createOrderWorker(config, {
    receipts: fileReceipts(config.stateDir), verifyRecipient: worker.ensureRecipient, isStopping: () => stopping,
  }) : null;
  process.on("SIGTERM", () => { stopping = true; });
  process.on("SIGINT", () => { stopping = true; });
  while (!stopping) {
    for (const [name, sender] of [["feedback", worker], ["orders", orderWorker]]) {
      if (!sender || stopping) continue;
      try {
        const outcome = await sender.runOnce();
        if (outcome !== "empty") console.log(`[${name}-worker] ${outcome}`);
      } catch { console.error(`[${name}-worker] iteration failed; will retry`); }
    }
    if (!stopping) await new Promise(resolve => setTimeout(resolve, 10_000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("[feedback-worker] configuration failed"); process.exitCode = 1; });
}
