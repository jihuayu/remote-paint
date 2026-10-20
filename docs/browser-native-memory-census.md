# 浏览器进程清单与原生内存采样

`tests/browser-native-memory.mjs` 是长测观测器的一部分。它对整个 Mac 浏览器进程清单做 libproc 批量测量，同时核对持久页面 nonce 和 Worker target ID。不能用前一次内存值、零值或过滤后的进程子集补齐缺失数据。

一次完整测量共享原有 5 秒期限，原生 helper 每次请求仍限 2 秒。只有 libproc 明确返回进程不存在（ESRCH），且重新获取的完整 CDP 清单已不含该 PID，才允许通过同一 helper 再测一次完整新清单。权限、协议、身份变化、请求超时、仍列出的失败 PID 和第二次失败均直接终止。正数内存批量读取之后还要核对前后进程清单一致、页面与 Worker 未替换；此时清单变化会失败，并保留刚取得的正数原始测量，不能改选一个较低值。

每次原生请求留在 `native-memory-attempts.jsonl`；完整清单、失败或成功状态和正数原始批量结果留在 `browser-native-cohorts.jsonl`。失败项的 requestId 与 helper 回执关联。成功样本中的 `processRssSampling.cohort` 保留完整尝试链；失败样本的 `failure.json.nativeMemoryFailure` 保留诊断。任何晚到的发现结果都不能在期限后启动新的原生请求。

已用真实 Mac Chromium 验证：在获取真实清单和正数内存后关闭测试自己的次级上下文，旧完整清单确实产生 ESRCH；封装随后确认退役并重新测量完整新清单，原主页面及 Worker 保持不变。另有合同覆盖拒绝条件和期限。原 600 秒 v9 基线失败证据保留；新的采样方式仍须重新通过完整测试、独立基线与丢包短测，之后才能进行独立 8 小时验收。这些检查不证明原失败 PID 的唯一退出原因，也不代表全部 41 项已完成。
