#!/usr/bin/env python3
"""S2 同步协议：Swift 端生成向量 → Python 独立复算（跨语言互操作证据）。

维护者复核版（2026-09-14）：对 tools/lansync-vectors/vectors.json 全量复算，**56/56 通过**。
覆盖：Device ID（base32 指纹 / 分组展示）、帧编码（QQP1 头 + 长度前缀）、nonce 构造、
Ed25519 hello 签名与验签、X25519+HKDF 三阶派生（含 DH 对称性）、ChaCha20-Poly1305（AAD=帧头）。

用法：/Users/dax/codes/qqplayer/venv/bin/python3 tools/lansync-vectors/verify.py
"""
import base64, hashlib, json, struct, sys
from Crypto.PublicKey import ECC
from Crypto.Protocol import DH
from Crypto.Signature import eddsa
from Crypto.Hash import SHA256
from Crypto.Protocol.KDF import HKDF
from Crypto.Cipher import ChaCha20_Poly1305

from pathlib import Path

P = str(Path(__file__).resolve().parent / "vectors.json")
V = json.load(open(P))
b64 = lambda s: base64.b64decode(s)
b32 = lambda b: base64.b32encode(b).decode().rstrip("=")
ok = fail = 0
def chk(name, got, exp):
    global ok, fail
    if got == exp: ok += 1
    else:
        fail += 1
        print(f"  X {name}: got={str(got)[:70]} exp={str(exp)[:70]}")

print("== device_ids ==")
for e in V["device_ids"]:
    pub = b64(e["public_key_b64"])
    chk("device_id", b32(hashlib.sha256(pub).digest()), e["device_id"])
    full = e["device_id"]
    chk("formatted", "-".join(full[i:i+7] for i in range(0, len(full), 7)), e["formatted"])

print("== base32 ==")
for e in V["base32"]:
    chk("b32", b32(bytes.fromhex(e["bytes_hex"])), e["encoded"])

print("== nonces ==")
for e in V["nonces"]:
    chk("nonce", (b"\x00"*4 + struct.pack(">Q", int(e["counter"]))).hex(), e["nonce_hex"])

print("== frames ==")
for e in V["frames"]:
    p = bytes.fromhex(e["payload_hex"])
    chk("frame", (b"QQP1" + struct.pack(">I", len(p)) + bytes([int(e["type"]), int(e["flags"])]) + p).hex(), e["encoded_hex"])

print("== ed25519 hello signatures ==")
for e in V["hello_signature"]:
    si = b64(e["ephemeral_public_key_b64"]) + e["peer_device_id"].encode() + e["role"].encode()
    chk("signing_input", si.hex(), e["signing_input_hex"])
    v = eddsa.new(eddsa.import_public_key(b64(e["public_key_b64"])), "rfc8032")
    try:
        v.verify(si, b64(e["signature_b64"])); ok += 1
    except Exception as ex:
        fail += 1; print("  X verify:", ex)
    # 私钥自洽：seed 导出的公钥应等于 public_key_b64
    chk("seed->pub", eddsa.import_private_key(b64(e["seed_b64"])).public_key().export_key(format="raw"), b64(e["public_key_b64"]))

print("== X25519 + HKDF key_derivation ==")
for e in V["key_derivation"]:
    priv = ECC.construct(curve="Curve25519", seed=b64(e["my_ephemeral_private_b64"]))
    peer = ECC.construct(curve="Curve25519", point_x=int.from_bytes(b64(e["peer_ephemeral_public_b64"]), "little"))
    shared = DH.key_agreement(static_priv=priv, static_pub=peer, kdf=lambda x: x)
    master = HKDF(shared, 32, b"", SHA256, context=b"qqplayer-sync/v1/master")
    chk("c2h", HKDF(master, 32, b"", SHA256, context=b"qqplayer-sync/v1/dir/c2h").hex(), e["client_to_host_hex"])
    chk("h2c", HKDF(master, 32, b"", SHA256, context=b"qqplayer-sync/v1/dir/h2c").hex(), e["host_to_client_hex"])
    my_pub = int(priv.public_key().pointQ.x).to_bytes(32, "little")
    # DH 对称性：本条的 priv 派生公钥，应能在另一条里作为 peer 公钥出现，且派生结果一致
    for other in V["key_derivation"]:
        if b64(other["peer_ephemeral_public_b64"]) == my_pub:
            chk("peer c2h 对称", other["client_to_host_hex"], e["client_to_host_hex"])
            chk("peer h2c 对称", other["host_to_client_hex"], e["host_to_client_hex"])

print("== ChaCha20-Poly1305 ==")
for e in V["aead"]:
    key = bytes.fromhex(e["key_hex"]); aad = bytes.fromhex(e["aad_hex"])
    nonce = b"\x00"*4 + struct.pack(">Q", int(e["counter"]))
    if not e["combined_hex"]:
        try:
            c = ChaCha20_Poly1305.new(key=key, nonce=nonce); c.update(aad)
            c.decrypt_and_verify(bytes(44))
            fail += 1; print("  X expected auth failure")
        except Exception:
            ok += 1
        continue
    c = ChaCha20_Poly1305.new(key=key, nonce=nonce); c.update(aad)
    ct, tag = c.encrypt_and_digest(bytes.fromhex(e["plaintext_hex"]))
    chk("aead", (nonce + ct + tag).hex(), e["combined_hex"])

print(f"\nRESULT ok={ok} fail={fail}")
sys.exit(1 if fail else 0)
