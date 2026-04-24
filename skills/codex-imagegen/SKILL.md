---
name: codex-imagegen
description: Generate or edit raster images in pi using the codex_image_generate tool backed by Codex Responses image_generation and gpt-image-2. Use when the user asks for AI-created bitmap visuals, photos, illustrations, mockups, variants, reference-image edits, or transparent/cutout-style image output.
---

# Codex Imagegen

Use this skill when a user wants a generated bitmap image rather than a code-native SVG, HTML/CSS mockup, or diagram.

## Default workflow

1. Use the `codex_image_generate` tool for agent-driven raster image generation or image edits; use `/imagegen` when the user explicitly wants the slash command path.
2. Keep `gpt-image-2` as the image model unless the user explicitly asks to experiment.
3. The backend uses the current pi provider only; it works when the provider is `openai` or `openai-codex` on a `gpt-5.x` model.
4. Choose `aspectRatio`: `square` for standalone images, `landscape` for banners/wallpapers, `portrait` for phone/poster layouts.
5. Use `quality: "medium"` by default, `low` for quick drafts, and `high` for final or text-heavy assets.
6. For deliverable files, set `save: "project"` or `save: "custom"`; for quick previews, `save: "none"` is fine.
7. Return the saved path when present, and mention the final prompt briefly.

## Reference images

- If the request depends on an existing image, pass it in `referenceImages`.
- Use `referenceIntent: "edit"` for direct edits, `style_reference` for style transfer, `subject_reference` for preserving a subject, and `compose` for combining images.
- Local paths may be absolute or relative to the current working directory.
- If using `maskImage`, provide exactly one source image in `referenceImages`.

## Decision rules

- Do not replace a requested image with an SVG placeholder.
- Do not use this for simple deterministic vector icons, charts, or repo-native UI elements unless the user explicitly asks for a raster concept.
- Ask only if a missing detail blocks success; otherwise make reasonable prompt-shaping choices.
- Avoid overwriting project assets unless the user explicitly asks to replace them.

## References

- Read [configuration](references/configuration.md) when provider support, saving, or setup is unclear.
- Read [prompting](references/prompting.md) for prompt shaping, transparent images, and reference-image guidance.
