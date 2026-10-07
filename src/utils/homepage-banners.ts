import type { Core } from "@strapi/strapi";
import { errors } from "@strapi/utils";

const UID = "api::homepage.homepage";
const groups = { heroBanners: "Верхние баннеры", promoBanners: "Нижние баннеры" };
const populate = { heroBanners: { populate: ["desktopImage", "mobileImage", "productImage"] }, promoBanners: { populate: ["desktopImage", "mobileImage"] } };

// Strapi's native required-media check does not cover repeatable components on publish.
// Keep incomplete drafts editable, but prevent broken slides from reaching the storefront.
export function registerHomepageBannerValidation(strapi: Core.Strapi) {
  strapi.documents.use(async (context, next) => {
    if (context.uid !== UID) return next();
    const params = context.params as { documentId?: string; status?: string; data?: Record<string, unknown> };
    if (context.action !== "publish" && !(["create", "update"].includes(context.action) && params.status === "published")) return next();
    const existing = params.documentId
      ? await strapi.documents(UID).findOne({ documentId: params.documentId, status: "draft", populate } as never)
      : null;
    const data = { ...(existing as Record<string, unknown> | null), ...params.data };
    for (const [field, label] of Object.entries(groups)) {
      const slides = data[field] as Array<Record<string, unknown>> | undefined;
      if (!slides) continue;
      if (!Array.isArray(slides) || slides.length > 6) throw new errors.ValidationError(`${label}: можно опубликовать не больше 6 баннеров.`);
      for (const [index, slide] of slides.entries()) {
        const prefix = `${label}, баннер ${index + 1}`;
        if (!slide.title || typeof slide.title !== "string" || !slide.title.trim()) throw new errors.ValidationError(`${prefix}: укажите название.`);
        if (slide.href && (typeof slide.href !== "string" || !/^(?:\/(?!\/)[^\\\s]*|https:\/\/[^\\\s]+)$/.test(slide.href))) throw new errors.ValidationError(`${prefix}: ссылка должна начинаться с / или https://.`);
        const editorial = field === "heroBanners" && slide.useTextLayout === true;
        if (editorial && (typeof slide.heading !== "string" || !slide.heading.trim())) throw new errors.ValidationError(`${prefix}: заполните заголовок для режима с отдельным текстом.`);
        if (editorial && slide.href && (typeof slide.buttonLabel !== "string" || !slide.buttonLabel.trim())) throw new errors.ValidationError(`${prefix}: заполните надпись на кнопке.`);
        for (const image of editorial ? ["productImage"] : ["desktopImage", "mobileImage"]) {
          const value = slide[image];
          const id = typeof value === "number" ? value : (value as { id?: number } | null)?.id;
          const file = id ? await strapi.db.query("plugin::upload.file").findOne({ where: { id } }) : null;
          if (!file || !["image/webp", "image/jpeg", "image/png", "image/avif"].includes(file.mime)) {
            throw new errors.ValidationError(`${prefix}: загрузите ${image === "productImage" ? "фото товаров без надписей" : image === "desktopImage" ? "картинку для компьютера" : "картинку для телефона"} в формате WebP, JPG или PNG.`);
          }
          if (file.size > 2048) throw new errors.ValidationError(`${prefix}: картинка больше 2 МБ. Сожмите её перед публикацией; желательно до ${image === "desktopImage" ? "300" : "150"} КБ.`);
        }
      }
    }
    return next();
  });
}
