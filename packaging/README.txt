QQPlayer v1.0.0-rc.1（预发布测试版）
=====================================

这是一个自包含的桌面应用：内置 Python 运行时与全部依赖，
目标电脑不需要安装 Python / Node / 任何开发环境。

安装（推荐）
------------
双击「安装.command」，输入密码，自动完成安装并解除 Gatekeeper 限制。

手动安装
--------
把 QQPlayer.app 拖进「应用程序」文件夹，然后打开终端执行：
    sudo xattr -dr com.apple.quarantine /Applications/QQPlayer.app

首次打开如提示「无法验证开发者」：右键点击 QQPlayer → 打开。

音乐库与数据
------------
- 默认音乐库：~/Music/QQPlayer（可在应用内设置修改）
- 收藏/歌单/歌词设置等数据：~/Library/Application Support/qqplayer/

已知限制（arm64 / Apple Silicon Mac，macOS 13+）
------------------------------------------------
- 仅支持 Apple Silicon（Intel Mac 暂不支持）
- 未做 Apple 公证，首次打开需按上述步骤解除隔离

反馈问题请到 GitHub: https://github.com/daxmate/qqplayer/issues
