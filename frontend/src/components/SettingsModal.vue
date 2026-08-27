<template>
  <!-- 嵌入式模式（iOS 壳负一屏设置区）：无 Teleport、无 modal 外壳/遮罩/侧边导航，仅渲染当前 tab 面板内容区 -->
  <Teleport to="body" :disabled="embedded">
    <div v-if="open" class="modal-mask" :class="{ embedded }" @click.self="onMaskClick">
      <div class="modal" :class="{ embedded }">
        <!-- 头部（嵌入式隐藏：头部由 MobileSettings 提供） -->
        <div v-if="!embedded" class="modal-head">
          <button v-if="isMobile" class="modal-back" :title="t('settings.back')" @click="close">
            <ChevronDown :size="18" />
          </button>
          <Settings :size="16" />
          {{ t("settings.title") }}
          <span class="head-sub">QQ Player v{{ version }}</span>
          <button class="modal-close" :title="t('common.close')" @click="close">
            <X :size="16" />
          </button>
        </div>

        <!-- 主体：左导航 + 右内容（嵌入式隐藏左导航） -->
        <div class="modal-body" :class="{ embedded }">
          <nav v-if="!embedded" class="side-nav">
            <button
              v-for="c in categories"
              :key="c.key"
              class="nav-item"
              :class="{ on: tab === c.key }"
              @click="tab = c.key"
            >
              <component :is="c.icon" :size="15" />
              {{ t(c.labelKey) }}
            </button>
          </nav>

          <div class="content">
            <!-- ============ 播放 ============ -->
            <section v-if="tab === 'playback'" class="settings-scroll">
              <div class="group">
                <template v-for="e in playbackMain" :key="e.id">
                  <SettingRow v-if="!e.render" :entry="e" />
                  <!-- 切歌淡入淡出：开关联动滑杆（fadeSec > 0 才显示） -->
                  <div v-else-if="e.id === 'fadeSec'" class="setting-item">
                    <div class="toggle-row" @click="toggleFade">
                      <div>
                        <div class="setting-label">{{ t("settings.fade") }}</div>
                        <div class="setting-desc">{{ t("settings.fadeDesc") }}</div>
                      </div>
                      <span class="switch" :class="{ on: playbackSettings.fadeSec > 0 }"
                        ><i
                      /></span>
                    </div>
                    <div v-if="playbackSettings.fadeSec > 0" class="fade-row">
                      <span class="setting-desc">{{ t("settings.duration") }}</span>
                      <input
                        v-model.number="playbackSettings.fadeSec"
                        class="slider"
                        type="range"
                        min="0.5"
                        max="5"
                        step="0.5"
                      />
                      <span class="val-badge">{{ playbackSettings.fadeSec }}s</span>
                    </div>
                  </div>
                  <!-- EQ 面板：开关 + 预设 chips + 十段滑杆（eqEnabled 联动） -->
                  <div v-else-if="e.id === 'eqEnabled'" class="setting-item">
                    <div
                      class="toggle-row"
                      @click="playbackSettings.eqEnabled = !playbackSettings.eqEnabled"
                    >
                      <div>
                        <div class="setting-label">{{ t("settings.eq") }}</div>
                        <div class="setting-desc">{{ t("settings.eqDesc") }}</div>
                      </div>
                      <span class="switch" :class="{ on: playbackSettings.eqEnabled }"><i /></span>
                    </div>
                    <template v-if="playbackSettings.eqEnabled">
                      <div class="eq-presets">
                        <button
                          v-for="(p, key) in EQ_PRESETS"
                          :key="key"
                          class="ext-chip"
                          :class="{ on: playbackSettings.eqPreset === key }"
                          @click="setEqPreset(key)"
                        >
                          {{ t(p.labelKey) }}
                        </button>
                      </div>
                      <div class="eq-grid">
                        <div v-for="(f, i) in EQ_BANDS" :key="f" class="eq-cell">
                          <span class="eq-val"
                            >{{ playbackSettings.eqGains[i] > 0 ? "+" : ""
                            }}{{ playbackSettings.eqGains[i] }}</span
                          >
                          <input
                            class="eq-slider"
                            type="range"
                            min="-12"
                            max="12"
                            step="1"
                            :value="playbackSettings.eqGains[i]"
                            @input="setEqGain(i, ($event.target as HTMLInputElement).value)"
                          />
                          <span class="eq-band">{{ fmtBand(f) }}</span>
                        </div>
                      </div>
                    </template>
                  </div>
                  <!-- 视觉样式：总开关 + 氛围背景/迷你频谱子开关 + 样式 chips（visualizerEnabled 联动） -->
                  <div v-else-if="e.id === 'visualizerEnabled'" class="setting-item">
                    <div
                      class="toggle-row"
                      @click="
                        playbackSettings.visualizerEnabled = !playbackSettings.visualizerEnabled
                      "
                    >
                      <div>
                        <div class="setting-label">{{ t("settings.visualizer") }}</div>
                        <div class="setting-desc">{{ t("settings.visualizerDesc") }}</div>
                      </div>
                      <span class="switch" :class="{ on: playbackSettings.visualizerEnabled }"
                        ><i
                      /></span>
                    </div>
                    <template v-if="playbackSettings.visualizerEnabled">
                      <!-- 主区域：封面取色氛围背景（任务 C 混合方案） -->
                      <div
                        class="sub-toggle-row"
                        @click="playbackSettings.ambientEnabled = !playbackSettings.ambientEnabled"
                      >
                        <div>
                          <div class="setting-label sub">{{ t("settings.ambient") }}</div>
                          <div class="setting-desc sub">{{ t("settings.ambientDesc") }}</div>
                        </div>
                        <span class="switch sm" :class="{ on: playbackSettings.ambientEnabled }">
                          <i
                        /></span>
                      </div>
                      <!-- ControlBar：迷你频谱条 -->
                      <div
                        class="sub-toggle-row"
                        @click="
                          playbackSettings.miniSpectrumEnabled =
                            !playbackSettings.miniSpectrumEnabled
                        "
                      >
                        <div>
                          <div class="setting-label sub">{{ t("settings.miniSpectrum") }}</div>
                          <div class="setting-desc sub">{{ t("settings.miniSpectrumDesc") }}</div>
                        </div>
                        <span
                          class="switch sm"
                          :class="{ on: playbackSettings.miniSpectrumEnabled }"
                        >
                          <i
                        /></span>
                      </div>
                      <!-- 6 样式 chips：现在语义 = ControlBar 迷你频谱样式（主区域已是氛围背景，不再有样式） -->
                      <div
                        v-if="playbackSettings.miniSpectrumEnabled"
                        class="ext-grid viz-style-grid"
                      >
                        <button
                          v-for="s in VISUALIZER_STYLES"
                          :key="s.id"
                          class="ext-chip"
                          :class="{ on: playbackSettings.visualizerStyle === s.id }"
                          @click="playbackSettings.visualizerStyle = s.id"
                        >
                          {{ t(s.labelKey) }}
                        </button>
                      </div>
                    </template>
                  </div>
                </template>
              </div>

              <div class="group">
                <div class="group-title">
                  <Repeat2 :size="13" />
                  {{ t("settings.abLoop") }}
                </div>
                <template v-for="e in playbackAb" :key="e.id">
                  <SettingRow v-if="!e.render" :entry="e" />
                  <!-- AB 循环计数：开关 + 次数滑杆/步进器（abLoopCountOn 联动） -->
                  <div v-else-if="e.id === 'abLoopCountOn'" class="setting-item">
                    <div
                      class="toggle-row"
                      @click="playbackSettings.abLoopCountOn = !playbackSettings.abLoopCountOn"
                    >
                      <div>
                        <div class="setting-label">{{ t("settings.abLoopCount") }}</div>
                        <div class="setting-desc">{{ t("settings.abLoopCountDesc") }}</div>
                      </div>
                      <span class="switch" :class="{ on: playbackSettings.abLoopCountOn }"
                        ><i
                      /></span>
                    </div>
                    <div v-if="playbackSettings.abLoopCountOn" class="fade-row">
                      <span class="setting-desc">{{ t("settings.count") }}</span>
                      <input
                        v-model.number="playbackSettings.abLoopMaxCount"
                        class="slider"
                        type="range"
                        min="1"
                        max="20"
                        step="1"
                      />
                      <div class="stepper">
                        <button
                          class="step-btn"
                          :title="t('settings.minusOne')"
                          @click="stepAbMax(-1)"
                        >
                          −
                        </button>
                        <span class="val-badge">{{
                          t("settings.loopTimes", { n: playbackSettings.abLoopMaxCount })
                        }}</span>
                        <button
                          class="step-btn"
                          :title="t('settings.plusOne')"
                          @click="stepAbMax(1)"
                        >
                          ＋
                        </button>
                      </div>
                    </div>
                  </div>
                </template>
              </div>

              <div class="group">
                <div class="group-title">
                  <Timer :size="13" />
                  {{ t("settings.sleepTimer") }}
                </div>
                <template v-for="e in playbackSleep" :key="e.id">
                  <SettingRow v-if="!e.render" :entry="e" />
                  <!-- 睡眠定时器：开关启动/取消倒计时 + 时长 chips（sleepTimerOn 联动） -->
                  <div v-else-if="e.id === 'sleepTimerOn'" class="setting-item">
                    <div class="toggle-row" @click="toggleSleepTimer">
                      <div>
                        <div class="setting-label">{{ t("settings.sleepTimer") }}</div>
                        <div class="setting-desc">{{ t("settings.sleepTimerDesc") }}</div>
                      </div>
                      <span class="switch" :class="{ on: playbackSettings.sleepTimerOn }"
                        ><i
                      /></span>
                    </div>
                  </div>
                  <div
                    v-if="e.id === 'sleepTimerOn' && playbackSettings.sleepTimerOn"
                    class="setting-item"
                  >
                    <div class="setting-label">{{ t("settings.duration") }}</div>
                    <div class="ext-grid">
                      <button
                        v-for="m in SLEEP_TIMER_OPTIONS"
                        :key="m"
                        class="ext-chip"
                        :class="{ on: playbackSettings.sleepTimerMinutes === m }"
                        @click="setSleepTimerMinutes(m)"
                      >
                        {{ t("settings.minutes", { n: m }) }}
                      </button>
                    </div>
                  </div>
                </template>
              </div>
            </section>

            <!-- ============ 音乐库 ============ -->
            <section v-else-if="tab === 'library'" class="settings-scroll">
              <div class="group">
                <div class="group-title">
                  <FolderOpen :size="13" />
                  {{ t("settings.library") }}
                </div>
                <div class="setting-item">
                  <div class="setting-label">{{ t("settings.libraryFolder") }}</div>
                  <div class="setting-desc">{{ t("settings.libraryFolderDesc") }}</div>
                  <div class="setting-control">
                    <input
                      v-model="libInput"
                      class="lib-input"
                      placeholder="/Users/xxx/Music"
                      @keyup.enter="save"
                    />
                    <button v-if="isNative" class="btn" @click="browseLibrary">
                      {{ t("settings.browse") }}
                    </button>
                    <button class="btn primary" :disabled="saving" @click="save">
                      {{ saving ? t("settings.saving") : t("common.save") }}
                    </button>
                  </div>
                  <div v-if="error" class="setting-error">{{ error }}</div>
                </div>
              </div>

              <div class="group">
                <div class="group-title">
                  <FileAudio :size="13" />
                  {{ t("settings.fileTypes") }}
                </div>
                <template v-for="e in libraryFiles" :key="e.id">
                  <SettingRow v-if="!e.render" :entry="e" />
                  <!-- 音频格式多选 chips（audioExts 数组，至少保留一种） -->
                  <div v-else-if="e.id === 'audioExts'" class="setting-item">
                    <div class="setting-desc">{{ t("settings.fileTypesDesc") }}</div>
                    <div v-if="librarySettings" class="ext-grid">
                      <button
                        v-for="ext in audioExtOptions"
                        :key="ext"
                        class="ext-chip"
                        :class="{ on: librarySettings.audioExts.includes(ext) }"
                        @click="toggleExt(ext)"
                      >
                        {{ ext.slice(1).toUpperCase() }}
                      </button>
                    </div>
                  </div>
                </template>
              </div>
            </section>

            <!-- ============ 视频 ============ -->
            <section v-else-if="tab === 'video'" class="settings-scroll">
              <div class="group">
                <div class="group-title">
                  <Video :size="13" />
                  {{ t("settings.video") }}
                </div>
                <template v-for="e in videoEntries" :key="e.id">
                  <SettingRow v-if="!e.render" :entry="e" />
                  <!-- 浏览器 Cookie 来源：原生 select（照抄原模板） -->
                  <div v-else-if="e.id === 'cookiesFromBrowser'" class="setting-item">
                    <div class="setting-label">{{ t("settings.cookiesFromBrowser") }}</div>
                    <div class="setting-desc">{{ t("settings.cookiesFromBrowserDesc") }}</div>
                    <div class="setting-control">
                      <select v-model="videoSettings.cookiesFromBrowser" class="lib-input">
                        <option value="">{{ t("settings.cookiesFromBrowserNone") }}</option>
                        <option value="vivaldi">Vivaldi</option>
                        <option value="chrome">Chrome</option>
                        <option value="safari">Safari</option>
                        <option value="edge">Edge</option>
                        <option value="firefox">Firefox</option>
                        <option value="brave">Brave</option>
                      </select>
                    </div>
                  </div>
                </template>
              </div>
            </section>

            <!-- ============ 下载 ============ -->
            <section v-else-if="tab === 'download'" class="settings-scroll">
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
                      <button
                        class="btn primary"
                        :disabled="quarkBusy"
                        @click="quarkLoginOpen = true"
                      >
                        {{ t("settings.quarkLogin") }}
                      </button>
                    </template>
                  </div>
                </div>
              </div>
            </section>

            <!-- ============ 同步（iOS 壳 → 负一屏同步中心入口；非 iOS 保留现状） ============ -->
            <section v-else-if="tab === 'sync'" class="settings-scroll">
              <template v-if="!embedded && isNative && isMobile">
                <div class="group">
                  <div class="group-title">
                    <RefreshCw :size="13" />
                    {{ t("settings.sync") }}
                  </div>
                  <div class="setting-item">
                    <div class="setting-label">{{ t("settings.openSyncCenter") }}</div>
                    <div class="setting-desc">{{ t("settings.openSyncCenterDesc") }}</div>
                    <div class="setting-control">
                      <button class="btn primary" @click="$emit('open-sync')">
                        {{ t("settings.openSyncCenterGo") }}
                      </button>
                    </div>
                  </div>
                </div>
              </template>
              <div v-else class="group">
                <div class="group-title">
                  <MonitorSmartphone :size="13" />
                  {{ t("settings.devicePanelTitle") }}
                </div>
                <div class="setting-item">
                  <div class="setting-desc">{{ t("settings.devicePanelDesc") }}</div>
                </div>

                <!-- 加载失败兑底（后端未启动等） -->
                <div v-if="syncPanelError" class="setting-item">
                  <div class="setting-desc sync-error">{{ syncPanelError }}</div>
                  <div class="setting-control">
                    <button class="btn" @click="loadDevicePanel">
                      {{ t("settings.refresh") }}
                    </button>
                  </div>
                </div>
                <div v-else-if="syncPanelLoading" class="setting-item">
                  <div class="setting-desc">{{ t("settings.devicePanelLoading") }}</div>
                </div>
                <template v-else>
                  <!-- ============ 设备区块 ============ -->
                  <div v-if="!syncDevices.length" class="setting-item">
                    <div class="setting-label">{{ t("settings.noDevices") }}</div>
                    <div class="setting-desc">{{ t("settings.noDevicesHint") }}</div>
                  </div>
                  <div
                    v-for="d in syncDevices"
                    :key="d.device_id"
                    class="sync-device"
                    :data-testid="'sync-device-' + d.device_id"
                  >
                    <div class="sync-device-head" @click="toggleDeviceAssets(d)">
                      <ChevronRight
                        :size="14"
                        class="sync-chevron"
                        :class="{ open: deviceExpanded(d) }"
                      />
                      <Smartphone :size="14" class="sync-device-icon" />
                      <span class="sync-device-name">{{ deviceName(d) }}</span>
                      <span class="sync-device-meta">
                        {{ t("settings.deviceLastSeen") }} {{ fmtLastSeen(d.last_seen) }}
                      </span>
                    </div>
                    <div class="sync-device-stats">
                      <span class="sync-stat">
                        {{ t("settings.deviceTotal") }}：{{ formatBytes(d.total) }} ·
                        {{ t("settings.deviceFiles", { n: assetCount(d) }) }}
                      </span>
                      <span v-for="(n, k) in byTypeEntries(d)" :key="k" class="sync-type-chip">
                        {{ t("settings.deviceType." + k) }} {{ n }}
                      </span>
                    </div>
                    <!-- 资产列表（懒渲染：展开时才挂 DOM） -->
                    <div v-if="deviceExpanded(d)" class="sync-assets">
                      <div v-if="!assetList(d).length" class="setting-desc">
                        {{ t("settings.deviceNoAssets") }}
                      </div>
                      <label v-for="a in assetList(d)" :key="a.path" class="sync-asset-row">
                        <input
                          type="checkbox"
                          :checked="assetSelected(d.device_id, a.path)"
                          @change="toggleAsset(d.device_id, a.path)"
                        />
                        <span class="sync-asset-path" :title="a.path">{{ a.path }}</span>
                        <span class="sync-asset-size">{{ formatBytes(a.size) }}</span>
                      </label>
                      <div v-if="selectedAssetCount(d.device_id)" class="sync-asset-actions">
                        <button
                          class="btn danger"
                          :disabled="syncDeleting"
                          @click="askDeleteAssets(d)"
                        >
                          {{ t("settings.deleteAssets") }} ({{ selectedAssetCount(d.device_id) }})
                        </button>
                      </div>
                    </div>
                  </div>

                  <!-- ============ 指令历史区块 ============ -->
                  <div class="sync-cmd-head">
                    <span class="sync-cmd-title">
                      <RefreshCw :size="12" />
                      {{ t("settings.commandHistory") }}
                    </span>
                    <button class="mini-btn" :disabled="syncPanelLoading" @click="loadDevicePanel">
                      {{ t("settings.refresh") }}
                    </button>
                  </div>
                  <div v-if="!syncCommands.length" class="setting-desc">
                    {{ t("settings.commandHistoryEmpty") }}
                  </div>
                  <table v-else class="sync-cmds">
                    <thead>
                      <tr>
                        <th>{{ t("settings.commandColType") }}</th>
                        <th>{{ t("settings.commandColStatus") }}</th>
                        <th>{{ t("settings.commandColTarget") }}</th>
                        <th>{{ t("settings.commandColCreated") }}</th>
                        <th>{{ t("settings.commandColAck") }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="c in syncCommands" :key="c.id" :data-testid="'sync-cmd-' + c.id">
                        <td>{{ commandTypeLabel(c.type) }}</td>
                        <td>
                          <span class="sync-status" :class="'st-' + String(c.status || 'unknown')">
                            {{ commandStatusLabel(c.status) }}
                          </span>
                        </td>
                        <td class="sync-cmd-target">
                          {{ c.device_id ? c.device_id : t("settings.commandTarget.all") }}
                        </td>
                        <td>{{ fmtTime(c.created_at) }}</td>
                        <td>{{ fmtTime(c.ack_at) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </template>
              </div>
            </section>

            <!-- ============ 刮削 ============ -->
            <section v-else-if="tab === 'scrape'" class="settings-scroll">
              <!-- 刮削字段 -->
              <div class="group">
                <div class="group-title">
                  <Tags :size="13" />
                  {{ t("settings.scrapeFields") }}
                </div>
                <div class="setting-item">
                  <div class="setting-desc">{{ t("settings.scrapeFieldsDesc") }}</div>
                  <div class="scrape-fields">
                    <label v-for="f in scrapeFieldOptions" :key="f.key" class="scrape-field">
                      <input
                        type="checkbox"
                        :checked="scrapingSettings.enabled_fields.includes(f.key)"
                        :data-testid="'scrape-field-' + f.key"
                        @change="toggleScrapeField(f.key)"
                      />
                      <span>{{ t(f.labelKey) }}</span>
                    </label>
                  </div>
                </div>
              </div>

              <!-- 重命名规则 -->
              <div class="group">
                <div class="group-title">
                  <Type :size="13" />
                  {{ t("settings.renameTemplate") }}
                </div>
                <div class="setting-item">
                  <div class="setting-desc">{{ t("settings.renameTemplateDesc") }}</div>
                  <div class="setting-control">
                    <input
                      v-model="scrapingSettings.rename_template"
                      class="lib-input"
                      type="text"
                      spellcheck="false"
                      :placeholder="'{artist} - {title}'"
                      data-testid="rename-template-input"
                      @change="scheduleScrapeSave"
                    />
                  </div>
                  <div class="setting-desc scrape-tokens">{{ t("settings.renameTokens") }}</div>
                  <div class="setting-desc scrape-tokens">{{ t("settings.renameSlashHint") }}</div>
                  <div class="scrape-preview">
                    <span class="setting-desc">{{ t("settings.renamePreview") }}</span>
                    <span class="scrape-preview-val" data-testid="rename-preview">{{
                      renamePreview
                    }}</span>
                  </div>
                </div>
              </div>

              <!-- 源优先级 -->
              <div class="group">
                <div class="group-title">
                  <RefreshCw :size="13" />
                  {{ t("settings.sourceOrder") }}
                </div>
                <div class="setting-item">
                  <div class="setting-desc">{{ t("settings.sourceOrderDesc") }}</div>
                  <div class="source-order">
                    <div
                      v-for="(src, i) in scrapingSettings.source_order"
                      :key="src"
                      class="source-row"
                    >
                      <span class="source-name">{{ t("settings.sourceName." + src) }}</span>
                      <span class="source-rank">{{ i + 1 }}</span>
                      <div class="source-arrows">
                        <button
                          class="mini-btn"
                          :disabled="i === 0"
                          :title="t('settings.sourceUp')"
                          data-testid="source-up"
                          @click="moveSource(src, -1)"
                        >
                          <ChevronUp :size="13" />
                        </button>
                        <button
                          class="mini-btn"
                          :disabled="i === scrapingSettings.source_order.length - 1"
                          :title="t('settings.sourceDown')"
                          data-testid="source-down"
                          @click="moveSource(src, 1)"
                        >
                          <ChevronDown :size="13" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 批量刮削 -->
              <div class="group">
                <div class="group-title">
                  <Sparkles :size="13" />
                  {{ t("settings.batchScrape") }}
                </div>
                <div class="setting-item">
                  <div class="toggle-row" @click="toggleBatchEnabled">
                    <div>
                      <div class="setting-label">{{ t("settings.batchScrape") }}</div>
                      <div class="setting-desc">{{ t("settings.batchScrapeDesc") }}</div>
                    </div>
                    <span class="switch" :class="{ on: scrapingSettings.batch_enabled }"
                      ><i
                    /></span>
                  </div>
                  <div v-if="scrapingSettings.batch_enabled" class="setting-control">
                    <button
                      class="btn primary"
                      :disabled="scrapeBatchState.loading"
                      data-testid="batch-library-btn"
                      @click="onBatchLibrary"
                    >
                      <Loader2 v-if="scrapeBatchState.loading" :size="13" class="spin" />
                      {{ batchArmed ? t("settings.batchArmed") : t("settings.batchLibraryGo") }}
                    </button>
                  </div>
                  <div v-if="scrapeError" class="setting-error" data-testid="scrape-error">
                    {{ scrapeError }}
                  </div>
                </div>
              </div>

              <!-- 插件占位 -->
              <div class="group">
                <div class="group-title">
                  <Zap :size="13" />
                  {{ t("settings.plugin") }}
                </div>
                <div class="setting-item disabled">
                  <div class="setting-label">{{ t("settings.pluginScrapeSource") }}</div>
                  <div class="setting-desc">{{ t("settings.pluginScrapeSourceDesc") }}</div>
                </div>
              </div>
            </section>

            <!-- ============ 歌词 ============ -->
            <section v-else-if="tab === 'lyric'" class="settings-scroll">
              <!-- 子 tab：APP 歌词 / 桌面歌词（桌面歌词是桌面壳功能，移动端隐藏子 tab——审计 L1） -->
              <div class="lyric-subtabs">
                <button
                  class="seg-btn"
                  :class="{ on: lyricSubTab === 'app' }"
                  @click="lyricSubTab = 'app'"
                >
                  {{ t("settings.lyricApp") }}
                </button>
                <button
                  v-if="!isMobile"
                  class="seg-btn"
                  :class="{ on: lyricSubTab === 'desktop' }"
                  @click="lyricSubTab = 'desktop'"
                >
                  {{ t("settings.lyricDesktop") }}
                </button>
              </div>

              <template v-if="lyricSubTab === 'app'">
                <!-- 外观排版 -->
                <div class="group">
                  <div class="group-title">
                    <Type :size="13" />
                    {{ t("settings.lyricAppearance") }}
                  </div>
                  <SettingRow v-for="e in lyricAppearance" :key="e.id" :entry="e" />
                </div>

                <!-- 显示内容 -->
                <div class="group">
                  <div class="group-title">
                    <Eye :size="13" />
                    {{ t("settings.lyricDisplay") }}
                  </div>
                  <SettingRow v-for="e in lyricDisplay" :key="e.id" :entry="e" />
                </div>

                <!-- 效果行为 -->
                <div class="group">
                  <div class="group-title">
                    <Sparkles :size="13" />
                    {{ t("settings.lyricEffects") }}
                  </div>
                  <SettingRow v-for="e in lyricEffects" :key="e.id" :entry="e" />
                  <!-- AMLL 三特效（仅 amll 引擎生效）：壳内默认开 = 满血；浏览器默认关防 CPU 高占用 -->
                  <div class="amll-head">
                    <span class="amll-head-label">{{ t("settings.amllEffects") }}</span>
                    <button
                      class="amll-info-btn"
                      :class="{ on: amllPerfHintOpen }"
                      :title="t('settings.amllPerfHint')"
                      :aria-expanded="amllPerfHintOpen ? 'true' : 'false'"
                      @click="amllPerfHintOpen = !amllPerfHintOpen"
                    >
                      <Info :size="13" />
                    </button>
                  </div>
                  <div v-if="amllPerfHintOpen" class="setting-desc hint amll-perf-hint">
                    {{ t("settings.amllPerfHint") }}
                  </div>
                  <SettingRow v-for="e in lyricAmll" :key="e.id" :entry="e" />
                </div>

                <!-- 时间校准 -->
                <div class="group">
                  <div class="group-title">
                    <Timer :size="13" />
                    {{ t("settings.lyricCalib") }}
                  </div>
                  <template v-for="e in lyricCalib" :key="e.id">
                    <SettingRow v-if="!e.render" :entry="e" />
                    <!-- 歌词延迟：徽标 + 一键归零 + 滑杆（offset 特殊显示） -->
                    <div v-else-if="e.id === 'offset'" class="setting-item">
                      <div class="setting-label">
                        {{ t("settings.lyricOffset") }}
                        <span class="val-badge">{{ fmtOffset }}</span>
                        <button
                          v-if="lyricSettings.offset !== 0"
                          class="mini-btn"
                          @click="lyricSettings.offset = 0"
                        >
                          {{ t("settings.reset") }}
                        </button>
                      </div>
                      <div class="setting-desc">
                        {{ t("settings.lyricOffsetDesc") }}
                      </div>
                      <input
                        v-model.number="lyricSettings.offset"
                        class="slider"
                        type="range"
                        min="-2"
                        max="2"
                        step="0.1"
                      />
                    </div>
                  </template>
                </div>

                <!-- 歌词来源 -->
                <div class="group">
                  <div class="group-title">
                    <Database :size="13" />
                    {{ t("settings.lyricSource") }}
                  </div>
                  <SettingRow v-for="e in lyricSource" :key="e.id" :entry="e" />
                </div>

                <!-- APP 歌词配色（参照桌面歌词） -->
                <div class="group">
                  <div class="group-title">
                    <Palette :size="13" />
                    {{ t("settings.colorSchemeGroup") }}
                  </div>
                  <template v-for="e in lyricColors" :key="e.id">
                    <SettingRow v-if="!e.render" :entry="e" />
                    <!-- 配色方案 swatches（applyLyricScheme 联动清除自定义色） -->
                    <div v-else-if="e.id === 'colorScheme'" class="setting-item">
                      <div class="setting-label">{{ t("settings.colorScheme") }}</div>
                      <div class="desktop-schemes">
                        <button
                          v-for="sc in LYRIC_SCHEMES"
                          :key="sc.key"
                          class="scheme-swatch"
                          :class="{ on: lyricSettings.colorScheme === sc.key }"
                          :title="t(sc.labelKey)"
                          @click="applyLyricScheme(sc)"
                        >
                          <span
                            class="scheme-dot"
                            :style="{ background: sc.jp || 'var(--accent)' }"
                          />
                          <span
                            class="scheme-dot"
                            :style="{ background: sc.zh || 'var(--text2)' }"
                          />
                          <span class="scheme-name">{{ t(sc.labelKey) }}</span>
                        </button>
                      </div>
                    </div>
                    <!-- 字体颜色（主行/翻译两个色块 + 清除自定义） -->
                    <div v-else-if="e.id === 'jpColor'" class="setting-item">
                      <div class="setting-label">{{ t("settings.fontColor") }}</div>
                      <div class="desktop-colors">
                        <label class="color-field">
                          <span>{{ t("settings.mainLine") }}</span>
                          <input v-model="lyricSettings.jpColor" type="color" class="color-input" />
                        </label>
                        <label class="color-field">
                          <span>{{ t("settings.translation") }}</span>
                          <input v-model="lyricSettings.zhColor" type="color" class="color-input" />
                        </label>
                        <button
                          v-if="lyricSettings.jpColor || lyricSettings.zhColor"
                          class="mini-btn"
                          @click="
                            lyricSettings.jpColor = '';
                            lyricSettings.zhColor = '';
                          "
                        >
                          {{ t("settings.clearCustom") }}
                        </button>
                      </div>
                      <div class="setting-desc">
                        {{ t("settings.fontColorDesc") }}
                      </div>
                    </div>
                  </template>
                </div>
              </template>

              <!-- ============ 桌面歌词（子 tab；移动端不可达：子 tab 按钮已隐藏，此处显式守卫防未来代码直达） ============ -->
              <template v-else-if="lyricSubTab === 'desktop' && !isMobile">
                <div class="group">
                  <div class="group-title">
                    <MonitorPlay :size="13" />
                    {{ t("settings.lyricDesktop") }}
                  </div>
                  <template v-for="e in desktopEntries" :key="e.id">
                    <SettingRow v-if="!e.render" :entry="e" />
                    <!-- 配色方案 swatches（applyScheme 联动清除自定义色） -->
                    <div v-else-if="e.id === 'desktopColorScheme'" class="setting-item">
                      <div class="setting-label">{{ t("settings.colorScheme") }}</div>
                      <div class="desktop-schemes">
                        <button
                          v-for="sc in DESKTOP_LYRIC_SCHEMES"
                          :key="sc.key"
                          class="scheme-swatch"
                          :class="{ on: desktopLyricSettings.colorScheme === sc.key }"
                          :title="t(sc.labelKey)"
                          @click="applyScheme(sc)"
                        >
                          <span class="scheme-dot" :style="{ background: sc.jp }" />
                          <span class="scheme-dot" :style="{ background: sc.zh }" />
                          <span class="scheme-name">{{ t(sc.labelKey) }}</span>
                        </button>
                      </div>
                    </div>
                    <!-- 字体颜色（主行/翻译两个色块，桌面版无清除按钮） -->
                    <div v-else-if="e.id === 'desktopJpColor'" class="setting-item">
                      <div class="setting-label">{{ t("settings.fontColor") }}</div>
                      <div class="desktop-colors">
                        <label class="color-field">
                          <span>{{ t("settings.mainLine") }}</span>
                          <input
                            v-model="desktopLyricSettings.jpColor"
                            type="color"
                            class="color-input"
                          />
                        </label>
                        <label class="color-field">
                          <span>{{ t("settings.translation") }}</span>
                          <input
                            v-model="desktopLyricSettings.zhColor"
                            type="color"
                            class="color-input"
                          />
                        </label>
                      </div>
                    </div>
                  </template>
                  <div class="setting-item">
                    <button class="desktop-reset-btn" @click="resetDesktopLyric">
                      <RotateCcw :size="13" />
                      {{ t("settings.resetDesktopLyric") }}
                    </button>
                  </div>
                  <div class="setting-item">
                    <div class="setting-label">{{ t("settings.openMethod") }}</div>
                    <div class="setting-desc">
                      {{ t("settings.openMethodDesc") }}
                    </div>
                  </div>
                </div>
              </template>
            </section>

            <!-- ============ 界面 ============ -->
            <section v-else-if="tab === 'ui'" class="settings-scroll">
              <div class="group">
                <div class="group-title">
                  <LayoutGrid :size="13" />
                  {{ t("settings.uiPrefs") }}
                </div>
                <SettingRow v-for="e in uiPrefs" :key="e.id" :entry="e" :mobile="isMobile" />
                <!-- 卡拉OK跟唱模式：播放器状态（非设置字段），保留手写 -->
                <div class="setting-item">
                  <div class="toggle-row" @click="state.karaokeOn = !state.karaokeOn">
                    <div>
                      <div class="setting-label">{{ t("settings.karaokeOn") }}</div>
                      <div class="setting-desc">{{ t("settings.karaokeOnDesc") }}</div>
                    </div>
                    <span class="switch" :class="{ on: state.karaokeOn }"><i /></span>
                  </div>
                </div>
                <template v-for="e in uiCover" :key="e.id">
                  <SettingRow v-if="!e.render" :entry="e" :mobile="isMobile" />
                  <!-- 封面区域大小：自适应（0）或手动固定值（140~420）；滑块联动 + 恢复默认回自适应 -->
                  <div
                    v-else-if="e.id === 'coverSize' && uiSettings.showCover && !isMobile"
                    class="setting-item"
                  >
                    <div class="setting-label">
                      {{ t("settings.coverSize") }}
                      <span class="val-badge">
                        {{ coverSizeLabel }}
                      </span>
                      <button
                        v-if="uiSettings.coverSize !== 0"
                        class="mini-btn"
                        @click="resetCoverSize()"
                      >
                        {{ t("settings.resetCoverSize") }}
                      </button>
                    </div>
                    <div class="setting-desc">{{ t("settings.coverSizeDesc") }}</div>
                    <input
                      v-model.number="coverSizeSlider"
                      class="slider"
                      type="range"
                      :min="COVER_MIN"
                      :max="COVER_MAX"
                      step="10"
                    />
                  </div>
                </template>
              </div>

              <!-- 主题与强调色 -->
              <div class="group">
                <div class="group-title">
                  <Palette :size="13" />
                  {{ t("settings.themeAccent") }}
                </div>
                <template v-for="e in uiTheme" :key="e.id">
                  <SettingRow v-if="!e.render" :entry="e" />
                  <!-- 强调色预设（色板） -->
                  <div v-else-if="e.id === 'accent'" class="setting-item">
                    <div class="setting-label">{{ t("settings.accent") }}</div>
                    <div class="accent-grid">
                      <button
                        v-for="a in ACCENT_OPTIONS"
                        :key="a.key"
                        class="accent-swatch"
                        :class="{ on: uiSettings.accent === a.key }"
                        :style="{ '--swatch': a.color, '--swatch2': a.color2 }"
                        :title="a.key"
                        @click="uiSettings.accent = a.key"
                      />
                    </div>
                  </div>
                </template>
              </div>
            </section>

            <!-- ============ 快捷键 ============ -->
            <section v-else-if="tab === 'shortcuts'" class="settings-scroll">
              <div class="group">
                <div class="group-title">
                  <Keyboard :size="13" />
                  {{ t("settings.keyboardShortcuts") }}
                </div>
                <div v-for="cat in SHORTCUT_CATEGORIES" :key="cat.key" class="shortcut-cat">
                  <div class="group-title sub-title">
                    {{ t(cat.labelKey) }}
                    <span class="sub-note">{{ t("settings.clickToRecord") }}</span>
                  </div>
                  <div
                    v-for="s in shortcutsOf(cat.key)"
                    :key="s.id"
                    class="shortcut-item editable"
                    :class="{ recording: recording === s.id }"
                    :title="t('settings.clickToSetKey')"
                    @click="startRecord(s.id)"
                  >
                    <span class="shortcut-desc">{{ t(s.labelKey) }}</span>
                    <span class="shortcut-keys">
                      <kbd v-if="recording === s.id" class="recording-kbd">{{
                        t("settings.pressNewKey")
                      }}</kbd>
                      <kbd v-else>{{ fmtSetting(s) }}</kbd>
                    </span>
                  </div>
                </div>
                <div class="setting-desc hint">{{ t("settings.recordHintAll") }}</div>
              </div>
              <div class="group">
                <div class="group-title">
                  <MonitorPlay :size="13" />
                  {{ t("settings.mediaKeys") }}
                </div>
                <div class="shortcut-item">
                  <span class="shortcut-desc">{{ t("settings.mediaKeysDesc") }}</span>
                  <span class="shortcut-keys">
                    <kbd>{{ t("settings.mediaPlayPause") }}</kbd>
                    <kbd>{{ t("settings.mediaPrev") }}</kbd>
                    <kbd>{{ t("settings.mediaNext") }}</kbd>
                    <kbd>{{ t("settings.mediaStop") }}</kbd>
                  </span>
                </div>
                <div class="setting-desc hint">
                  {{ t("settings.mediaKeysHint") }}
                </div>
              </div>
            </section>

            <!-- ============ 配对（iOS 壳隐藏） ============ -->
            <section v-else-if="tab === 'pairing'" class="settings-scroll">
              <PairingSettings />
            </section>

            <!-- ============ 关于 ============ -->
            <section v-else class="settings-scroll">
              <div class="group">
                <div class="group-title">
                  <Info :size="13" />
                  {{ t("settings.about") }}
                </div>
                <div class="about-author">
                  <img
                    class="about-logo"
                    src="https://github.com/daxmate.png?size=96"
                    alt="daxmate"
                  />
                  <div class="about-author-info">
                    <div class="about-name">daxmate</div>
                    <div class="about-tagline">{{ t("settings.aboutTagline") }}</div>
                  </div>
                </div>
                <div class="about-item">
                  <span class="about-label">{{ t("settings.version") }}</span>
                  <span class="about-value about-version" @click="onVersionClick"
                    >v{{ version }}</span
                  >
                </div>
                <div class="about-item">
                  <span class="about-label">{{ t("settings.dataDir") }}</span>
                  <span class="about-value mono">{{ dataDir }}</span>
                </div>
                <div class="about-item">
                  <span class="about-label">{{ t("settings.localAccess") }}</span>
                  <a class="about-value mono link" :href="localUrl" target="_blank">{{
                    localUrl
                  }}</a>
                </div>
                <div class="about-item">
                  <span class="about-label">{{ t("settings.repoHome") }}</span>
                  <a class="about-value mono link" :href="repoUrl" target="_blank"
                    >github.com/daxmate/qqplayer</a
                  >
                </div>
                <p class="about-desc">
                  {{ t("settings.aboutDesc") }}
                </p>
                <p v-if="eggVisible" class="about-easter-egg">🐘</p>
              </div>
            </section>
          </div>
        </div>

        <!-- 底部操作栏 -->
        <div class="modal-foot">
          <button class="reset-btn" :title="t('settings.resetAllTitle')" @click="resetAll">
            <RotateCcw :size="13" />
            {{ t("settings.resetAll") }}
          </button>
          <button class="btn primary" @click="close">{{ t("settings.done") }}</button>
        </div>
      </div>

      <!-- 夸克扫码登录（设置页登录入口；成功后刷新账号状态） -->
      <QuarkLoginModal
        :open="quarkLoginOpen"
        @success="onQuarkLoginSuccess"
        @close="quarkLoginOpen = false"
      />

      <!-- 批量刮削结果面板（多选批量 / 一键整库共用） -->
      <ScrapeResultModal />

      <!-- 删除选中资产确认弹窗（桌面端设备管理面板） -->
      <Teleport to="body">
        <div v-if="deleteConfirm" class="sync-mask" @mousedown.self="cancelDeleteAssets">
          <div
            class="sync-dialog"
            role="alertdialog"
            :aria-label="t('settings.deleteAssetsConfirm')"
          >
            <h3 class="sync-dialog-title">
              <Trash2 :size="15" />
              {{ t("settings.deleteAssetsConfirm") }}
            </h3>
            <p class="sync-dialog-text">
              {{ t("settings.deleteAssetsConfirmDesc", { n: deleteConfirm.paths.length }) }}
            </p>
            <div class="sync-dialog-btns">
              <button class="sync-dialog-btn" :disabled="syncDeleting" @click="cancelDeleteAssets">
                {{ t("common.cancel") }}
              </button>
              <button
                class="sync-dialog-btn danger"
                :disabled="syncDeleting"
                @click="confirmDeleteAssets"
              >
                {{ syncDeleting ? t("settings.devicePanelLoading") : t("common.confirm") }}
              </button>
            </div>
          </div>
        </div>
      </Teleport>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { useShellBridge } from "../composables/useShellBridge.js";
import {
  Settings,
  X,
  ChevronDown,
  FolderOpen,
  Type,
  Eye,
  Sparkles,
  LayoutGrid,
  Keyboard,
  Info,
  RotateCcw,
  MonitorPlay,
  Timer,
  Database,
  FileAudio,
  Palette,
  Repeat2,
  RefreshCw,
  Download,
  Video,
  Smartphone,
  Zap,
  Tags,
  ChevronUp,
  ChevronRight,
  MonitorSmartphone,
  Loader2,
} from "@lucide/vue";
import {
  state,
  setLibrary,
  loadLibrary,
  loadLibrarySettings,
  saveLibrarySettings,
  lyricSettings,
  uiSettings,
  playbackSettings,
  EQ_PRESETS,
  EQ_BANDS,
  setEqPreset,
  setEqGain,
  desktopLyricSettings,
  downloadSettings,
  DOWNLOAD_SETTINGS_DEFAULTS,
  videoSettings,
  VIDEO_SETTINGS_DEFAULTS,
  resetLyricSettingsToDefaults,
  UI_SETTINGS_DEFAULTS,
  PLAYBACK_SETTINGS_DEFAULTS,
  DESKTOP_LYRIC_DEFAULTS,
  DESKTOP_LYRIC_SCHEMES,
  LYRIC_SCHEMES,
  ACCENT_OPTIONS,
  SHORTCUTS,
  SHORTCUT_CATEGORIES,
  VISUALIZER_STYLES,
  fmtShortcutKey,
  parseShortcutCombo,
} from "../composables/usePlayer.js";
import { showToast } from "../composables/useToast.js";
import { getSettingsCategories } from "../composables/useSettingsCategories.js";
import {
  fetchDevices,
  fetchCommandHistory,
  deleteAssetsFromDevice,
  formatBytes,
  formatLastSeen,
} from "../utils/deviceCommands.js";
import { apiGet, apiPost } from "../utils/apiClient.js";
import { isMobile } from "../composables/useMobileViewport.js";
import {
  COVER_MIN,
  COVER_MAX,
  COVER_DEFAULT,
  resetCoverSize,
} from "../composables/useCoverSize.js";
import {
  SLEEP_TIMER_OPTIONS,
  toggleSleepTimer,
  setSleepTimerMinutes,
} from "../composables/useSleepTimer.js";
import QuarkLoginModal from "./QuarkLoginModal.vue";
import PairingSettings from "./PairingSettings.vue";
import ScrapeResultModal from "./ScrapeResultModal.vue";
import SettingRow from "./SettingRow.vue";
import { entriesByCategory, type SettingEntry } from "../settingsIndex";
import {
  scrapingSettings,
  SCRAPING_FIELDS,
  loadScrapingSettings,
  saveScrapingSettings,
  renderRenamePreview,
} from "../composables/useScrapingSettings.js";
import { scrapeBatchState, runScrapeBatch } from "../composables/useScrapeBatch.js";
import pkg from "../../package.json";

const props = defineProps({
  open: { type: Boolean, default: false },
  // 嵌入式面板模式（iOS 壳负一屏设置区）：无 modal 外壳/遮罩/导航，仅渲染当前 tab 面板；
  // 配合 initialTab（进入时定位面板）使用；桌面弹窗行为不变。
  embedded: { type: Boolean, default: false },
  initialTab: { type: String, default: "ui" },
});
const emit = defineEmits(["close", "open-sync"]);

const { t } = useI18n();

const version = pkg.version;

// ---- 关于页彩蛋：连点版本号 5 次 → 🐘 ----
const eggVisible = ref(false);
let eggClicks = 0;
let eggTimer: number | null = null;
function onVersionClick() {
  eggClicks++;
  clearTimeout(eggTimer ?? undefined);
  eggTimer = setTimeout(() => (eggClicks = 0), 1500);
  if (eggClicks >= 5) {
    eggClicks = 0;
    eggVisible.value = true;
    setTimeout(() => (eggVisible.value = false), 3200);
    window.alert(t("settings.aboutEasterEggText"));
  }
}

const dataDir = "~/Library/Application Support/qqplayer";
const localUrl = "http://localhost:17627";
const repoUrl = "https://github.com/daxmate/qqplayer";

const tab = ref(props.initialTab);
const lyricSubTab = ref("app"); // 歌词 tab 子页：'app' APP 歌词 | 'desktop' 桌面歌词
const amllPerfHintOpen = ref(false); // AMLL 三特效性能提示（info 按钮）展开状态
const libInput = ref("");
const saving = ref(false);
const error = ref("");

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

// ============ 设备管理面板（sync tab · 桌面端管理端） ============
// 设备指令队列（写指令让 iOS 推送下载/远程删除）+ 可见 iOS 资产清单。
const syncDevices = ref<any[]>([]);
const syncCommands = ref<any[]>([]);
const syncPanelLoading = ref(true);
const syncPanelError = ref("");
const expandedDeviceIds = ref<string[]>([]); // 已展开资产列表的设备 id
const assetSelection = ref<Record<string, Record<string, boolean>>>({}); // { [device_id]: { [path]: true } }
const deleteConfirm = ref<{ device: any; paths: string[] } | null>(null); // {device, paths} | null（确认弹窗目标）
const syncDeleting = ref(false);

// 进入 sync tab / 刷新：并行拉设备清单 + 指令历史（失败兑底文案，不阻塞其他 tab）
async function loadDevicePanel() {
  syncPanelLoading.value = true;
  syncPanelError.value = "";
  const [dr, cr] = await Promise.all([fetchDevices(), fetchCommandHistory()]);
  syncPanelLoading.value = false;
  if (dr.ok) {
    syncDevices.value = dr.devices;
  } else {
    syncDevices.value = [];
    syncPanelError.value = t("settings.syncFetchFailed");
  }
  syncCommands.value = cr.ok ? cr.commands : [];
  // 刷新后清空展开态与勾选（设备列表可能已变化）
  expandedDeviceIds.value = [];
  assetSelection.value = {};
}

// 展示名：device_name 非空用设备名，空则取 device_id 前 8 位
function deviceName(d: any) {
  if (d && d.device_name && String(d.device_name).trim()) return String(d.device_name).trim();
  return d && d.device_id ? String(d.device_id).slice(0, 8) : t("settings.noDevices");
}

function assetList(d: any) {
  return Array.isArray(d && d.assets) ? d.assets : [];
}

function assetCount(d: any) {
  if (d && typeof d.assets_count === "number") return d.assets_count;
  return assetList(d).length;
}

// byType 细分（音频/封面/图书/词典）：按已知键顺序展示，未知键忽略
const TYPE_ORDER = ["audio", "cover", "books", "dicts"];
function byTypeEntries(d: any) {
  const by = (d && d.byType) || {};
  const out: Record<string, unknown> = {};
  for (const k of TYPE_ORDER) {
    if (Number(by[k]) > 0) out[k] = by[k];
  }
  return out;
}

function deviceExpanded(d: any) {
  return expandedDeviceIds.value.includes(d.device_id);
}

// 展开/收起资产列表（懒渲染：仅展开时挂 DOM；收起时清空勾选）
function toggleDeviceAssets(d: any) {
  const id = d.device_id;
  const i = expandedDeviceIds.value.indexOf(id);
  if (i >= 0) {
    expandedDeviceIds.value.splice(i, 1);
    const sel = assetSelection.value;
    if (sel[id]) delete sel[id];
    assetSelection.value = { ...sel };
  } else {
    expandedDeviceIds.value.push(id);
  }
}

function assetSelected(deviceId: string, path: string) {
  return !!(assetSelection.value[deviceId] && assetSelection.value[deviceId][path]);
}

function toggleAsset(deviceId: string, path: string) {
  const sel = assetSelection.value[deviceId] || {};
  const next = { ...sel };
  if (next[path]) delete next[path];
  else next[path] = true;
  assetSelection.value = { ...assetSelection.value, [deviceId]: next };
}

function selectedAssetCount(deviceId: string) {
  const sel = assetSelection.value[deviceId];
  return sel ? Object.keys(sel).length : 0;
}

function askDeleteAssets(d: any) {
  const sel = assetSelection.value[d.device_id] || {};
  const paths = Object.keys(sel);
  if (!paths.length) return;
  deleteConfirm.value = { device: d, paths };
}

function cancelDeleteAssets() {
  if (syncDeleting.value) return;
  deleteConfirm.value = null;
}

// 确认删除：发 remoteDelete 指令 → toast → 刷新面板
async function confirmDeleteAssets() {
  const target = deleteConfirm.value;
  if (!target || syncDeleting.value) return;
  syncDeleting.value = true;
  const r = await deleteAssetsFromDevice(target.device.device_id, target.paths);
  syncDeleting.value = false;
  deleteConfirm.value = null;
  if (r.ok) {
    showToast(t("settings.deleteAssetsDone"));
  } else {
    showToast(t("settings.deleteAssetsFailed"), { type: "error" });
  }
  await loadDevicePanel();
}

// 最后在线人性化（x 分钟前/日期，文案走 i18n）
function fmtLastSeen(iso: string) {
  return formatLastSeen(iso, {
    justNow: t("settings.deviceJustNow"),
    minutesAgo: (n) => t("settings.deviceMinutesAgo", { n }),
    yesterday: t("settings.deviceYesterday"),
  });
}

// 时间：今天 → HH:mm；跨天 → MM-DD HH:mm；解析失败原样
function fmtTime(iso: string) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === new Date().toDateString()) return hm;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

// 指令类型/状态 → i18n label（未知值原样兑底）
function commandTypeLabel(type: string) {
  const key = `settings.commandType.${type}`;
  return t(key) !== key ? t(key) : String(type || "-");
}

function commandStatusLabel(status: string) {
  const key = `settings.commandStatus.${status}`;
  return t(key) !== key ? t(key) : String(status || "-");
}

// 原生壳环境（Swift 主窗口 WKWebView 注入 window.qqplayerNative）：切库走 NSOpenPanel 桥
// （WKWebView 沙箱不支持 <input webkitdirectory>，浏览按钮只在桌面版显示）
const isNative = typeof window !== "undefined" && !!(window as any).qqplayerNative;

function browseLibrary() {
  useShellBridge().pickLibrary();
}

// 原生壳切库完成 → 同步输入框与当前库路径（Swift POST /api/library 后派发 CustomEvent）
function onNativeLibrary(e: any) {
  const p = e?.detail?.path;
  if (!p) return;
  libInput.value = p;
  loadLibrary();
}

// 频点显示：1000 及以上缩写为 K（31/62/125/250/500/1K/2K/4K/8K/16K）
function fmtBand(f: number) {
  return f >= 1000 ? `${f / 1000}K` : String(f);
}

// 音乐库设置（后端持久化）：模板里用 computed 解包，null=还没加载
const librarySettings = computed<any>(() => state.librarySettings);
const audioExtOptions = [".mp3", ".flac", ".m4a", ".wav", ".ogg", ".aac", ".opus"];
// 保存防抖：连续点开关/格式时合并成一次请求（patch 累积不丢）
let libSaveTimer: ReturnType<typeof setTimeout> | null = null;
let libPatch = {};

function saveLib(patch: Record<string, unknown>) {
  error.value = "";
  Object.assign(libPatch, patch);
  if (libSaveTimer) clearTimeout(libSaveTimer);
  libSaveTimer = setTimeout(async () => {
    const p = libPatch;
    libPatch = {};
    try {
      await saveLibrarySettings(p);
    } catch (e) {
      error.value = (e as Error).message;
    }
  }, 300);
}

function toggleExt(ext: string) {
  if (!librarySettings.value) return;
  const cur = librarySettings.value.audioExts;
  const next = cur.includes(ext) ? cur.filter((e: string) => e !== ext) : [...cur, ext];
  if (!next.length) return; // 至少保留一种格式，防止扫不出任何歌
  saveLib({ audioExts: next });
}

// ============ 刮削设置（scraping · /api/library/settings 持久化） ============
// 保存防抖：与 saveLib 同款（连续改动合并成一次 PUT）；GET 完成前由 useScrapingSettings 门闩拦截
const scrapeError = ref("");
let scrapeSaveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleScrapeSave() {
  scrapeError.value = "";
  if (scrapeSaveTimer) clearTimeout(scrapeSaveTimer);
  scrapeSaveTimer = setTimeout(async () => {
    scrapeSaveTimer = null;
    const r = await saveScrapingSettings();
    if (!r.ok) scrapeError.value = r.error;
  }, 300);
}

// 刮削字段选项（labelKey 在 settings.js：settings.scrapeField.*）
const scrapeFieldOptions = SCRAPING_FIELDS.map((key) => ({
  key,
  labelKey: `settings.scrapeField.${key}`,
}));

function toggleScrapeField(key: string) {
  const cur = scrapingSettings.enabled_fields;
  scrapingSettings.enabled_fields = cur.includes(key)
    ? cur.filter((k) => k !== key)
    : [...cur, key];
  scheduleScrapeSave();
}

function toggleBatchEnabled() {
  scrapingSettings.batch_enabled = !scrapingSettings.batch_enabled;
  scheduleScrapeSave();
}

// 源优先级：上下移（简单实现，不引拖拽库）
function moveSource(key: string, dir: number) {
  const cur = [...scrapingSettings.source_order];
  const i = cur.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cur.length) return;
  [cur[i], cur[j]] = [cur[j], cur[i]];
  scrapingSettings.source_order = cur;
  scheduleScrapeSave();
}

// 重命名模板实时预览：取曲库第一首有 artist+title 的歌渲染；无示例/渲染为空显示 "—"
const renamePreview = computed(() => {
  const song = state.songs.find(
    (s: any) => s && String(s.artist || "").trim() && String(s.name || "").trim(),
  );
  if (!song) return "—";
  const out = renderRenamePreview(scrapingSettings.rename_template, song);
  return out || "—";
});

// 一键整库：两段式确认（WKWebView 不支持 window.confirm，沿用内联确认模式）
const batchArmed = ref(false);
let batchArmTimer: ReturnType<typeof setTimeout> | null = null;

function onBatchLibrary() {
  if (!scrapingSettings.batch_enabled) return;
  if (!batchArmed.value) {
    batchArmed.value = true;
    batchArmTimer = setTimeout(() => (batchArmed.value = false), 4000);
    return;
  }
  batchArmed.value = false;
  if (batchArmTimer) clearTimeout(batchArmTimer);
  runScrapeBatch({ mode: "library" });
}

// 分类导航：与移动端设置区抽屉共用（useSettingsCategories，避免双份维护）
// 每次实例创建时求值（isPairingEnabled 非响应式，模块级缓存会过期）
const categories = computed(() => getSettingsCategories());

// ============ 注册表驱动渲染（P0-2）：普通设置 tab 的项来自 settingsIndex 注册表 ============
// 分组保留手写结构，组内按注册表顺序渲染：纯简单项走 SettingRow，特殊交互项按 id 分发手写块
// （render 标记的非宿主项（如 eqPreset/ambientEnabled 等块内成员）自然落空不渲染）。
const pickIds = (arr: SettingEntry[], ids: string[]) => arr.filter((e) => ids.includes(e.id));
const playbackEntries = entriesByCategory("playback");
const playbackMain = pickIds(playbackEntries, [
  "playMode",
  "resumeLast",
  "rememberVolume",
  "fadeSec",
  "eqEnabled",
  "eqPreset",
  "eqGains",
  "visualizerEnabled",
  "ambientEnabled",
  "miniSpectrumEnabled",
  "visualizerStyle",
  "streamStats",
]);
const playbackAb = pickIds(playbackEntries, ["abVisual", "abLoopCountOn", "abLoopMaxCount"]);
const playbackSleep = pickIds(playbackEntries, ["sleepTimerOn", "sleepTimerMinutes"]);
const libraryEntries = entriesByCategory("library");
const libraryFiles = pickIds(libraryEntries, [
  "audioExts",
  "ignoreHidden",
  "autoRefresh",
  "autoScanOnStart",
]);
const videoEntries = entriesByCategory("video");
const downloadEntries = entriesByCategory("download");
const lyricAppEntries = entriesByCategory("lyric").filter((e) => e.subTab === "app");
const lyricAppearance = pickIds(lyricAppEntries, ["engine", "fontFamily", "fontSize", "align"]);
const lyricDisplay = pickIds(lyricAppEntries, ["showRoma", "showZh", "showSec"]);
const lyricEffects = pickIds(lyricAppEntries, ["focusPos", "fadeMask", "autoScroll"]);
const lyricAmll = pickIds(lyricAppEntries, ["amllBlur", "amllSpring", "amllScale"]);
const lyricCalib = pickIds(lyricAppEntries, ["offset"]);
const lyricSource = pickIds(lyricAppEntries, ["source"]);
const lyricColors = pickIds(lyricAppEntries, ["colorScheme", "jpColor", "zhColor"]);
const desktopEntries = pickIds(
  entriesByCategory("lyric").filter((e) => e.subTab === "desktop"),
  [
    "desktopShowZh",
    "desktopFontFamily",
    "desktopFontSize",
    "desktopZhSize",
    "desktopAlign",
    "desktopWidth",
    "desktopHeight",
    "desktopColorScheme",
    "desktopJpColor",
    "desktopZhColor",
  ],
);
const uiEntries = entriesByCategory("ui");
const uiPrefs = pickIds(uiEntries, ["showSongInfo", "karaokeShowTime", "karaokeShowNum"]);
const uiCover = pickIds(uiEntries, [
  "coverBlur",
  "glassCover",
  "showCover",
  "showListCover",
  "coverSize",
  "compact",
]);
const uiTheme = pickIds(uiEntries, ["theme", "miniTheme", "accent"]);

// 歌词延迟徽标：+0.5s / -1.2s / 0.0s（正 = 歌词延后显示）
const fmtOffset = computed(() => {
  const v = lyricSettings.offset;
  return (v > 0 ? "+" : "") + v.toFixed(1) + "s";
});
// 封面区域大小：0 = 自适应（显示「自适应」），固定值显示 px
const coverSizeLabel = computed(() =>
  uiSettings.coverSize === 0 ? t("settings.coverSizeAuto") : `${uiSettings.coverSize}px`,
);
// 滑块 v-model：0 时落滑块到默认锚点（340），拖动立即写固定值
const coverSizeSlider = computed({
  get: () => (uiSettings.coverSize === 0 ? COVER_DEFAULT : uiSettings.coverSize),
  set: (v) => {
    uiSettings.coverSize = Math.round(v);
  },
});
// 快捷键 tab：配置表驱动（SHORTCUTS/SHORTCUT_CATEGORIES 来自 playerCore；全部行可录制）
const recording = ref<string | null>(null); // 正在录制的快捷键 id（null = 未录制）

function startRecord(id: string) {
  recording.value = id;
}

// 当前组合显示（录制值 → 展示文本；⌘ 组合显示 ⌘← 等）
function fmtSetting(s: any) {
  return fmtShortcutKey((playbackSettings as any)[s.settingKey] || s.defaultCode);
}

function shortcutsOf(catKey: string) {
  return SHORTCUTS.filter((s) => s.category === catKey);
}

// capture 阶段拦截：录制时按键不触发播放快捷键（stopImmediatePropagation 挡住 bubble 阶段的 SHORTCUT_HANDLER）
function onRecordKeydown(e: KeyboardEvent) {
  if (!recording.value) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  if (e.key === "Escape" || e.key === "Enter") {
    recording.value = null; // 取消录制，保留原键
    return;
  }
  if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab"].includes(e.key)) return; // 纯修饰键不绑定（e.key 匹配 MetaLeft/ControlLeft 等）
  const target = SHORTCUTS.find((s) => s.id === recording.value);
  if (!target) {
    recording.value = null;
    return;
  }
  const combo = (e.metaKey ? "Meta+" : "") + e.code;
  // 冲突检测：组合已绑定其他快捷键 → toast 拒绝保存（“Meta+K”与“Meta+KeyK”视作同一组合）
  const conflict = SHORTCUTS.find((s) => {
    if (s.id === target.id) return false;
    return comboEq(combo, (playbackSettings as any)[s.settingKey] || s.defaultCode);
  });
  if (conflict) {
    showToast(t("settings.shortcutConflict", { name: t(conflict.labelKey) }), { type: "error" });
    recording.value = null;
    return;
  }
  (playbackSettings as any)[target.settingKey] = combo;
  recording.value = null;
}

// 组合等价比较（parseShortcutCombo 归一化，兼容历史 "Meta+K" 格式）
function comboEq(a: string, b: string) {
  const pa = parseShortcutCombo(a);
  const pb = parseShortcutCombo(b);
  if (!pa || !pb) return a === b;
  return pa.meta === pb.meta && pa.code === pb.code;
}

function toggleFade() {
  playbackSettings.fadeSec = playbackSettings.fadeSec > 0 ? 0 : 1.5;
}
// AB 循环次数步进（范围 1-20 钳制）
function stepAbMax(delta: number) {
  const cur = Math.floor(Number(playbackSettings.abLoopMaxCount));
  playbackSettings.abLoopMaxCount = Math.min(
    20,
    Math.max(1, (Number.isFinite(cur) ? cur : 10) + delta),
  );
}
// 恢复默认：重置全部设置为出厂值（watch 自动持久化；音乐库设置走后端）
function resetAll() {
  Object.assign(playbackSettings, PLAYBACK_SETTINGS_DEFAULTS);
  resetLyricSettingsToDefaults(); // 歌词：AMLL 三特效按环境差异化（壳满血 / 浏览器默认关）
  Object.assign(uiSettings, UI_SETTINGS_DEFAULTS);
  Object.assign(downloadSettings, DOWNLOAD_SETTINGS_DEFAULTS);
  Object.assign(videoSettings, VIDEO_SETTINGS_DEFAULTS);
  saveLib({
    audioExts: audioExtOptions,
    ignoreHidden: true,
    autoRefresh: true,
    autoScanOnStart: true,
  });
}

// 桌面歌词：应用配色方案（'theme' 跟随主题 → 清空自定义颜色）；一键恢复默认
function applyScheme(sc: any) {
  desktopLyricSettings.colorScheme = sc.key;
  if (sc.key === "theme") {
    desktopLyricSettings.jpColor = "";
    desktopLyricSettings.zhColor = "";
  } else {
    desktopLyricSettings.jpColor = sc.jp;
    desktopLyricSettings.zhColor = sc.zh;
  }
}

// APP 歌词：应用配色方案（'theme' 跟随主题 → 清空自定义颜色）
function applyLyricScheme(sc: any) {
  lyricSettings.colorScheme = sc.key;
  if (sc.key === "theme") {
    lyricSettings.jpColor = "";
    lyricSettings.zhColor = "";
  } else {
    lyricSettings.jpColor = sc.jp;
    lyricSettings.zhColor = sc.zh;
  }
}

function resetDesktopLyric() {
  Object.assign(desktopLyricSettings, DESKTOP_LYRIC_DEFAULTS);
}

// 每次打开时同步当前歌曲库路径 + 音乐库设置；进入下载分类时拉取夸克账号状态
watch(
  () => props.open,
  (o) => {
    if (o) {
      tab.value = props.initialTab;
      error.value = "";
      loadLibrary().then(() => {
        libInput.value = state.libraryPath;
      });
      loadLibrarySettings();
    }
  },
);
function runTabLoaders(v: string) {
  if (v === "download") refreshQuarkState();
  if (v === "scrape") loadScrapingSettings(); // 进入刮削 tab 拉取最新设置（与 library tab 同款）
  if (v === "sync") loadDevicePanel(); // 进入同步 tab 拉取设备面板
}
// immediate：嵌入式常驻实例（外部切 tab 后 :key 重挂）挂载时也要跑面板按需加载
watch(tab, (v) => runTabLoaders(v), { immediate: true });

async function save() {
  const p = libInput.value.trim();
  if (!p) return;
  saving.value = true;
  error.value = "";
  try {
    await setLibrary(p);
    emit("close");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

function close() {
  emit("close");
}

// 嵌入式模式遮罩点击不关闭（无遮罩语义）；弹窗模式保持点遮罩关闭
function onMaskClick() {
  if (!props.embedded) close();
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}
onMounted(() => {
  window.addEventListener("keydown", onKey);
  window.addEventListener("qqplayer:nativelibrary", onNativeLibrary);
  window.addEventListener("keydown", onRecordKeydown, true);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("qqplayer:nativelibrary", onNativeLibrary);
  window.removeEventListener("keydown", onRecordKeydown, true);
  clearTimeout(eggTimer ?? undefined);
});
</script>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: var(--mask);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
/* 嵌入式面板模式（iOS 壳负一屏设置区）：无遮罩/无弹窗外壳，作为页面内容区渲染 */
.modal-mask.embedded {
  position: static;
  inset: auto;
  width: 100%;
  height: 100%;
  background: none;
  backdrop-filter: none;
  display: block;
  z-index: auto;
}
.modal.embedded {
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: none;
  border-radius: 0;
  border: none;
  box-shadow: none;
}
.modal-body.embedded {
  display: flex;
  flex: 1;
  min-height: 0;
}
/* 嵌入式面板内容区：移动端密度（弹窗的 22px 左右内边距偏宽） */
.modal-mask.embedded .settings-scroll {
  padding: 14px 14px 24px;
}
.modal {
  width: min(780px, calc(100vw - 40px));
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow:
    0 24px 80px var(--shadow-strong),
    0 4px 16px var(--shadow-sm);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: min(640px, calc(100vh - 60px));
}
.modal-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  font-size: 15px;
  font-weight: 700;
  border-bottom: 1px solid var(--border);
}
.modal-head svg {
  color: var(--accent);
}
.head-sub {
  font-size: 12px;
  font-weight: 500;
  color: var(--text3);
  margin-left: 2px;
}
.modal-close {
  margin-left: auto;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  transition: all 0.15s;
}
@media (hover: hover) {
  .modal-close:hover {
    background: var(--card2);
    color: var(--text);
  }
}
/* 移动端返回按钮（仅 <1024px 渲染，桌面不出现） */
.modal-back {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  transition: all 0.15s;
  flex-shrink: 0;
}
.modal-back:active {
  background: var(--card2);
  color: var(--text);
}

/* ============ 主体：左导航 + 右内容 ============ */
.modal-body {
  display: flex;
  min-height: 0;
  flex: 1;
}
.side-nav {
  width: 158px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 14px 10px;
  border-right: 1px solid var(--border);
  background: var(--bg2);
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 12px;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text2);
  transition: all 0.15s;
  text-align: left;
  position: relative;
}
.nav-item svg {
  color: var(--text3);
  transition: color 0.15s;
}
@media (hover: hover) {
  .nav-item:hover {
    background: var(--card2);
    color: var(--text);
  }
  .nav-item:hover svg {
    color: var(--text2);
  }
}
.nav-item.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}
.nav-item.on svg {
  color: #fff;
}
/* 选中态：左侧指示条（多层阴影叠加出霓虹感） */
.nav-item.on::before {
  content: "";
  position: absolute;
  left: -10px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 20px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--accent), var(--accent2));
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 70%, transparent);
}

