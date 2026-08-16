// 电子书阅读器（src/books/：Bookshelf.vue / Reader.vue / BooksView.vue / MobileBooks.vue）
export default {
  books: {
    title: "图书",
    import: "导入 EPUB",
    importing: "导入中…",
    importDone: "已导入《{title}》",
    importInvalid: "仅支持 .epub 文件",
    delete: "删除",
    deleteConfirm: "确定删除《{title}》吗？",
    deleteDone: "已删除《{title}》",
    empty: "书架空空如也",
    emptyHint: "点击右上角「导入 EPUB」，或把 .epub 文件拖到这里",
    toc: "目录",
    fontSize: "字号",
    prevPage: "上一页",
    nextPage: "下一页",
    back: "返回",
    reading: "阅读中",
    loading: "加载中…",
    loadError: "无法打开这本书",
    unknownAuthor: "未知作者",
  },
};
