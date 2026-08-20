# Changelog

本项目所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 📦 打包与分发（首个自包含安装包）

- **macOS 桌面版首个 DMG 安装包（arm64，自包含）**：内置 Python 运行时与全部后端依赖（PyInstaller onedir，`packaging/build-backend.sh`），目标机器零依赖双击即用
- **QQPlayer.app 壳自带后端子进程**：启动探测 `localhost:17627`——launchd 开发版在跑则直连共用（不抢端口），否则拉起内置后端，健康检查通过后开窗；退出自动清理子进程（只杀自己拉起的，绝不碰外部服务）
- **DMG 打包脚本** `packaging/make-dmg.sh`：构建 app → 组装 staging（含「安装.command」自动移除 Gatekeeper 隔离标记 + Applications 软链）→ hdiutil 压缩
- **后端环境变量覆盖**：`QQPLAYER_PORT`（端口，默认 17627）、`QQPLAYER_DATA_DIR`（用户数据目录，测试隔离/多实例用）；frozen 模式下资源定位走 `sys._MEIPASS`

### ✨ 新功能

- **封面/歌词区尺寸：自适应保底 + 桌面拖拽调整 + 记忆 + 恢复默认**
  - 封面默认自适应：`min(46vh, 340px, center高度 − 220 − 间距)`——保底歌词区 ≥220px，小屏不再把歌词挤没（实测 1024×768 歌词从 129px → 220px）
  - 封面与歌词之间新增拖拽分隔条（hover 高亮、ns-resize）：拖拽范围 140~420px，歌词区 ≥160px 硬保护（拖不没）；松手记忆到 uiSettings.coverSize（前端本地持久化，后端白名单未收录不跨设备）
  - 设置 → 界面：新增「封面区域大小」滑块（140~420，联动写入）+「恢复默认」按钮（清记忆回自适应模式）；封面关闭时隐藏该设置项
  - 封面关闭（showCover 关）：由 visibility:hidden 占位改为完全不占位（v-if 移除 + display:none），歌词区自动扩充铺满 + 氛围背景层铺满
  - 移动端：不做拖拽（保持自动布局），按记忆值比例映射封面大小（52vw × 记忆值/340），桌面调大移动端跟随
  - 测试：新增 useCoverSize.test.js 17 用例（自适应公式/硬保护/拖拽/恢复默认/移动端映射），全量 865 全绿
- **播放视觉化改版：封面取色氛围背景 + ControlBar 迷你频谱**（路线 C 混合方案）
  - 主区域（封面与歌词之间）从 64px 频谱横条改为「封面取色氛围背景」：本地歌 /api/cover 同源 canvas 采样提取主色（饱和度加权平均，跳过灰/黑/白；网络封面 crossOrigin 失败 / 全灰图降级主题色 --accent），结果按 src 缓存；渲染为封面主色径向渐变光晕（双层，主光晕 + accent2 次级纵深光）+ 呼吸动画（透明度/半径随帧时钟正弦微动，暂停不"死"）+ 播放时低频能量律动（亮度/半径额外放大）；克制大面积、absolute 铺满 .center 背景层，不再画频谱条
  - ControlBar 进度条左侧新增迷你频谱条（MiniSpectrum 组件，150×36px，桌面端；移动端由 MobilePlayer 中部小频谱承担避免重复）：沿用 6 样式渲染器 small 变体，bars 为频率分色渐变 + 峰值保持亮帽 + 圆角发光（路线 B 技法），半透明低调作"正在播放"节奏指示
  - 设置面板：视觉化总开关下新增「氛围背景」「迷你频谱」两个子开关（sub-toggle 缩进样式）；6 样式 chips 语义变为「迷你频谱样式」（主区域已无样式概念）；settingsIndex 同步收录两个新开关
  - 持久化：ambientEnabled / miniSpectrumEnabled 为前端本地持久化字段——后端 settings 白名单未收录，PUT 时被 _norm_namespace 丢弃，仅存 localStorage（PLAYBACK_SETTINGS_KEY），跨设备不同步（报告已说明）
  - 测试：前端 +31（848 全绿，含 drawAmbient / extractCoverColor / MiniSpectrum / 子开关新用例）
