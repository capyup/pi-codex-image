import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getAgentDir, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "typebox";

const EXTENSION_NAME = "codex-imagegen";
const DIRECT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_HOST_MODEL = "gpt-5.4";
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_QUALITY: Quality = "medium";
const DEFAULT_ASPECT_RATIO: AspectRatio = "square";
const DEFAULT_SAVE_MODE: SaveMode = "project";

const ASPECT_RATIOS = ["landscape", "square", "portrait"] as const;
type AspectRatio = (typeof ASPECT_RATIOS)[number];

const QUALITIES = ["low", "medium", "high", "auto"] as const;
type Quality = (typeof QUALITIES)[number];

const SAVE_MODES = ["none", "project", "global", "custom"] as const;
type SaveMode = (typeof SAVE_MODES)[number];

const REFERENCE_INTENTS = ["style_reference", "subject_reference", "edit", "compose"] as const;
type ReferenceIntent = (typeof REFERENCE_INTENTS)[number];

const SIZE_BY_ASPECT: Record<AspectRatio, string> = {
	landscape: "1536x1024",
	square: "1024x1024",
	portrait: "1024x1536",
};

const MIME_BY_EXT: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
	".gif": "image/gif",
};

const INTENT_HINTS: Record<ReferenceIntent, string> = {
	style_reference:
		"The attached image(s) are style references. Generate a new image that follows their visual style, palette, and composition language without copying their subject unless the prompt asks for it.",
	subject_reference:
		"The attached image(s) define the subject. Keep the subject recognizable while following the user's requested scene, pose, mood, or rendering style.",
	edit: "The attached image is the source image to edit. Apply the requested change while preserving unaffected regions as much as possible.",
	compose:
		"The attached images are elements to combine. Produce one coherent final image that incorporates the relevant subjects or style from each reference.",
};

const BASE_INSTRUCTIONS =
	"You are an assistant that must fulfill this request by using the image_generation tool. Do not answer with text only. Produce exactly one image unless the user explicitly asks for something else.";

const TOOL_PARAMS = Type.Object({
	prompt: Type.String({
		description:
			"Complete description of the desired final image. When references are supplied, describe the final image or edit, not just the changed region.",
	}),
	aspectRatio: Type.Optional(
		StringEnum(ASPECT_RATIOS, {
			description: "Output aspect ratio. landscape=1536x1024, square=1024x1024, portrait=1024x1536. Default: square.",
		}),
	),
	quality: Type.Optional(
		StringEnum(QUALITIES, {
			description: "gpt-image-2 quality tier. Default comes from config/env, otherwise medium.",
		}),
	),
	referenceImages: Type.Optional(
		Type.Array(Type.String(), {
			maxItems: 4,
			description: "Optional reference image paths, http(s) URLs, or data:image URLs. Local paths may be absolute or relative to cwd.",
		}),
	),
	referenceIntent: Type.Optional(
		StringEnum(REFERENCE_INTENTS, {
			description:
				"How to use referenceImages: style_reference, subject_reference, edit, or compose. Omit when no reference image is involved.",
		}),
	),
	transparentBackground: Type.Optional(
		Type.Boolean({
			description:
				"Request a transparent PNG background. This depends on endpoint support; leave false unless the user asks for transparency.",
		}),
	),
	maskImage: Type.Optional(
		Type.String({
			description:
				"Optional inpainting mask path/URL/data URL. Use with exactly one source reference image. Transparent mask pixels mark areas to regenerate.",
		}),
	),
	save: Type.Optional(
		StringEnum(SAVE_MODES, {
			description: "Save mode: none, project (.pi/generated-images), global (~/.pi/agent/generated-images/codex), or custom.",
		}),
	),
	saveDir: Type.Optional(
		Type.String({
			description: "Directory used when save=custom. Defaults to PI_CODEX_IMAGEGEN_SAVE_DIR or config saveDir.",
		}),
	),
});

type ToolParams = Static<typeof TOOL_PARAMS>;

interface ExtensionConfig {
	hostModel?: string;
	imageModel?: string;
	quality?: Quality;
	save?: SaveMode;
	saveDir?: string;
}

interface SaveConfig {
	mode: SaveMode;
	outputDir?: string;
}

interface RequestTarget {
	mode: "pi-codex" | "openai-compatible";
	endpoint: string;
	headers: Headers;
	hostModel: string;
	imageModel: string;
	label: string;
}