.content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.settings-scroll {
  padding: 18px 22px 28px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.group-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: var(--accent2);
  letter-spacing: 1.5px;
  margin-bottom: 10px;
}
.setting-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}
.setting-item:last-child {
  margin-bottom: 0;
}
.setting-label {
  font-size: 14px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.setting-label svg {
  color: var(--text2);
}
.setting-desc {
  font-size: 12px;
  color: var(--text3);
}
.setting-control {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.lib-input {
  flex: 1;
  min-width: 0;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 9px 12px;
  color: var(--text);
  font-size: 13px;
  outline: none;
}
.lib-input:focus {
  border-color: var(--accent);
}
:deep(.setting-label) {
  font-size: 14px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
:deep(.setting-label svg) {
  color: var(--text2);
}
:deep(.setting-desc) {
  font-size: 12px;
  color: var(--text3);
}
:deep(.setting-control) {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
:deep(.lib-input) {
  flex: 1;
  min-width: 0;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 9px 12px;
  color: var(--text);
  font-size: 13px;
  outline: none;
}
:deep(.lib-input:focus) {
  border-color: var(--accent);
}
.btn {
  border-radius: 10px;
  padding: 9px 16px;
  font-size: 13px;
  font-weight: 600;
  transition: all 0.15s;
  white-space: nowrap;
  color: var(--text2);
  background: var(--card2);
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
@media (hover: hover) {
  .btn:hover {
    filter: brightness(1.1);
    color: var(--text);
  }
}
.btn.primary {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.setting-error {
  font-size: 12px;
  color: #ff6b6b;
}

.btn.danger {
  color: #ff6b6b;
  border-color: color-mix(in srgb, #ff6b6b 40%, var(--border));
}
.btn.danger:hover {
  background: color-mix(in srgb, #ff6b6b 12%, transparent);
}

/* 行内小按钮（重置等） */
.mini-btn {
  margin-left: 8px;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text2);
  background: var(--bg2);
  border: 1px solid var(--border);
  transition: all 0.15s;
  vertical-align: 1px;
}
@media (hover: hover) {
  .mini-btn:hover {
    color: var(--text);
    border-color: var(--accent);
  }
}

/* 文件类型多选（chip 网格） */
.ext-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
.ext-chip {
  min-width: 58px;
  padding: 7px 12px;
  border-radius: 9px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text2);
  background: var(--bg2);
  border: 1px solid var(--border);
  transition: all 0.15s;
}
@media (hover: hover) {
  .ext-chip:hover {
    color: var(--text);
    border-color: var(--text3);
  }
}
.ext-chip.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  border-color: transparent;
  box-shadow: 0 2px 8px var(--accent-glow2);
}
:deep(.ext-grid) {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
:deep(.ext-chip) {
  min-width: 58px;
  padding: 7px 12px;
  border-radius: 9px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text2);
  background: var(--bg2);
  border: 1px solid var(--border);
  transition: all 0.15s;
}
@media (hover: hover) {
  :deep(.ext-chip:hover) {
    color: var(--text);
    border-color: var(--text3);
  }
}
:deep(.ext-chip.on) {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  border-color: transparent;
  box-shadow: 0 2px 8px var(--accent-glow2);
}

/* 强调色预设（色板） */
.accent-grid {
  display: flex;
  gap: 10px;
  margin-top: 8px;
}
.accent-swatch {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--swatch), var(--swatch2));
  border: 2px solid transparent;
  transition: all 0.15s;
  position: relative;
}
@media (hover: hover) {
  .accent-swatch:hover {
    transform: scale(1.12);
  }
}
.accent-swatch.on {
  border-color: var(--text);
  box-shadow: 0 0 0 2px var(--bg);
  transform: scale(1.1);
}
.accent-swatch.on::after {
  content: "✓";
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 800;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
}

/* 歌词 tab 子页切换（APP 歌词 / 桌面歌词） */
.lyric-subtabs {
  display: flex;
  gap: 6px;
  margin-bottom: 14px;
  padding: 3px;
  background: var(--bg2);
  border-radius: 12px;
  width: fit-content;
}
.lyric-subtabs .seg-btn {
  padding: 7px 18px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text2);
  transition: all 0.15s;
}
.lyric-subtabs .seg-btn.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}

/* 夸克账号行 */
.quark-account-row {
  align-items: center;
}
.quark-account-name {
  font-size: 13px;
  color: var(--text2);
}

/* 桌面歌词配色方案（双色块 + 名称） */
.desktop-schemes {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-top: 8px;
}
.scheme-swatch {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 7px 9px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--card2);
  cursor: pointer;
  transition: all 0.15s;
}
@media (hover: hover) {
  .scheme-swatch:hover {
    border-color: var(--text3);
  }
}
.scheme-swatch.on {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
.scheme-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.25);
  flex-shrink: 0;
}
.scheme-name {
  font-size: 11px;
  color: var(--text2);
  white-space: nowrap;
}

