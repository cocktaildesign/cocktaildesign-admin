import type { Context } from "koa";
import { readEngravingFiles, bindEngravingFiles, releaseEngravingFiles, completeEngravingFiles } from "../../../utils/order-engraving-files";
import orderService from "../services/order";
import { loadSampleSaleFolderIdSet } from "../../../utils/product-discount-policy";
import type { PromoCodeResolveResult } from "../../promo-code/services/promo-code";

type ValidationErrorCode =
  | "invalid_payload"
  | "invalid_item_code"
  | "invalid_quantity"
  | "too_many_items"
  | "order_validation_failed"
  | "invalid_idempotency_key";

type OrderRequestRow = {
  id: number;
  idempotencyKey: string;
  status: "processing" | "succeeded";
  orderId?: string | null;
  orderName?: string | null;
};

type SanitizedItem = {
  code: string;
  quantity: number;
  engraving: boolean;
};

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function sendValidationError(ctx: Context, code: ValidationErrorCode) {
  ctx.status = 400;
  ctx.body = { ok: false, error: code };
}

function getString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function ensureMaxLength(value: string, max: number): boolean {
  return value.length <= max;
}

function getIdempotencyKey(ctx: Context): string | null {
  const raw = ctx.get("Idempotency-Key");
  const key = typeof raw === "string" ? raw.trim() : "";

  if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return null;
  }

  return key;
}

function sendExistingOrderRequest(ctx: Context, existing: OrderRequestRow): boolean {
  if (
    existing.status === "succeeded" &&
    typeof existing.orderId === "string" &&
    existing.orderId.trim() !== "" &&
    typeof existing.orderName === "string" &&
    existing.orderName.trim() !== ""
  ) {
    ctx.status = 200;
    ctx.body = {
      ok: true,
      orderId: existing.orderId,
      orderName: existing.orderName,
      replayed: true,
    };
    return true;
  }

  ctx.status = 409;
  ctx.body = { ok: false, error: "order_in_progress" };
  return true;
}

async function deleteOrderRequestSafely(orderRequestId: number) {
  const orderRequestQuery = strapi.db.query("api::order-request.order-request");

  try {
    await orderRequestQuery.delete({ where: { id: orderRequestId } });
  } catch {
    strapi.log.warn("[order] Failed to delete order-request record after pre-order error");
  }
}

function normalizeDescriptionText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

type ResolvedPromoSuccess = Extract<PromoCodeResolveResult, { ok: true }>;

function sendPromoValidationError(ctx: Context, promoResult: Extract<PromoCodeResolveResult, { ok: false }>) {
  ctx.status = 400;

  switch (promoResult.error) {
    case "not_found":
      ctx.body = { ok: false, error: "promo_not_found" };
      return;
    case "not_active":
      ctx.body = { ok: false, error: "promo_not_active" };
      return;
    case "limit_reached":
      ctx.body = { ok: false, error: "promo_limit_reached" };
      return;
    case "min_amount_not_reached":
      ctx.body = {
        ok: false,
        error: "promo_min_amount_not_reached",
        minAmount: promoResult.minAmount,
      };
      return;
    case "invalid_promo_configuration":
      ctx.body = { ok: false, error: "promo_invalid_configuration" };
      return;
    default:
      ctx.body = { ok: false, error: "promo_invalid_configuration" };
  }
}