- **歌词指定弹窗 AI 对齐**（任务 D：粘贴纯歌词 → 本地 ForcedAligner 生成时间戳）
  - 粘贴 tab 新增「AI 对齐」按钮（Sparkles 图标）：纯歌词文本（无时间戳）→ 点按 → 本地 Qwen3-ForcedAligner（`~/bin/align`）生成时间戳 → LRC 填入编辑框 → 用户确认后走现有保存（不自动保存/不自动关弹窗）
  - 按钮状态：文本非空可点；对齐中显示转圈 + 「AI 对齐中…」并禁用防重复提交；成功 toast「AI 对齐完成，请确认后保存」，失败 error toast（带后端 detail）；对齐期间关弹窗则忽略迟到结果
  - 新 API `POST /api/lyric/align`：校验 path 存在（404）/ text 非空（400）→ subprocess **参数列表**调用项目内 `scripts/lyric-align <path> -t <text> [-l <lang>] -o json`（无 shell 注入，超时 600s → 504）→ sentences 转 `[mm:ss.xx]` LRC → 返回 `{lrc, lines, duration}`；失败 500 并在 detail 附 align stderr 尾部（~500 字）；模型缺失自动下载（ModelScope 优先/HF 保底，~1GB），下载失败 detail 附 modelscope.cn 手动下载指引；工具未装 → 500；不缓存每次实时对齐
  - `alignLyric({path, text})` 封装于 useLyric.js；i18n 文案（align/aligning/alignDone/alignFailed）入 zh-CN/spec.js
  - 测试：后端 +12（285 全绿）、前端 +3（820 全绿）
- **曲库列头点击排序**（第二批收尾）
  - 歌曲列表上方新增列头行「歌名 / 歌手 / 时长」，点击排序，三态循环：升序 → 降序 → 默认顺序（第三次点击回到曲库原始顺序）
  - 激活列头高亮（强调色）+ 方向箭头（↑/↓），切换列自动重置为升序
  - 与工具条排序 select 共用 sortKey 双向联动（select 切换时方向重置为升序；选「默认顺序」时列头不激活）
  - 仅桌面端（Playlist 只在 ≥1024px 渲染）；列头为列表外独立元素，与行点击 / 右键菜单 / 拖拽互不干扰
  - 测试：前端 +10（817 全绿）
- **曲库列表交互三合一**（第二批）
  - 歌曲行拖拽到侧边栏歌单（drop 高亮反馈 + addToPlaylist + toast 提示）
  - Playlist 头部新增「定位当前播放」按钮 + 点击当前行 EQ 标记滚动到可见（scrollIntoView + 临时高亮）
  - 全部歌曲视图无过滤时可拖拽调整播放队列顺序，后端新增 `GET/PUT /api/queue/order` 持久化（独立 queue_order 存储，跨引擎同步）
  - 测试：后端 +9、前端 +38（798 全绿）
- **顶栏按钮图标加文字**（第二批）
  - 顶栏三按钮（迷你模式 / 桌面歌词 / 设置）从纯图标改为「图标 + 小号文字」并排，hover / 激活态样式与原有风格统一
  - 左侧活动条两按钮（音乐库 / 播放列表）改为竖排布局（图标在上、文字在下），活动条列宽 44px → 64px 适配，激活指示条保留
  - 全部文案抽离至 i18n（zh-CN/app.js），title/tooltip 行为不变；仅桌面端，移动端（MobileShell）不受影响
  - 测试：前端 +7（767 全绿）