/* 桌面歌词字体颜色（主行/翻译两个色块） */
.desktop-colors {
  display: flex;
  gap: 14px;
  margin-top: 8px;
}
.color-field {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text2);
}
.color-input {
  width: 34px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: transparent;
  cursor: pointer;
}
.color-input::-webkit-color-swatch-wrapper {
  padding: 2px;
}
.color-input::-webkit-color-swatch {
  border: none;
  border-radius: 4px;
}

/* 桌面歌词一键恢复默认 */
.desktop-reset-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--card2);
  color: var(--text2);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}
@media (hover: hover) {
  .desktop-reset-btn:hover {
    border-color: var(--accent);
    color: var(--accent-text);
    background: var(--accent-soft);
  }
}

/* 分段选择器 */
.seg {
  display: flex;
  gap: 6px;
  background: var(--bg2);
  border-radius: 10px;
  padding: 3px;
}
.seg-btn {
  flex: 1;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text2);
  transition: all 0.15s;
  white-space: nowrap;
}
@media (hover: hover) {
  .seg-btn:hover {
    color: var(--text);
  }
}
.seg-btn.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  box-shadow: 0 2px 8px var(--accent-glow2);
}
:deep(.seg) {
  display: flex;
  gap: 6px;
  background: var(--bg2);
  border-radius: 10px;
  padding: 3px;
}
:deep(.seg-btn) {
  flex: 1;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text2);
  transition: all 0.15s;
  white-space: nowrap;
}
@media (hover: hover) {
  :deep(.seg-btn:hover) {
    color: var(--text);
  }
}
:deep(.seg-btn.on) {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  box-shadow: 0 2px 8px var(--accent-glow2);
}
.val-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 2px 8px;
  border-radius: 8px;
  margin-left: 4px;
  white-space: nowrap;
}
:deep(.val-badge) {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 2px 8px;
  border-radius: 8px;
  margin-left: 4px;
  white-space: nowrap;
}

