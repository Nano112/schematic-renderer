import {
	BoxGeometry,
	DoubleSide,
	Group,
	InstancedMesh,
	LinearSRGBColorSpace,
	Matrix4,
	MeshLambertMaterial,
	NearestFilter,
	Quaternion,
	StaticDrawUsage,
	Texture,
	Vector3,
} from "three";

import type {
	BlockEntitySchematic,
	IndexedBlockEntity,
	SchematicBlockEntitySnapshot,
	SchematicBlockEntityWrapper,
} from "../snapshot.js";
import { captureSchematicBlockEntitySnapshot, parseIndexedBlockEntity } from "../snapshot.js";
const HEAD_TEXTURE_PATH_PATTERN = /^\/texture\/([a-f0-9]{32,64})$/i;
const PROFILE_UUID_PATTERN =
	/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9_]{1,16}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const LEGACY_TEXTURE_PAYLOAD_PATTERN =
	/^\s*\{\s*(?:"textures"|textures)\s*:\s*\{\s*(?:"SKIN"|SKIN)\s*:\s*\{\s*(?:"url"|url)\s*:\s*"([^"\\]{1,2048})"\s*\}\s*\}\s*\}\s*$/;
const MAX_HEAD_TEXTURE_BYTES = 2 * 1024 * 1024;
const MAX_TEXTURE_PROPERTY_LENGTH = 8_192;
const MAX_TEXTURE_PROPERTY_BYTES = 6_144;
const MAX_PROFILE_PROPERTIES_INSPECTED = 32;
const DEFAULT_HEAD_TEXTURE_KEY = "default";

export const MAX_CUSTOM_PLAYER_HEADS = 256;
export const MAX_CUSTOM_HEAD_TEXTURES = 64;
export const MAX_CUSTOM_HEAD_ENTITIES_INSPECTED = 1_024;
export const MAX_CUSTOM_HEAD_BLOCKS_INSPECTED = 750_000;
export const CUSTOM_HEAD_TEXTURE_CONCURRENCY = 4;
export const CUSTOM_HEAD_TEXTURE_LOAD_BUDGET_MS = 12_000;

type UnknownRecord = Record<string, unknown>;
type Position = readonly [number, number, number];
const FALLBACK_HEAD_MATERIAL_KEY = "schematic-renderer:fallback-player-head";

export type PlayerHeadCandidate = {
	position: Position;
	textureHash: string | null;
	profileIdentifier: string | null;
	profileFallbackIdentifier: string | null;
};

export type HeadBlockState = {
	name: string;
	properties: Record<string, string>;
};

export type CustomPlayerHead = PlayerHeadCandidate & {
	rotationY: number;
	offset: Position;
};

export type CustomPlayerHeadOverlay = {
	count: number;
	dispose: () => void;
};

type HeadSchematicWrapper = SchematicBlockEntityWrapper;

type LoadedTexture = {
	texture: Texture;
	legacyLayout: boolean;
	closeImage: () => void;
};

type HeadTextureRequest = {
	key: string;
	reference: PlayerHeadTextureReference;
	resolver: PlayerHeadTextureResolver;
	description: string;
};

export type PlayerHeadTextureReference =
	| { kind: "default" }
	| { kind: "texture-hash"; textureHash: string }
	| {
			kind: "profile";
			identifier: string;
			fallbackIdentifier: string | null;
	  };

export type PlayerHeadTextureResolver = (
	reference: PlayerHeadTextureReference,
	context: {
		signal: AbortSignal;
		maxBytes: number;
	}
) => Promise<Blob | null>;

export type CustomPlayerHeadRendererOptions = {
	/**
	 * Application-owned resolver for Mojang textures/profiles and the default
	 * skin. The renderer never contacts a hard-coded service.
	 */
	resolveTexture?: PlayerHeadTextureResolver;
};

type MaterialPair = {
	base: MeshLambertMaterial;
	hat: MeshLambertMaterial | null;
};

const BASE_UV_RECTS = [
	[16, 8, 24, 16], // +X, player's left
	[0, 8, 8, 16], // -X, player's right
	[8, 0, 16, 8], // +Y, top
	[16, 0, 24, 8], // -Y, bottom
	[8, 8, 16, 16], // +Z, front
	[24, 8, 32, 16], // -Z, back
] as const;

const HAT_UV_RECTS = [
	[48, 8, 56, 16],
	[32, 8, 40, 16],
	[40, 0, 48, 8],
	[48, 0, 56, 8],
	[40, 8, 48, 16],
	[56, 8, 64, 16],
] as const;

function asRecord(value: unknown): UnknownRecord | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	return value as UnknownRecord;
}

function samePosition(first: Position, second: Position) {
	return first[0] === second[0] && first[1] === second[1] && first[2] === second[2];
}

