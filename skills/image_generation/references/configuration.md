# Configuration

The package provides the `image_generation` and `view_image` extension tools plus the `image_generation` skill.

## Provider support

Tool availability is dynamic and follows the current selected Pi model.

- `image_generation`: enabled only for `openai-codex` models that advertise image input support.
- `view_image`: enabled for models that advertise image input support.
- `view_image.detail = "original"`: exposed only for image-capable Codex-family models.

When the model changes, the extension re-runs routing and updates active tools. Non-image tools that were already active are preserved.

## Native routing

`image_generation` is exposed to the agent as a normal function tool, then rewritten in `before_provider_request` to the native OpenAI Codex Responses tool:

```json
{ "type": "image_generation", "output_format": "png" }
```

The local function should not execute. If it does, the current provider/model is unsupported or the request was not rewritten.

## Install

```bash
pi install /path/to/pi-codex-image
```

For one session only:

```bash
pi -e /path/to/pi-codex-image
```

After installing into a running pi session, run `/reload`.