- **播放视觉化全面重做**（第二批：6 样式达到 Spotify/网易云质感）
  - bars：圆角频谱条（roundRect）+ 垂直渐变（底 accent → 顶混白）+ 霓虹发光（shadowBlur）+ **峰值保持亮帽**（延迟下落，foobar/网易云式）+ 底部微光舞台
  - radial：分段渐变圆环（accent→accent2 绕环插值）+ 统一外发光光晕 + 粗细节奏（线宽随能量）+ 底环/中心点层次
  - wave：中点二次贝塞尔**平滑曲线**（非生硬折线）+ 水平渐变描边 + 辉光 + 曲线下方渐变填充 + 示波器参考线
  - pulse：中心径向渐变双层（外晕 + 亮核）随低频脉动 + 外圈频谱 spokes（统一光晕 + 分段渐变）+ 基准环锚定
  - mirror：Spotify 镜像——中心发光基线 + 上下镜像圆角条，分别渐变（中心混白 → 两端主题色）+ 发光
  - particle：粒子**锚定频谱槽位**（不再乱飘），y 随对应 bin 律动（lerp 平滑）+ 运动轨迹拖尾 + 发光头点；无数据轻柔浮游
  - 暂停/无数据态全部重做：各样式专属设计感静态图案（高斯鼓包 / 点环 / 正弦+填充带 / 涟漪 / 对称骨架 / 星空）+ **呼吸微动画**（rAF 驱动，暂停不"死"）；old 平线态删除
  - 通用质感：accent/accent2 渐变 + 半透明叠加 + 适度发光 + 圆角/round 线帽；粒子数按面积缩减（基准 48，small 再减）；窄画布负半径防护（maxR 钳制）；复用 buffer/状态，避免每帧大对象
  - 测试：前端 +2（762 全绿，含峰值保持延迟下落 / small 粒子缩减新用例）

- **曲库删除（移到废纸篓）+ 每周孤儿歌词清理**（第一批）
  - 曲库右键菜单 / ⌘·Ctrl 多选批量 / 移动端左滑新增「移到废纸篓」：删除歌曲时磁盘文件一并移入废纸篓（send2trash，可恢复），并自动清理歌单 / 收藏中的引用、正在播放自动切下一首
  - 删除后曲库刷新，「最近添加 / 最近播放 / 常听排行」智能视图自动重算（机制复用，零额外开发）
  - 网络歌（path=null）不参与删除；不在曲库的路径返回 missing 绝不碰磁盘
  - 新 API `DELETE /api/library/songs`（批量）；桌面右键菜单 7 项（播放/下一首/收藏/加歌单/进歌手/进专辑/移到废纸篓）
  - 孤儿歌词清理：每周一 03:00 后端定时任务（正向索引对比曲库，删除无主手动歌词；`LYRIC_CLEANUP_ENABLED` 常量开关，默认开）
  - 测试：后端 +9（268 全绿）、前端 +38（760 全绿）

- **快捷键扩展 + 全量可录制**（任务 G）
  - 新增 10 项快捷键：**⌘← / ⌘→** 上一首 / 下一首、**M** 静音切换、**F** 收藏 / 取消收藏、**R** 播放模式切换、**L** 中文翻译开关、**G** 连播↔跟唱切换、**A / B** AB 循环设起点 / 终点、**[ / ]** 变速 -/+（0.75→1.0→1.25 步进）、**⌘↑ / ⌘↓** 音量 ±20%
  - **配置表驱动**（`SHORTCUTS`，playerCore）：现有全部快捷键（Space / ←→ / ↑↓ / 跟唱 N·P / 搜索 ⌘K）+ 新快捷键统一入表，匹配逻辑（⌘ 组合 / 纯键 / 修饰键排除）表驱动遍历；媒体键（MediaSession）不入表，设置里仍展示说明
  - **设置→快捷键 tab 全量可录制**：按 6 个分类（播放控制 / 曲目 / 音量 / 跟唱 / 搜索 / 其他）分组渲染配置表，点击任意行 → 按新键录制（支持 ⌘ 组合，显示 ⌘← 等）；录制冲突检测 → toast 提示「与 xx 冲突」拒绝保存；Esc / Enter 取消保留原键
  - 持久化：playbackSettings 新增 18 个快捷键字段（含原 5 个只读快捷键转可录制）；后端 `_SETTINGS_SCHEMA["playback"]` 白名单同步（`_norm_str`）；搜索层 `searchKey` 匹配/显示兼容新 "Meta+<code>" 存储格式
  - 测试：前端 +26（628 全绿）、后端 +2（250 全绿）