function firstValue(record: UnknownRecord, ...keys: string[]) {
	for (const key of keys) {
		if (record[key] !== undefined) return record[key];
	}
	return undefined;
}

function firstRecord(record: UnknownRecord, ...keys: string[]) {
	return asRecord(firstValue(record, ...keys));
}

function firstString(record: UnknownRecord, ...keys: string[]) {
	const value = firstValue(record, ...keys);
	return typeof value === "string" ? value : null;
}

function textureUrlFromPropertyPayload(payload: string): string | null {
	try {
		const parsed = asRecord(JSON.parse(payload));
		const textures = parsed === null ? null : asRecord(parsed.textures);
		const skin = textures === null ? null : asRecord(textures.SKIN);
		return skin !== null && typeof skin.url === "string" ? skin.url : null;
	} catch {
		// Some older custom-head generators encoded Mojangson-like unquoted
		// `textures` and `SKIN` keys rather than JSON. Accept only that exact,
		// bounded shape; URL validation below remains identical.
		return LEGACY_TEXTURE_PAYLOAD_PATTERN.exec(payload)?.[1] ?? null;
	}
}

function textureHashFromPropertyValue(value: unknown): string | null {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_TEXTURE_PROPERTY_LENGTH ||
		value.length % 4 === 1 ||
		!BASE64_PATTERN.test(value)
	) {
		return null;
	}

	try {
		const binary = globalThis.atob(value);
		if (binary.length === 0 || binary.length > MAX_TEXTURE_PROPERTY_BYTES) return null;
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		const rawUrl = textureUrlFromPropertyPayload(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes)
		);
		if (rawUrl === null) return null;

		const url = new URL(rawUrl);
		if (
			(url.protocol !== "http:" && url.protocol !== "https:") ||
			url.hostname !== "textures.minecraft.net" ||
			url.username !== "" ||
			url.password !== "" ||
			url.port !== "" ||
			url.search !== "" ||
			url.hash !== ""
		) {
			return null;
		}
		const path = HEAD_TEXTURE_PATH_PATTERN.exec(url.pathname);
		return path?.[1]?.toLowerCase() ?? null;
	} catch {
		return null;
	}
}

function textureHashFromPropertyList(value: unknown, requireName: boolean): string | null {
	if (!Array.isArray(value)) return null;
	const inspected = Math.min(value.length, MAX_PROFILE_PROPERTIES_INSPECTED);
	for (let index = 0; index < inspected; index += 1) {
		const property = asRecord(value[index]);
		if (property === null) continue;
		if (requireName) {
			const name = firstString(property, "name", "Name");
			if (name?.toLowerCase() !== "textures") continue;
		}
		const hash = textureHashFromPropertyValue(firstValue(property, "value", "Value"));
		if (hash !== null) return hash;
	}
	return null;
}

function textureHashFromProperties(value: unknown): string | null {
	if (Array.isArray(value)) return textureHashFromPropertyList(value, true);
	const properties = asRecord(value);
	if (properties === null) return null;
	return textureHashFromPropertyList(firstValue(properties, "textures", "Textures"), false);
}

function textureHashFromRawData(data: UnknownRecord): string | null {
	const owner = firstRecord(data, "SkullOwner", "skull_owner", "skullOwner", "Owner", "owner");
	if (owner !== null) {
		const legacy = textureHashFromProperties(firstValue(owner, "Properties", "properties"));
		if (legacy !== null) return legacy;
	}

	const profile = firstRecord(data, "profile", "Profile");
	return profile === null
		? null
		: textureHashFromProperties(firstValue(profile, "properties", "Properties"));
}

function textureHashFromRawNbt(nbt: UnknownRecord): string | null {
	const wrappedData = firstRecord(nbt, "Data", "data");
	if (wrappedData !== null) {
		const wrapped = textureHashFromRawData(wrappedData);
		if (wrapped !== null) return wrapped;
	}
	return textureHashFromRawData(nbt);
}

function profileUuid(value: unknown): string | null {
	if (typeof value === "string") {
		return PROFILE_UUID_PATTERN.test(value) ? value.replace(/-/g, "").toLowerCase() : null;
	}
	const parts = Array.isArray(value)
		? value
		: ArrayBuffer.isView(value)
			? Array.from(value as unknown as ArrayLike<number>)
			: null;
	if (
		parts === null ||
		parts.length !== 4 ||
		parts.some(
			(part) => !Number.isInteger(part) || Number(part) < -0x8000_0000 || Number(part) > 0xffff_ffff
		)
	) {
		return null;
	}
	return parts.map((part) => (Number(part) >>> 0).toString(16).padStart(8, "0")).join("");
}

