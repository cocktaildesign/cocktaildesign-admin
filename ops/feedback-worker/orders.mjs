import { createHash } from "node:crypto";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function partReceiptId(requestId, part, extraChatId) {
  // Keep the original recipient's receipt keys compatible with the previous image.
  const scope = extraChatId === undefined ? "" : `:recipient:${extraChatId}`;
  const h = createHash("sha256").update(`order-notification:${requestId}:${part}${scope}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function validOrderItem(item) {
  return item && Number.isSafeInteger(item.id) && item.id > 0 && UUID.test(item.requestId) && UUID.test(item.leaseToken) &&
    Number.isFinite(Date.parse(item.leaseExpiresAt)) && Array.isArray(item.messages) && item.messages.length > 0 && item.messages.length <= 100 &&
    item.messages.every(text => typeof text === "string" && text.length > 0 && text.length <= 3800);
}

export function createOrderWorker(config, { receipts, verifyRecipient, fetchImpl = fetch,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)), isStopping = () => false } = {}) {
  if (!receipts || typeof verifyRecipient !== "function") throw new Error("verification_required");
  const recipients = [{chatId: config.chatId, username: config.username}, ...(config.extraOrderRecipients || [])];
  const verifiedUntil = new Map();
  async function verifyExtraRecipient(recipient) {
    if ((verifiedUntil.get(recipient.chatId) || 0) > Date.now()) return;
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/getChat`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json" }, body: JSON.stringify({chat_id:recipient.chatId}),
      });
      const body = await response.json();
      if (!response.ok || body?.ok !== true || body.result?.type !== "private" ||
          String(body.result.id) !== recipient.chatId ||
          String(body.result.username).toLowerCase() !== recipient.username.toLowerCase()) throw new Error();
      verifiedUntil.set(recipient.chatId, Date.now() + 600_000);
    } catch { throw new Error("order_recipient_verification_failed"); }
  }
  async function api(path, body) {
    const response = await fetchImpl(new URL(`feedback-delivery/order-${path}`, config.apiUrl), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(45_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${config.workerToken}` }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok || result?.ok !== true) throw new Error("order_queue_unavailable");
    return result;
  }
  return {
    async verifyRecipients() {
      await verifyRecipient();
      for (const recipient of recipients.slice(1)) await verifyExtraRecipient(recipient);
    },
    async runOnce() {
      await verifyRecipient();
      const { item } = await api("claim", {});
      if (item === null) return "empty";
      if (!validOrderItem(item)) throw new Error("invalid_order_notification");
      const messageIds = [];
      let failure = null;
      const receiptIds = [];
      for (const [recipientIndex, recipient] of recipients.entries()) {
        for (let index = 0; index < item.messages.length; index++) {
          if (isStopping() || Date.now() + 20_000 >= Date.parse(item.leaseExpiresAt)) throw new Error("order_delivery_interrupted");
          const receiptId = partReceiptId(item.requestId, index, recipientIndex === 0 ? undefined : recipient.chatId);
          let messageId = await receipts.get(receiptId);
          if (!messageId) {
            if (recipientIndex > 0) {
              try { await verifyExtraRecipient(recipient); }
              catch {
                failure ||= {error:"order_recipient_verification_failed",retryAfter:0};
                break; // An unavailable extra recipient must not block the others.
              }
            }
            await pause(1100); // Respect the per-chat message rate, including after feedback.
            if (isStopping() || Date.now() + 20_000 >= Date.parse(item.leaseExpiresAt)) throw new Error("order_delivery_interrupted");
            let sent;
            try {
              const response = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
                method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
                headers: { "content-type": "application/json" }, body: JSON.stringify({
                  chat_id: recipient.chatId, text: item.messages[index], parse_mode: "HTML", link_preview_options: { is_disabled: true },
                }),
              });
              const body = await response.json();
              sent = response.ok && body?.ok === true ? { ok: true, messageId: String(body.result?.message_id) } :
                { ok: false, error: `telegram_http_${response.status}`, retryAfter: Number(body?.parameters?.retry_after || 0) };
            } catch { sent = { ok: false, error: "telegram_unavailable", retryAfter: 0 }; }
            if (!sent.ok) {
              failure = {error:sent.error,retryAfter:Math.max(failure?.retryAfter || 0,sent.retryAfter || 0)};
              break; // Preserve this recipient's part order, then try the next recipient.
            }
            if (!/^\d{1,20}$/.test(sent.messageId)) throw new Error("invalid_telegram_result");
            messageId = sent.messageId;
            await receipts.put(receiptId, messageId);
          }
          if (recipientIndex === 0) messageIds.push(messageId);
          receiptIds.push(receiptId);
        }
      }
      if (failure) {
        await api("complete", {id:item.id,leaseToken:item.leaseToken,ok:false,...failure});
        return "retry_scheduled";
      }
      // Keep the website's existing primary-recipient acknowledgement contract.
      // It is completed only after every configured recipient received every part.
      await api("complete", { id: item.id, leaseToken: item.leaseToken, ok: true, messageIds });
      for (const receiptId of receiptIds) await receipts.remove(receiptId);
      return "delivered";
    },
  };
}
