"""Test the SiliconFlow vision model with a real image (base64 encoded)."""
import asyncio, base64, sys, pathlib
from PIL import Image, ImageDraw, ImageFont

# Create a meaningful test image with text and a simple network diagram
img = Image.new("RGB", (600, 400), "#f0f4f8")
draw = ImageDraw.Draw(img)
# Draw a simple "network diagram" - two boxes connected by an arrow
draw.rectangle([60, 150, 200, 230], outline="#2c5f8a", width=3, fill="#ddeeff")
draw.text((80, 180), "Host A", fill="#1a3a5c")
draw.rectangle([380, 150, 520, 230], outline="#2c5f8a", width=3, fill="#ddeeff")
draw.text((400, 180), "Host B", fill="#1a3a5c")
draw.line([200, 190, 380, 190], fill="#e05c00", width=3)
draw.polygon([370,183, 380,190, 370,197], fill="#e05c00")
draw.text((260, 165), "TCP/IP", fill="#333333")
draw.text((120, 100), "Figure 1.5 - End-to-End Communication", fill="#444444")
# Save
img_path = pathlib.Path("output/test_network_diagram.png")
img.save(img_path)

# Encode to base64
b64 = base64.b64encode(img_path.read_bytes()).decode()
data_url = f"data:image/png;base64,{b64}"

# Import settings/llm
sys.path.insert(0, "src")
from rag_mvp.config import settings
from rag_mvp.llm import vision_model_func

print(f"Vision model : {settings.vision_model}")
print(f"Vision URL   : {settings.effective_vision_base_url}")
print("Sending image + text prompt to vision model...")

async def main():
    resp = await vision_model_func(
        [
            {"type": "image_url", "image_url": {"url": data_url}},
            {"type": "text", "text": "Describe this network diagram in detail. What does it show?"},
        ],
        system_prompt="You are an expert in computer networking. Describe the diagram clearly.",
    )
    print(f"\n=== Vision model response ===\n{resp}\n")

asyncio.run(main())