function profileName(value: unknown): string | null {
	return typeof value === "string" && PROFILE_NAME_PATTERN.test(value) ? value : null;
}

type ProfileIdentifiers = {
	uuid: string | null;
	name: string | null;
};

function identifiersFromProfile(value: unknown): ProfileIdentifiers {
	if (typeof value === "string") {
		return { uuid: profileUuid(value), name: profileName(value) };
	}
	const profile = asRecord(value);
	if (profile === null) return { uuid: null, name: null };
	return {
		uuid: profileUuid(firstValue(profile, "id", "Id", "uuid", "UUID")),
		name: profileName(firstValue(profile, "name", "Name")),
	};
}

function profileIdentifiersFromRawData(data: UnknownRecord): ProfileIdentifiers[] {
	return [
		identifiersFromProfile(
			firstValue(data, "SkullOwner", "skull_owner", "skullOwner", "Owner", "owner")
		),
		identifiersFromProfile(firstValue(data, "profile", "Profile")),
	];
}

type ProfileReference = {
	identifier: string | null;
	fallbackIdentifier: string | null;
};

function profileReferenceFromRawNbt(nbt: UnknownRecord): ProfileReference {
	const wrappedData = firstRecord(nbt, "Data", "data");
	const identifiers = [
		...(wrappedData === null ? [] : profileIdentifiersFromRawData(wrappedData)),
		...profileIdentifiersFromRawData(nbt),
	];
	const uuid = identifiers.find((entry) => entry.uuid !== null)?.uuid ?? null;
	const name = identifiers.find((entry) => entry.name !== null)?.name ?? null;
	return uuid === null
		? { identifier: name, fallbackIdentifier: null }
		: { identifier: uuid, fallbackIdentifier: name };
}

function parseIndexedPlayerHeadCandidate(entity: IndexedBlockEntity): PlayerHeadCandidate | null {
	if (entity.position === null) return null;
	const textureHash = textureHashFromRawNbt(entity.nbt);
	const profile =
		textureHash === null
			? profileReferenceFromRawNbt(entity.nbt)
			: { identifier: null, fallbackIdentifier: null };
	return {
		position: entity.position,
		textureHash,
		profileIdentifier: profile.identifier,
		profileFallbackIdentifier: profile.fallbackIdentifier,
	};
}

export function resolveCustomPlayerHead(
	head: PlayerHeadCandidate,
	block: HeadBlockState | null
): CustomPlayerHead | null {
	if (block?.name === "minecraft:player_head") {
		const parsedRotation = Number(block.properties.rotation);
		const rotation =
			Number.isInteger(parsedRotation) && parsedRotation >= 0 && parsedRotation <= 15
				? parsedRotation
				: 0;
		return {
			...head,
			// Cubane centers every block at its integer coordinate. Minecraft model
			// coordinates use a 0..1 cell, so the standing head center
			// (0.5, 0.25, 0.5) becomes (0, -0.25, 0).
			offset: [0, -0.25, 0],
			rotationY: (-rotation * Math.PI) / 8,
		};
	}

	if (block?.name !== "minecraft:player_wall_head") return null;
	switch (block.properties.facing) {
		case "north":
			return { ...head, offset: [0, 0, 0.25], rotationY: Math.PI };
		case "south":
			return { ...head, offset: [0, 0, -0.25], rotationY: 0 };
		case "west":
			return { ...head, offset: [0.25, 0, 0], rotationY: -Math.PI / 2 };
		case "east":
			return { ...head, offset: [-0.25, 0, 0], rotationY: Math.PI / 2 };
		default:
			return null;
	}
}

function textureKeyForHead(
	head: Pick<PlayerHeadCandidate, "textureHash" | "profileIdentifier" | "profileFallbackIdentifier">
): string | null {
	if (head.textureHash !== null) return `hash:${head.textureHash}`;
	return head.profileIdentifier === null ? null : `profile:${head.profileIdentifier.toLowerCase()}`;
}

function textureRequestForHead(
	head: Pick<
		PlayerHeadCandidate,
		"textureHash" | "profileIdentifier" | "profileFallbackIdentifier"
	>,
	resolver: PlayerHeadTextureResolver
): HeadTextureRequest | null {
	if (head.textureHash !== null) {
		return {
			key: `hash:${head.textureHash}`,
			reference: { kind: "texture-hash", textureHash: head.textureHash },
			resolver,
			description: head.textureHash,
		};
	}
	if (head.profileIdentifier !== null) {
		return {
			key: `profile:${head.profileIdentifier.toLowerCase()}`,
			reference: {
				kind: "profile",
				identifier: head.profileIdentifier,
				fallbackIdentifier: head.profileFallbackIdentifier,
			},
			resolver,
			description: head.profileIdentifier,
		};
	}
	return null;
}

