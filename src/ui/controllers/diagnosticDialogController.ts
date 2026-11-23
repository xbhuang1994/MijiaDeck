// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 单设备诊断报告预览与显式复制对话框控制器。
 * 精确 1:1 移植自 app/ui/diagnostic_dialog.py。
 */

import { type IJobExecutor, TypedEmitter } from "../../core/contracts.ts";
import type { DeviceInfo } from "../../core/models.ts";

export const DIAGNOSTIC_WINDOW_TITLE = "设备诊断报告 - MijiaDeck";
export const DIAGNOSTIC_FEEDBACK_URL = "https://github.com/Songmanual/MijiaDeck/issues/new";
export const DIAGNOSTIC_PRIVACY_NOTE =
  "先复现问题，再生成报告。复制后粘贴到 GitHub Issue，并补充操作步骤和实际现象。\n" +
  "仅采集所选设备的能力定义及连接诊断；不包含账号凭证、设备名称、房间、画面或当前传感器读数。";

export interface DiagnosticServiceLike {
  deviceDiagnosticReport(
    device: DeviceInfo,
    observation?: Record<string, unknown> | null,
  ): Promise<string> | string;
}

export type ObservationProvider = () => Record<string, unknown> | null | undefined;

export interface DiagnosticDialogOptions {
  autoGenerate?: boolean;
}

export interface DiagnosticDialogState {
  devices: DeviceInfo[];
  selectedIndex: number;
  previewText: string;
  copyEnabled: boolean;
  copyButtonText: string;
  generateEnabled: boolean;
  statusText: string;
  closed: boolean;
  generation: number;
}

export type DiagnosticDialogEvents = {
  changed: [DiagnosticDialogState];
  closed: [];
};

export class DiagnosticDialogController extends TypedEmitter<DiagnosticDialogEvents> {
  readonly devices: DeviceInfo[];
  selectedIndex: number = 0;
  previewText: string = "";
  copyEnabled: boolean = false;
  copyButtonText: string = "复制诊断报告";
  generateEnabled: boolean = false;
  statusText: string = "";
  closed: boolean = false;
  generation: number = 0;

  private readonly _service: DiagnosticServiceLike;
  private readonly _jobs: IJobExecutor;
  private readonly _observation: ObservationProvider | null;

  constructor(
    service: DiagnosticServiceLike,
    jobs: IJobExecutor,
    devices: readonly DeviceInfo[],
    observation: ObservationProvider | null = null,
    options: DiagnosticDialogOptions = {},
  ) {
    super();
    this._service = service;
    this._jobs = jobs;
    this.devices = [...devices];
    this._observation = observation;
    this.generateEnabled = this.devices.length > 0;

    if (options.autoGenerate !== false) {
      this.generate();
    }
  }

  deviceLabels(): string[] {
    return this.devices.map((device) => `${device.name} · ${device.model}`);
  }

  selectDevice(index: number): void {
    if (index < 0 || index >= this.devices.length) {
      return;
    }
    if (index === this.selectedIndex) {
      return;
    }
    this.selectedIndex = index;
    this.generation += 1;
    this.previewText = "";
    this.copyEnabled = false;
    this.copyButtonText = "复制诊断报告";
    this.statusText = "点击“重新生成”获取所选设备的报告。";
    this.generateEnabled = this.devices.length > 0;
    this.emit("changed", this.snapshot());
  }

  generate(): void {
    if (this.closed || this.devices.length === 0) {
      this.statusText = "当前没有可诊断的设备，请先登录并刷新设备。";
      this.emit("changed", this.snapshot());
      return;
    }

    this.generation += 1;
    const currentGen = this.generation;
    const device = this.devices[this.selectedIndex];
    const observed =
      typeof this._observation === "function" ? (this._observation() ?? null) : null;

    this.copyEnabled = false;
    this.copyButtonText = "复制诊断报告";
    this.previewText = "";
    this.generateEnabled = false;
    this.statusText = "正在获取设备能力定义，不会操作设备…";
    this.emit("changed", this.snapshot());

    const alive = (): boolean => !this.closed && currentGen === this.generation;

    this._jobs.submit<string>(
      () => this._service.deviceDiagnosticReport(device, observed),
      {
        onSuccess: (report: string) => {
          if (!alive()) return;
          this.generateEnabled = true;
          this.previewText = report;
          this.copyEnabled = true;
          this.statusText =
            "报告已生成。能力定义不代表功能已支持；未尝试的连接不会被记为成功。";
          this.emit("changed", this.snapshot());
        },
        onError: () => {
          if (!alive()) return;
          this.generateEnabled = true;
          this.statusText = "报告生成失败，请重试。未复制任何内容。";
          this.emit("changed", this.snapshot());
        },
      },
    );
  }

  /**
   * 仅由用户显式调用才写入剪贴板；生成报告绝不自动复制。
   */
  copy(clipboardWrite: (text: string) => void | Promise<void>): boolean {
    if (this.copyEnabled && this.previewText.length > 0) {
      void clipboardWrite(this.previewText);
      this.copyButtonText = "已复制";
      this.emit("changed", this.snapshot());
      return true;
    }
    return false;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.generation += 1;
    this.emit("closed");
    this.emit("changed", this.snapshot());
  }

  snapshot(): DiagnosticDialogState {
    return {
      devices: [...this.devices],
      selectedIndex: this.selectedIndex,
      previewText: this.previewText,
      copyEnabled: this.copyEnabled,
      copyButtonText: this.copyButtonText,
      generateEnabled: this.generateEnabled,
      statusText: this.statusText,
      closed: this.closed,
      generation: this.generation,
    };
  }
}
