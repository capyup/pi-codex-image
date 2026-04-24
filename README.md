# pi-codex-imagegen

Pi package that adds Codex-backed image generation through `gpt-image-2`.

It provides:

- Extension tool: `codex_image_generate`
- Slash command: `/imagegen`
- Skill: `codex-imagegen`

The tool calls the Responses API `image_generation` built-in tool with the current `gpt-5.x` host model when available (or `gpt-5.4` by default) and `model: "gpt-image-2"` inside the image tool spec. It returns the generated image inline and can optionally save it to disk.

## Install

```bash
pi install /Users/lucas/pi-codex-imagegen
```

Or try for a single session:

```bash
pi -e /Users/lucas/pi-codex-imagegen
```

Run `/reload` after installing into an active session.

## Provider support

The backend always uses the current pi model provider. It is enabled only when the current provider is `openai` or `openai-codex` and the current model id matches `gpt-5.x` such as `gpt-5.4` or `gpt-5.5`.

If the current provider/model does not match, `/imagegen` and `codex_image_generate` report that the current provider is unsupported instead of trying unrelated fallback credentials.

## Slash command

Ask the agent to generate an image. The command forwards your request to the agent, and the agent chooses tool parameters such as aspect ratio, quality, reference intent, transparency, and save mode.

```text
/imagegen --square --high a cute capybara relaxing in a warm hot spring, cozy digital illustration, no text
```

Useful flags:

```text
/imagegen --landscape --save project a cinematic alpine cabin at sunrise
/imagegen --portrait --ref ./source.png --intent edit turn this into a rainy neon street scene
/imagegen --help
```

The command tells the agent to default to `save: "project"`, so output files land in `<cwd>/.pi/generated-images/` unless you ask for another save mode. The tool itself also defaults to project saving.

## Tool examples

Simple generation:

```json
{
  "prompt": "A cute capybara relaxing in a warm hot spring, cozy digital illustration, soft steam, no text, no watermark",
  "aspectRatio": "square",
  "quality": "medium",
  "save": "project"
}
```

Reference edit:

```json
{
  "prompt": "Edit the source image into a rainy neon street scene while keeping the main subject recognizable.",
  "referenceImages": ["/absolute/path/to/source.png"],
  "referenceIntent": "edit",
  "aspectRatio": "portrait",
  "quality": "high",
  "save": "project"
}
```

## Config

See `skills/codex-imagegen/references/configuration.md`.
