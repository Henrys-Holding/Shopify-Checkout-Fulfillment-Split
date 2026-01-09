//i18n.shared.ts
import enCommon from "./locales/en/common.json"  with { type: "json" };
import zhCommon from "./locales/zh/common.json"  with { type: "json" };

export const resources = {
  en: { common: enCommon },
  zh: { common: zhCommon },
};

export const i18nOptions = {
  fallbackLng: "en",
  supportedLngs: ["en", "zh"],
  ns: ["common"],
  defaultNS: "common",
  resources,
  interpolation: { escapeValue: false },

  // ✅ important: make init synchronous since resources are in-memory
  initImmediate: false,
};
