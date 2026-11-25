# 隐式指令纠偏与强化决策记忆架构设计（10 路子代理择优融合方案）

## 1. 背景与根因定位

### 观察到的典型故障
```
openWakeWord「Neo」0.74 · 声纹:Henry 74% · 降噪 +33.7dB · 听到：“帮我洗一下袜子。” · ⊘ SystemOne 判定为旁白/闲聊，保留当前对话窗口 · 1141ms
```

用户家中实际在线部署了美的三筒洗烘机 `美的可爱多`（`0xD9`, `sn8=38135636`），其左筒即为专用「左筒 · 袜子筒」（支持 `program: "socks"`），用户说出「帮我洗一下袜子」本质是希望 AI 核查洗衣机能力并开启袜子筒。系统误拦的根因如下：

1. **SystemOne 能力盲区与规则硬编码**：`systemOneClient.ts` 原先硬编码「只能控制米家设备与问答，不能跑腿做家务」，且未注入家庭专能设备摘要 `home_capabilities`、已学习触发语 `learned_triggers`、挂起待确认状态 `pending_confirmation` 及声学唤醒结果 `acoustic_wake`。
2. **声学唤醒丢字与短回复误杀**：ASR 吞掉句首 `"Neo"` 时，待机路径未结合 `openWakeWord` 声学命中与设备专能做恢复；`OBVIOUS_SIDETALK_RE` 未给纯语气词加 `$` 锚定导致误杀「嗯，用右筒」；`isNoiseOrGarbledFragment` 过滤 1 字答复（「嗯/好/对/是/要」）；`EXPLICIT_EXIT_RE` 在待确认时直接退出连续对话而非把「算了/取消/不用了」交给确认状态机。
3. **缺少渐进确认与时间/安全衰减机制**：对无前置规则的隐式指令缺乏「核查设备 → 确认提问 → 自动总结记录 → 最多问两次、第三次直接执行 → 久未触发或涉安全重新确认」的闭环。
4. **回声自确认与多家庭同名碰撞风险**：确认提问 TTS 播报期间若 `echoThreshold` 被 `looksDirectCommand` / 声纹加分抬高，可能发生回声自确认；跨家庭同名在线设备（如两个家庭各有 `美的可爱多`）原先会静默挑选第一台。

---

## 2. 10 路子代理多视角方案与择优融合

本次由 10 个独立视角的架构子代理并行设计，最终取各方案之长融合落地：