interface ParsedImage {
	data: string;
	mimeType: string;
}

interface ToolDetails {
	provider: string;
	providerMode: "pi-codex" | "openai-compatible";
	providerLabel: string;
	hostModel: string;
	imageModel: string;
	quality: Quality;
	size: string;
	aspectRatio: AspectRatio;
	saveMode: SaveMode;
	savedPath?: string;
	saveError?: string;
	referenceImagesUsed: number;
	referenceIntent?: ReferenceIntent;
	transparentBackground?: boolean;
	maskApplied?: boolean;
	warnings?: string[];
}

interface GenerationContext {
	cwd: string;
	modelRegistry: { getApiKeyForProvider: (provider: string) => Promise<string | undefined> };
	model?: { id?: string; provider?: string; api?: string; baseUrl?: string };
}

interface GenerationResult {
	image: ParsedImage;
	details: ToolDetails;
	summary: string;
}

type ProgressCallback = (message: string, details?: Record<string, unknown>) => void;

function readConfigFile(path: string): ExtensionConfig {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as ExtensionConfig;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function loadConfig(cwd: string): ExtensionConfig {
	const globalPath = join(getAgentDir(), "extensions", `${EXTENSION_NAME}.json`);
	const projectPath = join(cwd, ".pi", "extensions", `${EXTENSION_NAME}.json`);
	return { ...readConfigFile(globalPath), ...readConfigFile(projectPath) };
}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
	return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function env(name: string): string | undefined {
	const value = process.env[name];
	return value && value.trim() ? value.trim() : undefined;
}

function resolveAspect(value: unknown): AspectRatio {
	return oneOf(value, ASPECT_RATIOS) ? value : DEFAULT_ASPECT_RATIO;
}

function resolveQuality(params: ToolParams, config: ExtensionConfig): Quality {
	const value = params.quality || env("PI_CODEX_IMAGEGEN_QUALITY") || config.quality || DEFAULT_QUALITY;
	return oneOf(value, QUALITIES) ? value : DEFAULT_QUALITY;
}

function resolveSaveConfig(params: ToolParams, config: ExtensionConfig, cwd: string): SaveConfig {
	const value = params.save || env("PI_CODEX_IMAGEGEN_SAVE") || config.save || DEFAULT_SAVE_MODE;
	const mode = oneOf(value, SAVE_MODES) ? value : DEFAULT_SAVE_MODE;
	if (mode === "project") return { mode, outputDir: join(cwd, ".pi", "generated-images") };
	if (mode === "global") return { mode, outputDir: join(getAgentDir(), "generated-images", "codex") };
	if (mode === "custom") {
		const dir = params.saveDir || env("PI_CODEX_IMAGEGEN_SAVE_DIR") || config.saveDir;
		if (!dir || !dir.trim()) throw new Error("save=custom requires saveDir, PI_CODEX_IMAGEGEN_SAVE_DIR, or config saveDir.");
		return { mode, outputDir: dir };
	}
	return { mode };
}

function resolveHostModel(config: ExtensionConfig, fallback?: string): string {
	return env("PI_CODEX_IMAGEGEN_HOST_MODEL") || config.hostModel || fallback || DEFAULT_HOST_MODEL;
}

function resolveImageModel(config: ExtensionConfig): string {
	return env("PI_CODEX_IMAGEGEN_IMAGE_MODEL") || config.imageModel || DEFAULT_IMAGE_MODEL;
}

function directCodexEndpoint(baseUrl = DIRECT_CODEX_BASE_URL): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
	const payload = token.split(".")[1];
	if (!payload) throw new Error("Invalid OpenAI Codex OAuth token.");
	const padded = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
	return JSON.parse(Buffer.from(padded, "base64").toString("utf-8")) as Record<string, unknown>;
}

function extractAccountId(token: string): string {
	const payload = decodeJwtPayload(token);
	const auth = payload["https://api.openai.com/auth"] as { chatgpt_account_id?: string } | undefined;
	if (!auth?.chatgpt_account_id) throw new Error("OpenAI Codex token does not include a ChatGPT account id.");
	return auth.chatgpt_account_id;
}

function tryExtractAccountId(token: string | undefined): string | undefined {
	if (!token) return undefined;
	try {
		return extractAccountId(token);
	} catch {
		return undefined;
	}
}

function openAIResponsesEndpoint(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (normalized.endsWith("/responses")) return normalized;
	return `${normalized}/responses`;
}

