// 英文语言包：books / videos 命名空间（其余 key 由 fallbackLocale zh-CN 兜底）
import books from "./books.js";
import videos from "./videos.js";

export default {
  ...books,
  ...videos,
};
