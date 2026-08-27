# 设置体系架构与接线规范（P0 重构后）

> 2026-08-27 架构审计 P0 落地后的**唯一权威文档**。目标：**新增一个设置只改一处**（`settingsIndex.ts`），渲染 / 搜索 / 持久化 / 类型检查自动生效。
> 关联：`docs/ios-bridge-protocol.md`（桥契约）、`docs/ios-sync-contract.md`（同步契约）。

## 一、架构总览（五层 → 单定义源 + 契约）

```
                    ┌─────────────────────────────────────────────┐
                    │  settingsIndex.ts  ★唯一定义源（70 entry）   │
                    │  SettingEntry 类型 + satisfies 校验          │
                    └──────┬──────────────────┬───────────────────┘
                           │ 驱动              │ 驱动
              ┌────────────▼──────┐   ┌────────▼───────────────┐
              │ SettingsModal.vue │   │ SearchAnything +        │
              │ SettingRow 通用行  │   │ InlineControl（搜索层）  │
              │ + render 手写槽位  │   └────────┬───────────────┘
              └────────────┬──────┘            │
                           │ set() 写 reactive  │
              ┌────────────▼────────────────────▼───────────────┐
              │ settingsSync.js：deep watch → 防抖 PUT           │
              │   /api/settings（后端白名单校验 → settings.json） │
              └────────────────────────┬────────────────────────┘
                                       │
              ┌────────────────────────▼────────────────────────┐
              │ 后端 _SETTINGS_SPEC（11 namespace 白名单）        │
              │   + state.py 默认值（引用/字面量两种模式）          │
              └─────────────────────────────────────────────────┘

  契约测试（安全网，改漏即红）：
  ├─ frontend/src/__tests__/settingsIndex.test.js   entry 结构 / 字段存在性 / get-set 往返
  └─ backend/tests/test_settings_contract.py        注册表 id ⊆ 后端白名单（跨层双向）
```

**例外路径**：
- **音乐库项**（ignoreHidden / autoRefresh / autoScanOnStart / audioExts）：字段在 `state.librarySettings`，走 `/api/library/settings` 独立 API（`libGet`/`libSet` + `saveLibrarySettings`），**不走 settingsSync**
- **sleepTimerOn**：开关语义 = 启动/取消倒计时（`toggleSleepTimer`/`cancelSleepTimer`），仅赋字段不会计时
- **故意本地持久化字段**（5 个，后端白名单不收）：`ambientEnabled` / `miniSpectrumEnabled` / `amllBlur` / `amllSpring` / `amllScale`——钉死在契约测试 `FRONTEND_LOCAL_REGISTRY`，新增此类字段必须同步登记

## 二、新增一个设置（唯一正确流程）

1. **改一处**：`frontend/src/settingsIndex.ts` 加 entry（70 个既有 entry 是活模板，照抄结构）
2. 若需要**说明文字**：`descKey` 指向语言包 key（zh-CN + en-US 的 `settings.js` 都要加）
3. 若需要**新语言 key**：`frontend/src/locales/{zh-CN,en-US}/settings.js` 同步加
4. 若后端白名单没有该字段：`backend/app/services/settings.py` `_SETTINGS_SPEC` 对应 namespace 补字段（默认值对齐前端），`state.py` 对应默认值常量同步（引用模式硬要求，漏了 import 直接 KeyError）
5. 跑契约测试：前端 `npx vitest run __tests__/settingsIndex.test.js`；后端 `cd backend && pytest tests/test_settings_contract.py -q`
6. 跑 `npm run typecheck`（`satisfies SettingEntry[]` 会拦字段缺失/拼写）

### entry 字段速查

```ts
// 类型定义见 settingsIndex.ts 顶部（SettingType / SettingOption / SettingEntry）
{
  id: "maxSpeed",            // ★规范化 id（可与字段名不同，见别名规则）
  category: "download",      // playback|library|video|download|lyric|ui（shortcuts/about 无设置字段）
  subTab: null,              // lyric 分类： "app" | "desktop"
  labelKey: "settings.maxSpeed",
  descKey: "settings.maxSpeedDesc",   // 可选；缺省回落 settings.<id>Desc
  keywords: ["限速", "下载速度", "speed"],  // 搜索层匹配，中英文都要
  type: "text",              // "toggle"|"slider"|"select"|"text"|"custom"
  get: () => downloadSettings.maxSpeed,     // 读 reactive 命名空间
  set: (v) => { downloadSettings.maxSpeed = v; },  // 只赋 reactive，持久化交给 settingsSync
  // 按 type 可选：options / min / max / step / placeholder
  // 展示字段（SettingRow 消费）：render / descAfter / marginTop / chips / valueSuffix /
  //   badge / mobileOnly / inputType
}
```

