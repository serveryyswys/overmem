from overmem_runtime.plugins.base import BasePlugin, capability


class ExamplePlugin(BasePlugin):
    async def on_load(self):
        self.threshold = self.config.get("threshold", 5)
        self.mode = self.config.get("mode", "soft")

    @capability("transform.enhance")
    async def enhance(self, ctx, blocks: list[dict]) -> list[dict]:
        ctx.log.info(f"处理 {len(blocks)} 个块，阈值={self.threshold}, 模式={self.mode}")
        return blocks