/* 滑杆 */
.slider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 5px;
  border-radius: 3px;
  background: var(--bg2);
  outline: none;
  margin: 6px 0 2px;
}
.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border: 3px solid var(--bg);
  box-shadow: 0 0 0 1px var(--accent);
  cursor: pointer;
  transition: transform 0.15s;
}
@media (hover: hover) {
  .slider::-webkit-slider-thumb:hover {
    transform: scale(1.15);
  }
}
.slider::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border: 3px solid var(--bg);
  box-shadow: 0 0 0 1px var(--accent);
  cursor: pointer;
}
:deep(.slider) {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 5px;
  border-radius: 3px;
  background: var(--bg2);
  outline: none;
  margin: 6px 0 2px;
}
:deep(.slider)::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border: 3px solid var(--bg);
  box-shadow: 0 0 0 1px var(--accent);
  cursor: pointer;
  transition: transform 0.15s;
}
@media (hover: hover) {
  :deep(.slider)::-webkit-slider-thumb:hover {
    transform: scale(1.15);
  }
}
:deep(.slider)::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border: 3px solid var(--bg);
  box-shadow: 0 0 0 1px var(--accent);
  cursor: pointer;
}
.fade-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 2px;
}
.fade-row .slider {
  flex: 1;
}

/* AB 循环次数步进器 */
.stepper {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.step-btn {
  width: 24px;
  height: 24px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--card2);
  color: var(--text2);
  font-size: 14px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
  line-height: 1;
}
@media (hover: hover) {
  .step-btn:hover {
    border-color: var(--accent);
    color: var(--accent-text);
    background: var(--accent-soft);
  }
}

