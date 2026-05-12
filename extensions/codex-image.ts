import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
	createReadTool,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

const STATUS_KEY = "codex-image";
const STATUS_TEXT = "Codex image";
const IMAGE_GENERATION_TOOL_NAME = "image_generation";
const VIEW_IMAGE_TOOL_NAME = "view_image";
const CODEX_IMAGE_TOOL_NAMES = [IMAGE_GENERATION_TOOL_NAME, VIEW_IMAGE_TOOL_NAME];
const IMAGE_GENERATION_UNSUPPORTED_MESSAGE = "image_generation is only available with image-capable openai-codex models";
const IMAGE_GENERATION_LOCAL_EXECUTION_MESSAGE = "image_generation is a native openai-codex provider tool and should not execute locally";
const VIEW_IMAGE_UNSUPPORTED_MESSAGE = "view_image is not allowed because the current model does not support image inputs";
const DETAIL_DESCRIPTION = "Use `original` to preserve the file's original resolution; omit for default resized behavior.";

const IMAGE_GENERATION_PARAMETERS = Type.Unsafe<Record<string, never>>({
	type: "object",
	additionalProperties: false,
});

interface ExtensionState {
	enabled: boolean;
	previousToolNames?: string[];
}

interface FunctionToolPayload {
	type?: unknown;
	name?: unknown;
}

interface ResponsesPayload {
	tools?: unknown[];
	[key: string]: unknown;
}

interface ResponsesImageGenerationTool {
	type: "image_generation";
	output_format: "png";
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
	return isOpenAICodexModel(model) && supportsImageInputs(model);
}

function supportsOriginalImageDetail(model: ExtensionContext["model"]): boolean {
	const provider = (model?.provider ?? "").toLowerCase();
	const api = (model?.api ?? "").toLowerCase();
	const id = (model?.id ?? "").toLowerCase();
	return supportsImageInputs(model) && (provider.includes("codex") || api.includes("codex") || id.includes("codex"));
}

function isImageGenerationFunctionTool(tool: unknown): tool is FunctionToolPayload {
	return !!tool && typeof tool === "object" && (tool as FunctionToolPayload).type === "function" && (tool as FunctionToolPayload).name === IMAGE_GENERATION_TOOL_NAME;
}

function rewriteNativeImageGenerationTool(payload: unknown, model: ExtensionContext["model"]): unknown {
	if (!supportsNativeImageGeneration(model) || !payload || typeof payload !== "object") return payload;
	const tools = (payload as ResponsesPayload).tools;
	if (!Array.isArray(tools)) return payload;

	let rewritten = false;
	const nextTools = tools.map((tool) => {
		if (!isImageGenerationFunctionTool(tool)) return tool;
		rewritten = true;
		const nativeTool: ResponsesImageGenerationTool = { type: "image_generation", output_format: "png" };
		return nativeTool;
	});

	return rewritten ? { ...(payload as ResponsesPayload), tools: nextTools } : payload;
}

function createImageGenerationTool(): ToolDefinition<typeof IMAGE_GENERATION_PARAMETERS> {
	const description =
		"Generate an image. Outputs are saved under `.pi/openai-codex-images/` and mirrored to `.pi/openai-codex-images/latest.png`.";
	return {
		name: IMAGE_GENERATION_TOOL_NAME,
		label: IMAGE_GENERATION_TOOL_NAME,
		description,
		promptSnippet: description,
		parameters: IMAGE_GENERATION_PARAMETERS,
		prepareArguments: () => ({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!supportsNativeImageGeneration(ctx.model)) throw new Error(IMAGE_GENERATION_UNSUPPORTED_MESSAGE);
			throw new Error(IMAGE_GENERATION_LOCAL_EXECUTION_MESSAGE);
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

	pi.on("before_provider_request", async (event, ctx) => {
		return rewriteNativeImageGenerationTool(event.payload, ctx.model);
	});
}