export function selectCustomPlayerHeads(
	entities: unknown,
	getBlockState: (position: Position) => HeadBlockState | null
): CustomPlayerHead[] {
	if (!Array.isArray(entities)) return [];
	const indexedEntities: IndexedBlockEntity[] = [];
	const inspectionCount = Math.min(entities.length, MAX_CUSTOM_HEAD_ENTITIES_INSPECTED);
	for (let index = 0; index < inspectionCount; index += 1) {
		const entity = parseIndexedBlockEntity(entities[index]);
		if (entity !== null) indexedEntities.push(entity);
	}
	return selectIndexedCustomPlayerHeads(indexedEntities, getBlockState);
}

function selectIndexedCustomPlayerHeads(
	entities: readonly IndexedBlockEntity[],
	getBlockState: (position: Position) => HeadBlockState | null
): CustomPlayerHead[] {
	const heads: CustomPlayerHead[] = [];
	const positions = new Set<string>();
	const textureRequests = new Set<string>();
	const inspectionCount = Math.min(entities.length, MAX_CUSTOM_HEAD_ENTITIES_INSPECTED);

	for (let index = 0; index < inspectionCount && heads.length < MAX_CUSTOM_PLAYER_HEADS; index++) {
		const entity = entities[index];
		if (entity === undefined) continue;
		const parsedCandidate = parseIndexedPlayerHeadCandidate(entity);
		if (parsedCandidate === null) continue;

		const positionKey = parsedCandidate.position.join(",");
		if (positions.has(positionKey)) continue;
		let candidate = parsedCandidate;
		let requestKey = textureKeyForHead(candidate);
		if (
			requestKey !== null &&
			!textureRequests.has(requestKey) &&
			textureRequests.size >= MAX_CUSTOM_HEAD_TEXTURES
		) {
			candidate = {
				...candidate,
				textureHash: null,
				profileIdentifier: null,
				profileFallbackIdentifier: null,
			};
			requestKey = null;
		}

		const head = resolveCustomPlayerHead(candidate, getBlockState(candidate.position));
		if (head === null) continue;
		positions.add(positionKey);
		if (requestKey !== null) textureRequests.add(requestKey);
		heads.push(head);
	}

	return heads;
}

/**
 * Finds heads from block positions first, then joins block-entity NBT by position.
 * This avoids relying on Schem-at's batch block-entity path, which can omit NBT
 * from chunk meshes. Missing NBT or resolver data keeps a bounded fallback
 * material, so an unavailable skin never removes the block.
 */
export function selectCustomPlayerHeadsFromSchematic(
	wrapper: HeadSchematicWrapper,
	snapshot?: SchematicBlockEntitySnapshot
): CustomPlayerHead[] {
	const normalizedSnapshot =
		snapshot ??
		captureSchematicBlockEntitySnapshot(wrapper, {
			onReadError: (label, error) => {
				console.warn(`[schematic-renderer] Player head ${label.toLowerCase()} scan failed.`, error);
			},
		});
	const headBlocks = [
		...(normalizedSnapshot.blocksByName.get("minecraft:player_head") ?? []),
		...(normalizedSnapshot.blocksByName.get("minecraft:player_wall_head") ?? []),
	];
	if (headBlocks.length === 0) {
		return selectIndexedCustomPlayerHeads(normalizedSnapshot.indexedEntities, (position) =>
			readBlockState(wrapper, position)
		);
	}

	const heads: CustomPlayerHead[] = [];
	const positions = new Set<string>();
	const textureRequests = new Set<string>();
	const inspectionCount = Math.min(headBlocks.length, MAX_CUSTOM_HEAD_BLOCKS_INSPECTED);
	let inspectedEntities = 0;

	for (let index = 0; index < inspectionCount && heads.length < MAX_CUSTOM_PLAYER_HEADS; index++) {
		const block = headBlocks[index];
		if (block === undefined) continue;
		const state = normalizedSnapshot.paletteStates[block.paletteIndex];
		if (state === null || state === undefined) continue;

		const position = block.position;
		const positionKey = position.join(",");
		if (positions.has(positionKey)) continue;

		let candidate: PlayerHeadCandidate | undefined;
		const entitiesAtPosition = normalizedSnapshot.entitiesByPosition.get(positionKey) ?? [];
		for (const entity of entitiesAtPosition) {
			if (inspectedEntities >= MAX_CUSTOM_HEAD_ENTITIES_INSPECTED) break;
			inspectedEntities += 1;
			const parsed = parseIndexedPlayerHeadCandidate(entity);
			if (parsed === null) continue;
			if (
				candidate === undefined ||
				(candidate.textureHash === null &&
					(parsed.textureHash !== null || candidate.profileIdentifier === null))
			) {
				candidate = parsed;
			}
		}
		if (candidate === undefined || candidate.textureHash === null) {
			try {
				const directEntity = parseIndexedBlockEntity(
					wrapper.get_block_entity?.(position[0], position[1], position[2])
				);
				const direct = directEntity === null ? null : parseIndexedPlayerHeadCandidate(directEntity);
				if (direct !== null && samePosition(direct.position, position)) {
					candidate =
						direct.textureHash !== null ||
						(candidate?.profileIdentifier === null && direct.profileIdentifier !== null) ||
						candidate === undefined
							? direct
							: candidate;
				}
			} catch {
				// Batch NBT or the bundled player-skin fallback still renders this head.
			}
		}

		let textureHash = candidate?.textureHash ?? null;
		let profileIdentifier = textureHash === null ? (candidate?.profileIdentifier ?? null) : null;
		let profileFallbackIdentifier =
			profileIdentifier === null ? null : (candidate?.profileFallbackIdentifier ?? null);
		let requestKey = textureKeyForHead({
			textureHash,
			profileIdentifier,
			profileFallbackIdentifier,
		});
		if (
			requestKey !== null &&
			!textureRequests.has(requestKey) &&
			textureRequests.size >= MAX_CUSTOM_HEAD_TEXTURES
		) {
			textureHash = null;
			profileIdentifier = null;
			profileFallbackIdentifier = null;
			requestKey = null;
		}
		const head = resolveCustomPlayerHead(
			{
				position,
				textureHash,
				profileIdentifier,
				profileFallbackIdentifier,
			},
			state
		);
		if (head === null) continue;

		positions.add(positionKey);
		if (requestKey !== null) textureRequests.add(requestKey);
		heads.push(head);
	}

	return heads;
}