/* 均衡器 */
.eq-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
.eq-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px 12px;
  margin-top: 14px;
  padding: 12px 10px;
  border-radius: 10px;
  background: var(--bg2);
  border: 1px solid var(--border);
}
.eq-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.eq-val {
  font-size: 10.5px;
  font-weight: 700;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.eq-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 5px;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--bg3), var(--bg3));
  outline: none;
  cursor: pointer;
}
.eq-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  box-shadow: 0 1px 4px var(--accent-glow2);
  border: none;
}
.eq-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border: none;
}
.eq-band {
  font-size: 10px;
  color: var(--text3);
  font-variant-numeric: tabular-nums;
}

/* 开关 */
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  cursor: pointer;
  padding: 2px 0;
}
:deep(.toggle-row) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  cursor: pointer;
  padding: 2px 0;
}
/* 子开关（任务 C：氛围背景 / 迷你频谱）：缩进、小号字号、小号 switch */
.sub-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  cursor: pointer;
  padding: 3px 0 3px 14px;
  border-left: 2px solid var(--border);
  margin-left: 2px;
}
.setting-label.sub {
  font-size: 13px;
}
.setting-desc.sub {
  font-size: 11.5px;
}
.switch.sm {
  width: 40px;
  height: 22px;
  border-radius: 11px;
}
.switch.sm i {
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
}
.switch.sm.on i {
  transform: translateX(18px);
}
.switch {
  flex-shrink: 0;
  width: 48px;
  height: 26px;
  border-radius: 13px;
  background: var(--card2);
  position: relative;
  transition: background 0.2s;
  border: 1px solid var(--border);
}
.switch i {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s;
  box-shadow: 0 1px 3px var(--shadow-sm);
}
.switch.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border-color: transparent;
}
.switch.on i {
  transform: translateX(22px);
}
:deep(.switch) {
  flex-shrink: 0;
  width: 48px;
  height: 26px;
  border-radius: 13px;
  background: var(--card2);
  position: relative;
  transition: background 0.2s;
  border: 1px solid var(--border);
}
:deep(.switch i) {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s;
  box-shadow: 0 1px 3px var(--shadow-sm);
}
:deep(.switch.on) {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border-color: transparent;
}
:deep(.switch.on i) {
  transform: translateX(22px);
}

