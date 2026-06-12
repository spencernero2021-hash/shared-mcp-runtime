# MCP 上下文工程：从 152 工具到阶段感知

> 定理：Agent 在长任务中的不可靠性，根源不是模型不够聪明，而是上下文结构不够好。
> 不需要更大的模型——需要更好的上下文工程。

**日期**：2026-06-11
**Author**: Yunhao Shen with the help of ClaudeCode (Deepseek V4 Pro) and Codex (Chatgpt 5.5)

---

## 1. 问题定义

### 1.1 上下文污染

当你搭建 16 个 MCP 服务、~152 个工具时，每个工具定义（名称、描述、参数 schema）都会注入到模型的上下文窗口。这造成三个后果：

1. **注意力竞争**：模型在选择工具时，需要从 152 个候选中筛选，与当前任务无关的工具仍然在消耗注意力。
2. **多动倾向**：工具越多，模型越倾向于做未被要求的事情。A/B 测试中，170 工具条件下模型自动生成了押题——用户只要求了学习笔记。
3. **长上下文退化**：当会话变长，无关注入的效应累积加重。

### 1.2 传统方案的局限

| 方案 | 问题 |
|------|------|
| 换更大模型 | 实验证明上下文污染对所有模型一视同仁 |
| 增加上下文窗口 | 不能替代上下文结构优化 |
| Tool Attention (论文) | 需要 embedding + 向量库 + 检索 pipeline |
| ACE-Router (论文) | 需要训练路由模型 |
| Skill 指令约束 | 仅有行为引导，无机械执行 |

---

## 2. 架构设计

### 2.1 核心思路：Skill 主导，MCP 按需暴露

```
传统 MCP：
  所有 152 工具一启动就全量注入 → 模型从 152 个中找合适的

阶段感知 MCP：
  启动时 0 个业务工具 → Skill 告诉模型激活哪个领域 → 
  模型调 set_task_context → 该阶段 2-4 个工具出现 →
  切换阶段 → 工具跟着切换
```

### 2.2 三层递进设计

| 层次 | 名称 | 机制 | 粒度 |
|------|------|------|------|
| L1 | 渐进式暴露 | 入口工具调用后自动展开（服务端自省） | 全有/全无 |
| L2 | 阶段感知 | 模型通过 `set_task_context` 控制阶段 | 4 个阶段 |
| L3 | 行动融合 | `action` 参数消除 `list_changed` 一轮延迟 | 阶段内 |

我们最终实现了 L2+L3。

### 2.3 关键技术组件

**共享运行时** (`shared-mcp-runtime/index.js`, ~400行)
- 抽象可复用的动态工具暴露与工具生命周期管理
- 内置 `activate_domain`：简化的领域激活（二元开关）
- 内置 `set_task_context`：带 `skill/goal/stage/language/file_type` 的完整上下文
- 内置 `clear_task_context`：任务结束后返回 idle 状态
- `enableTaskContext: true` → 自动注册上述三个工具
- `onToolsChanged` → 将工具列表变化交给宿主适配器处理
- `ctx.task` → toolProvider 可见的阶段上下文
- `action` 参数 → 设上下文 + 执行首工具，消除一轮延迟

**生命周期**：
```
idle → activate/set_task → work → clear_task → idle
```

### 2.4 `set_task_context` 的 `action` 参数

这是解决 `list_changed` 一轮延迟的关键创新。

```
问题：list_changed 在协议层触发，模型要到下一轮才能看到新工具。
     3 个阶段 = 3 次空等轮次。

方案：set_task_context({ stage: "intake", action: "diagnose_courseware_intake", action_args: {...} })
     内部流程：设上下文 → refreshTools → 立即查 handler → 执行 → 直接返回结果
     
效果：6 轮变 3 轮。设上下文和首工具执行合并为一次调用。
```

---

## 3. MCP 迁移状态

### 3.1 已迁移到阶段感知 (共享运行时)

| MCP | 工具数 | 方式 | 版本 |
|-----|--------|------|------|
| `courseware-mcp` | 2/8（idle/extraction） | enableTaskContext + 4 阶段 | v0.6.0 |
| `market-intel-mcp` | 0/20（idle/active） | enableTaskContext + idle gate | v0.4.0 |
| `design-mcp` | 0/9 | enableTaskContext + idle gate | v0.3.0 |
| `presenton-mcp` | 0/4 | enableTaskContext + idle gate | v0.3.0 |
| `personal-learning-mcp` | 0/5 | enableTaskContext + idle gate | v0.3.0 |
| `docx-mcp` | 0/4 | enableTaskContext + idle gate | v0.2.0 |
| `searxng-mcp` | 0/1 | enableTaskContext + idle gate | v0.2.0 |
| `local-ocr-mcp` | 0/2 | enableTaskContext + idle gate | v0.2.0 |

### 3.2 通过代理迁移 (无需修改源码)

