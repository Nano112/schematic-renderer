import * as THREE from "three";

import type { Block, loadSchematic } from "@enginehub/schematicjs";

import type {
	BlockModel,
	BlockModelData,
	BlockStateDefinition,
	BlockStateDefinitionVariant,
	BlockStateModelHolder,
	Vector,
} from "./types";

import {
	faceToFacingVector,
	INVISIBLE_BLOCKS,
	NON_OCCLUDING_BLOCKS,
	normalize,
	rotateVector,
	TRANSPARENT_BLOCKS,
	REDSTONE_COLORS,
	getDirectionData,
	hashBlockForMap,
	POSSIBLE_FACES,
	DEFAULT_UV,
} from "./utils";

import { ResourceLoader } from "./resource_loader";

export class BlockMeshBuilder {
	public blockMeshCache: Map<any, any>;
	materialMap: Map<string, THREE.Material>;
	base64MaterialMap: Map<string, string>;
	ressourceLoader: ResourceLoader;
	schematic: any;

	constructor(ressourceLoader: any, materialMap: Map<string, THREE.Material>) {
		this.blockMeshCache = new Map();
		this.materialMap = materialMap;
		this.base64MaterialMap = new Map();
		this.ressourceLoader = ressourceLoader;
	}

	public setSchematic(schematic: any) {
		this.schematic = schematic;
	}

	public getMaterialId(model: BlockModel, faceData: any, color: THREE.Color) {
		const textureName = this.ressourceLoader.resolveTextureName(
			faceData.texture,
			model
		);
		return `${textureName}-${color?.r ?? 1}-${color?.g ?? 1}-${color?.b ?? 1}`;
	}

	public normalizeElementCoords(element: BlockModel["elements"][0]) {
		if (!element.from || !element.to) {
			throw new Error("Element is missing from or to");
		}
		element.from = element.from.map(normalize) as Vector;
		element.to = element.to.map(normalize) as Vector;
		if (element.rotation && element.rotation.origin) {
			element.rotation.origin = element.rotation.origin.map(
				normalize
			) as Vector;
		}
	}

	public faceToRotation(face: string) {
		switch (face) {
			case "north":
				return { angle: 180, axis: [0, 1, 0] };
			case "south":
				return { angle: 0, axis: [0, 1, 0] };
			case "east":
				return { angle: 90, axis: [0, 1, 0] };
			case "west":
				return { angle: 270, axis: [0, 1, 0] };
			case "up":
				return { angle: 270, axis: [1, 0, 0] };
			case "down":
				return { angle: 90, axis: [1, 0, 0] };
			default:
				return { angle: 0, axis: [0, 1, 0] };
		}
	}

	public rotateBlockComponents(blockComponents: any, facing: string) {
		const rotation = this.faceToRotation(facing);
		// console.log("rotation", rotation);
		const rotatedBlockComponents: any = {};
		for (const key in blockComponents) {
			const blockComponent = blockComponents[key];
			const { positions, normals, uvs } = blockComponent;
			const rotatedPositions = [];
			const rotatedNormals = [];
			const rotatedUvs = [];
			for (let i = 0; i < positions.length; i += 3) {
				const [x, y, z] = rotateVector(
					[positions[i], positions[i + 1], positions[i + 2]],
					rotation,
					[0.5, 0.5, 0.5]
				);
				rotatedPositions.push(x, y, z);
			}
			for (let i = 0; i < normals.length; i += 3) {
				const [x, y, z] = rotateVector(
					[normals[i], normals[i + 1], normals[i + 2]],
					rotation
				);
				rotatedNormals.push(x, y, z);
			}
			for (let i = 0; i < uvs.length; i += 2) {
				rotatedUvs.push(uvs[i], uvs[i + 1]);
			}
			rotatedBlockComponents[key] = {
				...blockComponent,
				positions: rotatedPositions,
				normals: rotatedNormals,
				uvs: rotatedUvs,
			};
		}
		return rotatedBlockComponents;
	}

	public async processFaceData(
		element: BlockModel["elements"][0],
		model: BlockModel,
		block: any,
		rotation = 0
	) {
		const subMaterials: { [key: string]: string | null } = {};
		const uvs: { [key: string]: [number, number, number, number] } = {};
		if (!element.faces) {
			return { subMaterials, uvs };
		}
		for (const face of POSSIBLE_FACES) {
			const faceData: any = element.faces[face];
			if (!faceData) {
				subMaterials[face] = null;
				uvs[face] = DEFAULT_UV.map((u) => u / 16) as [
					number,
					number,
					number,
					number
				];
				continue;
			}
			const materialColor = this.ressourceLoader.getColorForElement(
				faceData,
				this.ressourceLoader.resolveTextureName(faceData.texture, model),
				block
			);
			const materialId = this.getMaterialId(
				model,
				faceData,
				materialColor ?? new THREE.Color(1, 1, 1)
			);
			if (!this.materialMap.has(materialId)) {
				const material = await this.ressourceLoader.getTextureMaterial(
					model,
					faceData,
					TRANSPARENT_BLOCKS.has(block.type) ||
						faceData.texture.includes("overlay"),
					materialColor,
					rotation
				);
				this.materialMap.set(
					materialId,
					material ?? new THREE.MeshBasicMaterial()
				);
				const base64Material = await this.ressourceLoader.getBase64Image(
					model,
					faceData
				);
				this.base64MaterialMap.set(materialId, base64Material ?? "");
			}

			subMaterials[face] = materialId;
			uvs[face] = (faceData.uv || DEFAULT_UV).map((u: number) => u / 16) as [
				number,
				number,
				number,
				number
			];
		}
		return { subMaterials, uvs };
	}

