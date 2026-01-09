import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { i18nOptions } from "./i18n.shared.js";

export async function getServerI18n(lng) {
  const instance = i18next.createInstance();
  await instance.use(initReactI18next).init({ ...i18nOptions, lng });
  return instance;
}