/* 快捷键 */
.shortcut-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 2px;
  border-bottom: 1px solid var(--border);
}
.shortcut-item:last-of-type {
  border-bottom: none;
}
.sub-title {
  margin-top: 14px;
}
.shortcut-cat + .shortcut-cat {
  margin-top: 10px;
}
.sub-note {
  margin-left: auto;
  font-size: 11.5px;
  font-weight: 400;
  color: var(--text2);
}
.shortcut-item.editable {
  cursor: pointer;
  border-radius: 8px;
  padding: 9px 8px;
  margin: 0 -8px;
  transition: background 0.15s;
  border-bottom-color: transparent;
}
@media (hover: hover) {
  .shortcut-item.editable:hover {
    background: rgba(127, 127, 127, 0.08);
  }
}
.shortcut-item.editable.recording {
  background: rgba(255, 107, 107, 0.1);
}
.recording-kbd {
  color: #ff6b6b;
  animation: kbd-blink 1s ease-in-out infinite;
}
@keyframes kbd-blink {
  50% {
    opacity: 0.45;
  }
}
.shortcut-desc {
  font-size: 13px;
  color: var(--text);
}
.shortcut-keys {
  display: inline-flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
kbd {
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  background: var(--bg2);
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 6px;
  padding: 3px 8px;
  min-width: 22px;
  text-align: center;
}
.hint {
  margin-top: 10px;
  line-height: 1.6;
}

/* AMLL 三特效：子标题 + info 按钮（点击展开/收起性能提示） */
.amll-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px 0 6px;
}
.amll-head-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text2);
}
.amll-info-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  color: var(--text3);
  background: var(--bg2);
  border: 1px solid var(--border);
  transition: all 0.15s;
  cursor: pointer;
  flex-shrink: 0;
}
@media (hover: hover) {
  .amll-info-btn:hover {
    color: var(--accent-text);
    border-color: var(--accent);
    background: var(--accent-soft);
  }
}
.amll-info-btn.on {
  color: var(--accent-text);
  border-color: var(--accent);
  background: var(--accent-soft);
}
.amll-perf-hint {
  margin: 0 0 10px;
  font-size: 12px;
}

