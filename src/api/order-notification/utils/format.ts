// Read-only notification view of an already created MoySklad order.
const clean = (value: unknown) => String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = (kopecks: number) => (kopecks / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + " ₽";
const numeric = (n: unknown) => typeof n === "number" && Number.isFinite(n);

function field(label: string, value: unknown, bold = false): string[] {
  const chars = Array.from(clean(value));
  if (!chars.length) return [];
  const lines: string[] = [];
  for (let i = 0; i < chars.length; i += 320) {
    const text = escape(chars.slice(i, i + 320).join(""));
    lines.push((i === 0 ? label : "") + (bold ? `<b>${text}</b>` : text));
  }
  return lines;
}

export function formatOrder(order: any, positions: any[]): string[] {
  if (!order || !clean(order.name) || !numeric(order.sum) || order.sum < 0 ||
      !Array.isArray(positions) || positions.length < 1 || positions.length > 1000) throw new Error("invalid_order_snapshot");
  const blocks: string[][] = [["Заказ принят в МойСклад.", "", "<b>Товары — цены до скидок</b>"]];
  let gross = 0;
  positions.forEach((p, index) => {
    if (!p || !numeric(p.quantity) || p.quantity <= 0 || !numeric(p.price) || p.price < 0 ||
        !clean(p.assortment?.name) || (p.discount != null && (!numeric(p.discount) || p.discount > 100))) throw new Error("invalid_order_position");
    const line = Math.round(p.quantity * p.price); gross += line;
    const lines = ["", ...field(`${index + 1}. `, p.assortment.name, true),
      ...field("Артикул: ", p.assortment.code || p.assortment.article),
      `${p.quantity.toLocaleString("ru-RU")} × ${money(p.price)} = ${money(line)}`];
    if (p.discount) lines.push(`Скидка: ${p.discount.toLocaleString("ru-RU")}%`);
    if (Array.isArray(p.assortment.characteristics)) {
      for (const c of p.assortment.characteristics) lines.push(...field("", `${clean(c.name)}: ${clean(c.value)}`));
    }
    blocks.push(lines);
  });
  const totals = ["", `Товары до скидок: ${money(gross)}`];
  if (gross > order.sum) totals.push(`Скидка по заказу: ${money(gross - order.sum)}`);
  totals.push(`<b>Сумма заказа: ${money(order.sum)}</b>`);
  if (order.vatEnabled && order.vatIncluded && positions.every(p => p.vat === 5)) totals.push("В том числе НДС 5%.");
  blocks.push(totals);
  blocks.push(["", "<b>Покупатель</b>", ...field("Имя: ", order.agent?.name), ...field("Телефон: ", order.agent?.phone),
    ...field("Email: ", order.agent?.email), ...field("Адрес: ", order.shipmentAddress)]);
  if (clean(order.description)) blocks.push(["", "<b>Детали заказа</b>", ...clean(order.description).split(" | ").flatMap(part => field("", part))]);
  blocks.push(["", "Источник: new.cocktaildesign.ru", "Уведомление о заказе, не подтверждение оплаты."]);

  // Keep ordinary product blocks together, splitting exceptionally long fields at safe HTML boundaries.
  const bodies: string[] = []; let body = "";
  function add(text: string) {
    if (body && body.length + text.length + 1 > 3000) { bodies.push(body); body = ""; }
    body += (body ? "\n" : "") + text;
  }
  for (const lines of blocks) {
    const block = lines.join("\n");
    if (block.length <= 3000) add(block); else for (const line of lines) add(line);
  }
  if (body) bodies.push(body);
  if (bodies.length > 100) throw new Error("notification_too_large");
  const name = escape(Array.from(clean(order.name)).slice(0, 80).join(""));
  return bodies.map((text, i) => `<b>Новый заказ №${name}</b>${bodies.length > 1 ? ` · ${i + 1}/${bodies.length}` : ""}\n\n${text}`);
}
