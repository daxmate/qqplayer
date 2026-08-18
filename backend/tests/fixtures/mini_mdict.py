"""最小 MDX/MDD 生成器（测试专用）。

readmdict 是只读库（无写支持），测试不依赖用户词典目录——按 MDict v2.0 格式
（zlib 压缩、8 字节偏移）现场生成最小文件，验证 dict_reader 的真实解析/提取路径。
"""

import struct
import zlib

_NUM_FMT = ">Q"  # v2.0：8 字节大端


def _compress_block(data: bytes) -> bytes:
    """zlib 压缩块：4 字节类型 0x02 + 4 字节 adler32(BE) + zlib 数据"""
    return (
        b"\x02\x00\x00\x00"
        + struct.pack(">I", zlib.adler32(data) & 0xFFFFFFFF)
        + zlib.compress(data)
    )


def build_mdx(path, entries: list[tuple[str, str]]) -> None:
    """entries: [(word, html), ...] → 可被 readmdict 读取的最小 MDX（UTF-8 key）"""
    records = []
    offset = 0
    for word, html in entries:
        data = html.encode("utf-8")
        records.append((offset, word, data))
        offset += len(data)
    record_data = b"".join(r[2] for r in records)
    comp_record = _compress_block(record_data)
    record_block_info = struct.pack(">QQ", len(comp_record), len(record_data))
    key_block = b"".join(
        struct.pack(_NUM_FMT, off) + word.encode("utf-8") + b"\x00" for off, word, _ in records
    )
    comp_key = _compress_block(key_block)
    kbi = (
        struct.pack(_NUM_FMT, len(entries))
        + struct.pack(">H", 0)
        + b"\x00"
        + struct.pack(">H", 0)
        + b"\x00"
        + struct.pack(_NUM_FMT, len(comp_key))
        + struct.pack(_NUM_FMT, len(key_block))
    )
    comp_kbi = _compress_block(kbi)
    header = (
        '<Dictionary GeneratedByEngineVersion="2.0" RequiredEngineVersion="2.0" '
        'Encoding="UTF-8" Encrypted="No" Format="Html" CreationDate="2026-08-17" '
        'Compact="No" Compat="No" KeyCaseSensitive="No" Description="mini"/>'
    ).encode("utf-16") + b"\x00\x00"
    out = struct.pack(">I", len(header)) + header
    out += struct.pack("<I", zlib.adler32(header) & 0xFFFFFFFF)
    nums = struct.pack(">QQQQQ", 1, len(entries), len(kbi), len(comp_kbi), len(comp_key))
    out += nums + struct.pack(">I", zlib.adler32(nums) & 0xFFFFFFFF)
    out += comp_kbi + comp_key
    out += struct.pack(">QQQQ", 1, len(entries), len(record_block_info), len(comp_record))
    out += record_block_info + comp_record
    path.write_bytes(out)


def build_mdd(path, resources: list[tuple[str, bytes]]) -> None:
    """resources: [(反斜杠相对路径, 字节), ...] → 最小 MDD（UTF-16 key）"""
    records = []
    offset = 0
    for rp, data in resources:
        records.append((offset, rp, data))
        offset += len(data)
    record_data = b"".join(r[2] for r in records)
    comp_record = _compress_block(record_data)
    record_block_info = struct.pack(">QQ", len(comp_record), len(record_data))
    key_block = b"".join(
        struct.pack(_NUM_FMT, off) + rp.encode("utf-16-le") + b"\x00\x00" for off, rp, _ in records
    )
    comp_key = _compress_block(key_block)
    kbi = (
        struct.pack(_NUM_FMT, len(records))
        + struct.pack(">H", 0)
        + b"\x00\x00"
        + struct.pack(">H", 0)
        + b"\x00\x00"
        + struct.pack(_NUM_FMT, len(comp_key))
        + struct.pack(_NUM_FMT, len(key_block))
    )
    comp_kbi = _compress_block(kbi)
    header = (
        '<Dictionary GeneratedByEngineVersion="2.0" Encoding="UTF-16" Encrypted="No" '
        'Format="Html"/>'
    ).encode("utf-16") + b"\x00\x00"
    out = struct.pack(">I", len(header)) + header
    out += struct.pack("<I", zlib.adler32(header) & 0xFFFFFFFF)
    nums = struct.pack(">QQQQQ", 1, len(records), len(kbi), len(comp_kbi), len(comp_key))
    out += nums + struct.pack(">I", zlib.adler32(nums) & 0xFFFFFFFF)
    out += comp_kbi + comp_key
    out += struct.pack(">QQQQ", 1, len(records), len(record_block_info), len(comp_record))
    out += record_block_info + comp_record
    path.write_bytes(out)