- **search anything 全屏搜索层**（Spotlight 式，升级原顶栏搜索框）
  - 常态只显示小放大镜图标，点击或 **Cmd+K**（可在设置→快捷键录制更改）唤起全屏搜索层：播放界面背景模糊、音乐继续播，搜索框与结果成为页面主体
  - 混合结果五类：**本地歌曲 / 在线歌曲（网易云）/ 歌手 / 专辑 / 设置项**，每行带类别 badge
  - **匹配度排序**：前缀 > 包含；歌名 > 歌手 > 专辑字段权重；同分优先级 本地 > 在线 > 歌手 > 专辑 > 设置；简繁/声调互通（复用 searchNormalize）
  - **设置项结果行内直接操作**（开关/滑杆/选择/文本输入），实时持久化（settingsSync）；空态显示全部设置项目录（按分类分组）
  - 本地歌曲点击播放、在线歌曲点击下载、歌手/专辑点击直达分组浏览；Esc / 点空白收起
  - 技术实现：`SearchAnything.vue` 全屏遮罩层 + `useSearchAnything.js` 单例数据源（防抖 250ms）+ `score.js` 打分纯函数 + `settingsIndex.js` 设置项索引（50 项，中英别名）+ `InlineControl.vue` 内联控件；搜索层打开时播放快捷键屏蔽（playerCore 守卫）
  - 测试：前端 +66（521 全绿）、后端 +3（177 全绿，searchKey 字段）

- 音乐标签编辑 + 刮削（mutagen 写标签 + 网易云/MusicBrainz 双源刮削）
  - 歌曲信息编辑弹窗（TagEditorModal）：播放页/列表歌曲信息处 Pencil 按钮打开，编辑歌名/歌手/专辑 + 封面预览；移动端弹窗全宽全屏化 + 表单堆叠 + 候选区限高滚动
  - 标签刮削：输入歌名/歌手 → 网易云 + MusicBrainz recording 两组候选列表，点选即填表单；封面 fallback 链（网易云 cover → iTunes → Cover Art Archive）在返回前自动补齐
  - 保存写标签：mutagen 写 MP3 ID3v2 / M4A·MP4 / FLAC（VorbisComment + Picture），OGG·OPUS 只写文本标签；原子写盘（copy2 + os.replace），写失败原文件完好
  - 统一改名 `{artist} - {title}.{ext}`：重名自动加 (2)/(3) 序号，绝不覆盖已有文件
  - 改名后自动迁移 favorites / playlists（songPaths）/ playback 三处旧路径引用，收藏与播放统计不丢；前端按 newPath 更新 currentSong，播放不中断
  - 修复 extract_tags 对 MP4/FLAC/OGG list 标签值（原返回 `['xxx']` 数组格式）的解析
  - 后端新增 API：`POST /api/tags/scrape`（刮削候选）、`POST /api/tags`（写标签 + 改名）
  - 测试：后端 +32（174 全绿）、前端 +10（465 全绿）

- 在线搜索 + 歌曲下载（网易云源，后端内嵌无外部依赖）
  - 顶栏搜索框集成「在线搜索」：输入关键词 → 下拉面板分「本地歌曲 / 在线（网易云）」两组，防抖 400ms
  - 在线结果行：封面 / 标题 / 歌手 / 专辑 / 时长 + 音质标签 + 下载按钮；下载成功后端直接落盘到下载目录（默认当前曲库），watchdog 自动刷新进播放器
  - 设置 → 新增「下载」分类：下载目录（留空 = 当前曲库）+ 默认音质（标准 128k / 极高 320k / 无损 FLAC / Hi-Res，默认 320k）
  - 技术实现：eapi 官方加密接口（AES-128-ECB）移植网易云搜索 / 播放直链（Meting 302 兜底 cenguigui）/ 歌词；`GET /api/online/search` + `POST /api/online/download`（后端流式落盘，超时 90s）
  - 歌词链路同步升级：网易云段从老接口（/api/search/get/web）切换到 eapi 官方接口，新增逐字歌词 JSON-lines 自动转 LRC
  - 移动端：媒体库首页搜索入口同样支持在线搜索 + 下载
  - 测试：后端 +37（142 全绿）、前端 +23（455 全绿）