function applySkinUvs(geometry: BoxGeometry, hatLayer: boolean, legacyLayout: boolean) {
	const rectangles = hatLayer ? HAT_UV_RECTS : BASE_UV_RECTS;
	const uv = geometry.getAttribute("uv");
	const textureHeight = legacyLayout ? 32 : 64;

	rectangles.forEach(([left, top, right, bottom], faceIndex) => {
		const vertex = faceIndex * 4;
		const u0 = left / 64;
		const u1 = right / 64;
		const v0 = 1 - top / textureHeight;
		const v1 = 1 - bottom / textureHeight;
		// BoxGeometry's -Y plane is wound in the opposite vertical direction.
		const firstV = faceIndex === 3 ? v1 : v0;
		const secondV = faceIndex === 3 ? v0 : v1;
		uv.setXY(vertex, u0, firstV);
		uv.setXY(vertex + 1, u1, firstV);
		uv.setXY(vertex + 2, u0, secondV);
		uv.setXY(vertex + 3, u1, secondV);
	});
	uv.needsUpdate = true;
}

export function createMinecraftHeadGeometry(hatLayer = false, legacyLayout = false): BoxGeometry {
	const size = hatLayer ? 9 / 16 : 0.5;
	const geometry = new BoxGeometry(size, size, size);
	applySkinUvs(geometry, hatLayer, legacyLayout);
	return geometry;
}

function validSkinDimensions(width: number, height: number) {
	return (
		width >= 64 && width <= 1024 && width % 64 === 0 && (height === width || height * 2 === width)
	);
}

/**
 * Mirrors Minecraft's "Notch transparency hack" for legacy skins. If the
 * legacy-only right half has no meaningful alpha, Minecraft treats that whole
 * half as transparent. Without this conversion, old skins such as Notch's
 * render their opaque black headwear matte as a cube around the real head.
 */
export function applyLegacyNotchTransparencyHack(
	pixels: Uint8ClampedArray,
	width: number,
	height: number
) {
	if (
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width < 64 ||
		width % 64 !== 0 ||
		height * 2 !== width ||
		pixels.length !== width * height * 4
	) {
		return false;
	}

	const startX = width / 2;
	for (let y = 0; y < height; y += 1) {
		for (let x = startX; x < width; x += 1) {
			const alphaOffset = (y * width + x) * 4 + 3;
			const alpha = pixels[alphaOffset];
			if (alpha !== undefined && alpha < 128) {
				return false;
			}
		}
	}

	for (let y = 0; y < height; y += 1) {
		for (let x = startX; x < width; x += 1) {
			pixels[(y * width + x) * 4 + 3] = 0;
		}
	}
	return true;
}