/* 关于 */
.about-author {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 2px 14px;
  margin-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
.about-logo {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  object-fit: cover;
  flex: none;
}
.about-author-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.about-name {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
}
.about-tagline {
  font-size: 12px;
  color: var(--text2);
}
.about-version {
  cursor: pointer;
  user-select: none;
  transition: transform 0.1s ease;
}
.about-version:active {
  transform: scale(0.92);
}
.about-easter-egg {
  font-size: 34px;
  text-align: center;
  margin: 12px 0 0;
  animation: about-egg-bounce 0.8s ease infinite;
}
@keyframes about-egg-bounce {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-10px);
  }
}
.about-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 2px;
}
.about-label {
  width: 76px;
  flex-shrink: 0;
  font-size: 13px;
  color: var(--text3);
}
.about-value {
  font-size: 13px;
  color: var(--text);
}
.mono {
  font-family: "SF Mono", "Menlo", monospace;
  font-size: 12px;
}
.link {
  color: var(--accent);
  text-decoration: none;
}
@media (hover: hover) {
  .link:hover {
    text-decoration: underline;
  }
}
.about-desc {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text2);
}

/* 底部操作栏 */
.modal-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
  background: var(--bg2);
}
.reset-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 9px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text2);
  border: 1px solid var(--border);
  transition: all 0.15s;
}
@media (hover: hover) {
  .reset-btn:hover {
    background: rgba(255, 107, 107, 0.12);
    border-color: rgba(255, 107, 107, 0.4);
    color: #ff6b6b;
  }
}