	public async getBlockMesh(block: any): Promise<{
		[key: string]: {
			materialId: string;
			face: string;
			positions: number[];
			normals: number[];
			uvs: number[];
		};
	}> {
		const blockComponents: {
			[key: string]: {
				materialId: string;
				face: string;
				positions: number[];
				normals: number[];
				uvs: number[];
			};
		} = {};
		const { modelOptions } = await this.ressourceLoader.getBlockMeta(block);
		for (const modelHolder of modelOptions.holders) {
			if (modelHolder === undefined) {
				continue;
			}
			const model = await this.ressourceLoader.loadModel(modelHolder.model);
			const elements = model?.elements;
			if (!elements) {
				continue;
			}
			for (const element of elements) {
				if (!element.from || !element.to) {
					continue;
				}
				this.normalizeElementCoords(element);
				const faceData = await this.processFaceData(element, model, block);
				const from = element.from;
				const to = element.to;
				if (!from || !to) {
					continue;
				}
				const size = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
				const directionData = getDirectionData(faceData.uvs);
				const faces = POSSIBLE_FACES;
				for (const dir of faces) {
					const materialId = faceData.subMaterials[dir];
					if (!materialId) {
						continue;
					}
					const uniqueKey = `${materialId}-${dir}`;
					if (!blockComponents[uniqueKey]) {
						blockComponents[uniqueKey] = {
							materialId: materialId,
							face: dir,
							positions: [],
							normals: [],
							uvs: [],
						};
					}

					const dirData = directionData[dir];
					for (const { pos, uv } of dirData.corners) {
						if (!from || !size || !pos || !uv) {
							continue;
						}
						blockComponents[uniqueKey].positions.push(
							from[0] + size[0] * pos[0],
							from[1] + size[1] * pos[1],
							from[2] + size[2] * pos[2]
						);
						const invertedUV = [1 - uv[0], 1 - uv[1]];
						blockComponents[uniqueKey].uvs.push(...invertedUV);
						blockComponents[uniqueKey].normals.push(...dirData.normal);
					}
				}
			}
		}
		return blockComponents;
	}

	public occludedFacesListToInt(occludedFaces: { [key: string]: boolean }) {
		let result = 0;
		for (const face of POSSIBLE_FACES) {
			result = (result << 1) | (occludedFaces[face] ? 1 : 0);
		}
		return result;
	}

	public getOccludedFacesForBlock(
		blockType: string,
		pos: THREE.Vector3
	): number {
		const { x, y, z } = pos;
		const directionVectors = {
			east: new THREE.Vector3(1, 0, 0),
			west: new THREE.Vector3(-1, 0, 0),
			up: new THREE.Vector3(0, 1, 0),
			down: new THREE.Vector3(0, -1, 0),
			south: new THREE.Vector3(0, 0, 1),
			north: new THREE.Vector3(0, 0, -1),
		};
		const occludedFaces = {
			east: false,
			west: false,
			up: false,
			down: false,
			south: false,
			north: false,
		};
		if (
			NON_OCCLUDING_BLOCKS.has(blockType) ||
			TRANSPARENT_BLOCKS.has(blockType)
		) {
			return this.occludedFacesListToInt(occludedFaces);
		}
		for (const face of POSSIBLE_FACES) {
			const directionVector = directionVectors[face];
			const adjacentBlock = this.schematic.getBlock(
				new THREE.Vector3(x, y, z).add(directionVector)
			);
			if (adjacentBlock === undefined) {
				continue;
			}
			if (NON_OCCLUDING_BLOCKS.has(adjacentBlock.type)) {
				continue;
			}
			if (TRANSPARENT_BLOCKS.has(adjacentBlock.type)) {
				continue;
			}
			occludedFaces[face] = true;
		}
		return this.occludedFacesListToInt(occludedFaces);
	}

	public async updateBlockModelLookup(
		blockModelLookup: Map<string, BlockModelData>,
		loadedSchematic: ReturnType<typeof loadSchematic>
	): Promise<Map<string, BlockModelData>> {
		for (const block of loadedSchematic.blockTypes) {
			if (INVISIBLE_BLOCKS.has(block.type)) {
				continue;
			}

			if (blockModelLookup.get(hashBlockForMap(block))) {
				continue;
			}
			const blockState = await this.ressourceLoader.loadBlockStateDefinition(
				block.type
			);
			const blockModelData = this.ressourceLoader.getBlockModelData(
				block,
				blockState
			);
			if (!blockModelData.models.length) {
				continue;
			}

			blockModelLookup.set(hashBlockForMap(block), blockModelData);
		}
		return blockModelLookup;
	}

	public async getBlockMeshFromCache(block: any) {
		const blockUniqueKey = hashBlockForMap(block);
		if (this.blockMeshCache.has(blockUniqueKey)) {
			return this.blockMeshCache.get(blockUniqueKey);
		} else {
			const blockComponents = await this.getBlockMesh(block);
			this.blockMeshCache.set(blockUniqueKey, blockComponents);
			return blockComponents;
		}
	}
}
