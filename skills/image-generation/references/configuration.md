# Configuration

The package provides the `image_generation` and `view_image` extension tools plus the `image-generation` skill.

## Provider support

Tool availability is dynamic and follows the current selected Pi model.

- `image_generation`: enabled for `openai-codex` models.
- `view_image`: enabled for models that advertise image input support.
- `view_image.detail = "original"`: exposed only for image-capable Codex-family models.

When the model changes, the extension re-runs routing and updates active tools. Non-image tools that were already active are preserved.

## Image generation routing

`image_generation` is exposed to the agent as a normal function tool with a `prompt` parameter. When executed, it calls the Codex Responses image generation endpoint, extracts the returned `image_generation_call.result`, and writes the PNG locally under `.pi/openai-codex-images/`.

The latest generated image is also mirrored to `.pi/openai-codex-images/latest.png`.

This avoids depending on Pi core provider parsing for native `image_generation_call` response stream items.

## Install

```bash
pi install /path/to/pi-codex-image
```

For one session only:

```bash
pi -e /path/to/pi-codex-image
```

After installing into a running pi session, run `/reload`.
