// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Pi Agent 任务闭环核心引擎：
 * 1. 执行后真实设备状态核验（回读 powerState / readProps / readProp，绝不盲信写入返回；支持设备/云端异步状态延迟确认轮询）
 * 2. 问题可解性思考与分类（区分离线/未找到/硬件不支持等不可解问题与状态不一致/超时等可解问题）
 * 3. 最多 3 轮递进式排错恢复计划生成（静默自愈重试，仅在时间线记录排错详情，不打扰用户播报）
 * 4. 成功后提炼沉淀为可复用 Skill 所需的结构化步骤与校验规则
 */

import { lightControls } from "../core/deviceControls.ts";
import { JobExecutor } from "../core/jobs.ts";
import { isSpeaker, type DeviceInfo, type PropInfo } from "../core/models.ts";
import { ServiceError } from "../core/service.ts";
import type { IJobExecutor } from "../core/contracts.ts";
import type {
  AgentSkillStep,
  AgentSkillVerificationSpec,
} from "./agentSkillStore.ts";
import { parseColorToRgbInt, type SmartHomeToolDeps } from "./smartHomeTools.ts";

export const MAX_RECOVERY_ROUNDS = 3;

/** 通用设备状态回读出现不一致/瞬时回读异常时的延迟确认轮询间隔（ms）；首次回读已一致时零等待。 */
export const DEFAULT_VERIFY_SETTLE_DELAYS_MS: readonly number[] = [300, 600];

/** 智能音箱播放状态（playing-state）延迟确认轮询间隔（ms）：覆盖音箱停播/暂停缓冲与云端异步状态同步窗口（约 1~4s）。 */
export const DEFAULT_SPEAKER_PLAYBACK_SETTLE_DELAYS_MS: readonly number[] = [700, 1000, 1300];

