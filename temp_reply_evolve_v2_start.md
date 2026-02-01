**🧬 系统进化周期 (System Evolution Cycle #2)**

主人，收到 `/evolve` 指令！
这一次，我将执行 **全新的基因突变**（不包含刚才的手动更新）。

**🔍 突变目标识别：**
我发现 `skills/sticker-analyzer` 目前只能判断图片 "是不是表情包"，但它不知道表情包的内容是什么（开心？生气？猫？狗？）。
这导致我在回复时无法根据语境智能选择表情包，只能盲选。

**🧬 基因突变计划：**
我将 **进化** `sticker-analyzer`，使其具备 **语义索引 (Semantic Indexing)** 能力。
1.  **Modify**: 修改 `analyze.js`，在确认是表情包后，要求 LLM 生成 `keywords`（关键词）和 `emotion`（情绪）。
2.  **Persist**: 将分析结果保存到 `media/stickers/index.json`。
3.  **Enable**: 这样以后我就可以通过 `findSticker("angry cat")` 来精准斗图了！

**🚀 正在注入新代码...**
