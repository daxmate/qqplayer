// 简体中文语言包（默认语言）
// 按源文件/模块拆分（每个模块一个文件，并行抽离零冲突），在此聚合。
// key 命名规范：<模块>.<功能>.<描述>，如 settings.category.playback
import common from "./common.js";
import app from "./app.js";
import control from "./control.js";
import playlist from "./playlist.js";
import sidebar from "./sidebar.js";
import karaoke from "./karaoke.js";
import lyric from "./lyric.js";
import spec from "./spec.js";
import settings from "./settings.js";
import online from "./online.js";
import mobile from "./mobile.js";
import smart from "./smart.js";
import eq from "./eq.js";
import errors from "./errors.js";
import tags from "./tags.js";
import search from "./search.js";

export default {
  ...common,
  ...app,
  ...control,
  ...playlist,
  ...sidebar,
  ...karaoke,
  ...lyric,
  ...spec,
  ...settings,
  ...online,
  ...mobile,
  ...smart,
  ...eq,
  ...errors,
  ...tags,
  ...search,
};