function normalizeModelId(modelId: string | undefined): string | undefined {
	if (!modelId) return undefined;
	const raw = modelId.trim();
	if (!raw) return undefined;
	return raw.includes("/") ? raw.split("/").pop() : raw;
}

function isGpt5HostModel(modelId: string | undefined): boolean {
	const id = normalizeModelId(modelId)?.toLowerCase();
	if (!id) return false;
	return /^gpt-5(?:\.\d+)?(?:[-_.][a-z0-9]+)*$/.test(id);
}

function buildOpenAICompatibleHeaders(apiKey: string): Headers {
	return new Headers({
		Authorization: `Bearer ${apiKey}`,
		Accept: "text/event-stream",
		"Content-Type": "application/json",
	});
}

function buildCodexHeaders(token: string, accountId: string): Headers {
	const requestId = randomUUID();
	return new Headers({
		Authorization: `Bearer ${token}`,
		"chatgpt-account-id": accountId,
		originator: "pi",
		"User-Agent": `pi-codex-imagegen (${platform()} ${release()}; ${arch()})`,
		"OpenAI-Beta": "responses=experimental",
		Accept: "text/event-stream",
		"Content-Type": "application/json",
		session_id: requestId,
		"x-client-request-id": requestId,
	});
}

async function resolveCurrentProviderTarget(
	config: ExtensionConfig,
	ctx: {
		modelRegistry: { getApiKeyForProvider: (provider: string) => Promise<string | undefined> };
		model?: { id?: string; provider?: string; api?: string; baseUrl?: string };
	},
): Promise<RequestTarget | undefined> {
	const model = ctx.model;
	if (!model?.provider) return undefined;
	if (model.provider !== "openai" && model.provider !== "openai-codex") return undefined;
	if (!isGpt5HostModel(model.id)) return undefined;
	const hostModel = resolveHostModel(config, normalizeModelId(model.id));
	const imageModel = resolveImageModel(config);
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
	if (!apiKey) return undefined;

	if (model.provider === "openai-codex" && model.api === "openai-codex-responses") {
		const accountId = tryExtractAccountId(apiKey);
		if (!accountId) return undefined;
		return {
			mode: "pi-codex",
			label: `current-provider:${model.provider}`,
			endpoint: directCodexEndpoint(model.baseUrl || DIRECT_CODEX_BASE_URL),
			headers: buildCodexHeaders(apiKey, accountId),
			hostModel,
			imageModel,
		};
	}

	if (model.api !== "openai-responses" && model.api !== "openai-completions") return undefined;
	return {
		mode: "openai-compatible",
		label: `current-provider:${model.provider}`,
		endpoint: openAIResponsesEndpoint(model.baseUrl || "https://api.openai.com/v1"),
		headers: buildOpenAICompatibleHeaders(apiKey),
		hostModel,
		imageModel,
	};
}

async function resolveRequestTarget(
	config: ExtensionConfig,
	ctx: {
		modelRegistry: { getApiKeyForProvider: (provider: string) => Promise<string | undefined> };
		model?: { id?: string; provider?: string; api?: string; baseUrl?: string };
	},
): Promise<RequestTarget> {
	const currentProvider = await resolveCurrentProviderTarget(config, ctx);
	if (currentProvider) return currentProvider;
	throw new Error("The current provider/model does not support /imagegen. Switch to an openai or openai-codex gpt-5.x model and try again.");
}

function mimeFromPath(path: string): string {
	const lower = path.toLowerCase();
	const dot = lower.lastIndexOf(".");
	if (dot < 0) return "image/png";
	return MIME_BY_EXT[lower.slice(dot)] || "image/png";
}

function imageExtension(mimeType: string): string {
	const lower = mimeType.toLowerCase();
	if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
	if (lower.includes("webp")) return "webp";
	if (lower.includes("gif")) return "gif";
	return "png";
}

function stripDataUrl(value: string): ParsedImage | undefined {
	const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
	if (!match) return undefined;
	return { mimeType: match[1] || "image/png", data: match[2] || "" };
}

async function referenceToImageUrl(ref: string, cwd: string): Promise<string | undefined> {
	const trimmed = (ref || "").trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("data:image/")) return trimmed;
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;

	const filePath = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
	try {
		const raw = await readFile(filePath);
		const mimeType = mimeFromPath(filePath);
		return `data:${mimeType};base64,${raw.toString("base64")}`;
	} catch {
		return undefined;
	}
}

