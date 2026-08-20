"""MDX/MDD 词典封装：懒加载 + 模块级缓存 + 按偏移提取单条记录。

readmdict 0.1.1（已装 venv）实测：
- `MDX(path)` 构造时即解析 header + 全部 key（大词典 LDOCE6++ 175MB 需数秒）→ 懒加载
- `mdx._key_list` 为 `[(record_offset, key_bytes), ...]`（按 offset 升序，key 为 UTF-8 bytes）
- **该版本没有 `__getitem__` / `__contains__`**（`mdx[word]`、`word in mdx` 均不可用，
  前者 TypeError、后者退化成 O(n) 全量遍历）→ 词条/资源提取自行按 record block 结构取单条
- keys 数量用 `len(mdx._key_list)`（实际加载 key 数，与 header 的 num_entries 一致）

词典打开失败（文件不存在/权限/iCloud dataless 占位，实测读占位文件报
`OSError: [Errno 11] Resource deadlock avoided`）→ 抛 `MdxLoadError`（带可读原因），
路由层转成 200 + error 字段，不 500。
"""

import re
import threading
import zlib
from bisect import bisect_left, bisect_right
from pathlib import Path
from struct import pack

import lzo  # noqa: F401  # readmdict 依赖；本模块解压 record block 也直接用
from readmdict import MDD, MDX

# 模块级缓存：path → MdxDict 实例（大词典索引构建开销大，进程内复用）
_CACHE: dict[str, "MdxDict"] = {}
_CACHE_LOCK = threading.Lock()


class MdxLoadError(RuntimeError):
    """词典打开/读取失败（文件不存在、权限、iCloud dataless 占位、坏文件等）"""


def _describe_error(e: Exception) -> str:
    if isinstance(e, FileNotFoundError):
        return f"file not found: {e.filename or ''}"
    if isinstance(e, OSError):
        return (
            f"cannot read file ({e.strerror or e}); "
            "if the file is on iCloud, download it in Finder first"
        )
    return f"{type(e).__name__}: {e}"


def _normalize_relpath(p: str) -> str:
    """资源路径规范化：\\ → /、去前导 /、转小写（mdd key 侧同一规则）"""
    return p.replace("\\", "/").lstrip("/").lower()


def get_dict(path: str) -> "MdxDict":
    """取词典实例（模块级缓存，key=规范化路径；open 失败实例不入缓存，下次重试）"""
    key = str(Path(path))
    with _CACHE_LOCK:
        inst = _CACHE.get(key)
        if inst is None:
            inst = MdxDict(key)
            _CACHE[key] = inst
        return inst


def evict(path: str) -> None:
    """从缓存移除指定词典（打开失败后调用，下次查询重试——iCloud 下载完成后即可用）"""
    key = str(Path(path))
    with _CACHE_LOCK:
        _CACHE.pop(key, None)


def clear_cache() -> None:
    """清空全部缓存（测试用）"""
    with _CACHE_LOCK:
        _CACHE.clear()