| # | 架构视角 | 采纳核心机制 | 权衡与融合取舍 |
|---|---|---|---|
| 1 | **SystemOne 门控与能力路由** | `HomeCapabilityDigest` 自动解析美的 0xD9 三筒（左筒袜子筒/右筒内裤筒/下筒主洗烘）、干衣机、灌溉、扫地机、喂食器；向 SystemOne 注入 `home_capabilities` / `learned_triggers` / `pending_confirmation` / `acoustic_wake` / `capabilityDigestHash`；待确认态禁用负向 LRU 缓存 | 在 `smart` 模式下对强命中专能设备的明确请求提供 0ms 直通并保留 SystemOne 声学唤醒兜底挽救，消除 1141ms 误拦延迟 |
| 2 | **强化记忆 Schema 与信任状态机** | `reinforcement_memories.json` 独立持久化（原子写入 + 忽略提交）；状态机覆盖 `learning -> autonomous -> stale_reconfirm / safety_locked / cooldown / revoked / superseded`；`confirmThreshold = 2`（问 2 次，第 3 次直行） | 优先级金字塔：`L3 安全红线 > 待确认挂起槽 > 显式 custom_instructions > 强化记忆 > Skills / 本地快路径`；细化洗衣机冲突域到对象级（`洗衣机:${room}:${object}:drum/program`），使通用「智洗烘」规则不误伤「袜子筒」 |
| 3 | **时间衰减与间隔重复遗忘模型** | 混合艾宾浩斯保留率 $R(\Delta t) = \exp(-\Delta t / S)$ + 硬休眠上限 $D_{\text{hard}}$ + 设备拓扑哈希漂移 `topologyHash` + 换季检测；分层配置（L1: $S_0=45\text{d}, D_{\text{hard}}=180\text{d}$；L2 家电: $S_0=21\text{d}, D_{\text{hard}}=90\text{d}$；L2 季节: $S_0=21\text{d}, D_{\text{hard}}=75\text{d}$）；**子能力级独立隔离**（`did#left:socks`）；**休眠 1 次确认即恢复自主**（$S \leftarrow \max(S_0, 0.7 S_{\text{prev}})$） | 注入可测时钟 `now?: () => number`，无需真实等待数月即可 100% 确定性验证 +90d/+180d 休眠与 1-confirm 恢复 |
| 4 | **安全风险分级与不可绕过安全闸门** | 纯代码确定性分类器 `classifyActionRisk`（门锁/安防关闭/开灌溉水阀/独立干衣机/洗衣机 ≥60°C·烘干·蒸汽·煮洗/热水器高温/基建批量断电/危险动作/越界参数 -> `L3_HIGH_SAFETY` 永久锁定）；**关水阀定为 L1 零确认即刻执行**；洗衣机启动前实时硬件安全探针 `probeWasherRuntimeSafety`（过热/故障/未开远程控制硬阻断，舱门开启/童锁/残留高温升级确认）；附加指令反越狱拦截 `detectSafetyBypassInstruction` | 宿主独占一次性 `SafetyConfirmationRegistry` 票据防 LLM 伪造确认，同时在独立直调 `createSmartHomeTools` 无注册表时保持旧测试 `confirm_dangerous: true` 100% 向后兼容 |
| 5 | **意图规范化与歧义探测** | `canonicalizeImplicitIntent` 将「帮我洗一下袜子」「洗个袜子」「袜子洗一下」稳定归并到 `implicit:laundry:wash:socks`；负向护栏 `NON_DEVICE_CHORE_VETO_RE`（洗碗/做饭/倒垃圾/取快递）与 `NARRATIVE_NON_COMMAND_RE`（昨天/明天/听说）；跨家庭同名设备自动检测并触发消歧 | 在 `smartHomeTools.ts` 的 `resolveSingleDeviceChecked` 同步落地跨家庭同名保护，消除静默误控另一家庭设备风险 |
| 6 | **待确认生命周期与自动总结** | `PendingConfirmationManager` 单槽位原子 CAS（90s TTL）；`classifyConfirmationReply` 精确区分肯定、单次取消、映射否决、参数改选、多设备选定、疑似回声与全新话题；执行+核验通过后由 `buildAutoDecisionSummary` 自动总结并写入记忆 | 仅在真实执行且 `verifyExecutedToolCalls` 通过后才累加 `confirmCount`，失败调用绝不污染记忆 |
| 7 | **Pi Agent 工具与提示词协同** | 新增 4 个非变更工具（`propose_confirmation`、`resolve_decision_memory`、`list_decision_memories`、`forget_decision_memory`）；Step 0 统一承载云端与本地双引擎确认闭环；更新提示词能力边界并在尾部 KV-Cache 友好注入强化记忆与待确认上下文；防止短答复（「好/嗯」）误沉淀为 Skill | `localPlannerStream.ts` 在存在挂起待确认时自动让路，确保本地引擎与云端模型体验完全一致 |
| 8 | **多说话人隔离与语音防回声并发** | `SpeakerPrincipal` 区分主人（全局）、已识别成员（L1 共享、L2 成员独立学习、L3 禁越权）与未识别访客（不跳确认、不推进记忆、禁 L3）；自适应抑制确认提问前的 `"好的"` ACK；提问后强制保活连续对话窗口 ≥20s；确认播报期间锁定 `echoThreshold = 0.42` + 禁用半剥离 + 8500ms 尾窗 + 播完 450ms 反回声不应期；自动执行后 120s 内取消触发 48h 污染回滚 | 忽略早于确认提问时间的旧短 ACK 回声匹配，确保用户紧接说「好的/嗯」不被误杀 |
| 9 | **可观测性、透明 UI 与 REST API** | 新增 `/api/agent/memories*` 与 `/api/agent/confirmations/:id/resolve` 接口；抽屉新增可折叠 `#pi-memories-bar`（0 条隐藏）；设置页新增 `#setting-row-agent-memories` 管理面板（状态徽章/保留率/重置/停用/删除/清空）；时间线展示记忆胶囊与活跃待确认的 `✓ 确认执行 / ✕ 取消`（或多设备选定）按钮；语音遥测栏展示 `passSource` | 复用既有抽屉与设置页设计语言，保持克制零侵入 |
| 10 | **对抗红队与防污染验证矩阵** | 防回声自确认 6 项攻击、16 项负向家务/闲聊/叙事拒识、任务级幂等去重、120s 撤销污染回滚、3 次拒映射自动撤销、自定义指令越狱注入拦截、跨家庭同名设备隔离、+90d 休眠与 1-confirm 恢复端到端回归测试 | 全部固化于 `tests/reinforcement_memory_gate.test.ts` |

---

## 3. 核心模块清单

- `src/agent/intentCanonicalizer.ts`：隐式意图规范化、家庭专能设备摘要（`HomeCapabilityDigest`）与能力探查。
- `src/agent/safetyGate.ts`：L1/L2/L3 确定性风险分级、说话人权限解析、洗衣机实时硬件安全探针、附加指令反越狱检查、一次性宿主安全确认票据表。
- `src/agent/reinforcementMemoryStore.ts`：`reinforcement_memories.json` 持久化、混合艾宾浩斯时间衰减模型、渐进确认裁决器、`PendingConfirmationManager` 与回复分类器。
- `src/agent/echoGuard.ts` / `src/agent/systemOneClient.ts` / `src/agent/voiceAttentionGate.ts` / `src/agent/audioSourceSeparator.ts` / `src/agent/voiceListenerController.ts`：全链路语音门控、待确认优先通道、防回声自确认与连续对话保活。
- `src/agent/piAgentService.ts` / `src/agent/smartHomeTools.ts` / `src/agent/localPlannerStream.ts` / `src/agent/customInstructionStore.ts` / `src/agent/cavemanReplyPolicy.ts` / `src/agent/taskVerificationLoop.ts`：双引擎执行闭环、确定性安全闸门、强化记忆工具集与自动总结。
- `src/server/routes.ts` / `src/web/index.html` / `src/web/piAgentPanel.ts` / `src/web/app.ts` / `src/web/styles.css`：透明可管理的 REST API 与 Web UI。
