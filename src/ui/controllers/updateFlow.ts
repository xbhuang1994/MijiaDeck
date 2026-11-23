// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 版本检查的界面流程（1:1 移植自 app/ui/update_flow.py）：
 * 发起检查 → 有新版本按场景提示，否则按场景反馈。
 *
 * 自动（启动时）与手动（底栏/关于页入口）共用这一条链路，仅反馈策略
 * 不同：自动检查在「无新版本」与「网络失败」时完全静默，有新版本时仅
 * 更新底栏角标不弹模态对话框；手动检查在错误或已是最新版时都给出明确
 * Toast 回显，有新版本时更新角标并触发版本更新提示。
 */

import { APP_VERSION } from "../../core/appMeta.ts";
import { isNewer, UpdateChecker, type ReleaseInfo } from "../../core/updateChecker.ts";

export interface UpdateHost {
  onUpdateAvailable?(info: ReleaseInfo | null): void;
  showToast?(text: string, durationMs?: number): void;
  promptNewVersion?(info: ReleaseInfo): void;
}

export interface CheckUpdateOptions {
  manual: boolean;
  checker?: Pick<UpdateChecker, "on" | "check">;
  fetcher?: typeof fetch;
  currentVersion?: string;
}

export interface UpdatePromptModel {
  title: string;
  text: string;
  informativeText: string;
  acceptLabel: string;
  rejectLabel: string;
  url: string;
}

/** 构造「发现新版本」对话框展示文案（与 app/ui/update_flow.py 一致）。 */
export function buildUpdatePrompt(
  info: ReleaseInfo,
  currentVersion: string = APP_VERSION,
): UpdatePromptModel {
  return {
    title: "发现新版本",
    text: `发现新版本 ${info.tag}（当前 v${currentVersion}）`,
    informativeText: info.name && info.name !== info.tag ? info.name : "",
    acceptLabel: "前往下载",
    rejectLabel: "暂不更新",
    url: info.url,
  };
}

/** 发起一次版本检查；自动检查静默且仅更新底栏角标，手动检查明确回显并弹窗。 */
export async function checkUpdate(host: UpdateHost, options: CheckUpdateOptions): Promise<void> {
  const checker = options.checker ?? new UpdateChecker();
  const currentVersion = options.currentVersion ?? APP_VERSION;

  let handled = false;
  const finish = (info: ReleaseInfo | null, error: Error | null): void => {
    if (handled) {
      return;
    }
    handled = true;
    unsubscribe();

    if (error !== null) {
      if (options.manual) {
        host.showToast?.(`检查更新失败：${error.message}`, 4000);
      }
      return;
    }

    if (info === null || !isNewer(info.tag, currentVersion)) {
      host.onUpdateAvailable?.(null);
      if (options.manual) {
        host.showToast?.("当前已是最新版本", 2500);
      }
      return;
    }

    host.onUpdateAvailable?.(info);
    if (!options.manual) {
      return;
    }
    host.promptNewVersion?.(info);
  };

  const unsubscribe = checker.on("checkFinished", finish);
  try {
    await checker.check(options.fetcher);
  } finally {
    unsubscribe();
  }
}
