// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/** Error hierarchy compatible with mijiaAPI 5.x semantics. */

export class MijiaApiError extends Error {
  readonly code?: number;

  constructor(message: string, code?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    if (code !== undefined) {
      this.code = code;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class LoginError extends MijiaApiError {}

export class DeviceGetError extends MijiaApiError {}

export class DeviceSetError extends MijiaApiError {}

export class DeviceActionError extends MijiaApiError {}

export class DeviceNotFoundError extends MijiaApiError {}

export class GetDeviceInfoError extends MijiaApiError {}

/**
 * 小米 IoT（MIoT-Spec）标准云端/设备错误码中文说明。
 * 参考：https://iot.mi.com/v2/new/doc/home （MIoT-Spec 常见错误码规范）
 */
const MIOT_ERROR_ZH: Record<number, string> = {
  [-704000000]: "请求参数格式错误",
  [-704002000]: "请求参数格式错误",
  [-704010000]: "设备暂未上报该状态或未授权",
  [-704013006]: "设备授权已失效，请重新登录",
  [-704030013]: "该属性当前不可写入",
  [-704030023]: "该属性当前不可写入",
  [-704040002]: "设备不支持该服务（SIID 不存在）",
  [-704040003]: "设备固件不支持该属性（PIID 不存在）",
  [-704040004]: "设备固件不支持该事件（EIID 不存在）",
  [-704040005]: "设备固件不支持该操作（AIID 不存在）",
  [-704040009]: "设备离线或当前不可达",
  [-704042001]: "设备不存在或已离线",
  [-704042009]: "设备离线或当前不可达",
  [-704042011]: "设备所属区域不支持该指令或设备离线",
  [-704053036]: "设备当前状态不允许执行此操作",
  [-704053100]: "设备当前状态不允许执行此操作",
  [-704083036]: "设备执行超时或当前状态不支持",
  [-704220008]: "当前设备固件不支持该功能或动作",
  [-704220025]: "操作输入参数数量或类型不匹配",
  [-704220035]: "操作参数格式无效",
  [-704220043]: "属性值超出允许范围或格式不正确",
  [-704222034]: "设备执行超时，请稍后重试",
  [-704222035]: "设备返回无效结果，请稍后重试",
  [-705004000]: "设备响应超时，请稍后重试",
  [-705004501]: "设备响应超时，请稍后重试",
  [-705201013]: "设备响应超时，请稍后重试",
  [-705201015]: "设备响应超时，请稍后重试",
  [-4001]: "该属性当前不可读取",
  [-4002]: "该属性当前不可写入",
  [-4003]: "当前设备固件未实现该属性或动作",
  [-4004]: "设备内部执行错误",
  [-4005]: "属性值或参数无效",
  [-4006]: "操作输入参数不匹配",
  [-4007]: "设备未就绪或当前状态不支持",
};

const MIOT_UNSUPPORTED_CODES: ReadonlySet<number> = new Set([
  -704220008,
  -704040002,
  -704040003,
  -704040005,
  -4003,
]);

/** 根据 MIoT 错误码返回用户可读的中文说明；未收录时返回 null。 */
export function miotErrorMessageZh(code: number | undefined): string | null {
  if (code === undefined || !Number.isFinite(code)) {
    return null;
  }
  return MIOT_ERROR_ZH[code] ?? null;
}

/** 判断 MIoT 错误码是否表示设备固件未实现/不支持该 SIID/PIID/AIID。 */
export function isMiotUnsupportedCode(code: number | undefined): boolean {
  return code !== undefined && MIOT_UNSUPPORTED_CODES.has(code);
}
