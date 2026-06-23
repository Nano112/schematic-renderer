export const DEFAULT_NAMESPACE = "minecraft";

export type AssetDirectory = "textures" | "blockstates" | "models";
export type AssetType = "texture" | "blockstate" | "model";

export interface ResourceLocation {
	namespace: string;
	path: string;
}

export interface PackAssetReference extends ResourceLocation {
	type: AssetType;
	directory: AssetDirectory;
}

const assetTypeToDirectory: Record<AssetType, AssetDirectory> = {
	texture: "textures",
	blockstate: "blockstates",
	model: "models",
};

const assetDirectoryToType: Record<AssetDirectory, AssetType> = {
	textures: "texture",
	blockstates: "blockstate",
	models: "model",
};

const assetTypeExtension: Record<AssetType, string> = {
	texture: ".png",
	blockstate: ".json",
	model: ".json",
};

function stripLeadingSlashes(value: string): string {
	return value.replace(/^\/+/, "");
}

export function parseResourceLocation(
	value: string,
	defaultNamespace: string = DEFAULT_NAMESPACE
): ResourceLocation {
	const trimmed = value.trim();
	const colonIndex = trimmed.indexOf(":");

	if (colonIndex >= 0) {
		const namespace = trimmed.slice(0, colonIndex) || defaultNamespace;
		const path = stripLeadingSlashes(trimmed.slice(colonIndex + 1));

		return { namespace, path };
	}

	return {
		namespace: defaultNamespace,
		path: stripLeadingSlashes(trimmed),
	};
}

export function formatResourceLocation(
	location: ResourceLocation,
	options: { omitDefaultNamespace?: boolean } = {}
): string {
	if (options.omitDefaultNamespace && location.namespace === DEFAULT_NAMESPACE) {
		return location.path;
	}

	return `${location.namespace}:${location.path}`;
}

export function normalizeResourceLocation(
	value: string,
	options: { omitDefaultNamespace?: boolean } = {}
): string {
	return formatResourceLocation(parseResourceLocation(value), options);
}

function isAssetDirectory(value: string): value is AssetDirectory {
	return value === "textures" || value === "blockstates" || value === "models";
}

export function resolveAssetFilePath(path: string): string {
	const normalizedPath = path.replace(/\\/g, "/").replace(/^\/+/, "");

	if (normalizedPath.startsWith("assets/")) {
		return normalizedPath;
	}

	const slashIndex = normalizedPath.indexOf("/");

	if (slashIndex === -1) {
		return `assets/${DEFAULT_NAMESPACE}/${normalizedPath}`;
	}

	const directory = normalizedPath.slice(0, slashIndex);
	const resourcePath = normalizedPath.slice(slashIndex + 1);

	if (!isAssetDirectory(directory)) {
		return `assets/${DEFAULT_NAMESPACE}/${normalizedPath}`;
	}

	const location = parseResourceLocation(resourcePath);

	return `assets/${location.namespace}/${directory}/${location.path}`;
}

export function packPathForAsset(assetPath: string, type: AssetType): string {
	const location = parseResourceLocation(assetPath);
	const directory = assetTypeToDirectory[type];
	const extension = assetTypeExtension[type];

	return `assets/${location.namespace}/${directory}/${location.path}${extension}`;
}

export function packAssetFromFilePath(filePath: string): PackAssetReference | null {
	const normalizedPath = filePath.replace(/\\/g, "/");
	const match = normalizedPath.match(/^assets\/([^/]+)\/(textures|blockstates|models)\/(.+)$/);

	if (!match) {
		return null;
	}

	const [, namespace, directory, rawPath] = match as [string, string, AssetDirectory, string];
	const type = assetDirectoryToType[directory];
	const extension = assetTypeExtension[type];

	if (!rawPath.endsWith(extension)) {
		return null;
	}

	return {
		namespace,
		directory,
		type,
		path: rawPath.slice(0, -extension.length),
	};
}

export function formatPackAssetReference(
	asset: Pick<PackAssetReference, "namespace" | "path">,
	options: { omitDefaultNamespace?: boolean } = { omitDefaultNamespace: true }
): string {
	return formatResourceLocation(asset, options);
}