function buildOrderDescriptionParts(params: {
  buyerType: "individual" | "legal";
  engravingItems: string[];
  telegram?: string;
  inn?: string;
  comment?: string;
  trustedVolumeDiscountPercent: number;
  discountPlan: ReturnType<typeof orderService.resolveOrderDiscountPlan>;
  resolvedPromo: ResolvedPromoSuccess | null;
}): string[] {
  const {
    buyerType,
    engravingItems,
    telegram,
    inn,
    comment,
    trustedVolumeDiscountPercent,
    discountPlan,
    resolvedPromo,
  } = params;

  const parts: string[] = [
    buyerType === "legal" ? "Юрлицо" : "Физлицо",
    engravingItems.length > 0 ? `Гравировка: ${engravingItems.join(", ")}` : null,
    telegram ? `Telegram: ${telegram}` : null,
    inn ? `ИНН: ${inn}` : null,
    comment ? `Комментарий: ${comment}` : null,
  ].filter((part): part is string => part !== null);

  if (discountPlan.appliedVolumeDiscountAmount > 0) {
    parts.push(
      `Скидка за объём: ${trustedVolumeDiscountPercent}% (${discountPlan.appliedVolumeDiscountAmount} ₽)`,
    );
  }

  if (resolvedPromo) {
    if (resolvedPromo.discountType === "fixed") {
      parts.push(`Промокод ${resolvedPromo.code}: ${discountPlan.appliedPromoDiscountAmount} ₽`);
    } else if (resolvedPromo.discountType === "percent") {
      if (discountPlan.promoWinsAgainstVolume) {
        parts.push(
          `Промокод ${resolvedPromo.code}: ${resolvedPromo.discountValue}% (${discountPlan.appliedPromoDiscountAmount} ₽)`,
        );
      } else {
        parts.push(`Промокод ${resolvedPromo.code} не применён: объёмная скидка выгоднее`);
      }
    } else if (resolvedPromo.discountType === "startup") {
      if (discountPlan.promoWinsAgainstVolume) {
        parts.push(
          `Акция СТАРТАП ${resolvedPromo.code}: ${resolvedPromo.discountValue}% (${discountPlan.appliedPromoDiscountAmount} ₽)`,
        );
      } else {
        parts.push(`Акция СТАРТАП ${resolvedPromo.code} не применена: объёмная скидка выгоднее`);
      }
      parts.push("Новый клиент — проверить вручную");
      if (resolvedPromo.bonusMessage.trim() !== "") {
        parts.push(`Бонусы: ${normalizeDescriptionText(resolvedPromo.bonusMessage)}`);
      }
    } else if (resolvedPromo.discountType === "inventory") {
      parts.push(`Промокод ${resolvedPromo.code}: подарок`);
      if (resolvedPromo.giftDescription && resolvedPromo.giftDescription.trim() !== "") {
        parts.push(`Подарок: ${normalizeDescriptionText(resolvedPromo.giftDescription)}`);
      }
      if (resolvedPromo.bonusMessage.trim() !== "") {
        parts.push(`Условия: ${normalizeDescriptionText(resolvedPromo.bonusMessage)}`);
      }
    }
  }

  parts.push(`Итого после скидок: ${discountPlan.finalPrice} ₽`);

  return parts;
}

