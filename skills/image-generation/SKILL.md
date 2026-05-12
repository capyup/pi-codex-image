---
name: image-generation
description: Generate images with the Codex image_generation tool and inspect local images with view_image when the current model supports those capabilities. Use when the user asks for AI-created bitmap visuals, photos, illustrations, mockups, variants, reference-image inspection, or local image viewing.
---

# Image Generation

Use this skill when a user wants a generated bitmap image rather than a code-native SVG, HTML/CSS mockup, or deterministic diagram, or when they ask to inspect a local image file.

## Default workflow

1. Use `image_generation` for agent-driven raster image generation when it is available.
2. Use `view_image` to inspect local image files before or after generation when the user references an existing image or asks you to verify the output.
3. `image_generation` is available on `openai-codex` models.
4. `view_image` is available only when the current model supports image inputs.
5. Treat visible text as a supported capability: when the user asks for a cover, poster, social graphic, title, label, or typography, include the exact requested wording in the prompt instead of removing it or adding `no text`.
6. Ask only if a missing detail blocks success; otherwise make reasonable prompt-shaping choices.

## Decision rules

- Do not replace a requested image with an SVG placeholder.
- Do not use this for simple deterministic vector icons, charts, or repo-native UI elements unless the user explicitly asks for a raster concept.
- Do not reserve blank title space or suppress lettering for text-capable image models unless the user asks for a wordless background or post-production text.
- Use `view_image` for local image inspection; use shell/file tools for text files.
- Avoid overwriting project assets unless the user explicitly asks to replace them.

## References

- Read [configuration](references/configuration.md) when provider support, routing, or setup is unclear.
- Read [prompting](references/prompting.md) for prompt shaping, transparent images, reference-image guidance, and text handling.