### 别名规则（id ≠ 字段名的特判，契约测试已钉死）

| 注册表 id | 实际字段 |
|---|---|
| `downloadEngine` | `downloadSettings.engine` |
| `desktopAlign` 等 `desktop*` | `desktopLyricSettings.align`（去 `desktop` 前缀首字母小写） |

### 特殊交互项（render 槽位）

EQ 十段滑杆、视觉样式预览、睡眠定时器、AB 循环、fade 联动、coverSize 百分比、audioExts chips、AMLL 特效、aria2 条件区、配色/强调色板——这些**保留 SettingsModal 手写块**，entry 加 `render` 标记（如 `render: "eqPanel"`），模板按 `v-if="e.render"` 分发手写块。**新增特殊交互项**：entry 加 render 标记 + SettingsModal 对应 tab 加 `v-else-if="e.id === 'xxx'"` 手写块。

## 三、契约测试（安全网，不许绕过）

```bash
# 前端：entry 结构 / 字段存在性 / get-set 往返 / 语言包 key
cd frontend && npx vitest run __tests__/settingsIndex.test.js
# 后端：注册表 id ⊆ 后端白名单（跨层）
cd backend && pytest tests/test_settings_contract.py -q
```

- 契约红只有两种合法原因：① 真违规（改注册表漏同步后端/前端默认值）→ **修复**；② 新字段属"故意本地持久化"→ **更新 `FRONTEND_LOCAL_REGISTRY` 缺口清单**（同时更新文件顶部 docstring）
- 禁止静默绕过：契约测试的已知缺口清单就是"有意不收"的登记簿，新增必须显式登记

## 四、加载优先级与数据安全

- 前端初始加载：后端值经 `importLocalDiffs` 合并进 reactive，**本地 localStorage 旧值胜出**（用户已改过的值不被后端默认值覆盖，并自动上传）
- 后端白名单新增字段后，存量用户旧值升级保留；全新用户用默认值
- 已知窄风险（整个同步层既有设计特性，非设置体系独有）：GET 通但紧接着导入 PUT 失败的窗口内，本地值会被默认值覆盖

## 五、跨端改动接线规范（审计报告原文，P0 起立规矩）

1. **新设置**：只改 `settingsIndex.ts` 一处 → 渲染/搜索/持久化/类型检查自动生效（本规范全部内容）
2. **新桥命令**（Web↔原生）：`docs/ios-bridge-protocol.md` 契约文件加一行 + 两端实现 + 契约测试绿
3. **新页面/组件**：走现有挂载点（桌面三栏 / 移动分页 / 模式 tab），不另起炉灶
4. **跨端功能**（前端+壳+后端）：先出接线图（数据流 + 契约点），review 通过再动手
5. **行为零变化原则**：任何重构 commit 附带"测试全绿 + 无功能变更"声明，与功能 commit 分开

## 六、关键文件地图

| 文件 | 职责 |
|---|---|
| `frontend/src/settingsIndex.ts` | ★注册表唯一定义源（70 entry + 类型） |
| `frontend/src/components/SettingRow.vue` | 注册表驱动通用设置行（DOM 类名契约：`.setting-item/.setting-label/.setting-desc/.toggle-row/.switch/.seg/.slider/.lib-input`，compactCss 测试依赖，别改） |
| `frontend/src/components/SettingsModal.vue` | 设置弹窗（6 普通 tab 注册表驱动 + render 手写槽位 + 5 特殊面板：sync/scrape/shortcuts/pairing/about） |
| `frontend/src/composables/useSettings.js` | 前端默认值常量 + reactive 命名空间（settingsSync 持久化域） |
| `frontend/src/composables/settingsSync.js` | deep watch 防抖 PUT |
| `frontend/src/composables/useSettingsCategories.js` | 设置分类（按使用频度排序） |
| `backend/app/services/settings.py` | `_SETTINGS_SPEC` 白名单（11 namespace） |
| `backend/app/state.py` | 后端默认值（`*_SETTINGS_DEFAULTS`，引用模式字段必须同步） |
| `frontend/src/__tests__/settingsIndex.test.js` | 前端契约测试 |
| `backend/tests/test_settings_contract.py` | 跨层契约测试（含缺口清单） |
