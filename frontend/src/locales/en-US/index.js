// 英文语言包：books / videos / settings / app(pairing) / playlist(ctx) / tags 命名空间
// （其余 key 由 fallbackLocale zh-CN 兜底）
import books from "./books.js";
import videos from "./videos.js";
import settings from "./settings.js";
import app from "./app.js";
import playlist from "./playlist.js";
import tags from "./tags.js";

export default {
  ...books,
  ...videos,
  ...settings,
  ...app,
  ...playlist,
  ...tags,
};