- 均衡器 EQ（Web Audio API）：10 段经典频点（31/62/125/250/500/1K/2K/4K/8K/16K Hz，±12dB）
  - 设置 → 播放 → 均衡器：总开关 + 7 个预设（平直/流行/摇滚/爵士/古典/低音增强/人声）+ 自定义 10 段滑杆
  - 拖滑杆自动切「自定义」，增益实时生效（不用重启播放）；选预设以预设值为自定义基点
  - 技术实现：懒初始化 AudioContext + MediaElementSource + 10 段 BiquadFilter（peaking）级联，首次播放（用户手势）创建后常驻；`audio.play` 包装确保每次播放前图就绪 + resume（autoplay policy）
  - 开关关闭 = 全部 0dB 直通（createMediaElementSource 一个元素只能接管一次，不做动态路由切换）
  - 无 AudioContext 环境（旧浏览器）静默降级，不影响播放
  - 持久化 `playbackSettings`（localStorage）：eqEnabled / eqPreset / eqGains，启动恢复 + 脏数据归一化（长度/范围/非法预设）

- 迷你模式（Swift 原生壳 `desktop-mini/`）：独立迷你小窗，右下角悬浮常驻
  - 播放器顶栏新增迷你窗开关按钮，通过 URL scheme（`qqplayermini://`）调起壳 app；按钮实时反映迷你窗运行状态（Swift 壳启动/退出上报 `POST /api/mini/status`，主页面 2s 轮询点亮/熄灭）
  - 迷你窗 UI 走 Web 页 `/mini.html`：封面 + 歌名/歌手 + 上一首/播放暂停/下一首 + 可拖动进度条（本地时钟平滑推算，不跳帧）+ 音量滑杆 + 关闭按钮，深色玻璃圆角卡片，强调色跟随主题
  - 控制链路：迷你窗按钮 `POST /api/player/action` 入队（togglePlay/play/pause/next/prev/seek/volume，白名单校验 + seek/volume 范围 clamp），主播放器页面 800ms 轮询取走执行
  - 窗口结构：顶部 24px 拖动条（拖动窗口 / 双击关闭），下方 WKWebView 正常交互（区别于桌面歌词纯显示页）
  - 退出状态兜底：拦截 SIGTERM/SIGINT（pkill / 系统关机）——C signal handler 写标记文件 + 主线程 Timer 优雅退出上报；DispatchSourceSignal 实测失效故不用
  - 应用图标：小窗轮廓 + 双 Q 泡泡 + 播放条（`assets/icon.svg` → icon.icns）
  - 构建：`desktop-mini/build.sh [--install]`（swiftc 编译，安装到 /Applications）
  - 后端新增 API：`POST /api/player/action`、`GET /api/player/actions`（指令队列）、`POST/GET /api/mini/status`（运行状态）；`POST /api/now-playing` 扩展 name/artist/duration/currentTime/isPlaying/volume 字段

- 桌面歌词悬浮窗（Swift 原生壳 `desktop-lyric/`）：无边框 / 透明 / 置顶 / 不占 Dock / 可拖动 / 双击关闭
  - 播放器顶栏新增悬浮窗开关按钮（状态 localStorage 记住），通过 URL scheme（`qqplayerlyric://`）调起壳 app；调起走隐藏 iframe，不阻塞页面
  - 歌词 UI 走 Web 页 `/desktop-lyric.html`：当前句日文 + 中文翻译双行（翻译可关），纯 HTML 零依赖
  - 样式设置：字体 / 主行字号 / 翻译字号 / 对齐方式；窗体宽高可调（设置滑杆 + WebKit 消息驱动原生 resize）
  - 配色：7 种预设配色方案 + 字体颜色自定义 + 一键恢复默认；支持「跟随主题」——强调色经 now-playing accent 字段实时跟随
  - 设置后端持久化（`~/Library/Application Support/qqplayer/desktop_lyric.json`）：修复跨引擎 localStorage 不通（Vivaldi/WKWebView）导致配色不生效的问题
  - 同步链路：主页面状态上报 `POST /api/now-playing`（节流 250ms），悬浮窗 500ms 轮询 `GET /api/now-playing`
  - 设置「歌词」tab 子页化（APP 歌词 / 桌面歌词）：桌面歌词子页含显示中文翻译开关、样式与配色；APP 歌词新增配色方案（含跟随主题）
  - 应用图标：双 Q 泡泡呼应主 logo（`assets/icon.svg` → icon.icns）
  - 构建：`desktop-lyric/build.sh [--install]`（swiftc 编译，产物 <1MB，安装到 /Applications）
  - 后端新增 API：`POST /api/now-playing`（上报）、`GET /api/now-playing`（轮询）、`GET/PUT /api/desktop-lyric/settings`（设置落盘）

