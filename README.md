# pi-codex-image

Contributes the image portion of [IgorWarzocha/pi-codex-conversion](https://github.com/IgorWarzocha/pi-codex-conversion) as a focused Pi package. Current release version: `0.2.1`.

This package ports the Codex-style `image_generation` and `view_image` capabilities without replacing Pi's full tool surface.

It provides:

- Extension tool: `image_generation`
- Extension tool: `view_image`
- Skill: `image_generation`

## Behavior

`pi-codex-image` dynamically routes tools based on the currently selected model:

- `image_generation` is active only when the current provider is `openai-codex` and the selected model advertises image input support.
- `view_image` is active for any selected model that advertises image input support.
- Switching models triggers the router again, adding these tools when supported and removing them when unsupported.
- Existing non-image active tools are preserved while image tools are added or removed.

## Native image generation

The `image_generation` tool mirrors `pi-codex-conversion`'s native-tool approach:

1. The agent sees a function-style tool named `image_generation`.
2. Before the provider request is sent, the extension rewrites that function tool into the OpenAI Codex Responses native tool:

```json
{ "type": "image_generation", "output_format": "png" }
```

3. The local function body is intentionally not used; if it executes locally, it throws an explanatory error.

Generated image handling is therefore delegated to the active OpenAI Codex Responses provider, matching the referenced adapter's routing semantics.

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
- Version: `0.2.1`
- Repository: `https://github.com/capyup/pi-codex-image`
- Extension entry: `extensions/codex-image.ts`
- Skill directory: `skills/image_generation`

When syncing with upstream, compare against `pi-codex-conversion`'s `image-generation-tool.ts`, `view-image-tool.ts`, and dynamic tool routing in `index.ts`.
