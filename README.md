# pi-codex-image

Contributes the image portion of [IgorWarzocha/pi-codex-conversion](https://github.com/IgorWarzocha/pi-codex-conversion) as a focused Pi package. Current release version: `0.2.2`.

This package ports the Codex-style `image_generation` and `view_image` capabilities without replacing Pi's full tool surface.

It provides:

- Extension tool: `image_generation`
- Extension tool: `view_image`
- Skill: `image-generation`

## Behavior

`pi-codex-image` dynamically routes tools based on the currently selected model:

- `image_generation` is active when the current provider is `openai-codex`.
- `view_image` is active for any selected model that advertises image input support.
- Switching models triggers the router again, adding these tools when supported and removing them when unsupported.
- Existing non-image active tools are preserved while image tools are added or removed.

## Image generation

The `image_generation` tool is exposed as a normal Pi function tool. It accepts a prompt, calls the Codex Responses image generation endpoint, extracts the returned `image_generation_call.result`, and writes the PNG locally.

Generated images are saved under:

```text
.pi/openai-codex-images/
```

The newest image is also mirrored to:

```text
.pi/openai-codex-images/latest.png
```

This local tool implementation avoids depending on Pi core support for native `image_generation_call` stream items.

## View images

`view_image` wraps Pi's native image reader and returns only image content to the model.

Parameters:

```json
{
  "path": "./local-image.png",
  "detail": "original"
}
```

- `path` is required and may be absolute or relative to the current working directory.
- `detail: "original"` is exposed only for Codex-family image-capable models.
- `file_path` and `image_path` are accepted as compatibility aliases and normalized to `path`.

## Install

From a checkout:

```bash
pi install npm:@capyup/pi-codex-image
```

For one session:

```bash
pi -e /path/to/pi-codex-image
```

Run `/reload` after installing into an active session.

## Development

Package metadata:

- Package name: `@capyup/pi-codex-image`
- Version: `0.2.2`
- Repository: `https://github.com/capyup/pi-codex-image`
- Extension entry: `extensions/codex-image.ts`
- Skill directory: `skills/image-generation`

When syncing with upstream, compare against `pi-codex-conversion`'s `image-generation-tool.ts`, `view-image-tool.ts`, and dynamic tool routing in `index.ts`.