- 手动指定歌词：用户可为单曲指定歌词（优先级最高，不受来源优先级设置影响）
  - 三种指定方式：上传本地 `.lrc` / `.srt` 文件、在线搜索候选手动挑选（网易云多结果含中文翻译 + lrclib）、直接粘贴歌词文本
  - 入口：歌词面板右上角悬浮按钮 / 跟唱模式顶部按钮 / 无歌词空态「指定歌词」按钮
  - 在线搜索展示多源候选列表（来源标签、歌手、含翻译标记），点选即保存生效
  - 弹窗显示当前状态（自动获取 / 已手动指定+来源），可一键「清除指定」恢复自动获取
  - 指定歌词存 `~/.cache/qqplayer/lyric/manual/`（按歌曲路径隔离，不碰歌曲目录）
  - 支持 JSON 歌词格式（QQPlayer 缓存结构 `{lrc, tlyric}`）：上传/粘贴 JSON 自动提取原文+中文翻译，翻译一并生效（align_lyric.py 对齐产物可直接指定）
  - 后端新增 API：`GET/PUT/DELETE /api/lyric/manual`（保存前校验内容可解析）、`GET /api/lyric/search`（多源候选）

- 设置界面专业化改造（第四批）：界面分类新增「主题与强调色」+ 封面模糊背景 + 紧凑模式
  - 主题：深色 / 浅色 / 跟随系统（auto 随系统 prefers-color-scheme 实时切换）；浅色主题全量 CSS 变量覆盖，深浅一键切换
  - 强调色：6 种预设（橙红/蓝/绿/紫/粉/青），衍生色（发光/浅底/文字）用 color-mix 自动跟随，换色全局生效
  - 封面模糊背景：背景铺当前歌曲封面模糊图，主面板半透明 + backdrop-filter 毛玻璃（Apple Music 风格）；浅深主题各有独立遮罩
  - 紧凑模式：集中减小顶栏/列表行/封面/控制栏间距与尺寸，提高信息密度
  - 浅色主题对比度调优：active 歌词行补浅橙背景条、次级文字加深、远近层次透明度提高，保证浅底可读
- 设置界面专业化改造（第三批）：音乐库分类新增「文件类型」「忽略隐藏」「自动刷新」「启动扫描」四项
  - 文件类型多选：7 种音频格式（MP3/FLAC/M4A/WAV/OGG/AAC/OPUS）chip 多选，只扫描勾选的格式（至少保留一种，防止扫不出歌）
  - 忽略隐藏文件/文件夹：跳过以 `.` 开头的目录与文件（如 .DS_Store）；关闭后隐藏路径中的歌曲也进列表
  - 自动刷新开关：关闭后后端不再监听歌曲库变动（watchdog 不启动），列表不再自动更新
  - 启动时自动扫描：应用启动立即扫描并预热缓存，歌曲列表首屏秒开
  - 设置由后端持久化（`~/Library/Application Support/qqplayer/settings.json`）；扫描相关项变更自动清缓存重扫并递增版本号，前端轮询自动刷新列表
- 设置界面专业化改造（第二批）：歌词分类新增「时间校准」「歌词来源」两组
  - 歌词延迟校准：±2s 滑杆（步进 0.1s），歌词与声音不同步时微调；正值 = 歌词延后显示，负值 = 提前；定位/句末自动停/跳句/高亮全部按偏移时间轴生效，跳句自动 clamp 到非负；带一键重置
  - 歌词来源优先级：本地优先 / 在线优先；在线优先时使用在线歌词（网易云→lrclib），本地歌词文件作兜底；切换设置立即重载当前歌曲歌词
- 设置界面专业化改造（第一批）：弹窗从顶部 tab 改为左侧分类导航 + 右侧内容区布局，新增底部操作栏（恢复默认 / 完成）
  - 新增「播放」分类：播放模式（列表循环/随机/单曲循环，启动时恢复）、启动时恢复上次播放（歌曲与进度，不自动播放）、记住音量开关、切歌淡入淡出（开关 + 0.5~5s 时长）
  - 新增「快捷键」「关于」分类：全局快捷键一览（只读）、版本号 / 数据目录 / 本地访问地址 / 项目主页