type SkinImage = ImageBitmap | HTMLImageElement;
type SkinCanvas = OffscreenCanvas | HTMLCanvasElement;
type SkinCanvasContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function createSkinCanvas(
	width: number,
	height: number
): { canvas: SkinCanvas; context: SkinCanvasContext } | null {
	try {
		if (typeof OffscreenCanvas !== "undefined") {
			const canvas = new OffscreenCanvas(width, height);
			const context = canvas.getContext("2d", { willReadFrequently: true });
			if (context !== null) return { canvas, context };
		}
	} catch {
		// Fall through to the DOM canvas implementation.
	}
	try {
		if (typeof document !== "undefined") {
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext("2d", { willReadFrequently: true });
			if (context !== null) return { canvas, context };
		}
	} catch {
		// The original decoded image remains a valid texture fallback.
	}
	return null;
}

function normalizeLegacySkinSource(image: SkinImage): SkinImage | SkinCanvas {
	const surface = createSkinCanvas(image.width, image.height);
	if (surface === null) return image;

	try {
		surface.context.imageSmoothingEnabled = false;
		surface.context.drawImage(image, 0, 0);
		const imageData = surface.context.getImageData(0, 0, image.width, image.height);
		if (!applyLegacyNotchTransparencyHack(imageData.data, image.width, image.height)) {
			return image;
		}
		surface.context.putImageData(imageData, 0, 0);
		return surface.canvas;
	} catch {
		return image;
	}
}

async function imageElementFromBlob(blob: Blob, signal: AbortSignal) {
	if (signal.aborted) {
		throw signal.reason ?? new DOMException("Aborted", "AbortError");
	}
	const objectUrl = URL.createObjectURL(blob);
	try {
		const image = new Image();
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				image.removeEventListener("load", load);
				image.removeEventListener("error", fail);
				signal.removeEventListener("abort", abort);
			};
			const load = () => {
				cleanup();
				resolve();
			};
			const fail = () => {
				cleanup();
				reject(new Error("Head texture decode failed"));
			};
			const abort = () => {
				cleanup();
				image.src = "";
				reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
			};
			image.addEventListener("load", load, { once: true });
			image.addEventListener("error", fail, { once: true });
			signal.addEventListener("abort", abort, { once: true });
			image.src = objectUrl;
		});
		return image;
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
}

async function loadHeadTexture(
	request: HeadTextureRequest,
	signal: AbortSignal
): Promise<LoadedTexture> {
	const blob = await resolveHeadTexture(request, signal);
	if (blob === null) throw new Error("Head texture resolver returned no texture");
	if (blob.type !== "" && blob.type.split(";", 1)[0] !== "image/png") {
		throw new Error("Head texture resolver returned a non-PNG image");
	}
	if (blob.size === 0 || blob.size > MAX_HEAD_TEXTURE_BYTES) {
		throw new Error("Head texture has an invalid byte length");
	}

	let image: ImageBitmap | HTMLImageElement;
	let closeImage: () => void = () => undefined;
	let flipY = true;
	if ("createImageBitmap" in globalThis) {
		try {
			const bitmap = await createImageBitmap(blob, {
				colorSpaceConversion: "none",
				imageOrientation: "flipY",
				premultiplyAlpha: "none",
			});
			if (signal.aborted) {
				bitmap.close();
				throw signal.reason ?? new DOMException("Aborted", "AbortError");
			}
			image = bitmap;
			closeImage = () => bitmap.close();
			flipY = false;
		} catch (error) {
			if (signal.aborted) throw error;
			image = await imageElementFromBlob(blob, signal);
		}
	} else {
		image = await imageElementFromBlob(blob, signal);
	}

	if (!validSkinDimensions(image.width, image.height)) {
		closeImage();
		throw new Error("Head texture dimensions are invalid");
	}

	const legacyLayout = image.height * 2 === image.width;
	const textureSource = legacyLayout ? normalizeLegacySkinSource(image) : image;
	if (textureSource !== image) {
		closeImage();
		closeImage = () => undefined;
	}
	const texture = new Texture(textureSource);
	// Schem-at applies its own gamma post-processing and marks its entity
	// textures as linear. Match that pipeline or skins are gamma-corrected
	// twice and render almost black.
	texture.colorSpace = LinearSRGBColorSpace;
	texture.flipY = flipY;
	texture.magFilter = NearestFilter;
	texture.minFilter = NearestFilter;
	// A player skin is a sparse pixel atlas. Generated mipmaps bleed transparent
	// atlas padding into the tiny face regions.
	texture.generateMipmaps = false;
	texture.needsUpdate = true;
	return {
		texture,
		legacyLayout,
		closeImage,
	};
}

function abortError(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("Aborted", "AbortError");
}

/**
 * Stop waiting as soon as the render pass is cancelled, even when an
 * application resolver ignores its signal. Both resolution branches remain
 * observed so a late Blob or rejection is safely ignored.
 */
