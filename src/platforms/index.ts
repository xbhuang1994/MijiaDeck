// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 多平台智能家居接入统一入口（米家 + 涂鸦智能 + 美的智能 + 德业智能）

import type { IMijiaService } from "../core/contracts.ts";
import type { MijiaServiceOptions } from "../core/service.ts";
import { DeyePlatformProvider, type DeyePlatformProviderOptions } from "./deye/provider.ts";
import { MideaPlatformProvider, type MideaPlatformProviderOptions } from "./midea/provider.ts";
import { MijiaPlatformProvider } from "./mijia/provider.ts";
import { MultiPlatformService, PlatformRegistry } from "./registry.ts";
import { TuyaPlatformProvider, type TuyaProviderOptions } from "./tuya/provider.ts";
import type { IDevicePlatformProvider } from "./types.ts";

export * from "./types.ts";
export * from "./configStore.ts";
export * from "./registry.ts";
export { MijiaPlatformProvider, MIJIA_PLATFORM_METADATA } from "./mijia/provider.ts";
export * as tuya from "./tuya/index.ts";
export * as midea from "./midea/index.ts";
export * as deye from "./deye/index.ts";
export { TuyaPlatformProvider, TUYA_PLATFORM_METADATA } from "./tuya/provider.ts";
export { MideaPlatformProvider, MIDEA_PLATFORM_METADATA } from "./midea/provider.ts";
export { DeyePlatformProvider, DEYE_PLATFORM_METADATA } from "./deye/provider.ts";

export interface CreateMultiPlatformServiceOptions {
  mijiaService?: IMijiaService;
  mijiaOptions?: MijiaServiceOptions;
  tuyaOptions?: TuyaProviderOptions;
  mideaOptions?: MideaPlatformProviderOptions;
  deyeOptions?: DeyePlatformProviderOptions;
  extraProviders?: IDevicePlatformProvider[];
}

/**
 * 装配默认多平台聚合服务：统一注册小米米家、涂鸦智能、美的智能、德业智能四大平台提供者。
 */
export function createMultiPlatformService(
  options: CreateMultiPlatformServiceOptions = {},
): MultiPlatformService {
  const registry = new PlatformRegistry();
  const mijiaProvider = new MijiaPlatformProvider(options.mijiaService, options.mijiaOptions);
  registry.register(mijiaProvider);
  registry.register(new TuyaPlatformProvider(options.tuyaOptions));
  registry.register(new MideaPlatformProvider(options.mideaOptions));
  registry.register(new DeyePlatformProvider(options.deyeOptions));
  if (options.extraProviders) {
    for (const provider of options.extraProviders) {
      registry.register(provider);
    }
  }
  return new MultiPlatformService({
    registry,
    primaryMijia: mijiaProvider,
  });
}