/* ============ 刮削 tab ============ */
/* 刮削字段 checkbox 列表 */
.scrape-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 16px;
  margin-top: 8px;
}
.scrape-field {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 9px;
  background: var(--bg2);
  border: 1px solid var(--border);
  font-size: 12.5px;
  color: var(--text2);
  cursor: pointer;
  transition: all 0.12s;
}
@media (hover: hover) {
  .scrape-field:hover {
    color: var(--text);
    border-color: var(--text3);
  }
}
.scrape-field input {
  accent-color: var(--accent);
  margin: 0;
}
/* 重命名模板：占位符说明 + 实时预览 */
.scrape-tokens {
  margin-top: 6px;
  font-variant-numeric: tabular-nums;
}
.scrape-preview {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.scrape-preview-val {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--accent);
  background: var(--bg2);
  border: 1px dashed var(--border);
  border-radius: 9px;
  padding: 7px 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 源优先级排序 */
.source-order {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.source-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 9px;
  background: var(--bg2);
  border: 1px solid var(--border);
}
.source-name {
  flex: 1;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text2);
}
.source-rank {
  font-size: 11px;
  color: var(--text3);
  background: var(--card2);
  border-radius: 8px;
  padding: 1px 8px;
  font-variant-numeric: tabular-nums;
}
.source-arrows {
  display: flex;
  gap: 4px;
}
.source-arrows .mini-btn {
  margin-left: 0;
  padding: 3px 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.source-arrows .mini-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
/* 插件占位（禁用态） */
.setting-item.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.setting-item.disabled .setting-label {
  color: var(--text3);
}
/* 按钮内 spinner（Loader2） */
.spin {
  animation: sr-spin 0.9s linear infinite;
}
@keyframes sr-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ============ 设备管理面板（sync tab · 桌面端） ============ */
.sync-error {
  color: #ff6b6b;
}
.sync-device {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 12px;
  margin-bottom: 10px;
  background: var(--card);
}
.sync-device-head {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}
.sync-chevron {
  color: var(--text3);
  transition: transform 0.15s;
  flex-shrink: 0;
}
.sync-chevron.open {
  transform: rotate(90deg);
}
.sync-device-icon {
  color: var(--accent);
  flex-shrink: 0;
}
.sync-device-name {
  font-size: 13.5px;
  font-weight: 700;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sync-device-meta {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text3);
  white-space: nowrap;
  flex-shrink: 0;
}
.sync-device-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  padding-left: 22px;
}
.sync-stat {
  font-size: 12px;
  color: var(--text2);
}
.sync-type-chip {
  font-size: 11px;
  color: var(--text2);
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 1px 8px;
}
.sync-assets {
  margin-top: 8px;
  padding-left: 22px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sync-asset-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 3px 0;
  cursor: pointer;
}
.sync-asset-row input {
  accent-color: var(--accent);
  flex-shrink: 0;
}
.sync-asset-path {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text2);
}
.sync-asset-size {
  color: var(--text3);
  white-space: nowrap;
  flex-shrink: 0;
}
.sync-asset-actions {
  margin-top: 6px;
}
.sync-cmd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 6px 0 4px;
}
.sync-cmd-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: var(--accent2);
  letter-spacing: 1.5px;
}
.sync-cmds {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.sync-cmds th {
  text-align: left;
  font-weight: 600;
  color: var(--text3);
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.sync-cmds td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  color: var(--text2);
  white-space: nowrap;
}
.sync-cmd-target {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sync-status {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  border-radius: 20px;
  padding: 1px 8px;
}
.sync-status.st-pending {
  background: color-mix(in srgb, #f5a623 15%, transparent);
  color: #f5a623;
}
.sync-status.st-executing {
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  color: var(--accent);
}
.sync-status.st-done {
  background: color-mix(in srgb, #34c759 15%, transparent);
  color: #34c759;
}
.sync-status.st-failed {
  background: color-mix(in srgb, #ff6b6b 15%, transparent);
  color: #ff6b6b;
}
.sync-status.st-unknown {
  background: var(--bg2);
  color: var(--text3);
}
/* 删除资产确认弹窗 */
.sync-mask {
  position: fixed;
  inset: 0;
  background: var(--mask);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 130;
}
.sync-dialog {
  width: min(360px, calc(100vw - 40px));
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 20px 60px var(--shadow-strong);
  padding: 16px;
}
.sync-dialog-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 8px;
}
.sync-dialog-title svg {
  color: #ff6b6b;
}
.sync-dialog-text {
  font-size: 12.5px;
  color: var(--text3);
  line-height: 1.6;
  margin-bottom: 14px;
}
.sync-dialog-btns {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.sync-dialog-btn {
  padding: 8px 16px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text2);
  background: var(--card2);
  transition: all 0.15s;
}
@media (hover: hover) {
  .sync-dialog-btn:hover {
    color: var(--text);
  }
}
.sync-dialog-btn.danger {
  color: #ff6b6b;
}
.sync-dialog-btn.danger:hover {
  background: color-mix(in srgb, #ff6b6b 12%, transparent);
}
.sync-dialog-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
