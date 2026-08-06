import type { Group, Object3D, Texture } from "three";

export type SchematicPosition = readonly [number, number, number];
export type UnknownRecord = Record<string, unknown>;

export interface BlockState {
	name: string;
	properties: Record<string, string>;
}

export interface IndexedSchematicBlock {
	position: SchematicPosition;
	paletteIndex: number;
}

export interface IndexedBlockEntity {
	position: SchematicPosition | null;
	id: string | null;
	nbt: UnknownRecord;
	raw: unknown;
}

/**
 * Narrow interface shared by Nucleation wrappers from multiple releases.
 * All reads are optional and guarded because malformed NBT must not prevent
 * the regular block mesh from rendering.
 */
export interface SchematicBlockEntityWrapper {
	get_all_block_entities?: () => unknown;
	get_block_entity?: (x: number, y: number, z: number) => unknown;
	get_palette?: () => unknown;
	blocks_indices?: () => unknown;
	get_block_with_properties?: (x: number, y: number, z: number) => unknown;
	get_block?: (x: number, y: number, z: number) => string | undefined;
}

export interface BlockEntitySchematic {
	group: Group;
	schematicWrapper: SchematicBlockEntityWrapper;
}

/**
 * Resource access owned by the renderer context. Returned models/textures are
 * borrowed; block-entity renderers clone before mutating and never dispose the
 * context-owned object.
 */
export interface BlockEntityResources {
	getEntityMesh: (entityType: string, useCache?: boolean) => Promise<Object3D>;
	getTexture: (texturePath: string) => Promise<Texture>;
}

/**
 * Immutable-at-capture snapshot used by every block-entity renderer in one
 * render pass. Raw arrays remain available for format-specific parsers, while
 * normalized indexes avoid repeated wrapper/NBT scans.
 */
export interface SchematicBlockEntitySnapshot {
	palette: readonly unknown[];
	blocks: readonly unknown[];
	entities: readonly unknown[];
	paletteStates: readonly (BlockState | null)[];
	indexedBlocks: readonly IndexedSchematicBlock[];
	indexedEntities: readonly IndexedBlockEntity[];
	blocksByPosition: ReadonlyMap<string, IndexedSchematicBlock>;
	blocksByName: ReadonlyMap<string, readonly IndexedSchematicBlock[]>;
	entitiesByPosition: ReadonlyMap<string, readonly IndexedBlockEntity[]>;
	entitiesById: ReadonlyMap<string, readonly IndexedBlockEntity[]>;
	blockStateAt(position: SchematicPosition): BlockState | null;
	hasBlockId(id: string): boolean;
	hasEntityId(id: string): boolean;
}

export interface CaptureSnapshotOptions {
	onReadError?: (label: string, error: unknown) => void;
	maxPaletteEntries?: number;
	maxBlocks?: number;
	maxBlockEntities?: number;
}

const DEFAULT_MAX_PALETTE_ENTRIES = 65_536;
const DEFAULT_MAX_BLOCKS = 1_000_000;
const DEFAULT_MAX_BLOCK_ENTITIES = 16_384;

export function asRecord(value: unknown): UnknownRecord | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as UnknownRecord)
		: null;
}

function firstValue(record: UnknownRecord, ...keys: string[]): unknown {
	for (const key of keys) {
		if (record[key] !== undefined) return record[key];
	}
	return undefined;
}

export function parseSchematicPosition(value: unknown): SchematicPosition | null {
	const values = Array.isArray(value)
		? value
		: ArrayBuffer.isView(value)
			? Array.from(value as unknown as ArrayLike<number>)
			: null;
	if (
		values === null ||
		values.length !== 3 ||
		values.some((coordinate) => !Number.isSafeInteger(coordinate))
	) {
		return null;
	}
	return [Number(values[0]), Number(values[1]), Number(values[2])];
}

export function schematicPositionKey(position: SchematicPosition): string {
	return `${position[0]},${position[1]},${position[2]}`;
}

export function parseIndexedSchematicBlock(value: unknown): IndexedSchematicBlock | null {
	const values = Array.isArray(value)
		? value
		: ArrayBuffer.isView(value)
			? Array.from(value as unknown as ArrayLike<number>)
			: null;
	if (
		values === null ||
		values.length < 4 ||
		values.slice(0, 4).some((coordinate) => !Number.isSafeInteger(coordinate))
	) {
		return null;
	}
	return {
		position: [Number(values[0]), Number(values[1]), Number(values[2])],
		paletteIndex: Number(values[3]),
	};
}

export function parsePaletteBlockState(value: unknown): BlockState | null {
	if (typeof value === "string") {
		const propertyStart = value.indexOf("[");
		const name = value.slice(0, propertyStart < 0 ? undefined : propertyStart);
		const properties: Record<string, string> = {};
		if (propertyStart >= 0 && value.endsWith("]")) {
			for (const property of value.slice(propertyStart + 1, -1).split(",")) {
				const separator = property.indexOf("=");
				if (separator > 0) {
					properties[property.slice(0, separator)] = property.slice(separator + 1);
				}
			}
		}
		return name.length === 0 ? null : { name, properties };
	}

	const block = asRecord(value);
	if (block === null) return null;
	const rawName =
		typeof block.name === "string"
			? block.name
			: typeof block.Name === "string"
				? block.Name
				: null;
	if (rawName === null) return null;
	const rawProperties = asRecord(block.properties) ?? asRecord(block.Properties) ?? {};
	const properties = Object.fromEntries(
		Object.entries(rawProperties)
			.filter(
				(entry): entry is [string, string | number | boolean] =>
					typeof entry[1] === "string" ||
					typeof entry[1] === "number" ||
					typeof entry[1] === "boolean"
			)
			.map(([key, property]) => [key, String(property)])
	);
	const propertyStart = rawName.indexOf("[");
	const name = rawName.slice(0, propertyStart < 0 ? undefined : propertyStart);
	return name.length === 0 ? null : { name, properties };
}

