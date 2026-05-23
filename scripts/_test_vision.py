"""Quick smoke-test for the SiliconFlow vision model (text-only prompt, no image)."""
import asyncio
from src.rag_mvp.llm import vision_model_func
from src.rag_mvp.config import settings

async def main():
    print(f"Vision model : {settings.vision_model}")
    print(f"Vision URL   : {settings.effective_vision_base_url}")
    print("Sending test prompt...")
    resp = await vision_model_func(
        "Say exactly: VISION_OK",
        system_prompt="You are a test assistant. Reply with only what you are told.",
    )
    print(f"Response: {resp!r}")

asyncio.run(main())
