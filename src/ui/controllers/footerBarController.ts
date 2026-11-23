// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 底栏控制器：版本检查、短暂加载进度/状态与账号操作共用同一固定底栏。
 * 精确 1:1 移植自 app/ui/footer_bar.py。
 */

import { APP_VERSION } from "../../core/appMeta.ts";
import { TypedEmitter } from "../../core/contracts.ts";
import type { ReleaseInfo } from "../../core/updateChecker.ts";
import { footerBackgroundColor } from "../theme.ts";

export type { ReleaseInfo };

export interface FooterBarState {
  height: number;
  versionText: string;
  versionVisible: boolean;
  updateButtonText: string;
  updateButtonVisible: boolean;
  progressValue: number | null;
  progressVisible: boolean;
  statusText: string;
  statusVisible: boolean;
  accountText: string;
  accountVisible: boolean;
  release: ReleaseInfo | null;
}

export type FooterBarEvents = {
  checkRequested: [];
  updateRequested: [];
  accountRequested: [];
  changed: [FooterBarState];
};

export class FooterBarController extends TypedEmitter<FooterBarEvents> {
  readonly height: number;
  readonly versionText: string = `当前版本号:v${APP_VERSION}`;
  versionVisible: boolean = true;
  updateButtonText: string = "";
  updateButtonVisible: boolean = false;
  progressValue: number | null = null;
  progressVisible: boolean = false;
  statusText: string = "";
  statusVisible: boolean = false;
  accountText: string = "退出登录";
  accountVisible: boolean = true;
  release: ReleaseInfo | null = null;

  private _rawStatusText: string = "";
  private _progressText: string = "";

  constructor(height = 30) {
    super();
    this.height = height;
    this._syncStatus();
  }

  setStatus(text: string): void {
    this._rawStatusText = text;
    this._syncStatus();
  }

  setProgress(value: number | null, text = ""): void {
    this.progressValue = value;
    this._progressText = text;
    this._syncStatus();
  }

  setRelease(info: ReleaseInfo | null): void {
    this.release = info;
    this.updateButtonText = info ? `发现新版 ${info.tag}` : "";
    this.setStatus(this._rawStatusText);
  }

  setLoggedIn(loggedIn: boolean): void {
    this.accountText = loggedIn ? "退出登录" : "登录账号";
    this.emit("changed", this.snapshot());
  }

  requestCheck(): void {
    this.emit("checkRequested");
  }

  requestUpdate(): void {
    this.emit("updateRequested");
  }

  requestAccount(): void {
    this.emit("accountRequested");
  }

  backgroundColor(): string {
    return footerBackgroundColor();
  }

  snapshot(): FooterBarState {
    return {
      height: this.height,
      versionText: this.versionText,
      versionVisible: this.versionVisible,
      updateButtonText: this.updateButtonText,
      updateButtonVisible: this.updateButtonVisible,
      progressValue: this.progressValue,
      progressVisible: this.progressVisible,
      statusText: this.statusText,
      statusVisible: this.statusVisible,
      accountText: this.accountText,
      accountVisible: this.accountVisible,
      release: this.release,
    };
  }

  private _syncStatus(): void {
    const loading = this.progressValue !== null;
    const text = loading ? this._progressText : this._rawStatusText;
    this.statusText = text;
    this.statusVisible = Boolean(text);
    this.progressVisible = loading;
    this.versionVisible = !text && !loading;
    this.updateButtonVisible = !text && !loading && this.release !== null;
    this.emit("changed", this.snapshot());
  }
}
