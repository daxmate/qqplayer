// 拖拽导入曲库：桌面端 window 级拖拽状态 + 文件上传（移动端文件选择复用上传/提示逻辑）
// App.vue 负责挂载/卸载 window 监听；MobileHome.vue 复用 importFiles 上传 + toast 逻辑
// 曲库自动刷新依赖现有 3s 轮询（后端 version+1），导入成功后无需额外刷新逻辑
import { ref, computed } from "vue";
import { showToast, toastError } from "./useToast.js";
import i18n from "../locales/i18n.js";

// 音频扩展名白名单（大小写不敏感）
export const AUDIO_EXTENSIONS = ["mp3", "flac", "m4a", "wav", "ogg", "aac", "opus"];

// 模块级单例状态（与 useToast 同模式：跨组件共享，测试可读取/重置）
const dragCount = ref(0); // 拖入计数：enter +1 / leave -1，归零才隐藏（避免子元素抖动）
const uploading = ref(false); // 上传中：禁用重复拖入

export const dragVisible = computed(() => dragCount.value > 0);
export const dragUploading = uploading;

export function isAudioFile(file) {
  const name = String(file?.name || "");
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTENSIONS.includes(ext);
}

export function filterAudioFiles(files) {
  return Array.from(files || []).filter(isAudioFile);
}

// 是否文件拖拽（文本/链接拖入不触发遮罩与导入）
export function isFileDrag(e) {
  return Array.from(e?.dataTransfer?.types || []).includes("Files");
}

// 上传：FormData 多值 files → POST /api/import → { imported, skipped, errors }
export async function uploadFiles(files) {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  const res = await fetch("/api/import", { method: "POST", body: fd });
  if (!res.ok) throw new Error(`import http ${res.status}`);
  return res.json();
}

// 导入 + toast：成功「已导入 n 首」（skipped/errors 非空合并提示），失败 toastError
export async function importFiles(files) {
  if (uploading.value) return;
  uploading.value = true;
  try {
    const data = await uploadFiles(files);
    const parts = [];
    if (data.imported > 0) parts.push(i18n.global.t("import.success", { n: data.imported }));
    if (data.skipped > 0) parts.push(i18n.global.t("import.skipped", { n: data.skipped }));
    if (data.errors > 0) parts.push(i18n.global.t("import.errors", { n: data.errors }));
    showToast(parts.length ? parts.join("；") : i18n.global.t("import.success", { n: 0 }));
  } catch {
    toastError(i18n.global.t("import.failed"));
  } finally {
    uploading.value = false;
  }
}

// ---------- 拖拽事件处理（内部导出，便于单元测试） ----------
export function handleDragEnter() {
  dragCount.value++;
}

export function handleDragLeave() {
  if (dragCount.value > 0) dragCount.value--; // 防止 leave 比 enter 多时计数为负
}

export function handleDragOver(e) {
  e.preventDefault(); // 不阻止则浏览器默认打开文件
}

export async function handleDrop(e) {
  e.preventDefault();
  dragCount.value = 0;
  const files = filterAudioFiles(e.dataTransfer?.files);
  if (!files.length) {
    toastError(i18n.global.t("import.noAudio"));
    return;
  }
  await importFiles(files);
}

// 挂载 window 级拖拽监听（App.vue onMounted 调用），返回卸载函数
export function setupDragImport() {
  const onEnter = (e) => {
    if (isFileDrag(e)) handleDragEnter();
  };
  const onOver = (e) => {
    if (isFileDrag(e)) handleDragOver(e);
  };
  // dragleave 时 dataTransfer.types 常为空，不能按 isFileDrag 过滤，只做递减
  const onLeave = () => handleDragLeave();
  const onDrop = (e) => {
    if (isFileDrag(e)) handleDrop(e);
  };

  window.addEventListener("dragenter", onEnter);
  window.addEventListener("dragover", onOver);
  window.addEventListener("dragleave", onLeave);
  window.addEventListener("drop", onDrop);

  return () => {
    window.removeEventListener("dragenter", onEnter);
    window.removeEventListener("dragover", onOver);
    window.removeEventListener("dragleave", onLeave);
    window.removeEventListener("drop", onDrop);
    // 卸载同时复位拖拽计数（防 HMR/重挂载后遮罩残留）
    dragCount.value = 0;
  };
}

// 重置状态（测试用）
export function resetDragState() {
  dragCount.value = 0;
  uploading.value = false;
}