class MdxDict:
    """单个 MDX 词典（同目录同名 .mdd 自动挂载）。懒加载 + 线程安全。"""

    def __init__(self, path: str):
        self._path = Path(path)
        self._mdd_path = self._path.with_suffix(".mdd")
        self._mdx: MDX | None = None
        self._mdd: MDD | None = None
        # mdx 索引：key_bytes → record offset（record block 内绝对偏移）
        self._index: dict[bytes, int] | None = None
        # 词条按 offset 升序（取上一条的 end = 下一条的 start）
        self._record_ids: list[int] = []
        # record block 布局：[(comp_size, decomp_size, 文件内偏移)] + 累计解压终点
        self._record_blocks: list[tuple[int, int, int]] = []
        self._block_ends: list[int] = []
        # mdd 索引：规范化资源路径 → record offset
        self._mdd_index: dict[str, int] | None = None
        self._mdd_record_ids: list[int] = []
        self._mdd_record_blocks: list[tuple[int, int, int]] = []
        self._mdd_block_ends: list[int] = []
        self._load_error: str | None = None
        self._mdd_load_error: str | None = None
        self._lock = threading.Lock()

    # ---------- 基本信息 ----------
    @property
    def name(self) -> str:
        return self._path.stem

    @property
    def keys_count(self) -> int:
        self._ensure_loaded()
        return len(self._record_ids)

    def has_mdd(self) -> bool:
        return self._mdd_path.exists()

    # ---------- 懒加载 ----------
    def _ensure_loaded(self) -> None:
        """首次 lookup/keys_count 时打开 mdx 并构建索引（大词典慢，故懒加载）"""
        if self._index is not None:
            return
        with self._lock:
            if self._index is not None:
                return
            if self._load_error is not None:
                raise MdxLoadError(self._load_error)
            try:
                mdx = MDX(str(self._path))
                self._mdx = mdx
                self._index = {key_text: key_id for key_id, key_text in mdx._key_list}
                self._record_ids = [key_id for key_id, _ in mdx._key_list]
                self._record_blocks, self._block_ends = self._read_record_layout(mdx)
            except Exception as e:
                self._load_error = _describe_error(e)
                raise MdxLoadError(self._load_error) from None

    def _ensure_mdd_loaded(self) -> None:
        """首次 resource() 时打开同目录同名 .mdd；无 mdd 文件则不打开（resource 返回 None）"""
        if self._mdd_index is not None or not self._mdd_path.exists():
            return
        with self._lock:
            if self._mdd_index is not None:
                return
            if self._mdd_load_error is not None:
                raise MdxLoadError(self._mdd_load_error)
            try:
                mdd = MDD(str(self._mdd_path))
                self._mdd = mdd
                self._mdd_index = {
                    _normalize_relpath(key_text.decode("utf-8", errors="ignore")): key_id
                    for key_id, key_text in mdd._key_list
                }
                self._mdd_record_ids = [key_id for key_id, _ in mdd._key_list]
                self._mdd_record_blocks, self._mdd_block_ends = self._read_record_layout(mdd)
            except Exception as e:
                self._mdd_load_error = _describe_error(e)
                raise MdxLoadError(self._mdd_load_error) from None

    def _read_record_layout(self, obj) -> tuple[list[tuple[int, int, int]], list[int]]:
        """读 record block 头 + 每块 (comp_size, decomp_size, 文件内偏移) 与累计解压终点

        obj 为 MDX/MDD 实例（各自文件），文件路径用 obj._fname（readmdict 存的就是原路径）。
        """
        with Path(obj._fname).open("rb") as f:
            f.seek(obj._record_block_offset)
            num_blocks = obj._read_number(f)
            obj._read_number(f)  # num_entries
            obj._read_number(f)  # record_block_info_size
            obj._read_number(f)  # record_block_size
            blocks: list[tuple[int, int, int]] = []
            for _ in range(num_blocks):
                cs = obj._read_number(f)
                ds = obj._read_number(f)
                blocks.append((cs, ds, 0))
            # 数据区从 record_block_info（num_blocks * 16 字节）之后开始，块内压缩数据顺序拼接
            foff = f.tell()
            for i, (cs, ds, _) in enumerate(blocks):
                blocks[i] = (cs, ds, foff)
                foff += cs
        ends: list[int] = []
        acc = 0
        for _, ds, _ in blocks:
            acc += ds
            ends.append(acc)
        return blocks, ends

    # ---------- 词条 ----------
    def lookup(self, word: str) -> str | None:
        """精确查词：命中返回词条 HTML（str），未命中 None。

        @@@LINK= 重定向条目（MDX 别名词条，如 photographs → photograph）自动跳转目标
        词条：链式跟随、防循环（visited 集合 + 最多 5 层）、大小写不敏感（目标词任意
        大小写，词典 key 通常小写，直查 miss 后回退小写再查）。
        """
        return self._lookup_redirect(word, set(), 0)

    def _lookup_redirect(self, word: str, visited: set[str], depth: int) -> str | None:
        """查词递归实现：命中普通词条直接返回；@@@LINK= 条目跟随跳转（visited/depth 由 lookup 种子化）"""
        self._ensure_loaded()
        assert self._index is not None
        key_id = self._index.get(word.encode("utf-8"))
        if key_id is None:
            return None
        html = self._extract_record(key_id)
        if not html.startswith("@@@LINK="):
            return html
        if depth >= 5:  # 跳转层数上限：超限返回原链接条目（防深链）
            return html
        target = (
            html[8:].strip().strip("\"'").strip()
        )  # "@@@LINK=" 共 8 字符；容忍尾部 \r\n 与引号包裹
        norm = target.lower()
        if not norm or norm in visited:  # 空目标 / 循环（目标词已在链路中）→ 返回原链接条目
            return html
        visited.add(norm)
        # 目标词可能任意大小写：直查，miss 回退小写（词典 key 通常存小写原型）
        resolved = target
        if self._index.get(resolved.encode("utf-8")) is None:
            resolved = norm
            if self._index.get(resolved.encode("utf-8")) is None:
                return html  # 目标词不存在 → 保留原链接条目
        return self._lookup_redirect(resolved, visited, depth + 1)

    def lookup_variants(self, word: str) -> str | None:
        """变形兜底：s/es/ies/ed/ing/er/est/ly/d 简单规则 + 大小写变体，命中即返回

        大小写变体（原词小写/首字母大写/全大写）是查词兜底：词典 key 通常只存小写
        原型（如 COCA 只有 'the' 没有 'The'），书中句首大写单词需要能命中。
        """
        cands = [word + s for s in ("s", "es", "ed", "ing", "er", "est", "ly")]
        if word.endswith("y"):
            cands.append(word[:-1] + "ies")
        if word.endswith("e"):
            cands.append(word + "d")
        if word.lower() != word:
            cands.append(word.lower())
        cands.extend([word.capitalize(), word.upper()])
        for c in cands:
            if c == word:
                continue
            hit = self.lookup(c)
            if hit is not None:
                return hit
        return None

    def _extract_record(self, key_id: int) -> str:
        """按 record offset 解压单条词条（readmdict 无 __getitem__，自行提取）

        解码用词典自身声明的编码（readmdict 读 header 得到，GBK 系已归一为 GB18030），
        去尾部 \\x00 后返回 str——与 readmdict items() 产物一致（实测逐字节比对通过）。
        """
        assert self._mdx is not None
        raw = self._extract_bytes(
            self._path, self._record_blocks, self._block_ends, self._record_ids, key_id
        )
        return raw.decode(self._mdx._encoding, errors="ignore").strip("\x00")

    # ---------- 资源 ----------
    def resource(self, relpath: str) -> bytes | None:
        """资源字节：优先 mdd 内，其次词典同目录实体文件（外置 css/图片等）；都没有返回 None"""
        norm = _normalize_relpath(relpath)
        self._ensure_mdd_loaded()
        if self._mdd_index is not None:
            key_id = self._mdd_index.get(norm)
            if key_id is not None:
                return self._extract_bytes(
                    self._mdd_path,
                    self._mdd_record_blocks,
                    self._mdd_block_ends,
                    self._mdd_record_ids,
                    key_id,
                )
        # 回退：词典同目录实体文件（很多词典 css/图片外置，如 ldoce6ec.css）
        # 先按原始相对路径（保留大小写；Linux 等大小写敏感文件系统必须原样匹配），
        # 再按小写规范化路径（mdd key 侧同规则）；两个候选都做安全清洗
        for cand in (relpath, norm):
            cand = cand.replace("\\", "/").lstrip("/")
            if not cand or ".." in cand.split("/"):
                continue
            side = self._path.parent / cand
            try:
                if side.is_file():
                    return side.read_bytes()
            except OSError:
                return None
        return None

    def _extract_bytes(
        self,
        path: Path,
        blocks: list[tuple[int, int, int]],
        block_ends: list[int],
        record_ids: list[int],
        key_id: int,
    ) -> bytes:
        """定位含 key_id 的 record block → 解压 → 切片单条记录（记录不跨块，同 readmdict）"""
        bi = bisect_right(block_ends, key_id)  # 第一个解压终点 > key_id 的块
        if bi >= len(blocks):
            raise MdxLoadError("record offset out of range")
        cs, ds, foff = blocks[bi]
        with path.open("rb") as f:
            f.seek(foff)
            comp = f.read(cs)
        btype = comp[:4]
        if btype == b"\x00\x00\x00\x00":
            data = comp[8:]
        elif btype == b"\x01\x00\x00\x00":
            data = lzo.decompress(b"\xf0" + pack(">I", ds) + comp[8:])
        elif btype == b"\x02\x00\x00\x00":
            data = zlib.decompress(comp[8:])
        else:
            raise MdxLoadError(f"unknown record block type: {btype!r}")
        block_start = block_ends[bi] - ds
        start = key_id - block_start
        pos = bisect_left(record_ids, key_id)
        record_end = record_ids[pos + 1] if pos + 1 < len(record_ids) else None
        end = ds if record_end is None or record_end > block_ends[bi] else record_end - block_start
        return data[start:end]


# ============ 词条 HTML 解析辅助（音频引用，供路由层使用）============
_SOUND_RE = re.compile(r"sound://([^\s\"'<>\\]+)", re.IGNORECASE)
_MP3_SRC_RE = re.compile(r'src=["\']([^"\']+\.mp3)["\']', re.IGNORECASE)
_RANK_RE = re.compile(r'class=["\']rank["\']\s*>\s*(\d+)', re.IGNORECASE)


def extract_audio_refs(html: str) -> list[str]:
    """词条 HTML 中的音频引用（sound://xxx 与 src=xxx.mp3），去重保序"""
    refs = [m.group(1) for m in _SOUND_RE.finditer(html)]
    refs += [m.group(1) for m in _MP3_SRC_RE.finditer(html)]
    seen: set[str] = set()
    out = []
    for ref in refs:
        norm = _normalize_relpath(ref)
        if norm in seen:
            continue
        seen.add(norm)
        out.append(norm)
    return out


def parse_rank(html: str) -> int | None:
    """词频词典条目中的 rank（COCA 格式 `<span class="rank">N</span>`，取第一个）"""
    m = _RANK_RE.search(html)
    return int(m.group(1)) if m else None