function resolveHeadTexture(
	request: HeadTextureRequest,
	signal: AbortSignal
): Promise<Blob | null> {
	if (signal.aborted) return Promise.reject(abortError(signal));

	const pending = Promise.resolve().then(() =>
		request.resolver(request.reference, {
			signal,
			maxBytes: MAX_HEAD_TEXTURE_BYTES,
		})
	);
	return new Promise((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(abortError(signal));
		};

		signal.addEventListener("abort", onAbort, { once: true });
		pending.then(
			(blob) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(blob);
			},
			(error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			}
		);
	});
}

async function loadTextures(
	requests: HeadTextureRequest[],
	parentSignal: AbortSignal
): Promise<Map<string, LoadedTexture>> {
	const loaded = new Map<string, LoadedTexture>();
	const loadController = new AbortController();
	const abortFromParent = () => loadController.abort(parentSignal.reason);
	parentSignal.addEventListener("abort", abortFromParent, { once: true });
	const budgetTimeout = globalThis.setTimeout(() => {
		loadController.abort(new DOMException("Head texture load budget exceeded", "TimeoutError"));
	}, CUSTOM_HEAD_TEXTURE_LOAD_BUDGET_MS);
	const signal = loadController.signal;
	let nextIndex = 0;

	async function worker() {
		while (!signal.aborted) {
			const index = nextIndex++;
			if (index >= requests.length) return;
			const request = requests[index];
			if (request === undefined) return;
			try {
				loaded.set(request.key, await loadHeadTexture(request, signal));
			} catch (error) {
				if (!signal.aborted) {
					console.warn(
						`[schematic-renderer] Head texture ${request.description} was skipped.`,
						error
					);
				}
			}
		}
	}

	try {
		await Promise.all(
			Array.from({ length: Math.min(CUSTOM_HEAD_TEXTURE_CONCURRENCY, requests.length) }, () =>
				worker()
			)
		);
		return loaded;
	} finally {
		globalThis.clearTimeout(budgetTimeout);
		parentSignal.removeEventListener("abort", abortFromParent);
	}
}

function readBlockState(wrapper: HeadSchematicWrapper, position: Position): HeadBlockState | null {
	const [x, y, z] = position;
	let block:
		| {
				name?: (() => string) | string;
				properties?: (() => unknown) | UnknownRecord;
				free?: () => void;
		  }
		| null
		| undefined;
	try {
		block = wrapper.get_block_with_properties?.(x, y, z) as typeof block;
	} catch {
		block = undefined;
	}

	if (block == null) {
		try {
			const name = wrapper.get_block?.(x, y, z);
			return name === undefined
				? null
				: {
						name: name.slice(0, name.indexOf("[") < 0 ? undefined : name.indexOf("[")),
						properties: {},
					};
		} catch {
			return null;
		}
	}

	try {
		const name = typeof block.name === "function" ? block.name() : block.name;
		const rawProperties =
			typeof block.properties === "function" ? block.properties() : block.properties;
		const propertyRecord = asRecord(rawProperties) ?? {};
		const properties = Object.fromEntries(
			Object.entries(propertyRecord).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string"
			)
		);
		return typeof name === "string"
			? {
					name: name.slice(0, name.indexOf("[") < 0 ? undefined : name.indexOf("[")),
					properties,
				}
			: null;
	} catch {
		return null;
	} finally {
		block.free?.();
	}
}

function emptyOverlay(): CustomPlayerHeadOverlay {
	return { count: 0, dispose: () => undefined };
}

/**
 * Loads and attaches custom heads to the schematic group. The application owns
 * all network/profile lookup through resolveTexture; this module accepts only
 * validated PNG blobs. Every created GPU resource is disposable.
 */