async function resolveReferenceImages(values: unknown, cwd: string): Promise<string[]> {
	if (!Array.isArray(values)) return [];
	const urls: string[] = [];
	for (const value of values.slice(0, 4)) {
		if (typeof value !== "string") continue;
		const url = await referenceToImageUrl(value, cwd);
		if (url) urls.push(url);
	}
	return urls;
}

function buildInstructions(referenceUrls: string[], intent?: ReferenceIntent): string {
	if (referenceUrls.length > 0 && intent && INTENT_HINTS[intent]) return `${BASE_INSTRUCTIONS}\n\n${INTENT_HINTS[intent]}`;
	return BASE_INSTRUCTIONS;
}

function buildRequestBody(
	params: ToolParams,
	target: RequestTarget,
	quality: Quality,
	aspectRatio: AspectRatio,
	referenceUrls: string[],
	maskUrl: string | undefined,
): { body: Record<string, unknown>; warnings: string[]; maskApplied: boolean; referenceIntent?: ReferenceIntent } {
	const size = SIZE_BY_ASPECT[aspectRatio];
	const warnings: string[] = [];
	const rawIntent = params.referenceIntent;
	const referenceIntent = referenceUrls.length > 0 && oneOf(rawIntent, REFERENCE_INTENTS) ? rawIntent : undefined;
	const content: Array<Record<string, unknown>> = [{ type: "input_text", text: params.prompt }];
	for (const url of referenceUrls) content.push({ type: "input_image", image_url: url });

	const toolSpec: Record<string, unknown> = {
		type: "image_generation",
		model: target.imageModel,
		size,
		quality,
		output_format: "png",
	};
	if (params.transparentBackground) toolSpec.background = "transparent";

	let maskApplied = false;
	if (maskUrl && referenceUrls.length === 1) {
		toolSpec.input_image_mask = { image_url: maskUrl };
		maskApplied = true;
	} else if (maskUrl) {
		warnings.push("maskImage was ignored because it requires exactly one usable reference image.");
	}

	const body = {
		model: target.hostModel,
		store: false,
		stream: true,
		instructions: buildInstructions(referenceUrls, referenceIntent),
		input: [
			{
				type: "message",
				role: "user",
				content,
			},
		],
		tools: [toolSpec],
		tool_choice: {
			type: "allowed_tools",
			mode: "required",
			tools: [{ type: "image_generation" }],
		},
	};
	return { body, warnings, maskApplied, referenceIntent };
}

function extractImageFromPayload(payload: Record<string, unknown>): ParsedImage | undefined {
	const item = payload.item as { type?: string; result?: unknown } | undefined;
	if (item?.type === "image_generation_call" && typeof item.result === "string" && item.result) {
		return stripDataUrl(item.result) || { data: item.result, mimeType: "image/png" };
	}
	if (typeof payload.partial_image_b64 === "string" && payload.partial_image_b64) {
		return stripDataUrl(payload.partial_image_b64) || { data: payload.partial_image_b64, mimeType: "image/png" };
	}
	const response = payload.response as { output?: Array<{ type?: string; result?: unknown }> } | undefined;
	for (const output of response?.output || []) {
		if (output.type === "image_generation_call" && typeof output.result === "string" && output.result) {
			return stripDataUrl(output.result) || { data: output.result, mimeType: "image/png" };
		}
	}
	return undefined;
}

function formatPayloadError(payload: Record<string, unknown>, fallback: string): string {
	const error = payload.error as { message?: string; code?: string; type?: string } | string | undefined;
	if (typeof error === "string") return error;
	if (error?.message) return error.code ? `${error.message} (${error.code})` : error.message;
	return fallback;
}

