<!-- 下载设置面板（SettingsModal 拆分 · P3）：下载 + aria2 RPC + 夸克账号
  注册表条目由 entriesByCategory 计算（与拆分前 SettingsModal 一致）；
  夸克账号状态在面板挂载（进入下载 tab）时拉取，与拆分前容器 watch(tab) 语义一致；
  扫码登录弹窗为下载面板专属（Teleport 到 body）；通用样式由 SettingsModal :deep 继承，
  quark-* 专属样式 scoped。 -->
<template>
  <div class="group">
    <div class="group-title">
      <Download :size="13" />
      {{ t("settings.download") }}
    </div>
    <template v-for="e in downloadEntries" :key="e.id">
      <SettingRow v-if="!e.render" :entry="e" />
      <!-- aria2 参数（engine==='aria2' 才显示，照抄原模板） -->
      <template v-else-if="e.id === 'aria2Rpc'">
        <div v-if="downloadSettings.engine === 'aria2'" class="setting-item">
          <div class="setting-label">{{ t("settings.aria2Rpc") }}</div>
          <div class="setting-control">
            <input
              v-model="downloadSettings.aria2Rpc"
              class="lib-input"
              :placeholder="t('settings.aria2RpcPlaceholder')"
              spellcheck="false"
            />
          </div>
        </div>
        <div v-if="downloadSettings.engine === 'aria2'" class="setting-item">
          <div class="setting-label">{{ t("settings.aria2Secret") }}</div>
          <div class="setting-control">
            <input
              v-model="downloadSettings.aria2Secret"
              class="lib-input"
              type="password"
              :placeholder="t('settings.aria2SecretPlaceholder')"
              spellcheck="false"
            />
          </div>
        </div>
      </template>
    </template>
    <div class="setting-item">
      <div class="setting-label">{{ t("settings.quarkAccount") }}</div>
      <div class="setting-desc">{{ t("settings.quarkAccountDesc") }}</div>
      <div class="setting-control quark-account-row">
        <template v-if="quarkState && quarkState.logged_in">
          <span class="quark-account-name">{{
            t("settings.quarkLoggedInAs", {
              nickname: quarkState.nickname || "",
            })
          }}</span>
          <button class="btn" :disabled="quarkBusy" @click="quarkLogout">
            {{ t("settings.quarkLogout") }}
          </button>
        </template>
        <template v-else>
          <span class="quark-account-name">{{ t("settings.quarkNotLoggedIn") }}</span>
          <button class="btn primary" :disabled="quarkBusy" @click="quarkLoginOpen = true">
            {{ t("settings.quarkLogin") }}
          </button>
        </template>
      </div>
    </div>
  </div>

  <!-- 夸克扫码登录（设置页登录入口；成功后刷新账号状态） -->
  <QuarkLoginModal
    :open="quarkLoginOpen"
    @success="onQuarkLoginSuccess"
    @close="quarkLoginOpen = false"
  />
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { Download } from "@lucide/vue";
import { downloadSettings } from "../../composables/usePlayer.js";
import { apiGet, apiPost } from "../../utils/apiClient.js";
import SettingRow from "../SettingRow.vue";
import QuarkLoginModal from "../QuarkLoginModal.vue";
import { entriesByCategory } from "../../settingsIndex";

const { t } = useI18n();

// 注册表顺序渲染（与拆分前 SettingsModal 一致）；aria2Rpc 为 render 标记复合项
const downloadEntries = entriesByCategory("download");

// 夸克账号状态（下载分类展示）：null=未加载 | {logged_in, nickname?}
const quarkState = ref<{ logged_in: boolean; nickname?: string } | null>(null);
const quarkBusy = ref(false);
const quarkLoginOpen = ref(false);

// 进入下载分类时拉取夸克登录状态（登录/退出后也会刷新）
async function refreshQuarkState() {
  quarkBusy.value = true;
  try {
    // 夸克登录链路：401 是「未登录」语义（非配对 token 失效），skip401 关闭特判
    const res = await apiGet("/api/quark/login/state", { skip401: true });
    quarkState.value = res.ok ? res.data : { logged_in: false };
  } catch {
    quarkState.value = { logged_in: false };
  } finally {
    quarkBusy.value = false;
  }
}

// 退出登录：POST logout + 刷新状态
async function quarkLogout() {
  quarkBusy.value = true;
  try {
    await apiPost("/api/quark/login/logout", undefined, { skip401: true });
  } catch {
    /* 后端不可达：本地照常置为未登录 */
  }
  quarkState.value = { logged_in: false };
  quarkBusy.value = false;
}

// 扫码登录成功：关弹窗 + 刷新状态
function onQuarkLoginSuccess() {
  quarkLoginOpen.value = false;
  refreshQuarkState();
}

onMounted(refreshQuarkState);
</script>

<style scoped>
/* 夸克账号行 */
.quark-account-row {
  align-items: center;
}
.quark-account-name {
  font-size: 13px;
  color: var(--text2);
}
</style>