export async function createCustomPlayerHeadOverlay(
	schematic: BlockEntitySchematic,
	signal: AbortSignal,
	snapshot?: SchematicBlockEntitySnapshot,
	options: CustomPlayerHeadRendererOptions = {}
): Promise<CustomPlayerHeadOverlay> {
	const heads = selectCustomPlayerHeadsFromSchematic(schematic.schematicWrapper, snapshot);
	if (heads.length === 0 || signal.aborted) return emptyOverlay();

	const textureRequests = new Map<string, HeadTextureRequest>();
	if (options.resolveTexture !== undefined) {
		textureRequests.set(DEFAULT_HEAD_TEXTURE_KEY, {
			key: DEFAULT_HEAD_TEXTURE_KEY,
			reference: { kind: "default" },
			resolver: options.resolveTexture,
			description: "default player skin",
		});
		for (const head of heads) {
			const request = textureRequestForHead(head, options.resolveTexture);
			if (request !== null && textureRequests.size <= MAX_CUSTOM_HEAD_TEXTURES) {
				textureRequests.set(request.key, request);
			}
		}
	}
	const loadedTextures = await loadTextures([...textureRequests.values()], signal);
	if (signal.aborted) {
		for (const loaded of loadedTextures.values()) {
			loaded.texture.dispose();
			loaded.closeImage();
		}
		return emptyOverlay();
	}

	const geometries = {
		modern: {
			base: createMinecraftHeadGeometry(),
			hat: createMinecraftHeadGeometry(true),
		},
		legacy: {
			base: createMinecraftHeadGeometry(false, true),
			hat: createMinecraftHeadGeometry(true, true),
		},
	};
	const materials = new Map<string, MaterialPair>();
	const overlay = new Group();
	const meshes: InstancedMesh[] = [];
	overlay.name = "schematic-renderer:custom-player-heads";
	const headsByTexture = new Map<string, CustomPlayerHead[]>();
	for (const head of heads) {
		const requestKey = textureKeyForHead(head);
		const materialKey =
			requestKey !== null && loadedTextures.has(requestKey)
				? requestKey
				: loadedTextures.has(DEFAULT_HEAD_TEXTURE_KEY)
					? DEFAULT_HEAD_TEXTURE_KEY
					: FALLBACK_HEAD_MATERIAL_KEY;
		const textureHeads = headsByTexture.get(materialKey);
		if (textureHeads === undefined) {
			headsByTexture.set(materialKey, [head]);
		} else {
			textureHeads.push(head);
		}
	}
	const position = new Vector3();
	const rotation = new Quaternion();
	const scale = new Vector3(1, 1, 1);
	const up = new Vector3(0, 1, 0);
	const matrix = new Matrix4();

	for (const [textureKey, textureHeads] of headsByTexture) {
		const loaded = loadedTextures.get(textureKey);
		let pair = materials.get(textureKey);
		if (pair === undefined) {
			pair =
				loaded === undefined
					? {
							base: new MeshLambertMaterial({
								color: 0xd69a72,
								depthTest: true,
								depthWrite: true,
								name: FALLBACK_HEAD_MATERIAL_KEY,
							}),
							hat: null,
						}
					: {
							base: new MeshLambertMaterial({
								depthTest: true,
								depthWrite: true,
								map: loaded.texture,
							}),
							hat: new MeshLambertMaterial({
								alphaTest: 1 / 255,
								depthTest: true,
								depthWrite: true,
								map: loaded.texture,
								side: DoubleSide,
								transparent: true,
							}),
						};
			materials.set(textureKey, pair);
		}

		const geometry = loaded?.legacyLayout ? geometries.legacy : geometries.modern;
		const base = new InstancedMesh(geometry.base, pair.base, textureHeads.length);
		meshes.push(base);
		base.name = `schematic-renderer:custom-player-head-base:${textureKey}`;
		base.instanceMatrix.setUsage(StaticDrawUsage);
		const hat =
			pair.hat === null ? null : new InstancedMesh(geometry.hat, pair.hat, textureHeads.length);
		if (hat !== null) {
			meshes.push(hat);
			hat.name = `schematic-renderer:custom-player-head-hat:${textureKey}`;
			hat.instanceMatrix.setUsage(StaticDrawUsage);
		}

		textureHeads.forEach((head, index) => {
			position.set(
				head.position[0] + head.offset[0],
				head.position[1] + head.offset[1],
				head.position[2] + head.offset[2]
			);
			rotation.setFromAxisAngle(up, head.rotationY);
			matrix.compose(position, rotation, scale);
			base.setMatrixAt(index, matrix);
			hat?.setMatrixAt(index, matrix);
		});
		base.instanceMatrix.needsUpdate = true;
		base.computeBoundingBox();
		base.computeBoundingSphere();
		base.castShadow = true;
		base.receiveShadow = true;
		overlay.add(base);
		if (hat !== null) {
			hat.instanceMatrix.needsUpdate = true;
			hat.computeBoundingBox();
			hat.computeBoundingSphere();
			hat.castShadow = true;
			hat.receiveShadow = true;
			overlay.add(hat);
		}
	}

	schematic.group.add(overlay);
	let disposed = false;
	return {
		count: heads.length,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			schematic.group.remove(overlay);
			overlay.clear();
			for (const mesh of meshes) mesh.dispose();
			geometries.modern.base.dispose();
			geometries.modern.hat.dispose();
			geometries.legacy.base.dispose();
			geometries.legacy.hat.dispose();
			for (const pair of materials.values()) {
				pair.base.dispose();
				pair.hat?.dispose();
			}
			for (const loaded of loadedTextures.values()) {
				loaded.texture.dispose();
				loaded.closeImage();
			}
		},
	};
}
