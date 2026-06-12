# 从 152 个 MCP 工具到阶段感知：一次 Agent 上下文工程优化实践

当 MCP 工具数量从十几个增加到一百多个后，我遇到的第一个明显问题不是“模型不会调用工具”，而是：

> 模型看到的工具太多，开始变得不稳定。

在 ClaudeCode 接 Deepseek V4 Pro 的本地 Agent 工作流里，我接入了 OCR、课件解析、Word 文档生成、PPT 生成、科研搜索、股票分析等多个 MCP。能力确实变强了，但工具数量一度接近 152 个后，问题也变得很明显：

- 用户只要求生成学习笔记，模型会顺手生成押题和复习建议
- 做 PPT 时，模型会调用不相关的视觉检查或生图工具
- 长任务执行到后面，模型会忘记某些 Skill 中的流程约束
- 明明有正确工具，模型却在一堆无关工具之间绕路
- 工具 schema 越多，越容易干扰模型对当前任务的判断

这不是简单的“模型能力不够”。更准确地说，这是一个上下文结构问题。

MCP 工具名、description、参数 schema 都会进入模型上下文。工具少的时候，这种成本可以忽略；工具多了以后，它就会变成模型每一轮推理都要承受的噪声。

所以我的优化目标不是继续增加工具，而是解决一个更基础的问题：

> 如何让模型只在正确阶段看到正确工具？

## 问题：MCP 的全量暴露会污染上下文

很多 MCP 的默认使用方式是：

```text
启动 MCP
→ 所有工具全部暴露
→ 模型从所有工具中选择
```

当工具只有 5 个、10 个时，这种方式很自然。

但当 MCP 服务变成十几个，工具数量超过 100 个后，全量暴露会带来三个问题。

第一，注意力竞争。

模型本来只需要完成当前任务，却必须在大量无关工具中判断“哪个可能有用”。这些无关工具虽然不会被调用，但它们已经占用了上下文。

第二，行为诱导。

工具本身就是一种暗示。模型看到某个工具，就更容易认为这件事“也许应该做”。这会让 Agent 出现多动倾向。

第三，长任务退化。

工具 schema、历史对话、中间产物、旧任务约束会一起累积。长任务越往后，模型越容易忽略格式、流程和边界条件。

这让我意识到：MCP 的关键问题不是“有没有工具”，而是“工具什么时候出现”。

## 设计目标：工具按任务阶段出现

我的解决思路是把 MCP 从“全量工具列表”改成“阶段感知工具列表”。

传统模式：

```text
所有工具一启动就可见
模型从 152 个工具中选择
```

阶段感知模式：

```text
启动时只暴露控制工具
Skill 判断当前任务阶段
模型设置 task context
MCP 根据阶段暴露少量业务工具
阶段结束后清空上下文
工具回到 idle 状态
```

也就是说，MCP 不再默认把所有能力塞给模型，而是根据当前任务阶段动态展开。

以课件处理任务为例，可以拆成四个阶段：

```text
intake       判断文件类型和读取策略
extraction   提取文本、OCR、解析 PDF/PPTX
generation   生成 Word、思维导图、复习建议、模拟题
review        检查输出质量和格式
```

不同阶段只暴露对应工具。模型在 extraction 阶段不需要看到 PPT 设计工具，在 generation 阶段也不需要看到底层 OCR 调试工具。

这不是减少能力，而是减少干扰。

## 核心实现：shared-mcp-runtime

我把这套逻辑抽成了一个共享运行时 `shared-mcp-runtime`。

它提供几个核心能力：

- 统一 JSON-RPC MCP runtime
- 支持 `notifications/tools/list_changed`
- 内置 `activate_domain`
- 内置 `set_task_context`
- 内置 `clear_task_context`
- 通过 `ctx.task` 为 toolProvider 提供当前阶段上下文
- 支持第三方 MCP 的 proxy 包装

一个最小化的 MCP server 可以这样写：

```js
import { createMcpServer } from "@codex/shared-mcp-runtime";

const server = createMcpServer({
  name: "example-mcp",
  version: "0.1.0",
  listChanged: true,
  enableTaskContext: true,
  toolProvider: async (ctx) => {
    if (!ctx.task.hasTask) {
      return { tools: [], handlers: [] };
    }

    if (ctx.task.stage === "generation") {
      return {
        tools: [
          {
            name: "generate_docx",
            description: "Generate a structured Word document.",
            inputSchema: {
              type: "object",
              properties: {
                source: { type: "string" },
              },
              required: ["source"],
            },
          },
        ],
        handlers: [
          {
            name: "generate_docx",
            handler: async (args) => ({
              content: [
                {
                  type: "text",
                  text: `Generated from ${args.source}`,
                },
              ],
            }),
          },
        ],
      };
    }

    return { tools: [], handlers: [] };
  },
});

server.run();
```

