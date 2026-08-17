<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @click.self="close">
      <div class="modal">
        <!-- 头部 -->
        <div class="modal-head">
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

        <!-- 主体：左导航 + 右内容 -->
        <div class="modal-body">
          <nav class="side-nav">
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
                <div class="setting-item">
                  <div class="setting-label">{{ t("settings.playMode") }}</div>
                  <div class="setting-desc">{{ t("settings.playModeDesc") }}</div>
                  <div class="seg">
                    <button
                      v-for="m in playModeOptions"
                      :key="m.value"
                      class="seg-btn"
                      :class="{ on: playbackSettings.playMode === m.value }"
                      @click="playbackSettings.playMode = m.value"
                    >
                      {{ t(m.labelKey) }}
                    </button>
                  </div>
                </div>
                <div class="setting-item">
                  <div
                    class="toggle-row"
                    @click="playbackSettings.resumeLast = !playbackSettings.resumeLast"
                  >
                    <div>
                      <div class="setting-label">{{ t("settings.resumeLast") }}</div>
                      <div class="setting-desc">{{ t("settings.resumeLastDesc") }}</div>
                    </div>
                    <span class="switch" :class="{ on: playbackSettings.resumeLast }"><i /></span>
                  </div>
                </div>
                <div class="setting-item">
                  <div
                    class="toggle-row"
                    @click="playbackSettings.rememberVolume = !playbackSettings.rememberVolume"
                  >
                    <div>
                      <div class="setting-label">{{ t("settings.rememberVolume") }}</div>
                      <div class="setting-desc">{{ t("settings.rememberVolumeDesc") }}</div>
                    </div>
                    <span class="switch" :class="{ on: playbackSettings.rememberVolume }"
                      ><i
                    /></span>
                  </div>
                </div>
                <div class="setting-item">
                  <div class="toggle-row" @click="toggleFade">
                    <div>
                      <div class="setting-label">{{ t("settings.fade") }}</div>
                      <div class="setting-desc">{{ t("settings.fadeDesc") }}</div>
                    </div>
                    <span class="switch" :class="{ on: playbackSettings.fadeSec > 0 }"><i /></span>
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
                <div class="setting-item">
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
                          @input="setEqGain(i, $event.target.value)"
                        />
                        <span class="eq-band">{{ fmtBand(f) }}</span>
                      </div>
                    </div>
                  </template>
                </div>
                <div class="setting-item">
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
                        playbackSettings.miniSpectrumEnabled = !playbackSettings.miniSpectrumEnabled
                      "
                    >
                      <div>
                        <div class="setting-label sub">{{ t("settings.miniSpectrum") }}</div>
                        <div class="setting-desc sub">{{ t("settings.miniSpectrumDesc") }}</div>
                      </div>
                      <span class="switch sm" :class="{ on: playbackSettings.miniSpectrumEnabled }">
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
                <div class="setting-item">
                  <div
                    class="toggle-row"
                    @click="playbackSettings.streamStats = !playbackSettings.streamStats"
                  >
                    <div>
                      <div class="setting-label">{{ t("settings.streamStats") }}</div>
                      <div class="setting-desc">{{ t("settings.streamStatsDesc") }}</div>
                    </div>
                    <span class="switch" :class="{ on: playbackSettings.streamStats }"><i /></span>
                  </div>
                </div>
              </div>

              <div class="group">
                <div class="group-title">
                  <Repeat2 :size="13" />
                  {{ t("settings.abLoop") }}
                </div>
                <div class="setting-item">
                  <div
                    class="toggle-row"
                    @click="playbackSettings.abVisual = !playbackSettings.abVisual"
                  >
                    <div>
                      <div class="setting-label">{{ t("settings.abVisual") }}</div>
                      <div class="setting-desc">{{ t("settings.abVisualDesc") }}</div>
                    </div>
                    <span class="switch" :class="{ on: playbackSettings.abVisual }"><i /></span>
                  </div>
                </div>
                <div class="setting-item">
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
                      <button class="step-btn" :title="t('settings.plusOne')" @click="stepAbMax(1)">
                        ＋
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div class="group">
                <div class="group-title">
                  <Timer :size="13" />
                  {{ t("settings.sleepTimer") }}
                </div>
                <div class="setting-item">
                  <div class="toggle-row" @click="toggleSleepTimer">
                    <div>
                      <div class="setting-label">{{ t("settings.sleepTimer") }}</div>
                      <div class="setting-desc">{{ t("settings.sleepTimerDesc") }}</div>
                    </div>
                    <span class="switch" :class="{ on: playbackSettings.sleepTimerOn }"><i /></span>
                  </div>
                </div>
                <div v-if="playbackSettings.sleepTimerOn" class="setting-item">
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
                <div class="setting-item">
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
                <div class="setting-item">
                  <div class="toggle-row" @click="toggleSetting('ignoreHidden')">
                    <div>
                      <div class="setting-label">{{ t("settings.ignoreHidden") }}</div>
                      <div class="setting-desc">{{ t("settings.ignoreHiddenDesc") }}</div>
                    </div>
                    <span class="switch" :class="{ on: libBool('ignoreHidden') }"><i /></span>
                  </div>
                </div>
                <div class="setting-item">
                  <div class="toggle-row" @click="toggleSetting('autoRefresh')">
                    <div>
                      <div class="setting-label">{{ t("settings.autoRefresh") }}</div>
                      <div class="setting-desc">{{ t("settings.autoRefreshDesc") }}</div>
                    </div>
                    <span class="switch" :class="{ on: libBool('autoRefresh') }"><i /></span>
                  </div>
                </div>
                <div class="setting-item">
                  <div class="toggle-row" @click="toggleSetting('autoScanOnStart')">
                    <div>
                      <div class="setting-label">{{ t("settings.autoScanOnStart") }}</div>
                      <div class="setting-desc">{{ t("settings.autoScanOnStartDesc") }}</div>
                    </div>
                    <span class="switch" :class="{ on: libBool('autoScanOnStart') }"><i /></span>
                  </div>
                </div>
              </div>
            </section>

            <!-- ============ 视频 ============ -->
            <section v-else-if="tab === 'video'" class="settings-scroll">
              <div class="group">
                <div class="group-title">
                  <Video :size="13" />
                  {{ t("settings.video") }}
                </div>
                <div class="setting-item">
                  <div class="setting-label">{{ t("settings.bilibiliCookie") }}</div>
                  <div class="setting-desc">{{ t("settings.bilibiliCookieDesc") }}</div>
                  <div class="setting-control">
                    <input
                      v-model="videoSettings.bilibiliCookie"
                      class="lib-input"
                      type="text"
                      :placeholder="t('settings.bilibiliCookiePlaceholder')"
                      spellcheck="false"
                      autocomplete="off"
                    />
                  </div>
                </div>
              </div>
            </section>

            <!-- ============ 下载 ============ -->
            <section v-else-if="tab === 'download'" class="settings-scroll">
              <div class="group">
                <div class="group-title">
                  <Download :size="13" />
                  {{ t("settings.download") }}
                </div>
                <div class="setting-item">
                  <div class="setting-label">{{ t("settings.downloadDir") }}</div>
                  <div class="setting-desc">{{ t("settings.downloadDirDesc") }}</div>
                  <div class="setting-control">
                    <input
                      v-model="downloadSettings.downloadDir"
                      class="lib-input"
                      :placeholder="t('settings.downloadDirPlaceholder')"
                      spellcheck="false"
                    />
                  </div>
                </div>
                <div class="setting-item">
                  <div class="setting-label">{{ t("settings.defaultQuality") }}</div>
                  <div class="setting-desc">{{ t("settings.defaultQualityDesc") }}</div>
                  <div class="ext-grid">
                    <button
                      v-for="q in DOWNLOAD_QUALITY_OPTIONS"
                      :key="q.key"
                      class="ext-chip"
                      :class="{ on: downloadSettings.defaultQuality === q.key }"
                      @click="downloadSettings.defaultQuality = q.key"
                    >
                      {{ t(q.labelKey) }}
                    </button>
                  </div>
                </div>

                <!-- 歌曲海：下载品质 + 下载引擎 + aria2 参数 + 夸克账号 -->
                <div class="setting-item">
                  <div class="setting-label">{{ t("settings.quarkQuality") }}</div>
                  <div class="setting-desc">{{ t("settings.quarkQualityDesc") }}</div>
                  <div class="seg" style="margin-top: 4px">
                    <button
                      v-for="q in QUARK_QUALITY_OPTIONS"
                      :key="q.key"
                      class="seg-btn"
                      :class="{ on: downloadSettings.quarkQuality === q.key }"
                      @click="downloadSettings.quarkQuality = q.key"
                    >
                      {{ t(q.labelKey) }}
                    </button>
                  </div>
                </div>
                <div class="setting-item">
                  <div class="setting-label">{{ t("settings.downloadEngine") }}</div>
                  <div class="setting-desc">{{ t("settings.downloadEngineDesc") }}</div>
                  <div class="seg" style="margin-top: 4px">
                    <button
                      v-for="e in DOWNLOAD_ENGINE_OPTIONS"
                      :key="e.key"
                      class="seg-btn"
                      :class="{ on: downloadSettings.engine === e.key }"
                      @click="downloadSettings.engine = e.key"
                    >
                      {{ t(e.labelKey) }}
                    </button>
                  </div>
                </div>
                <template v-if="downloadSettings.engine === 'aria2'">
                  <div class="setting-item">
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
                  <div class="setting-item">
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

            <!-- ============ 歌词 ============ -->
            <section v-else-if="tab === 'lyric'" class="settings-scroll">
              <!-- 子 tab：APP 歌词 / 桌面歌词 -->
              <div class="lyric-subtabs">
                <button
                  class="seg-btn"
                  :class="{ on: lyricSubTab === 'app' }"
                  @click="lyricSubTab = 'app'"
                >
                  {{ t("settings.lyricApp") }}
                </button>
                <button
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
                  <div class="setting-item">
                    <div class="setting-label">{{ t("settings.scrollEngine") }}</div>
                    <div class="setting-desc">
                      {{ t("settings.scrollEngineDesc") }}
                    </div>
                    <div class="seg">
                      <button
                        v-for="e in engineOptions"
                        :key="e.value"
                        class="seg-btn"
                        :class="{ on: lyricSettings.engine === e.value }"
                        @click="lyricSettings.engine = e.value"
                      >
                        {{ t(e.labelKey) }}
                      </button>
                    </div>
                  </div>
                  <div class="setting-item">
                    <div class="setting-label">{{ t("settings.lyricFont") }}</div>
                    <div class="seg">
                      <button
                        v-for="f in fontOptions"
                        :key="f.value"
                        class="seg-btn"
                        :class="{ on: lyricSettings.fontFamily === f.value }"
                        :style="{ fontFamily: f.css }"
                        @click="lyricSettings.fontFamily = f.value"
                      >
                        {{ t(f.labelKey) }}
                      </button>
                    </div>
                  </div>
                  <div class="setting-item">
                    <div class="setting-label">
                      {{ t("settings.fontSize") }}
                      <span class="val-badge">{{ lyricSettings.fontSize }}px</span>
                    </div>
                    <div class="setting-desc">{{ t("settings.fontSizeDesc") }}</div>
                    <input
                      v-model.number="lyricSettings.fontSize"
                      class="slider"
                      type="range"
                      min="14"
                      max="30"
                      step="1"
                    />
                  </div>
                  <div class="setting-item">
                    <div class="setting-label">{{ t("settings.align") }}</div>
                    <div class="seg">
                      <button
                        v-for="a in alignOptions"
                        :key="a.value"
                        class="seg-btn"
                        :class="{ on: lyricSettings.align === a.value }"
                        @click="lyricSettings.align = a.value"
                      >
                        {{ t(a.labelKey) }}
                      </button>
                    </div>
                  </div>
                </div>

                <!-- 显示内容 -->
                <div class="group">
                  <div class="group-title">
                    <Eye :size="13" />
                    {{ t("settings.lyricDisplay") }}
                  </div>
                  <div class="setting-item">
                    <div
                      class="toggle-row"
                      @click="lyricSettings.showRoma = !lyricSettings.showRoma"
                    >
                      <div>
                        <div class="setting-label">{{ t("settings.showRoma") }}</div>
                        <div class="setting-desc">{{ t("settings.showRomaDesc") }}</div>
                      </div>
                      <span class="switch" :class="{ on: lyricSettings.showRoma }"><i /></span>
                    </div>
                  </div>
                  <div class="setting-item">
                    <div class="toggle-row" @click="lyricSettings.showZh = !lyricSettings.showZh">
                      <div>
                        <div class="setting-label">{{ t("settings.showZh") }}</div>
                        <div class="setting-desc">{{ t("settings.showZhDesc") }}</div>
                      </div>
                      <span class="switch" :class="{ on: lyricSettings.showZh }"><i /></span>
                    </div>
                  </div>
                  <div class="setting-item">
                    <div class="toggle-row" @click="lyricSettings.showSec = !lyricSettings.showSec">
                      <div>
                        <div class="setting-label">{{ t("settings.showSection") }}</div>
                        <div class="setting-desc">{{ t("settings.showSectionDesc") }}</div>
                      </div>
                      <span class="switch" :class="{ on: lyricSettings.showSec }"><i /></span>
                    </div>
                  </div>
                </div>

                <!-- 效果行为 -->
                <div class="group">
                  <div class="group-title">
                    <Sparkles :size="13" />
                    {{ t("settings.lyricEffects") }}
                  </div>
                  <div class="setting-item">
                    <div class="setting-label">{{ t("settings.focusPos") }}</div>
                    <div class="seg">
                      <button
                        v-for="p in focusOptions"
                        :key="p.value"
                        class="seg-btn"
                        :class="{ on: lyricSettings.focusPos === p.value }"
                        @click="lyricSettings.focusPos = p.value"
                      >
                        {{ t(p.labelKey) }}
                      </button>
                    </div>
                  </div>
                  <div class="setting-item">
                    <div
                      class="toggle-row"
                      @click="lyricSettings.fadeMask = !lyricSettings.fadeMask"
                    >
                      <div>
                        <div class="setting-label">{{ t("settings.fadeMask") }}</div>
                        <div class="setting-desc">{{ t("settings.fadeMaskDesc") }}</div>
                      </div>
                      <span class="switch" :class="{ on: lyricSettings.fadeMask }"><i /></span>
                    </div>
                  </div>
                  <div class="setting-item">
                    <div
                      class="toggle-row"
                      @click="lyricSettings.autoScroll = !lyricSettings.autoScroll"
                    >
                      <div>
                        <div class="setting-label">{{ t("settings.autoScroll") }}</div>
                        <div class="setting-desc">{{ t("settings.autoScrollDesc") }}</div>
                      </div>
                      <span class="switch" :class="{ on: lyricSettings.autoScroll }"><i /></span>
                    </div>
                  </div>
                </div>

                <!-- 时间校准 -->
                <div class="group">
                  <div class="group-title">
                    <Timer :size="13" />
                    {{ t("settings.lyricCalib") }}
                  </div>
                  <div class="setting-item">
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
                </div>

                <!-- 歌词来源 -->
                <div class="group">
                  <div class="group-title">
                    <Database :size="13" />
                    {{ t("settings.lyricSource") }}
                  </div>
                  <div class="setting-item">
                    <div class="setting-label">{{ t("settings.sourcePriority") }}</div>
                    <div class="seg">
                      <button
                        v-for="s in sourceOptions"
                        :key="s.value"
                        class="seg-btn"
                        :class="{ on: lyricSettings.source === s.value }"
                        @click="lyricSettings.source = s.value"
                      >
                        {{ t(s.labelKey) }}
                      </button>
                    </div>
                    <div class="setting-desc">{{ t("settings.sourcePriorityDesc") }}</div>
                  </div>
                </div>

                <!-- APP 歌词配色（参照桌面歌词） -->
                <div class="group">
                  <div class="group-title">
                    <Palette :size="13" />
                    {{ t("settings.colorSchemeGroup") }}
                  </div>
                  <div class="setting-item">
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
                        <span class="scheme-dot" :style="{ background: sc.zh || 'var(--text2)' }" />
                        <span class="scheme-name">{{ t(sc.labelKey) }}</span>
                      </button>
                    </div>
                  </div>
                  <div class="setting-item">
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
                </div>
              </template>

              <!-- ============ 桌面歌词（子 tab） ============ -->
              <template v-else>
                <div class="group">
                  <div class="group-title">
                    <MonitorPlay :size="13" />
                    {{ t("settings.lyricDesktop") }}
                  </div>
                  <div class="setting-item">
                    <div
                      class="toggle-row"
                      @click="desktopLyricSettings.showZh = !desktopLyricSettings.showZh"
                    >
                      <div>
                        <div class="setting-label">{{ t("settings.showZh") }}</div>
                        <div class="setting-desc">{{ t("settings.desktopShowZhDesc") }}</div>
                      </div>
                      <span class="switch" :class="{ on: desktopLyricSettings.showZh }"><i /></span>
                    </div>
                  </div>
                  <div class="setting-item">
                    <div class="setting-label">{{ t("settings.font") }}</div>
                    <div class="seg">
                      <button
                        v-for="f in fontOptions"
                        :key="f.value"
                        class="seg-btn"
                        :class="{ on: desktopLyricSettings.fontFamily === f.value }"
                        @click="desktopLyricSettings.fontFamily = f.value"
                      >
                        {{ t(f.labelKey) }}
                      </button>
                    </div>
                  </div>
                  <div class="setting-item">
                    <div class="setting-label">{{ t("settings.mainFontSize") }}</div>
                    <div class="val-badge">{{ desktopLyricSettings.fontSize }}px</div>
                    <input
                      v-model.number="desktopLyricSettings.fontSize"
                      class="slider"
                      type="range"
                      min="18"
                      max="40"
                      step="1"
                    />
                  </div>
                  <div class="setting-item">
                    <div class="setting-label">{{ t("settings.translationFontSize") }}</div>
                    <div class="val-badge">{{ desktopLyricSettings.zhSize }}px</div>
                    <input
                      v-model.number="desktopLyricSettings.zhSize"
                      class="slider"
                      type="range"
                      min="12"
                      max="26"
                      step="1"
                    />
                  </div>
                  <div class="setting-item">
                    <div class="setting-label">{{ t("settings.alignShort") }}</div>
                    <div class="seg">
                      <button
                        v-for="a in alignOptions"
                        :key="a.value"
                        class="seg-btn"
                        :class="{ on: desktopLyricSettings.align === a.value }"
                        @click="desktopLyricSettings.align = a.value"
                      >
                        {{ t(a.labelKey) }}
                      </button>
                    </div>
                  </div>
                  <div class="setting-item">
                    <div class="setting-label">{{ t("settings.windowWidth") }}</div>
                    <div class="val-badge">{{ desktopLyricSettings.width }}px</div>
                    <input
                      v-model.number="desktopLyricSettings.width"
                      class="slider"
                      type="range"
                      min="300"
                      max="800"
                      step="10"
                    />
                  </div>
                  <div class="setting-item">
                    <div class="setting-label">{{ t("settings.windowHeight") }}</div>
                    <div class="val-badge">{{ desktopLyricSettings.height }}px</div>
                    <input
                      v-model.number="desktopLyricSettings.height"
                      class="slider"
                      type="range"
                      min="80"
                      max="300"
                      step="10"
                    />
                  </div>
                  <div class="setting-item">
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
                  <div class="setting-item">
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
                <div class="setting-item">
                  <div
                    class="toggle-row"
                    @click="uiSettings.showSongInfo = !uiSettings.showSongInfo"
                  >
                    <div>
                      <div class="setting-label">{{ t("settings.showSongInfo") }}</div>
                      <div class="setting-desc">{{ t("settings.showSongInfoDesc") }}</div>
                    </div>
                    <span class="switch" :class="{ on: uiSettings.showSongInfo }"><i /></span>
                  </div>
                </div>
                <div class="setting-item">
                  <div
                    class="toggle-row"
                    @click="uiSettings.karaokeShowTime = !uiSettings.karaokeShowTime"
                  >
                    <div>
                      <div class="setting-label">{{ t("settings.karaokeShowTime") }}</div>
                      <div class="setting-desc">{{ t("settings.karaokeShowTimeDesc") }}</div>
                    </div>
                    <span class="switch" :class="{ on: uiSettings.karaokeShowTime }"><i /></span>
                  </div>
                </div>
                <div class="setting-item">
                  <div
                    class="toggle-row"
                    @click="uiSettings.karaokeShowNum = !uiSettings.karaokeShowNum"
                  >
                    <div>
                      <div class="setting-label">{{ t("settings.karaokeShowNum") }}</div>
                      <div class="setting-desc">{{ t("settings.karaokeShowNumDesc") }}</div>
                    </div>
                    <span class="switch" :class="{ on: uiSettings.karaokeShowNum }"><i /></span>
                  </div>
                </div>
                <div class="setting-item">
                  <div class="toggle-row" @click="uiSettings.coverBlur = !uiSettings.coverBlur">
                    <div>
                      <div class="setting-label">{{ t("settings.coverBlur") }}</div>
                      <div class="setting-desc">{{ t("settings.coverBlurDesc") }}</div>
                    </div>
                    <span class="switch" :class="{ on: uiSettings.coverBlur }"><i /></span>
                  </div>
                </div>
                <div class="setting-item">
                  <div class="toggle-row" @click="uiSettings.showCover = !uiSettings.showCover">
                    <div>
                      <div class="setting-label">{{ t("settings.showCover") }}</div>
                      <div class="setting-desc">{{ t("settings.showCoverDesc") }}</div>
                    </div>
                    <span class="switch" :class="{ on: uiSettings.showCover }"><i /></span>
                  </div>
                </div>
                <!-- 封面区域大小：自适应（0）或手动固定值（140~420）；滑块联动 + 恢复默认回自适应 -->
                <div v-if="uiSettings.showCover && !isMobile" class="setting-item">
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
                <div class="setting-item">
                  <div class="toggle-row" @click="uiSettings.compact = !uiSettings.compact">
                    <div>
                      <div class="setting-label">{{ t("settings.compact") }}</div>
                      <div class="setting-desc">{{ t("settings.compactDesc") }}</div>
                    </div>
                    <span class="switch" :class="{ on: uiSettings.compact }"><i /></span>
                  </div>
                </div>
              </div>

              <!-- 主题与强调色 -->
              <div class="group">
                <div class="group-title">
                  <Palette :size="13" />
                  {{ t("settings.themeAccent") }}
                </div>
                <div class="setting-item">
                  <div class="setting-label">{{ t("settings.appearance") }}</div>
                  <div class="seg" style="margin-top: 8px">
                    <button
                      v-for="th in themeOptions"
                      :key="th.value"
                      class="seg-btn"
                      :class="{ on: uiSettings.theme === th.value }"
                      @click="uiSettings.theme = th.value"
                    >
                      {{ t(th.labelKey) }}
                    </button>
                  </div>
                </div>
                <div class="setting-item">
                  <div class="setting-label">{{ t("settings.miniTheme") }}</div>
                  <div class="seg" style="margin-top: 8px">
                    <button
                      v-for="m in miniThemeOptions"
                      :key="m.value"
                      class="seg-btn"
                      :class="{ on: uiSettings.miniTheme === m.value }"
                      @click="uiSettings.miniTheme = m.value"
                    >
                      {{ t(m.labelKey) }}
                    </button>
                  </div>
                </div>
                <div class="setting-item">
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

            <!-- ============ 关于 ============ -->
            <section v-else class="settings-scroll">
              <div class="group">
                <div class="group-title">
                  <Info :size="13" />
                  {{ t("settings.about") }}
                </div>
                <div class="about-item">
                  <span class="about-label">{{ t("settings.version") }}</span>
                  <span class="about-value">v{{ version }}</span>
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
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import {
  Settings,
  X,
  ChevronDown,
  FolderOpen,
  Music2,
  Type,
  Eye,
  Sparkles,
  LayoutGrid,
  ListMusic,
  Keyboard,
  Info,
  RotateCcw,
  MonitorPlay,
  Timer,
  Database,
  FileAudio,
  Palette,
  Repeat2,
  Download,
  Video,
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
  DOWNLOAD_QUALITY_OPTIONS,
  QUARK_QUALITY_OPTIONS,
  DOWNLOAD_ENGINE_OPTIONS,
  DOWNLOAD_SETTINGS_DEFAULTS,
  videoSettings,
  VIDEO_SETTINGS_DEFAULTS,
  LYRIC_SETTINGS_DEFAULTS,
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
import pkg from "../../package.json";

const props = defineProps({
  open: { type: Boolean, default: false },
});
const emit = defineEmits(["close"]);

const { t } = useI18n();

const version = pkg.version;
const dataDir = "~/Library/Application Support/qqplayer";
const localUrl = "http://localhost:17627";
const repoUrl = "https://github.com/daxmate/qqplayer";

const tab = ref("playback");
const lyricSubTab = ref("app"); // 歌词 tab 子页：'app' APP 歌词 | 'desktop' 桌面歌词
const libInput = ref("");
const saving = ref(false);
const error = ref("");

// 夸克账号状态（下载分类展示）：null=未加载 | {logged_in, nickname?}
const quarkState = ref(null);
const quarkBusy = ref(false);
const quarkLoginOpen = ref(false);

// 进入下载分类时拉取夸克登录状态（登录/退出后也会刷新）
async function refreshQuarkState() {
  quarkBusy.value = true;
  try {
    const res = await fetch("/api/quark/login/state", { cache: "no-store" });
    quarkState.value = res.ok ? await res.json() : { logged_in: false };
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
    await fetch("/api/quark/login/logout", { method: "POST" });
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

// 原生壳环境（Swift 主窗口 WKWebView 注入 window.qqplayerNative）：切库走 NSOpenPanel 桥
// （WKWebView 沙箱不支持 <input webkitdirectory>，浏览按钮只在桌面版显示）
const isNative = typeof window !== "undefined" && !!window.qqplayerNative;

function browseLibrary() {
  if (window.webkit?.messageHandlers?.native) {
    window.webkit.messageHandlers.native.postMessage("pickLibrary");
  }
}

// 原生壳切库完成 → 同步输入框与当前库路径（Swift POST /api/library 后派发 CustomEvent）
function onNativeLibrary(e) {
  const p = e?.detail?.path;
  if (!p) return;
  libInput.value = p;
  loadLibrary();
}

const themeOptions = [
  { value: "dark", labelKey: "settings.themeDark" },
  { value: "light", labelKey: "settings.themeLight" },
  { value: "auto", labelKey: "settings.themeAuto" },
];

// 频点显示：1000 及以上缩写为 K（31/62/125/250/500/1K/2K/4K/8K/16K）
function fmtBand(f) {
  return f >= 1000 ? `${f / 1000}K` : String(f);
}

const miniThemeOptions = [
  { value: "theme", labelKey: "settings.miniThemeTheme" },
  { value: "dark", labelKey: "settings.miniThemeDark" },
  { value: "light", labelKey: "settings.miniThemeLight" },
];

// 音乐库设置（后端持久化）：模板里用 computed 解包，null=还没加载
const librarySettings = computed(() => state.librarySettings);
const audioExtOptions = [".mp3", ".flac", ".m4a", ".wav", ".ogg", ".aac", ".opus"];
// 保存防抖：连续点开关/格式时合并成一次请求（patch 累积不丢）
let libSaveTimer = null;
let libPatch = {};

function libBool(key) {
  return librarySettings.value ? librarySettings.value[key] : false;
}

function saveLib(patch) {
  error.value = "";
  Object.assign(libPatch, patch);
  if (libSaveTimer) clearTimeout(libSaveTimer);
  libSaveTimer = setTimeout(async () => {
    const p = libPatch;
    libPatch = {};
    try {
      await saveLibrarySettings(p);
    } catch (e) {
      error.value = e.message;
    }
  }, 300);
}

function toggleExt(ext) {
  if (!librarySettings.value) return;
  const cur = librarySettings.value.audioExts;
  const next = cur.includes(ext) ? cur.filter((e) => e !== ext) : [...cur, ext];
  if (!next.length) return; // 至少保留一种格式，防止扫不出任何歌
  saveLib({ audioExts: next });
}

function toggleSetting(key) {
  if (!librarySettings.value) return;
  saveLib({ [key]: !librarySettings.value[key] });
}

const categories = [
  { key: "playback", labelKey: "settings.category.playback", icon: ListMusic },
  { key: "library", labelKey: "settings.category.library", icon: FolderOpen },
  { key: "video", labelKey: "settings.category.video", icon: Video },
  { key: "download", labelKey: "settings.category.download", icon: Download },
  { key: "lyric", labelKey: "settings.category.lyric", icon: Music2 },
  { key: "ui", labelKey: "settings.category.ui", icon: LayoutGrid },
  { key: "shortcuts", labelKey: "settings.category.shortcuts", icon: Keyboard },
  { key: "about", labelKey: "settings.category.about", icon: Info },
];

const playModeOptions = [
  { value: "order", labelKey: "settings.playModeOrder" },
  { value: "shuffle", labelKey: "settings.playModeShuffle" },
  { value: "repeatOne", labelKey: "settings.playModeRepeatOne" },
];
const fontOptions = [
  { value: "system", labelKey: "settings.fontSystem", css: "" },
  { value: "serif", labelKey: "settings.fontSerif", css: '"Songti SC", "SimSun", serif' },
  {
    value: "rounded",
    labelKey: "settings.fontRounded",
    css: '"Yuanti SC", "PingFang SC", sans-serif',
  },
];
const engineOptions = [
  { value: "amll", labelKey: "settings.engineAmll" },
  { value: "spring", labelKey: "settings.engineSpring" },
  { value: "native", labelKey: "settings.engineNative" },
];
const alignOptions = [
  { value: "left", labelKey: "settings.alignLeft" },
  { value: "center", labelKey: "settings.alignCenter" },
  { value: "right", labelKey: "settings.alignRight" },
];
const focusOptions = [
  { value: 0.33, labelKey: "settings.focusUpperThird" },
  { value: 0.5, labelKey: "settings.focusCenter" },
];
const sourceOptions = [
  { value: "local", labelKey: "settings.sourceLocal" },
  { value: "online", labelKey: "settings.sourceOnline" },
];
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
const recording = ref(null); // 正在录制的快捷键 id（null = 未录制）

function startRecord(id) {
  recording.value = id;
}

// 当前组合显示（录制值 → 展示文本；⌘ 组合显示 ⌘← 等）
function fmtSetting(s) {
  return fmtShortcutKey(playbackSettings[s.settingKey] || s.defaultCode);
}

function shortcutsOf(catKey) {
  return SHORTCUTS.filter((s) => s.category === catKey);
}

// capture 阶段拦截：录制时按键不触发播放快捷键（stopImmediatePropagation 挡住 bubble 阶段的 SHORTCUT_HANDLER）
function onRecordKeydown(e) {
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
    return comboEq(combo, playbackSettings[s.settingKey] || s.defaultCode);
  });
  if (conflict) {
    showToast(t("settings.shortcutConflict", { name: t(conflict.labelKey) }), { type: "error" });
    recording.value = null;
    return;
  }
  playbackSettings[target.settingKey] = combo;
  recording.value = null;
}

// 组合等价比较（parseShortcutCombo 归一化，兼容历史 "Meta+K" 格式）
function comboEq(a, b) {
  const pa = parseShortcutCombo(a);
  const pb = parseShortcutCombo(b);
  if (!pa || !pb) return a === b;
  return pa.meta === pb.meta && pa.code === pb.code;
}

function toggleFade() {
  playbackSettings.fadeSec = playbackSettings.fadeSec > 0 ? 0 : 1.5;
}
// AB 循环次数步进（范围 1-20 钳制）
function stepAbMax(delta) {
  const cur = Math.floor(Number(playbackSettings.abLoopMaxCount));
  playbackSettings.abLoopMaxCount = Math.min(
    20,
    Math.max(1, (Number.isFinite(cur) ? cur : 10) + delta),
  );
}
// 恢复默认：重置全部设置为出厂值（watch 自动持久化；音乐库设置走后端）
function resetAll() {
  Object.assign(playbackSettings, PLAYBACK_SETTINGS_DEFAULTS);
  Object.assign(lyricSettings, LYRIC_SETTINGS_DEFAULTS);
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
function applyScheme(sc) {
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
function applyLyricScheme(sc) {
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
      tab.value = "playback";
      error.value = "";
      loadLibrary().then(() => {
        libInput.value = state.libraryPath;
      });
      loadLibrarySettings();
    }
  },
);
watch(tab, (v) => {
  if (v === "download") refreshQuarkState();
});

async function save() {
  const p = libInput.value.trim();
  if (!p) return;
  saving.value = true;
  error.value = "";
  try {
    await setLibrary(p);
    emit("close");
  } catch (e) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

function close() {
  emit("close");
}

function onKey(e) {
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

/* 关于 */
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
</style>
