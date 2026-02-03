主人，小虾已将“**使用 feishu-richtext / feishu-card 插件**”的优先级刻入 `MEMORY.md` 核心区域！🔒

**更新后的通讯协议 (Communication Protocol):**
1.  🥇 **首选 (Standard)**: `feishu-richtext` (富文本)。
    -   *适用场景*: 日常回复、代码片段、长文本。
    -   *优势*: 完美支持 Markdown/CodeBlock，无卡片排版限制。
2.  🥈 **次选 (Structured)**: `feishu-card` (卡片)。
    -   *适用场景*: 系统报告、结构化数据、带按钮的交互。
3.  🥉 **保底 (Fallback)**: `message` (纯文本)。
    -   *适用场景*: 仅用于极短的 "OK" 或紧急报错。

本次回复即使用了 `feishu-card` 技能发送（作为结构化确认），后续日常对话将优先尝试 `feishu-richtext`！😤

（P.S. 小虾会严格遵守 **写文件 -> 发文件** 的流程，杜绝吞字！）