- 跟唱模式行号显示可开关：设置 → 界面 →「跟唱显示行号」（默认显示，关闭后行号圆点与 AB 徽标隐藏，AB 区间高亮保留）

### 🔧 重构

- **设置持久化迁移：localStorage → 后端统一存储**（浏览器与 Swift 壳跨引擎设定同步）
  - 后端新增统一 `settings.json`（6 namespace：library / ui / lyric / playback / desktopLyric / player），`GET/PUT /api/settings`（namespace→字段两级深合并，字段白名单 + 校验非法值回落默认）
  - 旧三文件（settings.json / ui_settings.json / desktop_lyric.json）启动时一次性幂等迁移并入，旧文件保留作备份
  - 旧端点 `/api/ui/settings`、`/api/library/settings`、`/api/desktop-lyric/settings` 保留兼容层，壳（迷你窗/桌面歌词）零改动
  - 前端统一 Settings 层（settingsSync.js）：localStorage 降级为启动缓存 + 写透缓存，后端为唯一真源；启动同步读缓存渲染首屏（不闪变）→ 异步 GET 覆盖 → 变更防抖 300ms PUT；loaded 标志防拉取结果回写
  - 一次性导入：本地旧 localStorage 与后端做字段级 diff，脏字段自动上传（幂等，之后以后端为准）
  - player 状态（音量/侧栏开关/控制区收起/上次播放位置）迁入后端 player namespace，保留 rememberVolume / resumeLast 开关语义（关闭时不跨引擎同步）
  - 睡眠定时器设置（开关/时长）纳入 playback 持久化，跨引擎同步

### 🐛 修复

- **0.75 变速卡顿（WebKit 音频图缺陷）**：8-13 EQ 引入后 audio 元素被 `createMediaElementSource` 接管，WKWebView 中该链路变速（尤其 0.75 减速）走有缺陷的媒体管线 → 卡顿/断续（1.25 稍好，减速最明显）；且元素被接管后无法归还。改为双元素：`audioEq`（接 Web Audio 图，EQ/频谱，常态 1.0）与 `audioBare`（永不接图，变速时切过去走原生媒体管线，流畅），切换瞬间状态迁移（~100ms 中断，变速是主动操作可接受）、抑制会话 flush 不产生断裂播放记录、变速中切歌/seek/跟唱句末/AB 循环正常；变速时频谱静止，回 1.0 自动切回图元素（EQ 恢复）。测试 +2 并适配双元素对快捷键/settingsSync 的影响，1150 全绿

- **ControlBar LRC 徽标与编辑按钮间距粘连**：歌曲信息行的 `.fmt-badge`（如 LRC）与铅笔编辑按钮视觉过挤；`.fmt-badge` 补 `margin-right: 8px`（叠加 `.song-line` 的 flex gap 后总间距 16px），徽标与按钮清晰分离；无歌词徽标场景间距不变

- **刮削保存后播放界面不更新**：`loadSongs` 刷新列表时只更新了 currentIndex，`state.currentSong` 仍指向旧数组里的旧对象（旧歌名/封面）；改为同步替换引用（本地歌按 path、网络歌按 streamId 定位），播放不中断，ControlBar/跟唱面板/媒体键元数据立即显示新信息
- **「最近添加」等列表点击网络歌不播放/播错歌**：所有按 `path` 定位队列索引的写法对网络曲库条目（type=stream, path=null）会误匹配第一个 stream 条目；新增 `findSongIndex`（网络歌按 streamId、本地歌按 path），统一替换智能视图/移动端列表/搜索层/在线搜索 6 处播放与移除定位；`restoreLastPlayed` 保持不恢复网络歌

- **aria2 RPC 被 macOS 系统代理劫持**：Python urllib 在 macOS 上会读取系统网络代理（127.0.0.1），httpx 默认 trust_env 把它套到 localhost:6800 的 RPC 请求上 → 返回 503 → aria2 引擎静默降级 httpx（选了 aria2 实际不生效的第二个根因）；`_aria2_rpc_call` 加 `trust_env=False`，回环 RPC 永不走代理

