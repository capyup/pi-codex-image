# Configuration

The package provides the `codex_image_generate` extension tool, the `/imagegen` slash command, and the `codex-imagegen` skill.

## Install

Use the package by path:

```bash
pi install /Users/lucas/pi-codex-imagegen
```

For one session only:

```bash
pi -e /Users/lucas/pi-codex-imagegen
```

After installing into a running pi session, run `/reload`.

## Provider support

The backend uses the current pi provider only. It does not try unrelated fallback credentials or alternate auth modes.

Supported current providers:

- `openai` with a current model id matching `gpt-5.x`
- `openai-codex` with a current model id matching `gpt-5.x`

Examples of matching model ids: `gpt-5.4`, `gpt-5.5`, `gpt-5.3-codex`, `openai/gpt-5.4`.

If the current provider/model does not match, the tool reports that `/imagegen` is unsupported and asks the user to switch to an `openai` or `openai-codex` `gpt-5.x` model.

## Slash command

`/imagegen` asks the agent to choose parameters and call `codex_image_generate`. This keeps the command intelligent: the agent decides aspect ratio, quality, reference intent, mask use, transparent background, and save mode from the user's wording.

```text
/imagegen --square --medium a cozy capybara in a hot spring, no text
/imagegen --ref ./source.png --intent edit make this look like a watercolor postcard
/imagegen --help
```

Supported hint flags: `--square`, `--landscape`, `--portrait`, `--low`, `--medium`, `--high`, `--auto`, `--save`, `--dir`, `--ref`, `--intent`, `--mask`, and `--transparent`.

The command instructs the agent to use `save: "project"` by default, so images are saved under:

```text
<cwd>/.pi/generated-images/
```

## Environment variables

```bash
# Model defaults. Without this override, the host model defaults to the current gpt-5.x model.
export PI_CODEX_IMAGEGEN_HOST_MODEL=gpt-5.4
export PI_CODEX_IMAGEGEN_IMAGE_MODEL=gpt-image-2
export PI_CODEX_IMAGEGEN_QUALITY=medium     # low | medium | high | auto

# Saving defaults.
export PI_CODEX_IMAGEGEN_SAVE=project       # none | project | global | custom
export PI_CODEX_IMAGEGEN_SAVE_DIR=/path/to/images
```

## Config files

Project config overrides global config.

- Global: `~/.pi/agent/extensions/codex-imagegen.json`
- Project: `<cwd>/.pi/extensions/codex-imagegen.json`

Example:

```json
{
  "imageModel": "gpt-image-2",
  "quality": "medium",
  "save": "project"
}
```

Prefer environment variables for machine-local defaults. Do not commit project configs that contain local-only paths unless that is intentional.

## Save modes

- `project`: save to `<cwd>/.pi/generated-images/` (default).
- `none`: return the image inline only.
- `global`: save to `~/.pi/agent/generated-images/codex/`.
- `custom`: save to `saveDir`, `PI_CODEX_IMAGEGEN_SAVE_DIR`, or config `saveDir`.

## Troubleshooting

- If `/imagegen` says the current provider is unsupported, switch to an `openai` or `openai-codex` `gpt-5.x` model.
- If direct OpenAI Codex auth fails, run `/login` and select the OpenAI ChatGPT/Codex provider.
- If image generation returns `server_error` after several successful images, wait for the provider's image quota window to reset.