关键点在这里：

```js
if (!ctx.task.hasTask) {
  return { tools: [], handlers: [] };
}
```

没有任务上下文时，不暴露业务工具。

工具是否出现，由当前 task context 决定。

## 三个内置控制工具

### activate_domain

`activate_domain` 是最简单的领域激活工具。

它适合“只需要把某个 MCP 打开”的场景，比如第三方 MCP 没有阶段划分，只需要 idle/active 两种状态。

### set_task_context

`set_task_context` 是更重要的工具，用来设置当前任务上下文。

它可以包含：

```text
skill
goal
stage
language
file_type
```

例如：

```json
{
  "skill": "courseware-study",
  "goal": "generate study notes from PDF",
  "stage": "extraction",
  "language": "zh-CN",
  "file_type": "pdf"
}
```

MCP server 收到这个上下文后，会重新计算当前应该暴露哪些工具。

### clear_task_context

`clear_task_context` 用来收起工具。

没有它的话，工具一旦展开就会一直留在上下文里。完整生命周期应该是：

```text
idle → set_task_context → work → clear_task_context → idle
```

这一步很重要。工具暴露不仅要能展开，也要能收回。

## 解决 list_changed 的一轮延迟

MCP 支持 `notifications/tools/list_changed`。服务端工具列表变化后，可以通知客户端刷新工具。

但实际使用时会遇到一个问题：

```text
第 1 轮：模型调用 set_task_context
第 2 轮：模型才看到新工具
第 3 轮：模型调用业务工具
```

也就是说，动态工具列表会带来一轮空转。

如果一个任务有多个阶段，这种延迟会反复出现。

我的解决方式是在 `set_task_context` 里增加 `action` 参数。

例如：

```json
{
  "stage": "intake",
  "action": "diagnose_courseware_intake",
  "action_args": {
    "file": "chapter8.pdf"
  }
}
```

服务端内部流程变成：

```text
设置上下文
→ 刷新工具
→ 立即查找 action 对应 handler
→ 执行首个业务动作
→ 返回结果
```

这样可以把“设置上下文”和“执行第一步业务工具”合并成一次调用。

这不是 MCP 协议级的完美解法，但在实际使用中能明显减少空转轮次。

## 第三方 MCP 怎么办：proxy 包装

不是所有 MCP 都适合改源码。

对于第三方 MCP，我做了一个 `mcp.proxy.js`：

```text
ClaudeCode
→ shared-mcp-runtime proxy
→ child MCP server
```

proxy 默认只暴露控制工具。

当模型调用 `activate_domain` 或 `set_task_context` 后，proxy 再把 child MCP 的工具列表暴露出来。

这样可以在不修改第三方 MCP 源码的情况下，为它加上一层 idle gate。

不过这里有一个坑：

> 已经迁移到 shared runtime 的 MCP，不应该再套 proxy。

否则会出现“代理套代理”，工具生命周期反而变混乱。

我的规则是：

```text
自研 MCP：原生接入 shared runtime
第三方 MCP：用 proxy 包装
```

## 实验：课件总结任务

我用一个 98 页神经网络课件 PDF 做了测试。

任务目标：

- 生成学习笔记 DOCX
- 生成 Mermaid 思维导图

测试设计是 2×2：

| 条件 | 工具暴露方式 | 上下文状态 |
|---|---|---|
| A | 静态全量工具 | 短上下文 |
| B | 静态全量工具 | 长上下文 |
| C | 阶段感知工具 | 短上下文 |
| D | 阶段感知工具 | 长上下文 |

结果如下：

| 指标 | A 静态短上下文 | B 静态长上下文 | C 阶段短上下文 | D 阶段长上下文 |
|---|---:|---:|---:|---:|
| DOCX 字符数 | 3,749 | 2,758 | 4,816 | 5,376 |
| DOCX 表格数 | 12 | 7 | 10 | 15 |
| 思维导图行数 | 79 | 69 | 107 | 142 |
| 主要问题 | 表格 bug | 无关工具调用 | 无明显问题 | LaTeX 需二次修复 |

