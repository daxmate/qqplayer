// 英文语言包：books / videos / settings / app(pairing) 命名空间（其余 key 由 fallbackLocale zh-CN 兜底）
import books from "./books.js";
import videos from "./videos.js";
import settings from "./settings.js";
import app from "./app.js";

export default {
  ...books,
  ...videos,
  ...settings,
  ...app,
};
