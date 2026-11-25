<p align="center"><img src="assets/icon.png" width="88" alt="MijiaDeck logo"></p>

# MijiaDeck · 米家 / 小米智能设备桌面控制台（Bun + TypeScript 重构版）

**让米家智能设备在桌面更方便地查看、管理和控制 — 现已基于 Bun + 严格 TypeScript 完全重构。**

[项目介绍](https://songmanual.github.io/MijiaDeck/) · [English website](https://songmanual.github.io/MijiaDeck/en/) · [兼容性记录](docs/COMPATIBILITY.md) · [设备诊断说明](docs/DEVICE-DIAGNOSTICS.md)

MijiaDeck 是开源免费的第三方米家桌面客户端。本分支（`refactor/bun-ts`）将原 Python + PySide6 实现完全重构为 **零 Python 依赖的 Bun + TypeScript 全栈桌面控制台**，完整保留了原项目的全部核心协议、业务逻辑、安全/隐私约束与交互体验：

- **纯 TypeScript 米家云端 SDK (`src/mijia/`)**：原生实现 MIoT RC4-drop1024 加解密与 SHA1/SHA256 Nonce 签名、两步扫码登录（`getQrLoginData` + 120s 长轮询）、设备/家庭/共享设备/场景接口、MIoT 规格抓取与本地原子缓存、有界 HTTP 超时保护。
- **模块化多平台接入层 (`src/platforms/`)**：参考 Home Assistant 与开源社区协议实现，采用统一的 `IDevicePlatformProvider` + `PlatformRegistry` + `MultiPlatformService` 插件架构，并行故障隔离接入：
  - **涂鸦智能 (`src/platforms/tuya/`)**：支持 Home Assistant Device Sharing 扫码登录（AES-128-GCM + HMAC-SHA256）、Tuya Cloud OpenAPI v2.0 与 LocalTuya/TinyTuya 局域网直连（TCP 6668 v3.3/v3.4/v3.5 三次握手 + UDP 6666/6667 发现）。
  - **美的智能 (`src/platforms/midea/`)**：支持美的美居 / MSmartHome / NetHomePlus 云端登录与设备/令牌同步、UDP 6445 局域网发现、TCP 6444 V2 (`0x5A5A`) / V3 (`0x8370`) 加密控制与 `0xAA` 串口协议（空调/除湿机/风扇/空净/加湿器/热水器）。
  - **德业智能 (`src/platforms/deye/`)**：支持德业智能云（`libdeye` Classic / Fog HTTP / Combo MQTT 3.1.1 除湿机与空净协议）与本地 Solarman V5（TCP 8899 Modbus-RTU 光伏逆变器监控）。
- **核心业务与持久化层 (`src/core/`)**：完整移植设备角色判定（灯/开关/多路拆分面板/温湿度/摄像头/音箱/路由器过滤）、隐私保护的设备诊断报告生成、多账号 SHA-256 配置隔离、旧版 `MiHome-Windows` 无损数据迁移、优先级串行任务队列、网络可用性探测、GitHub Releases 更新检查（含公共重定向回退）与 CS2 摄像头远程中继会话管理。
- **主题引擎与 UI 控制器 (`src/ui/`)**：完整移植深浅双调色板、绿/粉/黄/蓝预设与 WCAG 对比度 `>= 4.5` 自定义 HEX 主题色、主窗口/托盘浮窗/音箱控制栏/灯光控制/摄像头预览与云台拖拽/房间标签/语音悬浮球/托盘管理/设置/诊断/首次引导等全部状态机控制器，以及纯 TypeScript ISO/IEC 18004 二维码 SVG 生成器。
- **Bun HTTP + WebSocket 服务与桌面 Web UI (`src/server/`, `src/web/`)**：基于 `Bun.serve` 提供实时 WebSocket 状态同步与桌面风格界面，内置离线演示模式（`--demo` / `--virtual-light`），无需真实米家账号即可体验与验收。

基于 [MiHome-Windows](https://github.com/huanyuejue/MiHome-Windows) 与 [MijiaDeck](https://github.com/Songmanual/MijiaDeck) 改进，延续 **GPL-3.0-or-later** 许可证并保留上游署名。MijiaDeck 与小米、米家官方没有隶属关系。

## 快速开始 / Quick Start

环境要求：**Bun >= 1.2**（已在 Bun 1.4.5 验证）。

```powershell
# 1. 安装开发依赖（TypeScript 类型与编译器）
bun install

# 2. 启动离线演示模式（虚拟家庭设备，无需登录真实账号）
bun run demo

# 3. 启动真实米家模式（支持米家 APP 扫码登录）
bun run start

# 4. 启动单台虚拟调光调色灯测试模式
bun run src/index.ts --virtual-light
```

常用 CLI 参数：
- `--demo`：启用内置虚拟家庭设备与场景（无网络/账号访问）
- `--virtual-light`：仅加载本地虚拟调光调色灯
- `--port <端口>` / `--host <地址>`：自定义监听地址（默认 `127.0.0.1:3456`）
- `--show-main`：覆盖静默托盘启动设置并显示主界面（不修改持久偏好）
- `--check-startup`：隔离临时目录执行启动健康自检后自动退出
- `--no-open`：启动时不自动打开浏览器

## 测试与构建 / Testing & Build

```powershell
# TypeScript 严格类型检查
bun run typecheck

# 运行全部 29 个测试套件（覆盖全部原版回归测试与 SDK/服务集成测试）
bun test

# 打包服务端与前端浏览器产物到 dist/
bun run build

# 启动健康检查
bun run check:startup
```

## 目录结构 / Project Structure

```text
├── assets/                   # 品牌图标与 SVG 资源（icon.png, icon.ico, tray_icon*.png, icons/*.svg）
├── src/
│   ├── index.ts              # 程序入口
│   ├── cli/startup.ts        # CLI 参数解析、单实例锁、标准流保护
│   ├── mijia/                # 纯 TypeScript 米家云端协议与 MIoT 规格 SDK
│   ├── core/                 # 服务适配层、持久化存储、角色判定、诊断、网络、队列、摄像头会话
│   ├── ui/
│   │   ├── theme.ts          # 深浅主题调色板、WCAG 自定义主色与动态 CSS 生成
│   │   ├── qrSvg.ts          # 零依赖纯 TS 二维码 SVG 生成器
│   │   └── controllers/      # 主窗口、卡片、托盘、音箱、灯光、摄像头、设置、诊断等状态控制器
│   ├── server/               # Bun HTTP REST API 与 WebSocket 实时推送服务
│   └── web/                  # 桌面控制台前端（index.html, styles.css, app.ts）
├── tests/                    # 29 个 Bun 测试套件（185 项测试，1885 项断言）
├── tools/camera_relay/       # 可选实验性 CS2 摄像头 Java 中继源码与测试
└── docs/                     # 项目文档、兼容性记录与第三方许可声明
```

## 数据位置与隐私说明

- 源码运行配置目录：项目根目录（已加入 `.gitignore`，切勿提交）
- 打包模式配置目录：`%LOCALAPPDATA%\MijiaDeck\`（首次启动自动从旧版 `MiHome-Windows` 无损迁移）
- 米家登录凭据：`~/.config/mijia-api/auth.json`（与 `mijia-api` CLI 通用，损坏时自动隔离为 `auth.json.corrupt`）
- 设备诊断报告仅输出公开 MIoT 能力定义与脱敏后的阶段码，绝不包含凭据、密钥、设备名、房间或画面。

## 开源致谢 / Credits

- [Songmanual/MijiaDeck](https://github.com/Songmanual/MijiaDeck) & [huanyuejue/MiHome-Windows](https://github.com/huanyuejue/MiHome-Windows)：原始桌面客户端与产品设计。
- [Do1e/mijia-api](https://github.com/Do1e/mijia-api)：米家云端协议参考。
- [eugeneRover/micam](https://github.com/eugeneRover/micam)：实验性摄像头远程传输参考。

完整说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目遵循 [GPL-3.0-or-later](LICENSE) 许可证。
