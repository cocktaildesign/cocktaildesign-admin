// Keep the version/text aligned with the published frontend legal/consent document.
export const FEEDBACK_CONSENT_VERSION = "2026-10-05";
export const FEEDBACK_CONSENT_TEXT = "Даю согласие на обработку персональных данных для рассмотрения обращения и ответа на него.";

export function acceptedConsent(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const consent = value as Record<string, unknown>;
  return consent.accepted === true && consent.version === FEEDBACK_CONSENT_VERSION;
}

export function consentReceipt(page: string, now = new Date()) {
  return { version: FEEDBACK_CONSENT_VERSION, text: FEEDBACK_CONSENT_TEXT,
    document: "/legal/consent", purpose: "feedback", action: "checkbox_and_submit",
    acceptedAt: now.toISOString(), page };
}