function blockEntityPosition(record: UnknownRecord, nbt: UnknownRecord): SchematicPosition | null {
	for (const candidate of [
		record.position,
		record.Position,
		record.pos,
		nbt.Pos,
		nbt.position,
		nbt.Position,
		nbt.pos,
	]) {
		const parsed = parseSchematicPosition(candidate);
		if (parsed !== null) return parsed;
	}
	const data = asRecord(firstValue(nbt, "Data", "data"));
	if (data !== null) {
		for (const candidate of [data.Pos, data.position, data.Position, data.pos]) {
			const parsed = parseSchematicPosition(candidate);
			if (parsed !== null) return parsed;
		}
	}
	for (const source of [record, nbt, data]) {
		if (source === null) continue;
		const coordinates = ["x", "y", "z"].map((key) => source[key]);
		if (coordinates.every(Number.isSafeInteger)) {
			return [Number(coordinates[0]), Number(coordinates[1]), Number(coordinates[2])];
		}
	}
	return null;
}

export function parseIndexedBlockEntity(value: unknown): IndexedBlockEntity | null {
	const record = asRecord(value);
	if (record === null) return null;
	const nbt = asRecord(record.nbt) ?? asRecord(record.Nbt) ?? asRecord(record.NBT) ?? record;
	const data = asRecord(firstValue(nbt, "Data", "data"));
	const rawId =
		firstValue(record, "id", "Id") ??
		firstValue(nbt, "id", "Id") ??
		(data === null ? undefined : firstValue(data, "id", "Id"));
	return {
		position: blockEntityPosition(record, nbt),
		id: typeof rawId === "string" && rawId.length > 0 ? rawId : null,
		nbt,
		raw: value,
	};
}

function readSnapshotValue(
	label: string,
	reader: (() => unknown) | undefined,
	onReadError: CaptureSnapshotOptions["onReadError"]
): unknown {
	try {
		return reader?.();
	} catch (error) {
		onReadError?.(label, error);
		return undefined;
	}
}

function asBoundedArray(value: unknown, maximum: number): readonly unknown[] {
	return Array.isArray(value) ? value.slice(0, maximum) : [];
}

function appendToIndex<T>(map: Map<string, T[]>, key: string, value: T): void {
	const values = map.get(key);
	if (values === undefined) map.set(key, [value]);
	else values.push(value);
}

export function captureSchematicBlockEntitySnapshot(
	wrapper: SchematicBlockEntityWrapper,
	options: CaptureSnapshotOptions = {}
): SchematicBlockEntitySnapshot {
	const onReadError =
		options.onReadError ??
		((label: string, error: unknown) => {
			console.warn(`[schematic-renderer] ${label} scan failed.`, error);
		});
	const palette = asBoundedArray(
		readSnapshotValue("Block palette", wrapper.get_palette?.bind(wrapper), onReadError),
		options.maxPaletteEntries ?? DEFAULT_MAX_PALETTE_ENTRIES
	);
	const blocks = asBoundedArray(
		readSnapshotValue("Block index", wrapper.blocks_indices?.bind(wrapper), onReadError),
		options.maxBlocks ?? DEFAULT_MAX_BLOCKS
	);
	const entities = asBoundedArray(
		readSnapshotValue("Block entity", wrapper.get_all_block_entities?.bind(wrapper), onReadError),
		options.maxBlockEntities ?? DEFAULT_MAX_BLOCK_ENTITIES
	);
	const paletteStates = palette.map(parsePaletteBlockState);
	const indexedBlocks: IndexedSchematicBlock[] = [];
	const indexedEntities: IndexedBlockEntity[] = [];
	const blocksByPosition = new Map<string, IndexedSchematicBlock>();
	const blocksByName = new Map<string, IndexedSchematicBlock[]>();
	const entitiesByPosition = new Map<string, IndexedBlockEntity[]>();
	const entitiesById = new Map<string, IndexedBlockEntity[]>();

	for (const rawBlock of blocks) {
		const block = parseIndexedSchematicBlock(rawBlock);
		if (block === null || paletteStates[block.paletteIndex] === undefined) continue;
		indexedBlocks.push(block);
		const key = schematicPositionKey(block.position);
		if (!blocksByPosition.has(key)) blocksByPosition.set(key, block);
		const state = paletteStates[block.paletteIndex];
		if (state !== null && state !== undefined) appendToIndex(blocksByName, state.name, block);
	}

	for (const rawEntity of entities) {
		const entity = parseIndexedBlockEntity(rawEntity);
		if (entity === null) continue;
		indexedEntities.push(entity);
		if (entity.position !== null) {
			appendToIndex(entitiesByPosition, schematicPositionKey(entity.position), entity);
		}
		if (entity.id !== null) appendToIndex(entitiesById, entity.id, entity);
	}

	const blockStateAt = (position: SchematicPosition): BlockState | null => {
		const block = blocksByPosition.get(schematicPositionKey(position));
		return block === undefined ? null : (paletteStates[block.paletteIndex] ?? null);
	};

	return {
		palette,
		blocks,
		entities,
		paletteStates,
		indexedBlocks,
		indexedEntities,
		blocksByPosition,
		blocksByName,
		entitiesByPosition,
		entitiesById,
		blockStateAt,
		hasBlockId: (id) => blocksByName.has(id),
		hasEntityId: (id) => entitiesById.has(id),
	};
}