这个结果说明：

1. 静态全量工具在短上下文中已经不是最优
2. 长上下文会进一步放大工具污染
3. 阶段感知可以明显改善工具选择和输出完整度
4. 阶段感知不能解决所有长上下文问题

条件 D 的内容最多，但仍然出现了 LaTeX 需要二次修复的问题。这说明工具污染只是长上下文问题的一部分。

对话历史、中间产物、旧任务要求也会影响模型表现。

所以阶段感知 MCP 不是万能解法，它解决的是：

> 工具定义层面的上下文污染。

长任务还需要继续结合产物传递、上下文压缩、阶段交接和质量检查。

## 和 CLI 的关系

我不认为 MCP 应该替代 CLI。

很多复杂任务底层就应该由 CLI、脚本或专门程序完成，因为它们稳定、可复现、易调试。

但 MCP 的价值不在于替代执行层，而在于把能力变成 Agent 可以发现、理解和调度的标准接口。

更合理的结构是：

```text
MCP：提供少量高层入口
CLI：完成底层复杂执行
Skill：描述任务流程和调用策略
```

也就是说：

```text
MCP 薄入口 + CLI 厚执行 + Skill 流程路由
```

不应该把一个复杂程序拆成几十个低层 MCP 工具，而应该暴露少数稳定的高层能力。

例如：

```text
不推荐：
extract_pdf_text
ocr_page
parse_table
make_docx
make_mindmap
make_quiz
export_file
```

更推荐：

```text
analyze_courseware
generate_exam_pack
export_study_doc
```

内部怎么执行，可以交给 CLI。

外部怎么发现、约束和跨 Agent 复用，交给 MCP。

## MCP 的真正价值：让本地工程规范化传播

如果只是自己用，CLI 已经足够强。

但如果希望自己做的能力能低成本传播给别人，MCP 的价值就很明显。

一个 CLI 工程给别人用时，对方需要理解：

- 怎么安装依赖
- 怎么配置运行环境
- 怎么传参数
- 输出在哪里
- 失败后怎么看日志
- Agent 什么时候该调用哪条命令

而 MCP 可以把这些能力包装成标准接口：

- 工具名
- 工具描述
- 参数 schema
- 返回结构
- 权限边界
- 客户端调用方式

这样别人的 ClaudeCode、Cursor、ChatGPT、Deepseek Harness 或其他 Agent Host 都有机会用统一方式接入。

所以我现在对 MCP 的理解是：

> CLI 让能力在自己的机器上好用。  
> MCP 让能力在别人的 Agent 环境里可复用。

这也是我认为 MCP 仍然有长期价值的原因。

## 未来方向

我认为 MCP 接下来会往几个方向发展。

### MCP Gateway

不会让模型直接看到所有工具，而是通过 gateway 做筛选、权限、审计和路由。

### Stage-aware Tool Exposure

工具按任务阶段暴露，而不是全量暴露。

这正是 `shared-mcp-runtime` 当前做的事情。

### MCP + CLI Hybrid

MCP 提供高层入口，CLI 负责重执行。

### Trusted MCP Registry

未来 MCP 生态需要更可信的注册表，包含权限声明、安全评分、签名、维护状态和审计信息。

### MCP Apps / UI

MCP 不只返回文本，还会提供可交互界面。这个方向更接近 Agent Host 的应用生态，而不是传统命令行工具。

## 结论

这次优化给我的最大启发是：

> Agent 工程不是给模型堆更多工具，而是设计工具出现的时机。

工具越多，Agent 不一定越强。

更重要的是：

```text
当前阶段需要什么工具
哪些工具应该隐藏
任务结束后如何收回工具
如何避免长上下文污染
如何把本地能力标准化传播
```

MCP 的问题不在于协议没有价值，而在于很多使用方式还停留在“全量暴露工具”的阶段。

我的实践路线是：

```text
MCP 薄入口
CLI 厚执行
Skill 做流程
共享 runtime 做上下文治理
```

这不是为了证明 MCP 比 CLI 更强，而是为了让 Agent 在复杂任务中更稳定、更可控、更容易复用。

项目地址：

https://github.com/spencernero2021-hash/shared-mcp-runtime

标签建议：

`MCP`、`AI Agent`、`ClaudeCode`、`Deepseek`、`上下文工程`、`工具调用`
