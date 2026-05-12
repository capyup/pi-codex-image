import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	createReadTool,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";

const STATUS_KEY = "codex-image";
const STATUS_TEXT = "Codex image";
const IMAGE_GENERATION_TOOL_NAME = "image_generation";
const VIEW_IMAGE_TOOL_NAME = "view_image";
const CODEX_IMAGE_TOOL_NAMES = [IMAGE_GENERATION_TOOL_NAME, VIEW_IMAGE_TOOL_NAME];
const IMAGE_GENERATION_UNSUPPORTED_MESSAGE = "image_generation is only available with openai-codex models";
const VIEW_IMAGE_UNSUPPORTED_MESSAGE = "view_image is not allowed because the current model does not support image inputs";
const DETAIL_DESCRIPTION = "Use `original` to preserve the file's original resolution; omit for default resized behavior.";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex/responses";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

const IMAGE_GENERATION_PARAMETERS = Type.Object({
	prompt: Type.String({ description: "Detailed image prompt describing what to generate." }),
});

type ImageGenerationParams = Static<typeof IMAGE_GENERATION_PARAMETERS>;

interface ExtensionState {
	enabled: boolean;
	previousToolNames?: string[];
}

interface ViewImageParams {
	path: string;
	detail?: string;
}

interface ViewImageReader {
	execute: (toolCallId: string, params: { path: string }, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>;
}

interface ViewImageReaders {
	resized: ViewImageReader;
	original: ViewImageReader;
}

interface CodexAuth {
	access?: string;
	accountId?: string;
}

type ViewImageParameters = ReturnType<typeof createViewImageParameters>;

function supportsImageInputs(model: ExtensionContext["model"]): boolean {
	return Array.isArray(model?.input) && model.input.includes("image");
}

function isOpenAICodexModel(model: ExtensionContext["model"]): boolean {
	return (model?.provider ?? "").toLowerCase() === "openai-codex";
}

function isCodexImageContext(ctx: ExtensionContext): boolean {
	return supportsNativeImageGeneration(ctx.model) || supportsImageInputs(ctx.model);
}

function supportsNativeImageGeneration(model: ExtensionContext["model"]): boolean {
	return isOpenAICodexModel(model);
}

function supportsOriginalImageDetail(model: ExtensionContext["model"]): boolean {
	const provider = (model?.provider ?? "").toLowerCase();
	const api = (model?.api ?? "").toLowerCase();
	const id = (model?.id ?? "").toLowerCase();
	return supportsImageInputs(model) && (provider.includes("codex") || api.includes("codex") || id.includes("codex"));
}

function parseJwtAccountId(token: string): string | undefined {
	try {
		const [, payload] = token.split(".");
		if (!payload) return undefined;
		const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		return decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
	} catch {
		return undefined;
	}
}

async function readCodexAuth(): Promise<{ token: string; accountId: string }> {
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	const raw = await readFile(authPath, "utf8");
	const auth = JSON.parse(raw)?.["openai-codex"] as CodexAuth | undefined;
	const token = auth?.access;
	if (!token) throw new Error(`Missing openai-codex OAuth access token in ${authPath}`);
	const accountId = auth.accountId || parseJwtAccountId(token);
	if (!accountId) throw new Error("Unable to determine ChatGPT account id for openai-codex image generation");
	return { token, accountId };
}

function parseSseEvents(text: string): unknown[] {
	const events: unknown[] = [];
	let dataLines: string[] = [];
	const flush = () => {
		if (dataLines.length === 0) return;
		const data = dataLines.join("\n");
		dataLines = [];
		if (data === "[DONE]") return;
		try {
			events.push(JSON.parse(data));
		} catch {
			// Ignore non-JSON keepalive/debug chunks.
		}
	};
	for (const line of text.split(/\r?\n/)) {
		if (line === "") {
			flush();
			continue;
		}
		if (line.startsWith("data: ")) dataLines.push(line.slice(6));
	}
	flush();
	return events;
}

function findGeneratedImage(events: unknown[]): string | undefined {
	for (const event of events) {
		if (!event || typeof event !== "object") continue;
		const item = (event as { item?: unknown }).item;
		if (!item || typeof item !== "object") continue;
		const typedItem = item as { type?: unknown; result?: unknown };
		if (typedItem.type === "image_generation_call" && typeof typedItem.result === "string" && typedItem.result.length > 0) {
			return typedItem.result;
		}
	}
	return undefined;
}

async function generateCodexImage(prompt: string, modelId: string, signal?: AbortSignal): Promise<string> {
	const { token, accountId } = await readCodexAuth();
	const body = {
		model: modelId,
		store: false,
		stream: true,
		instructions: "Generate the requested image. Return no extra text.",
		input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
		tools: [{ type: "image_generation", output_format: "png" }],
		tool_choice: "auto",
	};

	const response = await fetch(DEFAULT_CODEX_BASE_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"chatgpt-account-id": accountId,
			originator: "pi",
			"OpenAI-Beta": "responses=experimental",
			accept: "text/event-stream",
			"content-type": "application/json",
			"User-Agent": "pi-codex-image",
		},
		body: JSON.stringify(body),
		signal,
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Codex image generation failed (${response.status} ${response.statusText}): ${text.slice(0, 1000)}`);
	}

	const imageBase64 = findGeneratedImage(parseSseEvents(text));
	if (!imageBase64) {
		throw new Error("Codex image generation completed without an image_generation_call result");
	}
	return imageBase64;
}

async function saveGeneratedImage(cwd: string, imageBase64: string): Promise<{ path: string; latestPath: string }> {
	const outputDir = resolve(cwd, ".pi", "openai-codex-images");
	await mkdir(outputDir, { recursive: true });
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const imagePath = join(outputDir, `${timestamp}.png`);
	const latestPath = join(outputDir, "latest.png");
	const data = Buffer.from(imageBase64, "base64");
	await writeFile(imagePath, data);
	await writeFile(latestPath, data);
	return { path: imagePath, latestPath };
}

function prepareImageGenerationArguments(args: unknown): ImageGenerationParams {
	if (args && typeof args === "object") {
		const record = args as Record<string, unknown>;
		const prompt = record.prompt ?? record.description ?? record.query;
		if (typeof prompt === "string" && prompt.trim().length > 0) return { prompt: prompt.trim() };
	}
	return { prompt: String(args ?? "").trim() };
}

function createImageGenerationTool(): ToolDefinition<typeof IMAGE_GENERATION_PARAMETERS> {
	const description =
		"Generate a PNG image from a prompt. Outputs are saved under `.pi/openai-codex-images/` and mirrored to `.pi/openai-codex-images/latest.png`.";
	return {
		name: IMAGE_GENERATION_TOOL_NAME,
		label: IMAGE_GENERATION_TOOL_NAME,
		description,
		promptSnippet: `${description} When the user asks to generate an image, call this tool with a concise but complete prompt.`,
		parameters: IMAGE_GENERATION_PARAMETERS,
		prepareArguments: prepareImageGenerationArguments,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!supportsNativeImageGeneration(ctx.model)) throw new Error(IMAGE_GENERATION_UNSUPPORTED_MESSAGE);
			const prompt = params.prompt.trim();
			if (!prompt) throw new Error("image_generation requires a non-empty prompt");
			const imageBase64 = await generateCodexImage(prompt, ctx.model.id, signal);
			const saved = await saveGeneratedImage(ctx.cwd, imageBase64);
			return {
				content: [{ type: "text", text: `Generated image saved to ${saved.path}\nLatest mirror: ${saved.latestPath}` }],
				details: saved,
			};
		},
	};
}

function createViewImageParameters(allowOriginalDetail: boolean) {
	const properties: Record<string, TSchema> = {
		path: Type.String({ description: "Local image file path." }),
	};
	if (allowOriginalDetail) properties.detail = Type.Optional(Type.String({ description: DETAIL_DESCRIPTION }));
	return Type.Object(properties);
}

function parseViewImageParams(params: unknown): ViewImageParams {
	if (!params || typeof params !== "object" || !("path" in params) || typeof params.path !== "string") {
		throw new Error("view_image requires a string 'path' parameter");
	}
	const rawDetail = "detail" in params ? params.detail : undefined;
	if (rawDetail !== undefined && rawDetail !== null && typeof rawDetail !== "string") {
		throw new Error("view_image.detail must be a string when provided");
	}
	const detail = rawDetail === null ? undefined : rawDetail;
	if (detail !== undefined && detail !== "original") {
		throw new Error(`view_image.detail only supports \`original\`; omit \`detail\` for default resized behavior, got \`${detail}\``);
	}
	return { path: params.path, detail };
}

