# Prompting Guide

## Simple generation

Use a compact structured prompt. Include only details that improve the result.

```text
Use case: illustration-story
Asset type: standalone image
Primary request: a cute capybara relaxing in a warm hot spring
Style/medium: cozy polished digital illustration
Composition/framing: square image, capybara centered, generous padding
Lighting/mood: warm golden-hour light, calm, soft steam
Constraints: no text, no watermark
```

## Reference images

When references are present, describe the intended final image, not just the reference.

- `edit`: "Edit the source image so the dog is wearing a red raincoat; keep the background and pose unchanged."
- `style_reference`: "Create a new city street scene using the same watercolor texture and muted palette as the reference."
- `subject_reference`: "Draw the same cat as a small astronaut; keep the face and markings recognizable."
- `compose`: "Combine the product from image 1 with the desk scene from image 2 into one realistic ad photo."

## Transparent or cutout output

Use `transparentBackground: true` only when the user asks for a transparent PNG or cutout. Endpoint support can vary. If it fails, retry with a flat chroma-key background prompt and local background removal in a separate workflow.

Chroma-key fallback prompt:

```text
Create the requested subject on a perfectly flat solid #00ff00 chroma-key background for background removal.
The background must be one uniform color with no shadows, gradients, texture, reflections, floor plane, or lighting variation.
Keep the subject fully separated from the background with crisp edges and generous padding.
Do not use #00ff00 anywhere in the subject.
No cast shadow, no contact shadow, no reflection, no watermark, and no text unless explicitly requested.
```

## Quality choices

- `low`: fast drafts, thumbnails, broad composition checks.
- `medium`: default for most user-facing images.
- `high`: final assets, dense detail, product shots, diagrams with text.
- `auto`: let the endpoint choose.

## Aspect choices

- `square`: avatars, icons, standalone images, social cards.
- `landscape`: desktop wallpapers, banners, hero images, wide scenes.
- `portrait`: posters, phone backgrounds, vertical social posts.

## Avoid

- Do not add logos, text, watermarks, extra people, or extra objects unless requested.
- Do not invent brand names or slogans.
- Do not claim exact pixel preservation for masked edits; image masks are guidance.
- Do not overwrite files unless explicitly asked.