async function parseResponsesSseForImage(response: Response, signal?: AbortSignal): Promise<ParsedImage> {
	if (!response.body) throw new Error("No response body returned by Codex image endpoint.");

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let eventName = "message";
	let dataLines: string[] = [];
	let image: ParsedImage | undefined;

	const handleEvent = (event: string, data: string): void => {
		if (!data || data === "[DONE]") return;
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(data) as Record<string, unknown>;
		} catch {
			return;
		}
		const type = typeof payload.type === "string" ? payload.type : event;
		if (event === "error" || type === "error" || payload.error) {
			throw new Error(formatPayloadError(payload, "Codex image endpoint returned an error event."));
		}
		const candidate = extractImageFromPayload(payload);
		if (candidate?.data) image = candidate;
	};

	try {
		while (true) {
			if (signal?.aborted) throw new Error("Request was aborted");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (line === "") {
					handleEvent(eventName, dataLines.join("\n"));
					eventName = "message";
					dataLines = [];
					continue;
				}
				if (line.startsWith("event:")) {
					eventName = line.slice(6).trim();
				} else if (line.startsWith("data:")) {
					dataLines.push(line.slice(5).trimStart());
				}
			}
		}
		if (buffer || dataLines.length > 0) handleEvent(eventName, dataLines.concat(buffer).join("\n"));
	} finally {
		reader.releaseLock();
	}

	if (!image?.data) throw new Error("No image_generation_call result was found in the Codex response stream.");
	return image;
}