| MCP | 工具数 | 方式 |
|-----|--------|------|
| `antigravity-gemini-mcp` | 0/6（idle/active） | `mcp.proxy.js` 包装 |
| `playwright` | 0/~25（idle/active） | `mcp.proxy.js` 包装 (第三方 npx 包) |

### 3.3 SDK 服务迁移 (book-series)

| MCP | 工具数 | 方式 |
|-----|--------|------|
| `character-development` | 0/~9 | `base-server.js` 加 idle gate + listChanged |
| `plot-management` | 0/~15 | 同上 |
| `research-continuity` | 0/~17 | 同上 |
| `world-building` | 0/~12 | 同上 |
| `writing-production` | 0/~17 | 同上 |

所有 book-series MCP 在 `base-server.js` 中统一修改：加 `_active` 状态、`activate_domain`/`set_task_context`/`clear_task_context` 内置工具、`listChanged` 能力声明。

---

## 4. 实验证据

### 4.1 实验设计

**标准化任务**：提取 98 页神经网络课件 PDF，生成学习笔记 DOCX + Mermaid 思维导图。

**2×2 实验设计**（四个条件，工具量 × 上下文长度）：

| | 短上下文（干净会话） | 长上下文 |
|---|---|---|
| **静态全量** (~152 工具) | A | B（5 轮无关对话填充） |
| **阶段感知** (≤7 工具) | C | **D**（本次会话，已历经多轮讨论） |

### 4.2 结果

| 指标 | A (静态×短) | B (静态×长) | C (阶段×短) | **D (阶段×长)** |
|------|:---:|:---:|:---:|:---:|
| DOCX 字符数 | 3,749 | 2,758 (−26%) | 4,816 (+28%) | **5,376 (+12% over C, +95% over B)** |
| DOCX 表格数 | 12 | 7 (−42%) | 10 | **15** |
| 思维导图行数 | 79 | 69 (−13%) | 107 (+35%) | **142 (+33% over C)** |
| 质量问题 | 表格渲染 bug | 无关工具调用 | 无 | **LaTeX 公式未渲染（需二次修复）** |

### 4.3 结论

1. **静态全量在干净会话中已有次优产出**（A vs C：字符数 −22%）
2. **长上下文让退化加剧**（B vs A：字符数 −26%，表格 −42%）
3. **阶段感知在短上下文中产生最佳质量**（C：零质量问题，内容量充足）
4. **阶段感知在长上下文中产出最多内容**（D：5,376 字符 + 142 行思维导图，均居首位）
5. **但长上下文的影响未被完全消除**：D 出现了 LaTeX 渲染问题——模型在长上下文中更容易忽略格式约束。阶段感知解决了"工具定义"层面的污染，但对话历史本身的累积仍影响模型的格式化精度
6. **上下文结构 > 上下文长度**：阶段感知在长上下文下的表现（D）远超静态全量在短上下文下（A），结构优化比窗口扩容更根本

---

## 5. 遇到的问题与解决方案

### 5.1 `set_task_context` 在首次调用后消失

**问题**：原设计 `set_task_context` 只在 `!taskContext.skill` 时暴露，首次调用后工具定义被移除，无法切换阶段。

**修复**：改为始终暴露 `set_task_context`（无论上下文是否已设置），确保阶段可在任意时刻切换。

### 5.2 `list_changed` 的一轮延迟

**问题**：MCP 协议的 `list_changed` 通知在服务端发射后，客户端下一轮才能将新工具注入上下文。3 个阶段 = 3 次空等。

**方案**：`action` 参数。`set_task_context` 内设完上下文后，立即查找新阶段的工具 handler 并执行，将"设上下文+执行首工具"合并为一次调用。

### 5.3 工具生命周期不闭环

**问题**：有展开（`activate_domain`/`set_task_context`），没有收起。工具一旦暴露，永远可见。

**方案**：新增 `clear_task_context` 工具。重置所有上下文和域，返回 idle。完整生命周期：idle → activate → work → clear → idle。

### 5.4 Python 运行环境缺少依赖

**问题**：`COURSEWARE_PDF_PYTHON` 指向的 Python 没有安装 pypdf。

**修复**：`pip install pypdf`。

### 5.5 代理层套代理层

**初始错误方案**：对已迁移到共享运行时的 MCP（如 docx-mcp、courseware-mcp）再套一层 `mcp.proxy.js`。

**纠正**：代理仅用于非迁移 MCP（antigravity-gemini-mcp、playwright）。已迁移 MCP 直接使用原生 idle 模式。

---

## 6. 限制与未解决的问题