function sanitizeOrderPayload(body: unknown): {
  buyerType: "individual" | "legal";
  fullName?: string;
  contactName?: string;
  phone: string;
  telegram?: string;
  inn?: string;
  address: string;
  comment?: string;
  promoCode?: string;
  items: SanitizedItem[];
} | { error: ValidationErrorCode } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "invalid_payload" };
  }

  const data = body as Record<string, unknown>;
  const buyerType = data.buyerType;
  if (buyerType !== "individual" && buyerType !== "legal") {
    return { error: "invalid_payload" };
  }

  const phoneRaw = getString(data.phone)?.trim() ?? "";
  const addressRaw = getString(data.address)?.trim() ?? "";
  if (!phoneRaw || !addressRaw) {
    return { error: "order_validation_failed" };
  }
  if (!ensureMaxLength(phoneRaw, 32) || !ensureMaxLength(addressRaw, 500)) {
    return { error: "order_validation_failed" };
  }

  const telegramRaw = getString(data.telegram);
  const innRaw = getString(data.inn);
  const commentRaw = getString(data.comment);
  const fullNameRaw = getString(data.fullName);
  const contactNameRaw = getString(data.contactName);

  if (telegramRaw !== null && !ensureMaxLength(telegramRaw.trim(), 64)) {
    return { error: "order_validation_failed" };
  }
  if (innRaw !== null && !ensureMaxLength(innRaw.trim(), 16)) {
    return { error: "order_validation_failed" };
  }
  if (commentRaw !== null && !ensureMaxLength(commentRaw.trim(), 1000)) {
    return { error: "order_validation_failed" };
  }
  if (fullNameRaw !== null && !ensureMaxLength(fullNameRaw.trim(), 200)) {
    return { error: "order_validation_failed" };
  }
  if (contactNameRaw !== null && !ensureMaxLength(contactNameRaw.trim(), 200)) {
    return { error: "order_validation_failed" };
  }

  const fullName = fullNameRaw?.trim();
  const contactName = contactNameRaw?.trim();
  if (buyerType === "individual" && !fullName) {
    return { error: "order_validation_failed" };
  }
  if (buyerType === "legal" && !contactName) {
    return { error: "order_validation_failed" };
  }

  const items = data.items;
  if (!Array.isArray(items)) {
    return { error: "invalid_payload" };
  }
  if (items.length === 0) {
    return { error: "order_validation_failed" };
  }
  if (items.length > 100) {
    return { error: "too_many_items" };
  }

  const sanitizedItems: SanitizedItem[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { error: "invalid_payload" };
    }

    const itemData = item as Record<string, unknown>;
    const code = getString(itemData.code)?.trim() ?? "";
    if (!code) {
      return { error: "invalid_item_code" };
    }

    const quantity = itemData.quantity;
    if (!Number.isInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 100) {
      return { error: "invalid_quantity" };
    }

    const engraving = typeof itemData.engraving === "boolean" ? itemData.engraving : false;

    sanitizedItems.push({
      code,
      quantity: quantity as number,
      engraving,
    });
  }

  const promoCode = getString(data.promoCode)?.trim();
  if (promoCode && !ensureMaxLength(promoCode, 128)) {
    return { error: "order_validation_failed" };
  }

  return {
    buyerType,
    fullName: fullName || undefined,
    contactName: contactName || undefined,
    phone: phoneRaw,
    telegram: telegramRaw?.trim() || undefined,
    inn: innRaw?.trim() || undefined,
    address: addressRaw,
    comment: commentRaw?.trim() || undefined,
    promoCode: promoCode || undefined,
    items: sanitizedItems,
  };
}

async function findOrderRequestByKey(idempotencyKey: string): Promise<OrderRequestRow | null> {
  const orderRequestQuery = strapi.db.query("api::order-request.order-request");

  const row = await orderRequestQuery.findOne({
    where: { idempotencyKey },
  });

  if (!row) {
    return null;
  }

  return row as OrderRequestRow;
}

async function acquireOrderRequestRecord(idempotencyKey: string): Promise<
  | { kind: "continue"; orderRequestId: number }
  | { kind: "handled" }
> {
  const orderRequestQuery = strapi.db.query("api::order-request.order-request");

  let existing = await findOrderRequestByKey(idempotencyKey);

  if (existing) {
    return { kind: "handled" };
  }

  try {
    const created = await orderRequestQuery.create({
      data: {
        idempotencyKey,
        status: "processing",
      },
    });

    return { kind: "continue", orderRequestId: created.id as number };
  } catch {
    existing = await findOrderRequestByKey(idempotencyKey);

    if (existing) {
      return { kind: "handled" };
    }

    throw new Error("order_request_create_failed");
  }
}

async function finalizeSuccessfulOrder(params: {
  orderRequestId: number;
  orderId: string;
  orderName: string;
  promoId: number | null;
}) {
  await strapi.db.transaction(async ({ trx }) => {
    const updatedOrderRequestRows = await trx("order_requests")
      .where({ id: params.orderRequestId })
      .update({
        status: "succeeded",
        order_id: params.orderId,
        order_name: params.orderName,
        updated_at: new Date(),
      });

    if (updatedOrderRequestRows !== 1) {
      throw new Error("order_request_finalize_failed");
    }

    if (params.promoId !== null) {
      const updatedPromoRows = await trx("promo_codes")
        .where({ id: params.promoId })
        .update({
          usage_count: trx.raw("COALESCE(usage_count, 0) + 1"),
          updated_at: new Date(),
        });

      if (updatedPromoRows !== 1) {
        throw new Error("promo_usage_increment_failed");
      }
    }
  });
}