export interface VerifyExecutedToolCallsOptions {
  isCloudLlm?: boolean;
  signal?: AbortSignal;
  /** 通用属性/开关回读不一致时的延迟确认轮询间隔列表（ms） */
  settleDelaysMs?: readonly number[];
  /** 音箱播放状态回读不一致时的延迟确认轮询间隔列表（ms） */
  speakerPlaybackSettleDelaysMs?: readonly number[];
  /** 可选自定义 sleep（用于确定性单元测试） */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const MUTATING_TOOLS = new Set<string>([
  "set_device_power",
  "control_light",
  "control_speaker",
  "set_device_property",
  "run_device_action",
  "run_scene",
  "send_xiaoai_command",
]);

export interface ExecutedToolTrace {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
  text: string;
  details: Record<string, unknown> | null;
}

export type VerificationIssueCode =
  | "tool_error"
  | "power_mismatch"
  | "property_mismatch"
  | "playback_mismatch"
  | "readback_error"
  | "device_offline"
  | "device_not_found"
  | "unsupported_capability"
  | "access_blocked"
  | "invalid_argument"
  | "runtime_error";

export interface VerificationIssue {
  code: VerificationIssueCode;
  solvable: boolean;
  did?: string;
  deviceName?: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  summary: string;
  expected?: string;
  actual?: string;
  property?: string;
  expectedValue?: unknown;
  executedAction?: string;
  rawError?: string;
}

export interface VerificationCheckItem {
  did?: string;
  deviceName?: string;
  toolName: string;
  passed: boolean;
  summary: string;
}

export interface TaskVerificationOutcome {
  checked: boolean;
  passed: boolean;
  checks: VerificationCheckItem[];
  issues: VerificationIssue[];
  solvable: boolean;
  analysis: string;
  specs: AgentSkillVerificationSpec[];
}

export interface TaskVerificationSummary {
  status: "passed" | "recovered" | "failed" | "unsolvable" | "skipped";
  passed: boolean;
  checked: boolean;
  solvable: boolean;
  retriesUsed: number;
  maxRetries: number;
  analysis: string;
  checks: VerificationCheckItem[];
  issues: Array<{
    code: VerificationIssueCode;
    solvable: boolean;
    did?: string;
    deviceName?: string;
    summary: string;
  }>;
}

export interface RecoveryPlan {
  canSolve: boolean;
  attempt: number;
  maxAttempts: number;
  problem: string;
  plan: string;
  noticeText: string;
  steps: AgentSkillStep[];
  llmGuidancePrompt: string;
}

function runJob<T>(jobs: IJobExecutor, fn: () => T | Promise<T>, priority = 2): Promise<T> {
  if (jobs instanceof JobExecutor && jobs.isClosed) {
    return Promise.reject(new ServiceError("后台任务执行器已关闭"));
  }
  return new Promise<T>((resolve, reject) => {
    jobs.submit(fn, {
      priority,
      onSuccess: (res) => resolve(res),
      onError: (err) => reject(err),
    });
  });
}

function findPowerProp(props: readonly PropInfo[]): PropInfo | null {
  return (
    props.find(
      (p) =>
        p.type === "bool" &&
        p.writable &&
        (p.name === "on" || p.name.startsWith("on-") || p.name.startsWith("on_")),
    ) ?? null
  );
}

function findSpeakerProps(props: readonly PropInfo[]): {
  volumeProp: PropInfo | null;
  speakerMuteProp: PropInfo | null;
  micMuteProp: PropInfo | null;
  playingStateProp: PropInfo | null;
} {
  const volumeProp =
    props.find((p) => p.name === "volume" && p.readable) ??
    props.find((p) => p.name.startsWith("volume") && p.readable) ??
    null;
  const speakerMuteProp =
    props.find((p) => p.service === "speaker" && p.name.startsWith("mute") && p.readable) ??
    props.find((p) => p.name === "mute-2" && p.readable) ??
    props.find((p) => p.name === "mute" && p.readable) ??
    props.find((p) => p.name.startsWith("mute") && p.readable && p.name !== "mute-4") ??
    null;
  const micMuteProp =
    props.find((p) => p.service === "microphone" && p.name.startsWith("mute") && p.readable) ??
    props.find((p) => p.name === "mute-4" && p.readable) ??
    null;
  const playingStateProp =
    props.find((p) => p.name === "playing-state" && p.readable) ?? null;

  return { volumeProp, speakerMuteProp, micMuteProp, playingStateProp };
}

/**
 * 从 MIoT 规格 `playing-state` 的 `value_list` 动态解析代表“正在播放”的枚举值（默认 1）。
 * 兼容不同音箱型号（如 xiaomi.wifispeaker.l05b 为 1=Playing，部分机型枚举可能不同）。
 */
export function resolveSpeakerPlayingValue(prop: PropInfo): number {
  if (Array.isArray(prop.value_list) && prop.value_list.length > 0) {
    const hit = prop.value_list.find((opt) => {
      const desc = `${opt.description ?? ""} ${opt.desc_zh_cn ?? ""}`.trim();
      return /\bplaying\b|播放中|正在播放/i.test(desc);
    });
    if (hit && typeof hit.value === "number" && Number.isFinite(hit.value)) {
      return hit.value;
    }
  }
  return 1;
}

function isStopOrPauseXiaoAiDirective(text: string): "stop" | "pause" | null {
  const clean = text.trim();
  if (!clean) return null;
  if (/(?:暂停播放|暂停音乐|暂停一下|暂停)/i.test(clean)) return "pause";
  if (/(?:停止播放|停止音乐|别放了|不要放了|不要播放|关掉音乐|关闭音乐|停播)/i.test(clean)) {
    return "stop";
  }
  return null;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface SettlePollAttemptResult<T> {
  passed: boolean;
  value: T;
  fatal?: boolean;
}

/**
 * 延迟确认轮询：
 * - 首次回读若已符合预期，零延迟立即放行；
 * - 若因设备执行缓冲或云端影子状态上报延迟导致首次回读不一致/瞬时超时，按递进间隔重读确认，
 *   一旦同步到位即刻通过，避免误判失败并触发不必要的自愈重试与虚假技能沉淀；
 * - 若遇到不可重试异常（未登录/离线/执行器已关闭）或任务被中止，立即退出不空等。
 */
async function runWithSettleConfirmation<T>(
  attemptFn: () => Promise<SettlePollAttemptResult<T>>,
  delaysMs: readonly number[],
  sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<{ result: SettlePollAttemptResult<T>; settledAfterDelay: boolean; attempts: number }> {
  let current = await attemptFn();
  let attempts = 1;
  if (current.passed || current.fatal) {
    return { result: current, settledAfterDelay: false, attempts };
  }
  for (const delayMs of delaysMs) {
    if (signal?.aborted) {
      break;
    }
    await sleepFn(delayMs, signal);
    if (signal?.aborted) {
      break;
    }
    current = await attemptFn();
    attempts += 1;
    if (current.passed) {
      return { result: current, settledAfterDelay: true, attempts };
    }
    if (current.fatal) {
      break;
    }
  }
  return { result: current, settledAfterDelay: false, attempts };
}

function isReadbackErrorFatal(
  toolName: string,
  toolArgs: Record<string, unknown>,
  rawError: string,
  did?: string,
  deviceName?: string,
): boolean {
  const classified = classifyToolError(toolName, toolArgs, rawError, { did, deviceName });
  return !classified.solvable;
}

function scaleExpectedBrightness(prop: PropInfo, pct: number): number {
  const low = prop.range && prop.range.length >= 2 ? prop.range[0] : 1;
  const high = prop.range && prop.range.length >= 2 ? prop.range[1] : 100;
  const step = prop.range && prop.range.length >= 3 ? prop.range[2] : 1;
  const scaled = high === 100 ? pct : (pct / 100) * high;
  let clamped = Math.max(low, Math.min(high, scaled));
  if (step && step > 0) {
    clamped = low + Math.round((clamped - low) / step) * step;
    clamped = Math.max(low, Math.min(high, clamped));
  }
  return Math.round(clamped);
}

function formatBrightnessPct(prop: PropInfo, rawVal: number): number {
  const high = prop.range && prop.range.length >= 2 ? prop.range[1] : 100;
  if (high === 100 || high <= 0) return Math.round(rawVal);
  return Math.round((rawVal / high) * 100);
}

/**
 * 判断一条工具错误属于“不可自动解决”还是“可尝试思考并重试解决”。
 */
export function classifyToolError(
  toolName: string,
  toolArgs: Record<string, unknown>,
  rawError: string,
  options: {
    did?: string;
    deviceName?: string;
    isCloudLlm?: boolean;
  } = {},
): VerificationIssue {
  const msg = rawError.trim() || "工具执行失败";
  const devLabel = options.deviceName || (typeof toolArgs.target === "string" ? toolArgs.target : "");

  if (/(尚未登录|未登录|扫码登录|网络不可用|API\s*Key|后台任务执行器已关闭)/i.test(msg)) {
    return {
      code: "access_blocked",
      solvable: false,
      did: options.did,
      deviceName: options.deviceName,
      toolName,
      toolArgs,
      summary: msg,
      rawError: msg,
    };
  }

  if (/(?:设备已?离线|当前离线|离线[，,。]|离线$)/.test(msg)) {
    return {
      code: "device_offline",
      solvable: false,
      did: options.did,
      deviceName: options.deviceName,
      toolName,
      toolArgs,
      summary: devLabel && !msg.includes(devLabel) ? `${devLabel}当前离线` : msg,
      rawError: msg,
    };
  }

  if (
    /(未找到设备|未找到灯具|未找到可控设备|未找到场景|未找到指定的小爱音箱|未找到指定的音箱或红外音响|没有可用的在线|未添加任何智能音箱)/.test(
      msg,
    )
  ) {
    return {
      code: "device_not_found",
      solvable: false,
      did: options.did,
      deviceName: options.deviceName,
      toolName,
      toolArgs,
      summary: msg,
      rawError: msg,
    };
  }

  if (
    /(不支持亮度调节|不支持色温调节|不支持颜色调节|不支持静音控制|不支持麦克风静音|不支持音量调节|不是灯具设备|不是小爱音箱|不是音箱或红外音响设备|不支持开关控制|不支持该动作|暂不支持(?:绝对音量|语音点歌|文本播报|麦克风静音)|为红外遥控音响，暂不支持|不支持该红外参数组合|错误码\s*2050|仅支持只读遥测监控|不支持开关切换|属于高风险不可逆动作|confirm_dangerous|安全闸门拦截|过热告警|远程控制权限|硬阻断|必须明确确认)/.test(
      msg,
    )
  ) {
    return {
      code: "unsupported_capability",
      solvable: false,
      did: options.did,
      deviceName: options.deviceName,
      toolName,
      toolArgs,
      summary: msg,
      rawError: msg,
    };
  }

  // 云端大模型调用 set_device_property 传错属性名时，可通过查看设备详情修正属性名
  if (/未找到可写属性/.test(msg)) {
    return {
      code: "invalid_argument",
      solvable: Boolean(options.isCloudLlm),
      did: options.did,
      deviceName: options.deviceName,
      toolName,
      toolArgs,
      summary: msg,
      rawError: msg,
    };
  }

  if (/(无法识别颜色|参数无效|超出范围|不能为空)/.test(msg)) {
    return {
      code: "invalid_argument",
      solvable: Boolean(options.isCloudLlm),
      did: options.did,
      deviceName: options.deviceName,
      toolName,
      toolArgs,
      summary: msg,
      rawError: msg,
    };
  }

  // 其余如超时、网络抖动、MIoT 临时错误码、写入/动作失败等：归为可尝试恢复解决
  return {
    code: "tool_error",
    solvable: true,
    did: options.did,
    deviceName: options.deviceName,
    toolName,
    toolArgs,
    summary: devLabel && !msg.includes(devLabel) ? `${devLabel}执行失败（${msg}）` : msg,
    rawError: msg,
  };
}

function valuesMatch(expected: unknown, actual: unknown, prop?: PropInfo | null): boolean {
  if (typeof expected === "boolean") {
    return actual === expected;
  }
  if (typeof expected === "number" && typeof actual === "number" && Number.isFinite(actual)) {
    const step = prop?.range && prop.range.length >= 3 ? prop.range[2] : 1;
    const rangeSpan =
      prop?.range && prop.range.length >= 2 ? Math.abs(prop.range[1] - prop.range[0]) : 100;
    const tol = Math.max(step || 1, rangeSpan > 500 ? 50 : 2);
    return Math.abs(actual - expected) <= tol;
  }
  if (typeof expected === "string" && typeof actual === "string") {
    return expected.trim().toLowerCase() === actual.trim().toLowerCase();
  }
  return expected === actual;
}

/**
 * 执行后真实状态检查：
 * 对本轮所有涉及状态变更（或发生错误）的工具调用执行实时回读校验，
 * 发现状态不一致或执行异常时输出结构化诊断结果。
 */
export async function verifyExecutedToolCalls(
  traces: readonly ExecutedToolTrace[],
  deps: SmartHomeToolDeps,
  options: VerifyExecutedToolCallsOptions = {},
): Promise<TaskVerificationOutcome> {
  const checks: VerificationCheckItem[] = [];
  const issues: VerificationIssue[] = [];
  const specs: AgentSkillVerificationSpec[] = [];
  const devices = deps.mainWindow.activeDevices();
  const deviceByDid = new Map<string, DeviceInfo>(devices.map((d) => [d.did, d]));
  const settleDelays = options.settleDelaysMs ?? DEFAULT_VERIFY_SETTLE_DELAYS_MS;
  const speakerPlaybackDelays =
    options.speakerPlaybackSettleDelaysMs ?? DEFAULT_SPEAKER_PLAYBACK_SETTLE_DELAYS_MS;
  const sleepFn = options.sleep ?? sleepWithAbort;
  const signal = options.signal;
  let anyMutatingOrError = false;
  let stateMutated = false;

  for (const trace of traces) {
    if (signal?.aborted) {
      break;
    }
    const isMutating = MUTATING_TOOLS.has(trace.name);
    if (!isMutating && !trace.isError) {
      continue;
    }
    anyMutatingOrError = true;
    const d = trace.details ?? {};

    // 1. set_device_power
    if (trace.name === "set_device_power") {
      const failed = Array.isArray(d.failed)
        ? (d.failed as Array<{ did?: string; name?: string; reason?: string }>)
        : [];
      const succeeded = Array.isArray(d.succeeded)
        ? (d.succeeded as Array<{ did?: string; name?: string; state?: boolean; note?: string }>)
        : [];

      if (trace.isError && failed.length === 0) {
        issues.push(
          classifyToolError(trace.name, trace.args, trace.text, {
            isCloudLlm: options.isCloudLlm,
          }),
        );
        continue;
      }

      for (const f of failed) {
        issues.push(
          classifyToolError(
            trace.name,
            {
              ...trace.args,
              ...(f.did ? { target: f.did } : f.name ? { target: f.name } : {}),
            },
            f.reason || "控制失败",
            {
              did: f.did,
              deviceName: f.name,
              isCloudLlm: options.isCloudLlm,
            },
          ),
        );
      }

      for (const s of succeeded) {
        if (signal?.aborted) break;
        const did = typeof s.did === "string" ? s.did : "";
        const name = typeof s.name === "string" && s.name ? s.name : did || "设备";
        if (!did || typeof s.state !== "boolean") continue;
        const dev = deviceByDid.get(did);
        specs.push({
          did,
          deviceName: name,
          toolName: trace.name,
          expectedPower: s.state,
          note: `${name}预期${s.state ? "开启" : "关闭"}`,
        });

        if (dev && isSpeaker(dev)) {
          let cachedDetail: Awaited<ReturnType<typeof deps.service.deviceDetail>> | null = null;
          const pollDelays = !s.state ? speakerPlaybackDelays : settleDelays;
          const settled = await runWithSettleConfirmation(
            async () => {
              try {
                const detail =
                  cachedDetail ?? (await runJob(deps.jobs, () => deps.service.deviceDetail(did), 2));
                cachedDetail = detail;
                const { speakerMuteProp, playingStateProp } = findSpeakerProps(detail.props);
                const toRead = [speakerMuteProp?.name, playingStateProp?.name].filter(
                  (n): n is string => Boolean(n),
                );
                if (toRead.length === 0) {
                  return {
                    passed: true,
                    value: {
                      checks: [
                        {
                          did,
                          deviceName: name,
                          toolName: trace.name,
                          passed: true,
                          summary: `${name}指令已执行`,
                        },
                      ] as VerificationCheckItem[],
                      issues: [] as VerificationIssue[],
                    },
                  };
                }
                const vals = await runJob(deps.jobs, () => deps.service.readProps(did, toRead), 2);
                const expectedMuted = !s.state;
                const roundChecks: VerificationCheckItem[] = [];
                const roundIssues: VerificationIssue[] = [];
                if (speakerMuteProp && typeof vals[speakerMuteProp.name] === "boolean") {
                  const actualMuted = vals[speakerMuteProp.name] as boolean;
                  if (actualMuted !== expectedMuted) {
                    roundIssues.push({
                      code: "property_mismatch",
                      solvable: true,
                      did,
                      deviceName: name,
                      toolName: trace.name,
                      toolArgs: { target: did, state: s.state ? "on" : "off" },
                      property: speakerMuteProp.name,
                      expectedValue: expectedMuted,
                      expected: expectedMuted ? "静音待机" : "取消静音",
                      actual: actualMuted ? "静音" : "未静音",
                      summary: `${name}状态检查异常：当前仍处于${actualMuted ? "静音" : "未静音"}（预期${expectedMuted ? "静音待机" : "唤醒/取消静音"}）`,
                    });
                  } else {
                    roundChecks.push({
                      did,
                      deviceName: name,
                      toolName: trace.name,
                      passed: true,
                      summary: `${name}状态核验通过（${expectedMuted ? "已静音待机" : "已唤醒"}）`,
                    });
                  }
                }
                if (!s.state && playingStateProp && typeof vals[playingStateProp.name] === "number") {
                  const playingVal = resolveSpeakerPlayingValue(playingStateProp);
                  if ((vals[playingStateProp.name] as number) === playingVal) {
                    roundIssues.push({
                      code: "playback_mismatch",
                      solvable: true,
                      did,
                      deviceName: name,
                      toolName: trace.name,
                      toolArgs: { target: did, state: "off" },
                      property: playingStateProp.name,
                      expectedValue: 2,
                      expected: "暂停/停止播放",
                      actual: "仍在播放",
                      summary: `${name}状态检查异常：仍在播放中，未停止`,
                    });
                  }
                }
                if (roundIssues.length === 0 && roundChecks.length === 0) {
                  roundChecks.push({
                    did,
                    deviceName: name,
                    toolName: trace.name,
                    passed: true,
                    summary: `${name}状态核验通过`,
                  });
                }
                return {
                  passed: roundIssues.length === 0,
                  value: { checks: roundChecks, issues: roundIssues },
                };
              } catch (err) {
                const rawErr = err instanceof Error ? err.message : String(err);
                const toolArgs = { target: did, state: s.state ? "on" : "off" };
                const fatal = isReadbackErrorFatal(trace.name, toolArgs, rawErr, did, name);
                return {
                  passed: false,
                  fatal,
                  value: {
                    checks: [] as VerificationCheckItem[],
                    issues: [
                      {
                        code: "readback_error",
                        solvable: !fatal,
                        did,
                        deviceName: name,
                        toolName: trace.name,
                        toolArgs,
                        summary: `${name}状态回读失败（${rawErr}）`,
                        rawError: rawErr,
                      },
                    ] as VerificationIssue[],
                  },
                };
              }
            },
            pollDelays,
            sleepFn,
            signal,
          );
          for (const c of settled.result.value.checks) {
            checks.push(
              settled.settledAfterDelay ? { ...c, summary: `${c.summary}（延迟同步确认）` } : c,
            );
          }
          for (const iss of settled.result.value.issues) {
            issues.push(iss);
          }
          continue;
        }

        const powerSettled = await runWithSettleConfirmation<{
          actualPower: boolean | null;
          check: VerificationCheckItem | null;
          issue: VerificationIssue | null;
        }>(
          async () => {
            try {
              const actualPower = await runJob(deps.jobs, () => deps.service.powerState(did), 2);
              if (typeof actualPower === "boolean") {
                if (actualPower !== s.state) {
                  return {
                    passed: false,
                    value: {
                      actualPower,
                      check: null as VerificationCheckItem | null,
                      issue: {
                        code: "power_mismatch",
                        solvable: true,
                        did,
                        deviceName: name,
                        toolName: trace.name,
                        toolArgs: { target: did, state: s.state ? "on" : "off" },
                        expectedValue: s.state,
                        expected: s.state ? "开启" : "关闭",
                        actual: actualPower ? "开启" : "关闭",
                        summary: `${name}状态检查未生效：当前仍为${actualPower ? "开启" : "关闭"}（预期${s.state ? "开启" : "关闭"}）`,
                      } as VerificationIssue,
                    },
                  };
                }
                return {
                  passed: true,
                  value: {
                    actualPower,
                    check: {
                      did,
                      deviceName: name,
                      toolName: trace.name,
                      passed: true,
                      summary: `${name}电源状态核验通过（已${s.state ? "开启" : "关闭"}）`,
                    } as VerificationCheckItem,
                    issue: null as VerificationIssue | null,
                  },
                };
              }
              return {
                passed: true,
                value: {
                  actualPower: null as boolean | null,
                  check: {
                    did,
                    deviceName: name,
                    toolName: trace.name,
                    passed: true,
                    summary: `${name}开关指令已送达`,
                  } as VerificationCheckItem,
                  issue: null as VerificationIssue | null,
                },
              };
            } catch (err) {
              const rawErr = err instanceof Error ? err.message : String(err);
              const toolArgs = { target: did, state: s.state ? "on" : "off" };
              const fatal = isReadbackErrorFatal(trace.name, toolArgs, rawErr, did, name);
              return {
                passed: false,
                fatal,
                value: {
                  actualPower: null as boolean | null,
                  check: null as VerificationCheckItem | null,
                  issue: {
                    code: "readback_error",
                    solvable: !fatal,
                    did,
                    deviceName: name,
                    toolName: trace.name,
                    toolArgs,
                    summary: `${name}状态回读失败（${rawErr}）`,
                    rawError: rawErr,
                  } as VerificationIssue,
                },
              };
            }
          },
          settleDelays,
          sleepFn,
          signal,
        );
        if (typeof powerSettled.result.value.actualPower === "boolean") {
          if (deps.mainWindow.knownPower[did] !== powerSettled.result.value.actualPower) {
            deps.mainWindow.applyPowerState(did, powerSettled.result.value.actualPower);
            stateMutated = true;
          }
        }
        if (powerSettled.result.value.check) {
          const c = powerSettled.result.value.check;
          checks.push(
            powerSettled.settledAfterDelay ? { ...c, summary: `${c.summary}（延迟同步确认）` } : c,
          );
        }
        if (powerSettled.result.value.issue) {
          issues.push(powerSettled.result.value.issue);
        }
      }
      continue;
    }

    // 2. control_light
    if (trace.name === "control_light") {
      if (trace.isError) {
        issues.push(
          classifyToolError(trace.name, trace.args, trace.text, {
            isCloudLlm: options.isCloudLlm,
          }),
        );
        continue;
      }
      const did = typeof d.did === "string" ? d.did : "";
      const name = typeof d.name === "string" && d.name ? d.name : did || "灯具";
      if (!did) continue;

      const expectOff = d.on === false || trace.args.on === false;
      const hasVisualAdjust =
        typeof d.brightness === "number" ||
        typeof d.colorTemperature === "number" ||
        typeof d.color === "string" ||
        typeof d.mode === "string";
      const expectOn = !expectOff && (d.turnedOn === true || trace.args.on === true || hasVisualAdjust);

      const expectedPropsSpec: Record<string, unknown> = {};
      if (typeof d.brightness === "number") expectedPropsSpec.brightness = d.brightness;
      if (typeof d.colorTemperature === "number") expectedPropsSpec["color-temperature"] = d.colorTemperature;
      if (typeof d.color === "string") expectedPropsSpec.color = d.color;
      specs.push({
        did,
        deviceName: name,
        toolName: trace.name,
        ...(expectOff ? { expectedPower: false } : expectOn ? { expectedPower: true } : {}),
        ...(Object.keys(expectedPropsSpec).length > 0 ? { expectedProps: expectedPropsSpec } : {}),
      });

      let cachedDetail: Awaited<ReturnType<typeof deps.service.deviceDetail>> | null = null;
      const lightSettled = await runWithSettleConfirmation(
        async () => {
          try {
            const detail =
              cachedDetail ?? (await runJob(deps.jobs, () => deps.service.deviceDetail(did), 2));
            cachedDetail = detail;
            const controls = lightControls(detail.props);
            const powerProp = findPowerProp(detail.props);
            const modeProp = detail.props.find((p) => p.name === "mode" && p.readable) ?? null;

            const toRead = [
              powerProp?.readable ? powerProp.name : null,
              typeof d.brightness === "number" && controls.brightness?.readable ? controls.brightness.name : null,
              typeof d.colorTemperature === "number" && controls.temperature?.readable
                ? controls.temperature.name
                : null,
              typeof d.color === "string" && controls.color?.readable ? controls.color.name : null,
              typeof d.mode === "string" && modeProp ? modeProp.name : null,
            ].filter((n): n is string => Boolean(n));

            const vals =
              toRead.length > 0
                ? await runJob(deps.jobs, () => deps.service.readProps(did, toRead), 2)
                : {};

            const roundIssues: VerificationIssue[] = [];
            let observedPower: boolean | null = null;

            if (powerProp && typeof vals[powerProp.name] === "boolean") {
              const actualOn = vals[powerProp.name] as boolean;
              observedPower = actualOn;
              if (expectOff && actualOn !== false) {
                roundIssues.push({
                  code: "power_mismatch",
                  solvable: true,
                  did,
                  deviceName: name,
                  toolName: trace.name,
                  toolArgs: { ...trace.args, target: did, on: false },
                  property: powerProp.name,
                  expectedValue: false,
                  expected: "关闭",
                  actual: "开启",
                  summary: `${name}状态检查未生效：当前仍为开启（预期关闭）`,
                });
              } else if (expectOn && actualOn !== true) {
                roundIssues.push({
                  code: "power_mismatch",
                  solvable: true,
                  did,
                  deviceName: name,
                  toolName: trace.name,
                  toolArgs: { ...trace.args, target: did, on: true },
                  property: powerProp.name,
                  expectedValue: true,
                  expected: "开启",
                  actual: "关闭",
                  summary: `${name}状态检查未生效：灯具电源仍为关闭（预期开启）`,
                });
              }
            }

            if (!expectOff && typeof d.brightness === "number" && controls.brightness) {
              const actualRaw = vals[controls.brightness.name];
              if (typeof actualRaw === "number" && Number.isFinite(actualRaw)) {
                const expectedRaw = scaleExpectedBrightness(controls.brightness, d.brightness);
                const high =
                  controls.brightness.range && controls.brightness.range.length >= 2
                    ? controls.brightness.range[1]
                    : 100;
                const tol = Math.max(2, Math.ceil(high * 0.02));
                if (Math.abs(actualRaw - expectedRaw) > tol) {
                  const actualPct = formatBrightnessPct(controls.brightness, actualRaw);
                  roundIssues.push({
                    code: "property_mismatch",
                    solvable: true,
                    did,
                    deviceName: name,
                    toolName: trace.name,
                    toolArgs: { ...trace.args, target: did, brightness: d.brightness },
                    property: controls.brightness.name,
                    expectedValue: expectedRaw,
                    expected: `${d.brightness}%`,
                    actual: `${actualPct}%`,
                    summary: `${name}亮度状态检查未生效：当前为 ${actualPct}%（目标 ${d.brightness}%）`,
                  });
                }
              }
            }

            if (!expectOff && typeof d.colorTemperature === "number" && controls.temperature) {
              const actualK = vals[controls.temperature.name];
              if (typeof actualK === "number" && Number.isFinite(actualK)) {
                if (Math.abs(actualK - d.colorTemperature) > 80) {
                  roundIssues.push({
                    code: "property_mismatch",
                    solvable: true,
                    did,
                    deviceName: name,
                    toolName: trace.name,
                    toolArgs: { ...trace.args, target: did, color_temperature: d.colorTemperature },
                    property: controls.temperature.name,
                    expectedValue: d.colorTemperature,
                    expected: `${d.colorTemperature}K`,
                    actual: `${actualK}K`,
                    summary: `${name}色温状态检查未生效：当前为 ${actualK}K（目标 ${d.colorTemperature}K）`,
                  });
                }
              }
            }

            if (!expectOff && typeof d.color === "string" && controls.color) {
              const expectedRgb = parseColorToRgbInt(d.color);
              const actualRgb = vals[controls.color.name];
              if (expectedRgb !== null && typeof actualRgb === "number" && actualRgb !== expectedRgb) {
                roundIssues.push({
                  code: "property_mismatch",
                  solvable: true,
                  did,
                  deviceName: name,
                  toolName: trace.name,
                  toolArgs: { ...trace.args, target: did, color: d.color },
                  property: controls.color.name,
                  expectedValue: expectedRgb,
                  expected: d.color,
                  actual: `#${actualRgb.toString(16).padStart(6, "0")}`,
                  summary: `${name}颜色状态检查未生效（目标 ${d.color}）`,
                });
              }
            }

            return {
              passed: roundIssues.length === 0,
              value: { observedPower, issues: roundIssues },
            };
          } catch (err) {
            const rawErr = err instanceof Error ? err.message : String(err);
            const toolArgs = { ...trace.args, target: did };
            const fatal = isReadbackErrorFatal(trace.name, toolArgs, rawErr, did, name);
            return {
              passed: false,
              fatal,
              value: {
                observedPower: null as boolean | null,
                issues: [
                  {
                    code: "readback_error",
                    solvable: !fatal,
                    did,
                    deviceName: name,
                    toolName: trace.name,
                    toolArgs,
                    summary: `${name}状态回读失败（${rawErr}）`,
                    rawError: rawErr,
                  },
                ] as VerificationIssue[],
              },
            };
          }
        },
        settleDelays,
        sleepFn,
        signal,
      );

      if (typeof lightSettled.result.value.observedPower === "boolean") {
        if (deps.mainWindow.knownPower[did] !== lightSettled.result.value.observedPower) {
          deps.mainWindow.applyPowerState(did, lightSettled.result.value.observedPower);
          stateMutated = true;
        }
      }
      if (lightSettled.result.passed) {
        checks.push({
          did,
          deviceName: name,
          toolName: trace.name,
          passed: true,
          summary: lightSettled.settledAfterDelay
            ? `${name}灯光状态核验通过（延迟同步确认）`
            : `${name}灯光状态核验通过`,
        });
      } else {
        for (const iss of lightSettled.result.value.issues) {
          issues.push(iss);
        }
      }
      continue;
    }

    // 3. control_speaker
    if (trace.name === "control_speaker") {
      if (trace.isError) {
        issues.push(
          classifyToolError(trace.name, trace.args, trace.text, {
            isCloudLlm: options.isCloudLlm,
          }),
        );
        continue;
      }
      const did = typeof d.did === "string" ? d.did : "";
      const name = typeof d.name === "string" && d.name ? d.name : did || "音箱";
      if (!did) continue;

      const expectedPropsSpec: Record<string, unknown> = {};
      if (typeof d.volume === "number") expectedPropsSpec.volume = d.volume;
      if (typeof d.mute === "boolean") expectedPropsSpec.mute = d.mute;
      if (typeof d.playback === "string") expectedPropsSpec.playback = d.playback;
      specs.push({
        did,
        deviceName: name,
        toolName: trace.name,
        ...(Object.keys(expectedPropsSpec).length > 0 ? { expectedProps: expectedPropsSpec } : {}),
      });

      const needsPlaybackCheck =
        d.playback === "stop" ||
        d.playback === "pause" ||
        d.playback === "play" ||
        trace.args.power === "off";
      const executedAction =
        typeof d.executedPlaybackAction === "string" ? d.executedPlaybackAction : undefined;
      let cachedDetail: Awaited<ReturnType<typeof deps.service.deviceDetail>> | null = null;
      const pollDelays = needsPlaybackCheck ? speakerPlaybackDelays : settleDelays;

      const spkSettled = await runWithSettleConfirmation(
        async () => {
          try {
            const detail =
              cachedDetail ?? (await runJob(deps.jobs, () => deps.service.deviceDetail(did), 2));
            cachedDetail = detail;
            const { volumeProp, speakerMuteProp, micMuteProp, playingStateProp } = findSpeakerProps(
              detail.props,
            );
            const toRead = [
              typeof d.volume === "number" && volumeProp ? volumeProp.name : null,
              (typeof d.mute === "boolean" || trace.args.power === "on" || trace.args.power === "off") &&
              speakerMuteProp
                ? speakerMuteProp.name
                : null,
              typeof d.micMute === "boolean" && micMuteProp ? micMuteProp.name : null,
              needsPlaybackCheck && playingStateProp ? playingStateProp.name : null,
            ].filter((n): n is string => Boolean(n));

            const vals =
              toRead.length > 0
                ? await runJob(deps.jobs, () => deps.service.readProps(did, toRead), 2)
                : {};

            const roundIssues: VerificationIssue[] = [];

            if (typeof d.volume === "number" && volumeProp) {
              const actualVol = vals[volumeProp.name];
              if (typeof actualVol === "number" && Math.abs(actualVol - d.volume) > 2) {
                roundIssues.push({
                  code: "property_mismatch",
                  solvable: true,
                  did,
                  deviceName: name,
                  toolName: trace.name,
                  toolArgs: { ...trace.args, target: did, volume: d.volume },
                  property: volumeProp.name,
                  expectedValue: d.volume,
                  expected: `音量 ${d.volume}%`,
                  actual: `音量 ${actualVol}%`,
                  summary: `${name}音量状态检查未生效：当前为 ${actualVol}%（目标 ${d.volume}%）`,
                });
              }
            }

            const expectedMute =
              typeof d.mute === "boolean"
                ? d.mute
                : trace.args.power === "off"
                  ? true
                  : trace.args.power === "on"
                    ? false
                    : undefined;
            if (expectedMute !== undefined && speakerMuteProp) {
              const actualMute = vals[speakerMuteProp.name];
              if (typeof actualMute === "boolean" && actualMute !== expectedMute) {
                roundIssues.push({
                  code: "property_mismatch",
                  solvable: true,
                  did,
                  deviceName: name,
                  toolName: trace.name,
                  toolArgs: { ...trace.args, target: did, mute: expectedMute },
                  property: speakerMuteProp.name,
                  expectedValue: expectedMute,
                  expected: expectedMute ? "静音" : "取消静音",
                  actual: actualMute ? "静音" : "未静音",
                  summary: `${name}静音状态检查未生效：当前仍为${actualMute ? "静音" : "未静音"}（预期${expectedMute ? "静音" : "取消静音"}）`,
                });
              }
            }

            if (typeof d.micMute === "boolean" && micMuteProp) {
              const actualMicMute = vals[micMuteProp.name];
              if (typeof actualMicMute === "boolean" && actualMicMute !== d.micMute) {
                roundIssues.push({
                  code: "property_mismatch",
                  solvable: true,
                  did,
                  deviceName: name,
                  toolName: trace.name,
                  toolArgs: { ...trace.args, target: did, mic_mute: d.micMute },
                  property: micMuteProp.name,
                  expectedValue: d.micMute,
                  expected: d.micMute ? "麦克风静音" : "麦克风开启",
                  actual: actualMicMute ? "麦克风静音" : "麦克风开启",
                  summary: `${name}麦克风状态检查未生效`,
                });
              }
            }

            if (playingStateProp && typeof vals[playingStateProp.name] === "number") {
              const ps = vals[playingStateProp.name] as number;
              const playingVal = resolveSpeakerPlayingValue(playingStateProp);
              if (
                (d.playback === "stop" || d.playback === "pause" || trace.args.power === "off") &&
                ps === playingVal
              ) {
                roundIssues.push({
                  code: "playback_mismatch",
                  solvable: true,
                  did,
                  deviceName: name,
                  toolName: trace.name,
                  toolArgs: { ...trace.args, target: did, playback: d.playback ?? "pause" },
                  property: playingStateProp.name,
                  expectedValue: 2,
                  expected: "已暂停/停止播放",
                  actual: "仍在播放",
                  ...(executedAction ? { executedAction } : {}),
                  summary: `${name}播放状态检查未生效：音箱仍在播放中`,
                });
              } else if (d.playback === "play" && ps !== playingVal) {
                roundIssues.push({
                  code: "playback_mismatch",
                  solvable: true,
                  did,
                  deviceName: name,
                  toolName: trace.name,
                  toolArgs: { ...trace.args, target: did, playback: "play" },
                  property: playingStateProp.name,
                  expectedValue: playingVal,
                  expected: "正在播放",
                  actual: "未在播放",
                  ...(executedAction ? { executedAction } : {}),
                  summary: `${name}播放状态检查未生效：音箱尚未恢复播放`,
                });
              }
            }

            return {
              passed: roundIssues.length === 0,
              value: { issues: roundIssues },
            };
          } catch (err) {
            const rawErr = err instanceof Error ? err.message : String(err);
            const toolArgs = { ...trace.args, target: did };
            const fatal = isReadbackErrorFatal(trace.name, toolArgs, rawErr, did, name);
            return {
              passed: false,
              fatal,
              value: {
                issues: [
                  {
                    code: "readback_error",
                    solvable: !fatal,
                    did,
                    deviceName: name,
                    toolName: trace.name,
                    toolArgs,
                    summary: `${name}状态回读失败（${rawErr}）`,
                    rawError: rawErr,
                  },
                ] as VerificationIssue[],
              },
            };
          }
        },
        pollDelays,
        sleepFn,
        signal,
      );

      if (spkSettled.result.passed) {
        checks.push({
          did,
          deviceName: name,
          toolName: trace.name,
          passed: true,
          summary: spkSettled.settledAfterDelay
            ? `${name}音箱状态核验通过（延迟同步确认）`
            : `${name}音箱状态核验通过`,
        });
      } else {
        for (const iss of spkSettled.result.value.issues) {
          issues.push(iss);
        }
      }
      continue;
    }

    // 4. set_device_property
    if (trace.name === "set_device_property") {
      if (trace.isError) {
        issues.push(
          classifyToolError(trace.name, trace.args, trace.text, {
            isCloudLlm: options.isCloudLlm,
          }),
        );
        continue;
      }
      const did = typeof d.did === "string" ? d.did : "";
      const name = typeof d.name === "string" && d.name ? d.name : did || "设备";
      const propName = typeof d.property === "string" ? d.property : "";
      const propLabel = typeof d.propLabel === "string" ? d.propLabel : propName;
      const expectedVal = d.value;
      if (!did || !propName) continue;

      specs.push({
        did,
        deviceName: name,
        toolName: trace.name,
        expectedProps: { [propName]: expectedVal },
      });

      let cachedDetail: Awaited<ReturnType<typeof deps.service.deviceDetail>> | null = null;
      const propSettled = await runWithSettleConfirmation<{
        check: VerificationCheckItem | null;
        issue: VerificationIssue | null;
      }>(
        async () => {
          try {
            const detail =
              cachedDetail ?? (await runJob(deps.jobs, () => deps.service.deviceDetail(did), 2));
            cachedDetail = detail;
            const propInfo = detail.props.find((p) => p.name === propName) ?? null;
            if (!propInfo?.readable) {
              return {
                passed: true,
                value: {
                  check: {
                    did,
                    deviceName: name,
                    toolName: trace.name,
                    passed: true,
                    summary: `${name}属性「${propLabel}」已写入`,
                  } as VerificationCheckItem,
                  issue: null as VerificationIssue | null,
                },
              };
            }
            const actualVal = await runJob(deps.jobs, () => deps.service.readProp(did, propName), 2);
            if (actualVal !== null && actualVal !== undefined && !valuesMatch(expectedVal, actualVal, propInfo)) {
              return {
                passed: false,
                value: {
                  check: null as VerificationCheckItem | null,
                  issue: {
                    code: "property_mismatch",
                    solvable: true,
                    did,
                    deviceName: name,
                    toolName: trace.name,
                    toolArgs: { target: did, property: propName, value: expectedVal },
                    property: propName,
                    expectedValue: expectedVal,
                    expected: String(expectedVal),
                    actual: String(actualVal),
                    summary: `${name}属性「${propLabel}」状态检查未生效：当前为 ${String(actualVal)}（目标 ${String(expectedVal)}）`,
                  } as VerificationIssue,
                },
              };
            }
            return {
              passed: true,
              value: {
                check: {
                  did,
                  deviceName: name,
                  toolName: trace.name,
                  passed: true,
                  summary: `${name}属性「${propLabel}」状态核验通过`,
                } as VerificationCheckItem,
                issue: null as VerificationIssue | null,
              },
            };
          } catch (err) {
            const rawErr = err instanceof Error ? err.message : String(err);
            const toolArgs = { target: did, property: propName, value: expectedVal };
            const fatal = isReadbackErrorFatal(trace.name, toolArgs, rawErr, did, name);
            return {
              passed: false,
              fatal,
              value: {
                check: null as VerificationCheckItem | null,
                issue: {
                  code: "readback_error",
                  solvable: !fatal,
                  did,
                  deviceName: name,
                  toolName: trace.name,
                  toolArgs,
                  summary: `${name}属性「${propLabel}」状态回读失败（${rawErr}）`,
                  rawError: rawErr,
                } as VerificationIssue,
              },
            };
          }
        },
        settleDelays,
        sleepFn,
        signal,
      );

      if (propSettled.result.value.check) {
        const c = propSettled.result.value.check;
        checks.push(
          propSettled.settledAfterDelay ? { ...c, summary: `${c.summary}（延迟同步确认）` } : c,
        );
      }
      if (propSettled.result.value.issue) {
        issues.push(propSettled.result.value.issue);
      }
      continue;
    }

    // 5. run_device_action / run_scene / send_xiaoai_command / read-only errors
    if (trace.isError) {
      issues.push(
        classifyToolError(trace.name, trace.args, trace.text, {
          did: typeof d.did === "string" ? d.did : undefined,
          deviceName: typeof d.name === "string" ? d.name : undefined,
          isCloudLlm: options.isCloudLlm,
        }),
      );
    } else {
      const did = typeof d.did === "string" ? d.did : undefined;
      const name = typeof d.name === "string" ? d.name : typeof d.speaker === "string" ? d.speaker : trace.name;
      specs.push({
        ...(did ? { did } : {}),
        deviceName: name,
        toolName: trace.name,
        note: trace.text.slice(0, 120),
      });

      // 当通过 send_xiaoai_command 兜底执行停止/暂停播放指令时，同样用延迟确认回读 playing-state 核验停播生效
      const directiveText =
        trace.name === "send_xiaoai_command"
          ? typeof d.text === "string"
            ? d.text
            : typeof trace.args.text === "string"
              ? trace.args.text
              : ""
          : "";
      const stopDirectiveKind = directiveText ? isStopOrPauseXiaoAiDirective(directiveText) : null;
      const dev = did ? deviceByDid.get(did) : undefined;
      if (trace.name === "send_xiaoai_command" && did && dev && isSpeaker(dev) && stopDirectiveKind) {
        let cachedDetail: Awaited<ReturnType<typeof deps.service.deviceDetail>> | null = null;
        const xiaoAiSettled = await runWithSettleConfirmation(
          async () => {
            try {
              const detail =
                cachedDetail ?? (await runJob(deps.jobs, () => deps.service.deviceDetail(did), 2));
              cachedDetail = detail;
              const { playingStateProp } = findSpeakerProps(detail.props);
              if (!playingStateProp) {
                return { passed: true, value: { issue: null as VerificationIssue | null } };
              }
              const vals = await runJob(
                deps.jobs,
                () => deps.service.readProps(did, [playingStateProp.name]),
                2,
              );
              const rawPs = vals[playingStateProp.name];
              if (typeof rawPs === "number") {
                const playingVal = resolveSpeakerPlayingValue(playingStateProp);
                if (rawPs === playingVal) {
                  return {
                    passed: false,
                    value: {
                      issue: {
                        code: "playback_mismatch",
                        solvable: true,
                        did,
                        deviceName: name,
                        toolName: trace.name,
                        toolArgs: { ...trace.args, speaker: did },
                        property: playingStateProp.name,
                        expectedValue: 2,
                        expected: "已暂停/停止播放",
                        actual: "仍在播放",
                        executedAction: "execute-text-directive",
                        summary: `${name}播放状态检查未生效：音箱仍在播放中`,
                      } as VerificationIssue,
                    },
                  };
                }
              }
              return { passed: true, value: { issue: null as VerificationIssue | null } };
            } catch (err) {
              const rawErr = err instanceof Error ? err.message : String(err);
              const toolArgs = { ...trace.args, speaker: did };
              const fatal = isReadbackErrorFatal(trace.name, toolArgs, rawErr, did, name);
              return {
                passed: false,
                fatal,
                value: {
                  issue: {
                    code: "readback_error",
                    solvable: !fatal,
                    did,
                    deviceName: name,
                    toolName: trace.name,
                    toolArgs,
                    summary: `${name}状态回读失败（${rawErr}）`,
                    rawError: rawErr,
                  } as VerificationIssue,
                },
              };
            }
          },
          speakerPlaybackDelays,
          sleepFn,
          signal,
        );
        if (xiaoAiSettled.result.passed) {
          checks.push({
            did,
            deviceName: name,
            toolName: trace.name,
            passed: true,
            summary: xiaoAiSettled.settledAfterDelay
              ? `${name}停播指令状态核验通过（延迟同步确认）`
              : `${name}停播指令状态核验通过`,
          });
        } else if (xiaoAiSettled.result.value.issue) {
          issues.push(xiaoAiSettled.result.value.issue);
        }
        continue;
      }

      checks.push({
        ...(did ? { did } : {}),
        deviceName: name,
        toolName: trace.name,
        passed: true,
        summary: `${name}操作执行核验通过`,
      });
    }
  }

  if (stateMutated) {
    deps.mainWindow.updateTrayDevices();
    deps.broadcastState();
  }

  if (!anyMutatingOrError) {
    return {
      checked: false,
      passed: true,
      checks: [],
      issues: [],
      solvable: true,
      analysis: "本次任务未涉及设备状态变更，无需额外状态核验。",
      specs: [],
    };
  }

  if (issues.length === 0) {
    return {
      checked: true,
      passed: true,
      checks,
      issues: [],
      solvable: true,
      analysis: `已完成 ${checks.length} 项设备状态核验，结果全部符合预期。`,
      specs,
    };
  }

  const solvableIssues = issues.filter((i) => i.solvable);
  const solvable = solvableIssues.length > 0;
  const issueDesc = issues.map((i) => i.summary).join("；");
  const analysis = solvable
    ? `状态检查发现 ${issues.length} 项问题（其中 ${solvableIssues.length} 项可尝试自动修复）：${issueDesc}`
    : `思考评估后判断该问题无法通过重试自动解决：${issueDesc}`;

  return {
    checked: true,
    passed: false,
    checks,
    issues,
    solvable,
    analysis,
    specs,
  };
}

/**
 * 思考问题是否可解，并为第 attempt 轮（1..3）生成递进式修复方案与面向用户的透明说明。
 */
export async function analyzeAndPlanRecovery(
  outcome: TaskVerificationOutcome,
  attempt: number,
  userTask: string,
  deps: SmartHomeToolDeps,
  maxAttempts = MAX_RECOVERY_ROUNDS,
): Promise<RecoveryPlan> {
  const solvableIssues = outcome.issues.filter((i) => i.solvable);
  const problem = outcome.issues.map((i) => i.summary).join("；") || "状态检查未通过";

  if (solvableIssues.length === 0) {
    return {
      canSolve: false,
      attempt,
      maxAttempts,
      problem,
      plan: "",
      noticeText: problem,
      steps: [],
      llmGuidancePrompt: "",
    };
  }

  const steps: AgentSkillStep[] = [];
  const planParts: string[] = [];

  for (const issue of solvableIssues) {
    const devLabel = issue.deviceName || (typeof issue.toolArgs.target === "string" ? issue.toolArgs.target : "目标设备");

    // 1. 电源开关未生效
    if (issue.code === "power_mismatch") {
      const targetState = issue.expectedValue === true ? "on" : "off";
      const targetBool = issue.expectedValue === true;
      const targetRef = issue.did || (typeof issue.toolArgs.target === "string" ? issue.toolArgs.target : devLabel);

      if (attempt === 1) {
        if (issue.toolName === "control_light" && targetBool) {
          steps.push({
            toolName: "control_light",
            args: { ...issue.toolArgs, target: targetRef, on: true },
            note: "先显式开启灯具再应用灯光参数",
          });
          planParts.push(`先显式打开${devLabel}电源并重新下发灯光参数`);
        } else {
          steps.push({
            toolName: "set_device_power",
            args: { target: targetRef, state: targetState },
            note: `重新下发${targetBool ? "开启" : "关闭"}电源指令`,
          });
          planParts.push(`重新向${devLabel}下发${targetBool ? "开启" : "关闭"}指令`);
        }
      } else if (attempt === 2) {
        // 第 2 轮升级：读取真实电源属性名并改用底层属性写入兜底
        let powerPropName = issue.property || "on";
        if (issue.did) {
          try {
            const detail = await runJob(deps.jobs, () => deps.service.deviceDetail(issue.did!), 2);
            const p = findPowerProp(detail.props);
            if (p) powerPropName = p.name;
          } catch {
            // keep default
          }
        }
        steps.push({
          toolName: "set_device_property",
          args: { target: targetRef, property: powerPropName, value: targetBool },
          note: `直接写入底层开关属性 ${powerPropName}=${targetBool}`,
        });
        planParts.push(`改用底层属性写入（${powerPropName}=${targetBool ? "开" : "关"}）控制${devLabel}`);
      } else {
        // 第 3 轮：先读最新设备详情再组合电源开关+属性写入
        steps.push({
          toolName: "get_device_detail",
          args: { target: targetRef },
          note: "刷新设备实时规格与属性状态",
        });
        steps.push({
          toolName: "set_device_power",
          args: { target: targetRef, state: targetState },
          note: "刷新后再次执行开关控制",
        });
        planParts.push(`先刷新${devLabel}最新状态，再重新执行${targetBool ? "开启" : "关闭"}操作`);
      }
      continue;
    }

    // 2. 灯光/音箱/通用属性未生效
    if (issue.code === "property_mismatch") {
      const targetRef = issue.did || (typeof issue.toolArgs.target === "string" ? issue.toolArgs.target : devLabel);

      if (issue.toolName === "control_light") {
        if (attempt === 1) {
          steps.push({
            toolName: "control_light",
            args: { ...issue.toolArgs, target: targetRef, on: true },
            note: "确保灯具处于开启状态并重新设置目标参数",
          });
          planParts.push(`先确保${devLabel}已开启并重新下发目标灯光参数`);
        } else if (attempt === 2 && issue.property && issue.expectedValue !== undefined) {
          steps.push({
            toolName: "set_device_power",
            args: { target: targetRef, state: "on" },
            note: "先独立开启灯具电源",
          });
          steps.push({
            toolName: "set_device_property",
            args: { target: targetRef, property: issue.property, value: issue.expectedValue },
            note: `再直接写入底层属性 ${issue.property}`,
          });
          planParts.push(`改为先独立打开${devLabel}电源，再直接写入底层属性 ${issue.property}`);
        } else {
          steps.push({
            toolName: "set_device_power",
            args: { target: targetRef, state: "on" },
            note: "确认灯具供电开启",
          });
          steps.push({
            toolName: "control_light",
            args: { ...issue.toolArgs, target: targetRef, on: true },
            note: "最后一次通过灯光控制接口完整重设参数",
          });
          planParts.push(`重新确认${devLabel}开启并完整重设灯光参数`);
        }
      } else if (issue.toolName === "control_speaker") {
        if (attempt === 1) {
          steps.push({
            toolName: "control_speaker",
            args: { ...issue.toolArgs, target: targetRef },
            note: "重新下发音箱控制指令",
          });
          planParts.push(`重新向${devLabel}下发控制参数`);
        } else if (issue.property && issue.expectedValue !== undefined) {
          steps.push({
            toolName: "set_device_property",
            args: { target: targetRef, property: issue.property, value: issue.expectedValue },
            note: `改用底层属性写入 ${issue.property}`,
          });
          planParts.push(`改用底层属性写入方式设置${devLabel}的 ${issue.property}`);
        } else {
          steps.push({
            toolName: "control_speaker",
            args: { ...issue.toolArgs, target: targetRef },
            note: "再次执行音箱控制",
          });
          planParts.push(`再次尝试设置${devLabel}`);
        }
      } else if (issue.property && issue.expectedValue !== undefined) {
        if (attempt >= 2) {
          steps.push({
            toolName: "get_device_detail",
            args: { target: targetRef },
            note: "刷新设备最新属性规格",
          });
        }
        steps.push({
          toolName: "set_device_property",
          args: { target: targetRef, property: issue.property, value: issue.expectedValue },
          note: `重新写入属性 ${issue.property}`,
        });
        planParts.push(
          attempt >= 2
            ? `先刷新${devLabel}状态再重新写入属性 ${issue.property}`
            : `重新写入${devLabel}的 ${issue.property} 属性`,
        );
      } else {
        steps.push({
          toolName: issue.toolName,
          args: { ...issue.toolArgs },
          note: "重新执行控制指令",
        });
        planParts.push(`重新对${devLabel}执行控制指令`);
      }
      continue;
    }

    // 3. 音箱播放状态未停止/未恢复
    if (issue.code === "playback_mismatch") {
      const targetRef = issue.did || (typeof issue.toolArgs.target === "string" ? issue.toolArgs.target : devLabel);
      const wantPlay =
        issue.expected === "正在播放" ||
        issue.toolArgs.playback === "play" ||
        (!issue.expected && issue.expectedValue === 1);
      if (wantPlay) {
        steps.push({
          toolName: "control_speaker",
          args: { target: targetRef, playback: "play", mute: false },
          note: "取消静音并恢复音箱播放",
        });
        planParts.push(`为${devLabel}取消静音并重新触发继续播放`);
      } else {
        let hasTextDirective = false;
        if (issue.did) {
          try {
            const detail = await runJob(deps.jobs, () => deps.service.deviceDetail(issue.did!), 2);
            hasTextDirective = detail.actions.some((a) => a.name === "execute-text-directive");
          } catch {
            hasTextDirective = false;
          }
        }
        const alreadyUsedPause =
          issue.toolArgs.playback === "pause" ||
          issue.executedAction?.replace(/-\d+$/, "") === "pause";
        const alreadyUsedTextDirective =
          issue.toolName === "send_xiaoai_command" ||
          issue.executedAction === "execute-text-directive";
        const stopDirectiveText = issue.toolArgs.playback === "pause" ? "暂停播放" : "停止播放";

        if (alreadyUsedTextDirective) {
          if (attempt <= 2) {
            steps.push({
              toolName: "control_speaker",
              args: { target: targetRef, playback: "pause" },
              note: "改用暂停动作停止音箱播放",
            });
            planParts.push(`改用暂停动作停止${devLabel}播放`);
          } else {
            steps.push({
              toolName: "control_speaker",
              args: { target: targetRef, playback: "pause", mute: true },
              note: "暂停播放并同时静音兜底",
            });
            planParts.push(`对${devLabel}同时执行暂停并开启静音兜底`);
          }
        } else if (alreadyUsedPause) {
          if (attempt === 1 && hasTextDirective) {
            steps.push({
              toolName: "send_xiaoai_command",
              args: { speaker: targetRef, text: stopDirectiveText, silent: true },
              note: "通过静默小爱文本指令兜底停止播放",
            });
            planParts.push(`改用静默小爱文本指令要求${devLabel}${stopDirectiveText}`);
          } else if (attempt <= 2) {
            steps.push({
              toolName: "control_speaker",
              args: { target: targetRef, playback: "pause", mute: true },
              note: "暂停播放并同时静音兜底",
            });
            planParts.push(`对${devLabel}同时执行暂停并开启静音兜底`);
          } else if (hasTextDirective) {
            steps.push({
              toolName: "send_xiaoai_command",
              args: { speaker: targetRef, text: "停止播放", silent: true },
              note: "通过静默小爱文本指令再次兜底停止播放",
            });
            steps.push({
              toolName: "control_speaker",
              args: { target: targetRef, mute: true },
              note: "同时保持扬声器静音兜底",
            });
            planParts.push(`通过静默小爱文本指令要求${devLabel}停止播放并静音兜底`);
          } else {
            steps.push({
              toolName: "control_speaker",
              args: { target: targetRef, playback: "pause", mute: true },
              note: "暂停播放并同时静音兜底",
            });
            planParts.push(`对${devLabel}同时执行暂停并开启静音兜底`);
          }
        } else if (attempt === 1) {
          steps.push({
            toolName: "control_speaker",
            args: { target: targetRef, playback: "pause" },
            note: "切换 pause 动作停止音箱播放",
          });
          planParts.push(`改用暂停指令停止${devLabel}播放`);
        } else if (attempt === 2 && hasTextDirective) {
          steps.push({
            toolName: "send_xiaoai_command",
            args: { speaker: targetRef, text: stopDirectiveText, silent: true },
            note: "通过静默小爱文本指令兜底停止播放（不额外静音）",
          });
          planParts.push(`改用静默小爱文本指令要求${devLabel}${stopDirectiveText}`);
        } else {
          steps.push({
            toolName: "control_speaker",
            args: { target: targetRef, playback: "pause", mute: true },
            note: "暂停播放并同时静音兜底",
          });
          planParts.push(`对${devLabel}同时执行暂停并开启静音兜底`);
        }
      }
      continue;
    }

    // 4. 临时性工具执行异常 / 状态回读失败 / 云端 LLM 参数可修复错误
    if (attempt >= 2 && issue.did) {
      steps.push({
        toolName: "get_device_detail",
        args: { target: issue.did },
        note: "重新读取设备详情确认可用属性与状态",
      });
    }
    steps.push({
      toolName: issue.toolName,
      args: { ...issue.toolArgs },
      note: `第 ${attempt} 轮重试 ${issue.toolName}`,
    });
    planParts.push(
      attempt >= 2 && issue.did
        ? `先重新读取${devLabel}详情，再重试原控制操作`
        : `重新尝试执行${devLabel}的控制操作`,
    );
  }

  const dedupedPlanParts = [...new Set(planParts)];
  const plan = `${dedupedPlanParts.join("，并")}，完成后再次检查设备状态`;
  const noticeText = `第${attempt}次重试：检查发现${problem}。我准备${plan}。`;

  const llmGuidancePrompt = [
    `[状态校验未通过 · 第 ${attempt}/${maxAttempts} 轮自愈排错]`,
    `用户原始任务：${userTask}`,
    `状态检查发现的问题：${problem}`,
    `建议修复思路：${plan}`,
    "请先思考该问题是否能够解决：",
    "- 如果判断确实无法解决，不要再调用控制工具，直接输出以 `[UNSOLVABLE]` 开头的简短中文原因说明；",
    "- 如果可以解决，请立即调用合适的工具执行修复步骤（可先查 get_device_detail 核对真实属性/动作名），完成后简要汇报结果。",
  ].join("\n");

  return {
    canSolve: true,
    attempt,
    maxAttempts,
    problem,
    plan,
    noticeText,
    steps,
    llmGuidancePrompt,
  };
}

export function buildSkillNameForRecovery(userTask: string, steps: readonly AgentSkillStep[]): string {
  const cleaned = userTask
    .trim()
    .replace(/^(?:请|帮我|麻烦|给我)+/, "")
    .replace(/[。！？!?]+$/, "")
    .trim();
  if (cleaned && cleaned.length <= 28) {
    return `${cleaned}（避坑流程）`;
  }
  const primaryTool = steps[steps.length - 1]?.toolName ?? "smart_home";
  return `${cleaned.slice(0, 20) || primaryTool}（避坑流程）`;
}

export function toVerificationSummary(
  outcome: TaskVerificationOutcome,
  retriesUsed: number,
  maxRetries = MAX_RECOVERY_ROUNDS,
): TaskVerificationSummary {
  let status: TaskVerificationSummary["status"];
  if (!outcome.checked && outcome.passed) {
    status = "skipped";
  } else if (outcome.passed) {
    status = retriesUsed > 0 ? "recovered" : "passed";
  } else if (!outcome.solvable) {
    status = "unsolvable";
  } else {
    status = "failed";
  }

  return {
    status,
    passed: outcome.passed,
    checked: outcome.checked,
    solvable: outcome.solvable,
    retriesUsed,
    maxRetries,
    analysis: outcome.analysis,
    checks: outcome.checks.map((c) => ({ ...c })),
    issues: outcome.issues.map((i) => ({
      code: i.code,
      solvable: i.solvable,
      ...(i.did ? { did: i.did } : {}),
      ...(i.deviceName ? { deviceName: i.deviceName } : {}),
      summary: i.summary,
    })),
  };
}
