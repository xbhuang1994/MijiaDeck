// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 全局功能开关（零 Node 依赖，供服务端、控制器与浏览器端共用）。
 *
 * 场景功能及相关配置当前按需求先行屏蔽；底层协议与持久化结构予以保留，便于后续恢复。
 */
export const SCENES_FEATURE_ENABLED = false;