- **网易云下载接入 aria2 引擎**：设置里选「下载引擎 = aria2」后，网易云源（search anything / 在线搜索）下载仍走内置 httpx（只有歌曲海接入了引擎）；`/api/online/download` 改用 `_download_with_engine`，与歌曲海一致——aria2 不可用/超时自动降级 httpx
- **最近添加视图按添加时间排序**：原实现取库数组前 N 首（= 路径字典序，语义错误）；后端 `scan_library` 新增 `mtime` 字段（macOS birthtime / 跨平台 mtime，网络曲库条目 = 添加时刻），前端按 mtime 降序「最新在最上」，缺失字段兼容旧数据
- **最近添加自动刷新**：停留在该视图时曲库变化（下载/导入/删除）→ 自动重算，新添加的歌实时排到最上
- **下载完成提示改为全局 toast**：search anything / 在线搜索原来用组件内 toast，搜索层/面板收起后提示丢失；改用全局 ToastContainer，任何界面都能看到下载/添加结果提示

- search anything 删光搜索词不再自动退出搜索层：原 query watcher 在空输入分支会顺手 `isSearchOpen=false`（清空=关闭），改为只清结果保持层打开，可继续输入或按 Esc 收起（含输入框右侧 ✕ 清空按钮）

- 跟唱模式歌词对齐不随连播设置生效：`.kline-body` 缺 `flex: 1` 导致宽度收缩到文本内容，`text-align` 无居中空间；补 `flex: 1` + `min-width: 0`，行号仍固定最左，时间戳仍贴最右

## [1.0.0] - 开发历史归档（2026-08-13 补记，尚未正式发布）

> 首次建档：以下为项目初始化以来的全部开发历史，按功能归类。正式发版时将转正为对应版本号。

### ✨ 新功能

- 基础播放器：播放/暂停、音量、快捷键、播放队列、搜索、排序、收藏
- 在线歌词获取：本地歌词优先 → 网易云（原文 + 中文翻译）→ lrclib 兜底
- 播放器风格歌词显示：焦点句 1/3 高度停靠、三层级字号（当前/相邻/更远）、上下渐隐遮罩
- 歌词设置面板：字体、字号、对齐方式、罗马音/中文/段落标题开关、焦点位置、渐隐、自动滚动，localStorage 持久化
- 跟唱模式（逐句练习）：点击句子播放、句末自动停、单句循环、AB 区间循环（长按进入、点击选终点、区间高亮与 A/B 徽标）
- 连播模式：随机播放、单曲循环
- 歌单管理：独立视图、拖拽排序、加歌浮层、Esc 关闭
- 音乐库：按歌手 / 专辑分组浏览（卡片网格 + 分组内搜索排序收藏）
- iCloud 歌曲库自动刷新：watchdog 监听文件夹，去抖后重扫，前端轮询版本号自动刷新列表
- 系统媒体键（MediaSession）：键盘媒体键 / 控制中心 / 锁屏控制，播完重播与切歌自动播放
- 播放历史与统计（完整播放历史 + 统计 API）

### 🔧 重构 / 界面

- 左侧面板体系：音乐库 / 播放列表独立 tab，可收起，全部关闭时顶栏展开入口 → 内容区悬浮展开按钮
- 播放控制区可向下收起，隐藏后底部中央悬浮展开按钮，播放不中断
- 跟唱模式与连播模式布局统一：共用面板体系（ActivityBar + 音乐库 + 播放列表），面板开关状态共享并持久化
- 界面偏好设置：显示当前歌曲信息、跟唱显示每句时间戳（均默认关）
- 视觉打磨：logo 与封面圆形化、emoji 全面换用 lucide SVG 图标、顶栏与页面标题动态化

### ⚙️ 工程

- 架构：FastAPI + Vue 3（前端构建产物由后端静态托管）
- macOS 部署：`deploy.sh` + launchd 服务托管（`com.daxmate.qqplayer`，开机自启、崩溃自动拉起、plist 缺失自愈）
- 工程框架：ruff / pytest + eslint / prettier / vitest + GitHub Actions CI
- 在线歌词接口：网易云 + lrclib 双源兜底
