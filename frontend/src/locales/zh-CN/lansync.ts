// 局域网同步（S2 · web Host 侧）：LanSyncSettingsPanel.vue + composables/useLanSync.ts
export default {
  lansync: {
    statusTitle: "服务状态",
    running: "运行中 · 端口 {port}",
    notRunning: "未运行",
    statusDesc: "局域网同步服务随后端启动，供 iPhone 扫码配对与连接。",
    unavailableHint: "服务未启动，暂时无法配对（后端启动时会自动开启）。",

    identityTitle: "本机身份",
    deviceName: "设备名",
    deviceId: "设备 ID",
    deviceIdDesc: "这台电脑在局域网同步里的唯一标识（52 位，可在 iPhone 上核对）。",
    copy: "复制",

    addDeviceTitle: "添加设备",
    addDeviceHint: "在 iPhone 的 QQPlayer 里选择「扫码配对」，对准下方二维码。",
    showQr: "展示二维码",
    stopQr: "停止展示",
    qrHint: "二维码一次性有效；重新生成会让上一个立即失效。",

    pendingTitle: "待批准设备",
    pendingEmpty: "暂无待批准设备",
    approve: "批准",
    reject: "拒绝",
    approved: "已批准配对",
    rejected: "已拒绝配对",
    actionFailed: "操作失败，请重试",

    devicesTitle: "已配对设备",
    devicesEmpty: "还没有已配对设备",
    devicesEmptyDesc: "点击上方「展示二维码」，用 iPhone 扫码完成配对。",
    online: "在线",
    offline: "离线",
    lastSeen: "最近连接",
    justNow: "刚刚",
    minutesAgo: "{n} 分钟前",
    yesterday: "昨天",
    revoke: "撤销配对",
    revokeTitle: "撤销配对",
    revokeConfirm: "确定撤销与「{name}」的配对？该设备需要重新扫码才能连接。",
    revoked: "已撤销配对",

    copied: "已复制设备 ID",
    copyFailed: "复制失败，请手动选择复制",

    scopeTitle: "同步范围",
    scopeDesc:
      "本阶段只支持「配对 + 连接」：配对成功后设备保持连接。歌曲、歌单与播放数据的同步尚未接线，会在后续版本提供。",
  },
};