function prepareViewImageArguments(args: unknown): Record<string, unknown> {
	if (!args || typeof args !== "object") return args as Record<string, unknown>;
	const record = args as Record<string, unknown>;
	const prepared: Record<string, unknown> = { ...record };
	if (!("path" in prepared)) {
		if ("file_path" in prepared) prepared.path = prepared.file_path;
		else if ("image_path" in prepared) prepared.path = prepared.image_path;
	}
	return prepared;
}

function resolveViewImagePath(path: string, cwd: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

async function ensureViewImagePathIsFile(path: string, cwd: string): Promise<void> {
	const absolutePath = resolveViewImagePath(path, cwd);
	let metadata;
	try {
		metadata = await stat(absolutePath);
	} catch (error) {
		throw new Error(`unable to locate image at \`${absolutePath}\`: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!metadata.isFile()) throw new Error(`image path \`${absolutePath}\` is not a file`);
}

function normalizeViewImageResult(result: AgentToolResult<unknown>): AgentToolResult<unknown> {
	const imageContent = result.content.find((item) => item.type === "image");
	if (!imageContent || imageContent.type !== "image") {
		throw new Error("view_image expected an image file. Use exec_command or another text-reading tool for text files.");
	}
	return { ...result, content: [imageContent] };
}

function createDefaultViewImageReaders(cwd: string): ViewImageReaders {
	return {
		resized: createReadTool(cwd),
		original: createReadTool(cwd, { autoResizeImages: false }),
	};
}

function createViewImageTool(allowOriginalDetail = false): ToolDefinition<ViewImageParameters> {
	const parameters = createViewImageParameters(allowOriginalDetail);
	return {
		name: VIEW_IMAGE_TOOL_NAME,
		label: VIEW_IMAGE_TOOL_NAME,
		description: "View a local image file.",
		promptSnippet: "View a local image from the filesystem.",
		parameters,
		prepareArguments: prepareViewImageArguments,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			if (!supportsImageInputs(ctx.model)) throw new Error(VIEW_IMAGE_UNSUPPORTED_MESSAGE);
			const typedParams = parseViewImageParams(params);
			if (typedParams.detail === "original" && !allowOriginalDetail) {
				throw new Error("view_image.detail is not available for the current model");
			}
			await ensureViewImagePathIsFile(typedParams.path, ctx.cwd);
			const readers = createDefaultViewImageReaders(ctx.cwd);
			const reader = typedParams.detail === "original" ? readers.original : readers.resized;
			return normalizeViewImageResult(await reader.execute(toolCallId, { path: typedParams.path }, signal));
		},
	};
}

function getCodexImageToolNames(ctx: ExtensionContext): string[] {
	const toolNames: string[] = [];
	if (supportsNativeImageGeneration(ctx.model)) toolNames.push(IMAGE_GENERATION_TOOL_NAME);
	if (supportsImageInputs(ctx.model)) toolNames.push(VIEW_IMAGE_TOOL_NAME);
	return toolNames;
}

function stripCodexImageTools(toolNames: string[]): string[] {
	return toolNames.filter((toolName) => !CODEX_IMAGE_TOOL_NAMES.includes(toolName));
}

function hasCodexImageTools(toolNames: string[]): boolean {
	return toolNames.some((toolName) => CODEX_IMAGE_TOOL_NAMES.includes(toolName));
}

function mergeCodexImageTools(activeTools: string[], codexImageTools: string[]): string[] {
	const preservedTools = activeTools.filter((toolName) => !CODEX_IMAGE_TOOL_NAMES.includes(toolName));
	return [...codexImageTools, ...preservedTools];
}

function restoreTools(previousTools: string[] | undefined, activeTools: string[]): string[] {
	const restored = stripCodexImageTools(previousTools && previousTools.length > 0 ? previousTools : activeTools);
	for (const toolName of activeTools) {
		if (!CODEX_IMAGE_TOOL_NAMES.includes(toolName) && !restored.includes(toolName)) restored.push(toolName);
	}
	return restored;
}

function setStatus(ctx: ExtensionContext, enabled: boolean): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, enabled ? STATUS_TEXT : undefined);
}