async function requestImage(target: RequestTarget, body: Record<string, unknown>, signal?: AbortSignal): Promise<ParsedImage> {
	const response = await fetch(target.endpoint, {
		method: "POST",
		headers: target.headers,
		body: JSON.stringify(body),
		signal,
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Image request failed (${response.status}): ${text || response.statusText}`);
	}
	return parseResponsesSseForImage(response, signal);
}

async function saveImage(image: ParsedImage, outputDir: string, imageModel: string, quality: Quality): Promise<string> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const safeModel = imageModel.replace(/[^a-zA-Z0-9_.-]+/g, "-");
	const ext = imageExtension(image.mimeType);
	const filename = `codex-${safeModel}-${quality}-${timestamp}-${randomUUID().slice(0, 8)}.${ext}`;
	const filePath = join(outputDir, filename);
	await withFileMutationQueue(filePath, async () => {
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, Buffer.from(image.data, "base64"));
	});
	return filePath;
}

function buildSummary(details: ToolDetails): string {
	const parts = [
		`Generated image via ${details.providerLabel} using ${details.imageModel}.`,
		`Host model: ${details.hostModel}.`,
		`Size: ${details.size}.`,
		`Quality: ${details.quality}.`,
	];
	if (details.referenceImagesUsed > 0) parts.push(`Reference images used: ${details.referenceImagesUsed}.`);
	if (details.maskApplied) parts.push("Mask applied.");
	if (details.transparentBackground) parts.push("Transparent background requested.");
	if (details.savedPath) parts.push(`Saved image to: ${details.savedPath}`);
	if (details.saveError) parts.push(`Failed to save image: ${details.saveError}`);
	if (details.warnings?.length) parts.push(`Warnings: ${details.warnings.join(" ")}`);
	return parts.join(" ");
}

async function generateCodexImage(
	params: ToolParams,
	ctx: GenerationContext,
	signal?: AbortSignal,
	onProgress?: ProgressCallback,
): Promise<GenerationResult> {
	const prompt = (params.prompt || "").trim();
	if (!prompt) throw new Error("prompt is required.");

	const config = loadConfig(ctx.cwd);
	const quality = resolveQuality(params, config);
	const aspectRatio = resolveAspect(params.aspectRatio);
	const saveConfig = resolveSaveConfig(params, config, ctx.cwd);
	const target = await resolveRequestTarget(config, ctx);
	const referenceUrls = await resolveReferenceImages(params.referenceImages, ctx.cwd);
	const maskUrl = typeof params.maskImage === "string" ? await referenceToImageUrl(params.maskImage, ctx.cwd) : undefined;
	const request = buildRequestBody(params, target, quality, aspectRatio, referenceUrls, maskUrl);
	const size = SIZE_BY_ASPECT[aspectRatio];

	onProgress?.(`Requesting ${target.imageModel} via ${target.label} (${size}, ${quality})...`, {
		providerMode: target.mode,
		providerLabel: target.label,
		hostModel: target.hostModel,
		imageModel: target.imageModel,
		size,
		quality,
	});

	const image = await requestImage(target, request.body, signal);
	let savedPath: string | undefined;
	let saveError: string | undefined;
	if (saveConfig.mode !== "none" && saveConfig.outputDir) {
		try {
			savedPath = await saveImage(image, saveConfig.outputDir, target.imageModel, quality);
		} catch (error) {
			saveError = error instanceof Error ? error.message : String(error);
		}
	}

	const details: ToolDetails = {
		provider: "codex-imagegen",
		providerMode: target.mode,
		providerLabel: target.label,
		hostModel: target.hostModel,
		imageModel: target.imageModel,
		quality,
		size,
		aspectRatio,
		saveMode: saveConfig.mode,
		savedPath,
		saveError,
		referenceImagesUsed: referenceUrls.length,
		referenceIntent: request.referenceIntent,
		transparentBackground: params.transparentBackground ? true : undefined,
		maskApplied: request.maskApplied || undefined,
		warnings: request.warnings.length > 0 ? request.warnings : undefined,
	};

	return { image, details, summary: buildSummary(details) };
}

function splitCommandArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaping = false;
	for (const ch of input) {
		if (escaping) {
			current += ch;
			escaping = false;
			continue;
		}
		if (ch === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

function imagegenCommandWantsHelp(args: string): boolean {
	const tokens = splitCommandArgs(args || "");
	return tokens.includes("--help") || tokens.includes("-h");
}

function buildImagegenAgentPrompt(rawRequest: string): string {
	return [
		"Handle this /imagegen request by calling the codex_image_generate tool.",
		"Decide the best aspectRatio, quality, referenceIntent, transparentBackground, maskImage, and save settings from the user's wording.",
		"Use save=project by default so the file is written to <cwd>/.pi/generated-images/. Use save=none only if the user clearly asks for preview-only output.",
		"Do not ask about auth and do not set auth parameters; codex_image_generate only supports the current provider when it is openai/openai-codex on a gpt-5.x model.",
		"If the current provider/model is unsupported, tell the user to switch to an openai or openai-codex gpt-5.x model.",
		"User image request:",
		rawRequest,
	].join("\n");
}

function imagegenUsage(): string {
	return [
		"Usage: /imagegen [options] <prompt>",
		"",
		"Options:",
		"  --square | --landscape | --portrait",
		"  --low | --medium | --high | --auto",
		"  --save none|project|global|custom   (command default: project)",
		"  --dir <path>                         custom save directory",
		"  --ref <path-or-url>                  add reference image (repeatable)",
		"  --intent edit|style_reference|subject_reference|compose",
		"  --mask <path-or-url>                 inpainting mask with one reference",
		"  --transparent                        request transparent PNG background",
		"",
		"Example: /imagegen --square --high a cute capybara in a hot spring, cozy illustration, no text",
	].join("\n");
}

export default function codexImageGen(pi: ExtensionAPI) {
	pi.registerTool({
		name: "codex_image_generate",
		label: "Codex Image Generate",
		description:
			"Generate or edit a raster image with gpt-image-2 through Codex Responses image_generation. Supports reference images, optional masks, transparent-background requests, and saving to disk.",
		promptSnippet: "Generate or edit raster images with Codex gpt-image-2.",
		promptGuidelines: [
			"Use codex_image_generate when the user asks to generate a photo, illustration, product mockup, concept art, or other bitmap image asset.",
			"Use codex_image_generate instead of creating SVG placeholders when the user asks for AI-generated raster artwork.",
			"Pass referenceImages to codex_image_generate when the request depends on an existing local image path or image URL.",
		],
		parameters: TOOL_PARAMS,
		async execute(_toolCallId, params: ToolParams, signal, onUpdate, ctx) {
			const result = await generateCodexImage(params, ctx, signal, (message, details) => {
				onUpdate?.({ content: [{ type: "text", text: message }], details });
			});

			return {
				content: [
					{ type: "text", text: result.summary },
					{ type: "image", data: result.image.data, mimeType: result.image.mimeType },
				],
				details: result.details,
			};
		},
	});

	pi.registerCommand("imagegen", {
		description: "Ask the agent to generate an image with Codex gpt-image-2. Usage: /imagegen [options] <prompt>",
		handler: async (args, ctx) => {
			if (imagegenCommandWantsHelp(args)) {
				pi.sendMessage({ customType: "imagegen", content: imagegenUsage(), display: true, details: { usage: true } });
				return;
			}

			let request = (args || "").trim();
			if (!request && ctx.hasUI) {
				const prompt = await ctx.ui.editor("Image prompt", "A cute capybara relaxing in a warm hot spring, cozy digital illustration, no text");
				request = (prompt || "").trim();
			}
			if (!request) {
				pi.sendMessage({ customType: "imagegen", content: imagegenUsage(), display: true, details: { usage: true } });
				return;
			}

			pi.sendUserMessage(buildImagegenAgentPrompt(request), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		},
	});
}
