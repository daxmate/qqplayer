// 英文语言包：books / videos / settings / app / smart / sidebar / playlist / tags / scrape 命名空间
// （其余 key 由 fallbackLocale zh-CN 兜底）
import books from "./books.js";
import videos from "./videos.js";
import settings from "./settings.js";
import app from "./app.js";
import smart from "./smart.js";
import sidebar from "./sidebar.js";
import playlist from "./playlist.js";
import tags from "./tags.js";
import scrape from "./scrape.js";
import mobile from "./mobile.js";
import search from "./search.js";

export default {
  ...books,
  ...videos,
  ...settings,
  ...app,
  ...smart,
  ...sidebar,
  ...playlist,
  ...tags,
  ...scrape,
  ...mobile,
  ...search,
};