function syncCodexImageTools(pi: ExtensionAPI, ctx: ExtensionContext, state: ExtensionState): void {
	pi.registerTool(createViewImageTool(supportsOriginalImageDetail(ctx.model)));
	const codexImageTools = getCodexImageToolNames(ctx);

	if (isCodexImageContext(ctx)) {
		if (!state.enabled) {
			state.previousToolNames = stripCodexImageTools(pi.getActiveTools());
			state.enabled = true;
		}
		pi.setActiveTools(mergeCodexImageTools(pi.getActiveTools(), codexImageTools));
		setStatus(ctx, codexImageTools.length > 0);
		return;
	}

	if (state.enabled || hasCodexImageTools(pi.getActiveTools())) {
		pi.setActiveTools(restoreTools(state.previousToolNames, pi.getActiveTools()));
	}
	state.enabled = false;
	setStatus(ctx, false);
}

export default function codexImage(pi: ExtensionAPI) {
	const state: ExtensionState = { enabled: false };

	pi.registerTool(createImageGenerationTool());
	pi.registerTool(createViewImageTool(false));

	pi.on("session_start", async (_event, ctx) => {
		syncCodexImageTools(pi, ctx, state);
	});

	pi.on("model_select", async (_event, ctx) => {
		syncCodexImageTools(pi, ctx, state);
	});
}