1. **`list_changed` 的协议级延迟无法消除。** `action` 参数是 workaround，不是协议级的解决方案。
2. **长上下文不只是 MCP 的问题。** MCP 工具暴露解决了"工具定义"层面的上下文污染，但对话历史、中间结果、无关指令在长会话中同样污染上下文。条件 D 验证了这一点：阶段感知消除了工具污染，内容产出量居首（5,376 字符），但出现了 LaTeX 公式未渲染的格式化缺陷——说明长上下文仍通过非 MCP 路径影响模型精度。
3. **实验覆盖范围有限。** 仅在一个领域（courseware）、一个任务类型上验证。多领域推广需要进一步验证。
4. **book-series 的 SDK 集成方式是妥协。** SDK 的 `listChanged` 通知发射方式与手写运行时不同，稳定性需要更多测试。
5. **收缩永远比展开危险。** 模型可能在计划阶段依赖即将被收缩的工具。

---

## 7. 待讨论问题

1. 我们的 `action` 参数方案是 workaround 还是正确方向？MCP 协议是否有更好的路径？
2. 这个命题需要补什么证据才能具有广泛说服力？
3. 工具暴露问题解决后，下一个 MCP 层面的瓶颈是什么？
4. 有没有我们没有搜到的、正在做同样事情的项目？
5. 这个项目怎么定位才能被"对的人"看到？

---

## 8. 关键文件路径

以下路径来自原实验环境，仅用于说明项目组织方式。复现时请替换为自己的工作目录。

### 共享运行时

```
D:\Codex\New\shared-mcp-runtime\
  index.js                    # 核心工具暴露运行时：task context, dynamic tool gating, action, clear
  package.json                # npm 包定义
  verify.js                   # 模块验证（20项测试）
  mcp.proxy.js                # 通用 MCP 代理：不改源码加 idle 模式
```

### 迁移后的 MCP

```
D:\Codex\New\courseware-mcp\
  index.js                    # v0.6.0：4阶段 (idle/intake/extraction/generation) + action 支持
  index.backup.js             # 原始全量版本（静态全量实验用）

D:\Codex\New\market-intel-mcp\
  index.js                    # v0.4.0：idle gate (ctx.task.hasTask)
  index.backup.js

D:\Codex\New\design-mcp\
  index.js                    # v0.3.0：idle gate
  index.backup.js

D:\Codex\New\presenton-mcp\
  index.js                    # v0.3.0：idle gate
  index.backup.js

D:\Codex\New\personal-learning-mcp\
  index.js                    # v0.3.0：idle gate
  index.backup.js

D:\Codex\New\docx-mcp\
  index.js                    # v0.2.0：idle gate
  index.backup.js

D:\Codex\New\searxng-mcp\
  index.js                    # v0.2.0：idle gate
  index.backup.js

D:\Codex\New\ocr-mcp\
  index.js                    # v0.2.0：idle gate
  index.backup.js

D:\Codex\New\book-series-mcp\src\shared\
  base-server.js              # 加 idle gate + activate/set_task/clear + listChanged
```

### Skill 文件

```
D:\ClaudeCode\.claude\skills\courseware-study\
  SKILL.md                    # 阶段感知工作流 + action 参数说明

D:\ClaudeCode\.claude\skills\stage-handoff\
  SKILL.md                    # 领域切换 + 工具暴露规则
```

### 实验系统

```
D:\ClaudeCode\experiments\
  mcp.static_full.json        # 静态全量配置（~152 工具）
  mcp.stage_aware.json        # 阶段感知配置（~32 工具初始）
  task_short_context.md       # 短上下文任务 prompt
  task_long_context.md        # 长上下文任务（5 轮 filler + 任务）
  run_experiment.ps1          # 一键切换配置脚本
```

### 实验产物

```
D:\ClaudeCode\project\
  第八章-神经网络_学习笔记-1.docx        # 条件 A（静态全量 × 短）：3,749 字, 12 表
  第八章-神经网络_思维导图-1.md          # 条件 A：79 行
  第八章-神经网络-学习笔记-2.docx        # 条件 B（静态全量 × 长）：2,758 字, 7 表
  神经网络-思维导图-2.md                 # 条件 B：69 行
  第八章 神经网络与深度学习 - 学习笔记-3.docx  # 条件 C（阶段感知 × 短）：4,816 字, 10 表
  第八章 神经网络与深度学习 - 思维导图-3.md   # 条件 C：107 行
  第八章 神经网络与深度学习 - 学习笔记.docx   # 条件 D（阶段感知 × 长）：5,376 字, 15 表, LaTeX 二次修复
  第八章 神经网络与深度学习 - 思维导图.md    # 条件 D：142 行
  mcp_ab_test_plan.md                   # A/B 测试方案
  mcp_ab_test_results.md                # A/B 测试结果
  mcp_context_engineering_report.md     # 本文档
```

### 全局配置

```
D:\ClaudeCode\
  .mcp.json                   # 当前生产配置（阶段感知版本）
  CLAUDE.md                   # 项目规则
  .claude\settings.local.json # 权限配置（含 gemini-vision 残留待清理）
```

---

*本文档伴随 MCP 上下文工程优化计划使用。*

