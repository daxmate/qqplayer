import Foundation

/// 元数据文件持久化兜底（阶段3 · E3）：Documents/meta/{kind}.json 原子读写。
///
/// 背景：iOS 壳免费签名构建的 IndexedDB 重启后不可靠（同 Keychain 覆盖安装被清的已知
/// 问题，见 pairing「Keychain+文件双写」先例）——歌曲/收藏/歌单元数据需在文件系统
/// 落一份兜底，启动时回填前端 state；网络成功会覆盖、失败保留文件数据。
///
/// kinds 约定：`songs` / `favorites` / `playlists`（前端 sync.js nativeMetaSave/
/// nativeMetaLoad 桥对齐）。内容为前端序列化的 JSON 字符串，原生侧不解析、不校验
/// 结构——损坏/缺失一律按「无兜底」处理（load 返回 nil），绝不阻塞启动。
enum MetaStore {
    /// 元数据目录（Documents/meta/；与资产目录 qqplayer-assets/ 平级）
    private static var metaDir: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        return docs.appendingPathComponent("meta", isDirectory: true)
    }

    /// 文件 URL（kind 白名单外的非法值 → nil；防路径穿越，语义同 DownloadManager.isSafePath）
    private static func fileURL(kind: String) -> URL? {
        let k = kind.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !k.isEmpty, !k.contains(".."), !k.contains("/") else { return nil }
        return metaDir.appendingPathComponent(k + ".json")
    }

    /// 原子写：先写 .tmp 再 rename（目录不存在先建；失败静默返回 false，不抛）
    @discardableResult
    static func save(kind: String, json: String) -> Bool {
        guard let url = fileURL(kind: kind) else { return false }
        do {
            try FileManager.default.createDirectory(at: metaDir, withIntermediateDirectories: true)
            let tmp = metaDir.appendingPathComponent(kind + ".json.tmp")
            if FileManager.default.fileExists(atPath: tmp.path) {
                try FileManager.default.removeItem(at: tmp)
            }
            try Data(json.utf8).write(to: tmp)
            if FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.removeItem(at: url)
            }
            try FileManager.default.moveItem(at: tmp, to: url)
            return true
        } catch {
            return false
        }
    }

    /// 读文件；不存在/损坏/空 → nil
    static func load(kind: String) -> String? {
        guard let url = fileURL(kind: kind) else { return nil }
        guard let data = try? Data(contentsOf: url),
              let json = String(data: data, encoding: .utf8),
              !json.isEmpty
        else {
            return nil
        }
        return json
    }
}
