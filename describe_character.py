import os
import sys
from google import genai
from PIL import Image

api_key = os.environ.get('GEMINI_API_KEY')
if not api_key:
    print('GEMINI_API_KEY not found')
    sys.exit(1)

client = genai.Client(api_key=api_key)

image_path = 'assets/character.png'
try:
    img = Image.open(image_path)
except Exception as e:
    print(f'Error opening image: {e}')
    sys.exit(1)

response = client.models.generate_content(
    model='gemini-2.5-flash',
    contents=[
        "Describe the character/mascot/object in this image in detail. What does it look like? What is its shape, face, features, colors, and overall design? We want to create a high-quality ASCII art representation of it, so describe its structure, lines, eyes, mouth, and any other details that can be translated into ASCII art.",
        img
    ]
)

print(response.text)