export default {
  async create(ctx: Context) {
    const sanitizedPayload = sanitizeOrderPayload(ctx.request.body);
    if ("error" in sanitizedPayload) {
      sendValidationError(ctx, sanitizedPayload.error);
      return;
    }

    const { buyerType, fullName, contactName, phone, telegram, inn, address, comment, promoCode, items } =
      sanitizedPayload;
    const name = buyerType === "individual" ? fullName : contactName;

    if (!name) {
      sendValidationError(ctx, "order_validation_failed");
      return;
    }

    const idempotencyKey = getIdempotencyKey(ctx);
    if (!idempotencyKey) {
      sendValidationError(ctx, "invalid_idempotency_key");
      return;
    }

    const existingBeforeCreate = await findOrderRequestByKey(idempotencyKey);
    if (existingBeforeCreate && sendExistingOrderRequest(ctx, existingBeforeCreate)) {
      return;
    }

    let engravingFiles: ReturnType<typeof readEngravingFiles>;
    try { engravingFiles = readEngravingFiles(ctx.request.body, items.some(item => item.engraving)); }
    catch { ctx.status = 400; ctx.body = { ok: false, error: "invalid_engraving_files" }; return; }

    const positions: {
      productHref: string;
      productType: string;
      quantity: number;
      price: number;
      engraving: boolean;
      discountExcluded: boolean;
      name: string;
    }[] = [];

    let trustedSubtotal = 0;
    let trustedDiscountableSubtotal = 0;
    const sampleSaleFolderIds = await loadSampleSaleFolderIdSet(strapi);

    for (const item of items) {
      try {
        const resolved = await orderService.resolveOrderItemByCode(item.code, sampleSaleFolderIds);

        positions.push({
          productHref: resolved.href,
          productType: resolved.type,
          quantity: item.quantity,
          price: resolved.trustedPriceRub,
          engraving: item.engraving,
          discountExcluded: resolved.trustedDiscountExcluded,
          name: resolved.trustedName,
        });

        const lineTotal = resolved.trustedPriceRub * item.quantity;

        trustedSubtotal += lineTotal;

        if (!resolved.trustedDiscountExcluded) {
          trustedDiscountableSubtotal += lineTotal;
        }
      } catch (error) {
        const errorCode = (error as { code?: string })?.code;
        if (
          errorCode === "invalid_item_code" ||
          errorCode === "item_not_found" ||
          errorCode === "item_price_missing" ||
          errorCode === "item_price_invalid"
        ) {
          ctx.status = 400;
          ctx.body = { ok: false, error: errorCode };
          return;
        }
        throw error;
      }
    }

    if (positions.length === 0) {
      sendValidationError(ctx, "order_validation_failed");
      return;
    }

    const trustedVolumeDiscountPercent = await orderService.resolveVolumeDiscountPercent(trustedSubtotal);

    const promoCodeService = strapi.service("api::promo-code.promo-code") as {
      resolvePromoCode(
        rawCode: string,
        totalPrice: number,
        discountableTotal: number,
      ): Promise<PromoCodeResolveResult>;
    };

    let resolvedPromo: ResolvedPromoSuccess | null = null;

    if (promoCode) {
      const promoResult = await promoCodeService.resolvePromoCode(
        promoCode,
        trustedSubtotal,
        trustedDiscountableSubtotal,
      );

      if (promoResult.ok === false) {
        sendPromoValidationError(ctx, promoResult);
        return;
      }

      resolvedPromo = promoResult;
    }

    const promoForDiscountPlan =
      resolvedPromo !== null
        ? {
            discountType: resolvedPromo.discountType,
            discountValue: resolvedPromo.discountValue,
            discountAmount: resolvedPromo.discountAmount,
          }
        : null;

    const discountPlan = orderService.resolveOrderDiscountPlan({
      totalPrice: trustedSubtotal,
      discountableTotal: trustedDiscountableSubtotal,
      volumeDiscountPercent: trustedVolumeDiscountPercent,
      promo: promoForDiscountPlan,
    });

    const engravingItems = positions.filter((i) => i.engraving).map((i) => i.name);

    let description = buildOrderDescriptionParts({
      buyerType,
      engravingItems,
      telegram,
      inn,
      comment,
      trustedVolumeDiscountPercent,
      discountPlan,
      resolvedPromo,
    }).join(" | ");

    const orderPositions = positions.map((position) => ({
      productHref: position.productHref,
      productType: position.productType,
      quantity: position.quantity,
      price: position.price,
      engraving: position.engraving,
      discountPercent: position.discountExcluded
        ? discountPlan.excludedPositionPercent
        : discountPlan.discountablePositionPercent,
    }));

    let orderRequestId: number | null = null;
    let orderCreationStarted = false;
    let filesBound = false;
    let bindingFiles = false;

    try {
      const acquireResult = await acquireOrderRequestRecord(idempotencyKey);

      if (acquireResult.kind === "handled") {
        const existingAfterRace = await findOrderRequestByKey(idempotencyKey);
        if (existingAfterRace && sendExistingOrderRequest(ctx, existingAfterRace)) {
          return;
        }

        ctx.status = 409;
        ctx.body = { ok: false, error: "order_in_progress" };
        return;
      }

      orderRequestId = acquireResult.orderRequestId;

      if (engravingFiles) {
        bindingFiles = true;
        const links = bindEngravingFiles(engravingFiles, idempotencyKey);
        filesBound = true;
        bindingFiles = false;
        description += " | " + links.join(" | ");
      }

      const agentHref = await orderService.createCounterparty(name, phone);

      orderCreationStarted = true;

      const order = await orderService.createCustomerOrder({
        agentHref,
        positions: orderPositions,
        description,
        shipmentAddress: address,
      });

      const orderId = typeof order.id === "string" ? order.id.trim() : "";
      const orderName = typeof order.name === "string" ? order.name.trim() : "";

      if (!orderId || !orderName) {
        throw new Error("invalid_moysklad_order_response");
      }

      await finalizeSuccessfulOrder({
        orderRequestId,
        orderId,
        orderName,
        promoId: resolvedPromo !== null ? resolvedPromo.promoId : null,
      });

      if (filesBound) {
        // Bound files are already durable and linked to this request before the CRM call.
        // A metadata failure here must never turn an accepted order into a failed checkout.
        try { completeEngravingFiles(idempotencyKey, orderId, orderName); }
        catch { strapi.log.error("[engraving-files] accepted order metadata needs reconciliation"); }
      }

      ctx.body = { ok: true, orderId, orderName };
    } catch (err) {
      if (orderRequestId !== null && !orderCreationStarted) {
        if (filesBound) {
          try { releaseEngravingFiles(idempotencyKey); }
          catch { strapi.log.error("[engraving-files] retained files after pre-order failure"); }
        }
        await deleteOrderRequestSafely(orderRequestId);
      }

      if (bindingFiles && !orderCreationStarted) {
        ctx.status = 409;
        ctx.body = { ok: false, error: "engraving_files_unavailable" };
        return;
      }

      if (orderCreationStarted) {
        strapi.log.error("[order] Order status unknown after MoySklad customer order call");
        ctx.status = 500;
        ctx.body = { ok: false, error: "order_status_unknown" };
        return;
      }

      strapi.log.error("Ошибка создания заказа в МойСклад");
      ctx.status = 500;
      ctx.body = { ok: false, error: "order_validation_failed" };
    }
  },
};
