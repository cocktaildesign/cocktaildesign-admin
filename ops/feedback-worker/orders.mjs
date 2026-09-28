import { createHash } from "node:crypto";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function partReceiptId(requestId, part) {
  const h = createHash("sha256").update(`order-notification:${requestId}:${part}`).digest("hex");
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
    async runOnce() {
      await verifyRecipient();
      const { item } = await api("claim", {});
      if (item === null) return "empty";
      if (!validOrderItem(item)) throw new Error("invalid_order_notification");
      const messageIds = [];
      for (let index = 0; index < item.messages.length; index++) {
        if (isStopping() || Date.now() + 20_000 >= Date.parse(item.leaseExpiresAt)) throw new Error("order_delivery_interrupted");
        const receiptId = partReceiptId(item.requestId, index);
        let messageId = await receipts.get(receiptId);
        if (!messageId) {
          await pause(1100); // Respect the per-chat message rate, including after feedback.
          let sent;
          try {
            const response = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
              method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
              headers: { "content-type": "application/json" }, body: JSON.stringify({
                chat_id: config.chatId, text: item.messages[index], parse_mode: "HTML", link_preview_options: { is_disabled: true },
              }),
            });
            const body = await response.json();
            sent = response.ok && body?.ok === true ? { ok: true, messageId: String(body.result?.message_id) } :
              { ok: false, error: `telegram_http_${response.status}`, retryAfter: Number(body?.parameters?.retry_after || 0) };
          } catch { sent = { ok: false, error: "telegram_unavailable", retryAfter: 0 }; }
          if (!sent.ok) {
            await api("complete", { id: item.id, leaseToken: item.leaseToken, ok: false, error: sent.error, retryAfter: sent.retryAfter });
            return "retry_scheduled";
          }
          if (!/^\d{1,20}$/.test(sent.messageId)) throw new Error("invalid_telegram_result");
          messageId = sent.messageId;
          await receipts.put(receiptId, messageId);
        }
        messageIds.push(messageId);
      }
      await api("complete", { id: item.id, leaseToken: item.leaseToken, ok: true, messageIds });
      for (let i = 0; i < item.messages.length; i++) await receipts.remove(partReceiptId(item.requestId, i));
      return "delivered";
    },
  };
}
