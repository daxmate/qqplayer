// LAN sync (S2 · web host side): LanSyncSettingsPanel.vue + composables/useLanSync.ts
export default {
  lansync: {
    statusTitle: "Service status",
    running: "Running · port {port}",
    notRunning: "Not running",
    statusDesc: "The LAN sync service starts with the backend and serves iPhone pairing.",
    unavailableHint: "Service is not running; pairing is unavailable until the backend starts.",

    identityTitle: "This device",
    deviceName: "Device name",
    deviceId: "Device ID",
    deviceIdDesc: "This computer's unique ID for LAN sync (52 chars, verifiable on the iPhone).",
    copy: "Copy",

    addDeviceTitle: "Add device",
    addDeviceHint: "Open QQPlayer on the iPhone, choose “Scan to pair”, and point it at the code.",
    showQr: "Show QR code",
    stopQr: "Stop showing",
    qrHint: "The code is single-use; generating a new one invalidates the previous code.",

    pendingTitle: "Pending devices",
    pendingEmpty: "No device waiting for approval",
    approve: "Approve",
    reject: "Reject",
    approved: "Pairing approved",
    rejected: "Pairing rejected",
    actionFailed: "Action failed, please retry",

    devicesTitle: "Paired devices",
    devicesEmpty: "No paired devices yet",
    devicesEmptyDesc: "Click “Show QR code” above and scan it with the iPhone to pair.",
    online: "Online",
    offline: "Offline",
    lastSeen: "Last seen",
    justNow: "just now",
    minutesAgo: "{n} min ago",
    yesterday: "yesterday",
    revoke: "Unpair",
    revokeTitle: "Unpair device",
    revokeConfirm: "Unpair “{name}”? That device must scan the code again to reconnect.",
    revoked: "Device unpaired",

    copied: "Device ID copied",
    copyFailed: "Copy failed, please select and copy manually",

    scopeTitle: "Sync scope",
    scopeDesc:
      "This stage supports pairing and connection only: a paired device stays connected. Song, playlist and playback-data sync is not wired up yet and will follow in a later version.",
  },
};
