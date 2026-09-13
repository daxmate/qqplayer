# S2 跨语言测试向量（Swift → JSON）

用途：证明 **Python 侧实现（web 版主机）与 Swift 侧实现（iOS/macOS）在加密与帧层字节级一致**，
不需要真机/模拟器即可验证「iPhone 能否验通 web 端握手」。

- `generate.swift` + `SupportShim.swift` + `run.sh` —— 编译 Swift 端纯逻辑源文件并生成向量
  （引用 `/Users/dax/codes/qqplayer-swift/QQPlayer/Sync/`：DeviceID.swift / SyncFrame.swift /
  SyncCrypto.swift / SyncIdentity.swift；只读，不修改该仓库）
- `vectors.json` —— 向量数据（Swift repo commit 见文件内 `generated_by`）
- `verify.py` —— **Python 独立复算**（维护者复核版）：`venv/bin/python3 tools/lansync-vectors/verify.py`

## 状态（2026-09-14 01:5x）
- 向量生成：已完成（4 组 device_id / 5 组 base32 / 4 组 nonce / 4 组 hello 签名 / 4 组密钥派生 /
  5 组 AEAD（含 1 组期望认证失败）/ 6 组帧编码）
- 独立复算：**ok=56 fail=0**（Device ID、base32、nonce、帧、Ed25519、X25519+HKDF 双方向 + DH 对称、ChaCha20-Poly1305）

## 生成/复算命令
```bash
bash tools/lansync-vectors/run.sh                                   # 重新生成 vectors.json
/Users/dax/codes/qqplayer/venv/bin/python3 tools/lansync-vectors/verify.py   # 复算比对
```
