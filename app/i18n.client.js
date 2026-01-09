import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { i18nOptions } from "./i18n.shared";

const i18nClient = i18next.createInstance();
if (!i18nClient.isInitialized) {
  i18nClient.use(initReactI18next).init(i18nOptions);
}

export default i18nClient;
export const getClientI18n = () => i18nClient;
