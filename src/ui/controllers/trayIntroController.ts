// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 首次启动托盘使用说明引导层控制器。
 * 精确 1:1 移植自 app/ui/tray_intro.py。
 */

import { TypedEmitter } from "../../core/contracts.ts";
import { getTrayIntroSeen, setTrayIntroSeen } from "../../core/settingsStore.ts";

export const TRAY_INTRO_TITLE = "MijiaDeck 托盘使用说明";
export const TRAY_INTRO_HEADING = "从托盘快速操作 MijiaDeck";
export const TRAY_INTRO_DISMISS_LABEL = "知道了";
export const TRAY_INTRO_LINES = [
  "单击或双击托盘图标：打开 / 收起快捷浮窗",
  "右键托盘图标：打开菜单，选择「显示主窗口」",
  "鼠标经过图标不会再弹窗。开启托盘常驻时，关闭主窗口仍可从托盘操作。",
  "找不到图标？请点击任务栏右侧的「显示隐藏图标」按钮。",
] as const;

export interface TrayIntroState {
  visible: boolean;
  dismissed: boolean;
  title: string;
  heading: string;
  lines: readonly string[];
  dismissLabel: string;
}

export type TrayIntroEvents = {
  dismissed: [];
  changed: [TrayIntroState];
};

export class TrayIntroController extends TypedEmitter<TrayIntroEvents> {
  readonly title = TRAY_INTRO_TITLE;
  readonly heading = TRAY_INTRO_HEADING;
  readonly lines = TRAY_INTRO_LINES;
  readonly dismissLabel = TRAY_INTRO_DISMISS_LABEL;

  visible: boolean = true;
  dismissed: boolean = false;

  private readonly _onDismiss?: () => void;

  constructor(onDismiss?: () => void) {
    super();
    this._onDismiss = onDismiss;
  }

  isVisible(): boolean {
    return this.visible;
  }

  dismiss(): void {
    if (this.dismissed) {
      return;
    }
    this.dismissed = true;
    this.visible = false;
    this.emit("dismissed");
    this.emit("changed", this.snapshot());
    this._onDismiss?.();
  }

  snapshot(): TrayIntroState {
    return {
      visible: this.visible,
      dismissed: this.dismissed,
      title: this.title,
      heading: this.heading,
      lines: this.lines,
      dismissLabel: this.dismissLabel,
    };
  }
}

/**
 * 在启动可能弹出登录对话框的任务前完成首次托盘使用引导。
 * - 若 tray_intro_seen 为真：立即调用 onReady() 并返回 null。
 * - 否则返回打开状态的 TrayIntroController，待 dismiss() 后写入 tray_intro_seen = true 并调用 onReady()。
 */
export function startWithTrayIntro(onReady: () => void): TrayIntroController | null {
  if (getTrayIntroSeen()) {
    onReady();
    return null;
  }
  return new TrayIntroController(() => {
    setTrayIntroSeen(true);
    onReady();
  });
}
