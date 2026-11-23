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
