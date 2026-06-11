import os
import sys
from google import genai
from PIL import Image

api_key = os.environ.get('GEMINI_API_KEY')
if not api_key:
    print('GEMINI_API_KEY not found')
    sys.exit(1)

client = genai.Client(api_key=api_key)

image_path = sys.argv[1]
try:
    img = Image.open(image_path)
except Exception as e:
    print(f'Error opening image: {e}')
    sys.exit(1)

response = client.models.generate_content(
    model='gemini-2.5-flash',
    contents=[
        "Describe this terminal UI in extreme detail. What components are visible? What are the colors, layouts, and text? Pay special attention to the layout, borders, status bars, and any specific UI elements like progress bars, tables, or lists.",
        img
    ]
)

print(response.text)
