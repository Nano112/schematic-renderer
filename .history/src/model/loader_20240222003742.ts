import type { Block } from '@enginehub/schematicjs';
import deepmerge from 'deepmerge';
import type { ResourceLoader } from '../../resource/resourceLoader';
import { TRANSPARENT_BLOCKS } from '../utils';
import { loadModel } from './parser';
import type {
    BlockModel,
    BlockModelData,
    BlockModelOption,
    BlockStateDefinition,
    BlockStateDefinitionVariant,
    BlockStateModelHolder,
    Vector,
} from './types';
import { POSSIBLE_FACES } from './types';
import {
    Axis,
    Color3,
    Color4,
    type InstancedMesh,
    type Material,
    type Mesh,
    MeshBuilder,
    MultiMaterial,
    type Scene,
    Space,
    StandardMaterial,
    SubMesh,
    Texture,
    Vector3,
    Vector4,
} from '@babylonjs/core';

const TINT_COLOR = new Color4(145 / 255, 189 / 255, 89 / 255, 1);
const WATER_COLOR = new Color4(36 / 255, 57 / 255, 214 / 255, 1);
const LAVA_COLOR = new Color4(232 / 255, 89 / 255, 23 / 255, 1);
const RESTONE_COLORS = [
    new Color4(75 / 255, 0, 0, 1),
    new Color4(110 / 255, 0, 0, 1),
    new Color4(120 / 255, 0, 0, 1),
    new Color4(130 / 255, 0, 0, 1),
    new Color4(140 / 255, 0, 0, 1),
    new Color4(151 / 255, 0, 0, 1),
    new Color4(160 / 255, 0, 0, 1),
    new Color4(170 / 255, 0, 0, 1),
    new Color4(180 / 255, 0, 0, 1),
    new Color4(190 / 255, 0, 0, 1),
    new Color4(201 / 255, 0, 0, 1),
    new Color4(211 / 255, 0, 0, 1),
    new Color4(214 / 255, 0, 0, 1),
    new Color4(224 / 255, 6 / 255, 0, 1),
    new Color4(233 / 255, 26 / 255, 0, 1),
    new Color4(244 / 255, 48 / 255, 0, 1),
];
const AMBIENT_LIGHT = new Color3(0.5, 0.5, 0.5);
const DEFAULT_UV = [0, 0, 16, 16];

const DEG2RAD = Math.PI / 180;

function normalize(input: number): number {
    return input / 16 - 0.5;
}

interface ModelLoader {
    clearCache: () => void;
    getBlockModelData: (
        block: Block,
        blockState: BlockStateDefinition
    ) => BlockModelData;
    getModelOption: (data: BlockModelData) => BlockModelOption;
    getModel: (
        data: BlockModelOption,
        block: Block,
        scene: Scene
    ) => Promise<InstancedMesh[]>;
}

export function getModelLoader(resourceLoader: ResourceLoader): ModelLoader {
    const materialCache = new Map<string, Material>();
    const modelCache = new Map<string, Mesh[]>();

    const clearCache = () => {
        materialCache.clear();
        modelCache.clear();
    };

    async function getTextureMaterial(
        tex: string,
        scene: Scene,
        // rotation?: number,
        faceData: any,
        transparent?: boolean,
        color?: Color3
    ): Promise<Material> {
        // Normalise values for better caching.
        let rotation = faceData.rotation;
        if (rotation === 0) {
            rotation = undefined;
        }
        const cacheKey = `${tex}_rot=${rotation}`;

        // TODO - Determine if there's a better way to handle this other than manually caching.
        const cached = materialCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        if (tex.startsWith('minecraft:')) {
            tex = tex.substring('minecraft:'.length);
        }
        const blob = await resourceLoader.getResourceBlob(
            `textures/${tex}.png`
        );
        if (blob === undefined) {
            return undefined;
        }
        // TODO: Figure out why the fudge I have to do this nonsense to get the texture to render correctly.
        const inverted = faceData.texture === '#top';
        const texture = new Texture(
            blob,
            scene,
            false,
            !inverted,
            Texture.NEAREST_NEAREST_MIPNEAREST
        );
        texture.hasAlpha = transparent;
        texture.isBlocking = false;

        if (rotation) {
            texture.wAng = rotation * DEG2RAD;
        }

        const mat = new StandardMaterial(cacheKey, scene);
        mat.diffuseTexture = texture;
        mat.ambientColor = AMBIENT_LIGHT;

        if (color) {
            mat.diffuseColor = color;
        }
        materialCache.set(cacheKey, mat);
        return mat;
    }

    function getBlockModelData(
        block: Block,
        blockState: BlockStateDefinition
    ): BlockModelData {
        const models: BlockModelData['models'] = [];

        const validVariantProperties = blockState.variants
            ? new Set(
                  Object.keys(blockState.variants)[0]
                      .split(',')
                      .map(a => a.split('=')[0])
              )
            : new Set(Object.keys(block.properties));
        const variantName = Object.keys(block.properties)
            .sort()
            .reduce((a, b) => {
                if (!validVariantProperties.has(b)) {
                    return a;
                }
                a.push(`${b}=${block.properties[b]}`);
                return a;
            }, [])
            .join(',');
        const createWeightedModels = (
            model: BlockStateModelHolder | BlockStateModelHolder[]
        ): BlockModelData['models'][number]['options'] => {
            if (Array.isArray(model)) {
                return model.map(m => ({ holder: m, weight: m.weight ?? 1 }));
            }
            return [{ holder: model, weight: 1 }];
        };
        if (blockState.variants?.['']) {
            models.push({
                options: createWeightedModels(blockState.variants['']),
            });
        } else if (blockState.variants) {
            models.push({
                options: createWeightedModels(blockState.variants[variantName]),
            });
        } else if (blockState.multipart) {
            const doesFilterPass = (
                filter: BlockStateDefinitionVariant<string>
            ) => {
                for (const property of Object.keys(filter)) {
                    const filterProperties = filter[property].split('|');

                    if (
                        filterProperties.indexOf(block.properties[property]) ===
                        -1
                    ) {
                        return false;
                    }
                }
                return true;
            };

            for (const part of blockState.multipart) {
                if (part.when) {
                    if (part.when.OR) {
                        let anyPassed = false;
                        for (const test of part.when.OR) {
                            if (doesFilterPass(test)) {
                                anyPassed = true;
                                break;
                            }
                        }
                        if (!anyPassed) {
                            continue;
                        }
                    } else {
                        if (!doesFilterPass(part.when)) {
                            continue;
                        }
                    }
                }

                models.push({ options: createWeightedModels(part.apply) });
            }
        }

        const name =
            variantName.length > 0
                ? `${block.type}[${variantName}]`
                : block.type;

        return { models, name };
    }

    const getModelOption = (data: BlockModelData) => {
        const weightedRandomIndex = (
            options: BlockModelData['models'][number]['options']
        ) => {
            const weights = [];

            for (let i = 0; i < options.length; i++) {
                weights[i] = options[i].weight + (weights[i - 1] || 0);
            }

            const random = Math.random() * weights[weights.length - 1];

            for (let i = 0; i < weights.length; i++) {
                if (weights[i] > random) {
                    return i;
                }
            }

            return weights.length - 1;
        };

        let name = data.name;
        const holders = [];
        for (const model of data.models) {
            const index = weightedRandomIndex(model.options);
            holders.push(model.options[index].holder);
            name = `${name}-${index}`;
        }

        return { name, holders };
    };

    function resolveTexture(ref: string, model: BlockModel): string {
        while (ref.startsWith('#')) {
            ref = model.textures[ref.substring(1)];
        }
        return ref;
    }

    function getSizeFromElement(element: BlockModel['elements'][0]) {
        return [
            element.to[0] - element.from[0],
            element.to[1] - element.from[1],
            element.to[2] - element.from[2],
        ];
    }

    function normalizeElementCoords(element: BlockModel['elements'][0]) {
        element.from = element.from.map(normalize) as Vector;
        element.to = element.to.map(normalize) as Vector;
        if (element.rotation) {
            element.rotation.origin = element.rotation.origin.map(
                normalize
            ) as Vector;
        }
    }

    function getColorForElement(
        faceData: any,
        tex: string,
        block: Block | undefined
    ) {
        if (tex.startsWith('block/redstone_dust_')) {
            return RESTONE_COLORS[block?.properties?.['power'] ?? 0];
        } else if (faceData.tintindex !== undefined) {
            return TINT_COLOR;
        } else if (tex.startsWith('block/water_')) {
            return WATER_COLOR;
        } else if (tex.startsWith('block/lava_')) {
            return LAVA_COLOR;
        } else {
            return undefined;
        }
    }

    function applyRotation(box: Mesh, rotation: any) {
        box.setPivotPoint(
            new Vector3(
                rotation.origin[0],
                rotation.origin[1],
                rotation.origin[2]
            ),
            Space.WORLD
        );

        const radianRotation = rotation.angle * DEG2RAD;

        switch (rotation.axis) {
            case 'y':
                box.rotate(Axis.Y, radianRotation, Space.WORLD);
                break;
            case 'x':
                box.rotate(Axis.X, radianRotation, Space.WORLD);
                break;
            case 'z':
                box.rotate(Axis.Z, radianRotation, Space.WORLD);
                break;
        }

        box.setPivotPoint(new Vector3(0, 0, 0));
    }

    async function processFaceData(
        element: BlockModel['elements'][0],
        model: BlockModel,
        scene: Scene,
        block: Block
    ) {
        const colours = [];
        const uvs = [];
        const subMaterials: Material[] = [];
        let hasColor = false;
        for (const face of POSSIBLE_FACES) {
            const faceData = element.faces[face];
            if (!faceData) {
                subMaterials.push(undefined);
                colours.push(undefined);
                uvs.push(undefined);
                continue;
            }
            faceData.uv = (faceData.uv || DEFAULT_UV).map(u => u / 16) as [
                number,
                number,
                number,
                number,
            ];

            const tex = resolveTexture(faceData.texture, model);
            hasColor = true;
            const color = getColorForElement(faceData, tex, block);

            subMaterials.push(
                await getTextureMaterial(
                    tex,
                    scene,
                    faceData,
                    TRANSPARENT_BLOCKS.has(block.type) ||
                        faceData.texture.includes('overlay'),
                    new Color3(color?.r ?? 1, color?.g ?? 1, color?.b ?? 1)
                )
            );
            uvs.push(new Vector4(...faceData.uv));
        }

        return { colours, uvs, subMaterials, hasColor };
    }

    const getModel = async (
        data: BlockModelOption,
        block: Block,
        scene: Scene
    ) => {
        if (modelCache.has(data.name)) {
            return modelCache
                .get(data.name)
                .map((mesh, i) =>
                    mesh.createInstance(`instance-${data.name}-${i}`)
                );
        }

        const group: Mesh[] = [];
        for (
            let modelIndex = 0;
            modelIndex < data.holders.length;
            modelIndex++
        ) {
            const modelHolder = data.holders[modelIndex];
            const model = await loadModel(modelHolder.model, resourceLoader);
            if (block.type === 'water' || block.type === 'lava') {
                model.textures['all'] = model.textures.particle;
                const temporaryModel = deepmerge(
                    await loadModel('block/cube_all', resourceLoader),
                    model
                );
                model.textures = temporaryModel.textures;
                model.elements = temporaryModel.elements;
            }

            if (!model.elements) {
                continue;
            }
            for (const element of model.elements) {
                if (Object.keys(element.faces).length === 0) {
                    continue;
                }
                if (element.faces['bottom']) {
                    element.faces['down'] = element.faces['bottom'];
                }

                normalizeElementCoords(element);
                const elementSize = getSizeFromElement(element);
                const faceData = await processFaceData(
                    element,
                    model,
                    scene,
                    block
                );
                const box = MeshBuilder.CreateBox(
                    `${data.name}-${modelIndex}`,
                    {
                        width: elementSize[0] || 0.001,
                        height: elementSize[1] || 0.001,
                        depth: elementSize[2] || 0.001,
                        wrap: true,
                        faceColors: faceData.colours,
                        updatable: false,
                        faceUV: faceData.uvs,
                    },
                    scene
                );
                box.doNotSyncBoundingInfo = true;

                const verticesCount = box.getTotalVertices();
                let { subMaterials } = faceData;
                const subMeshes = [];
                for (let i = 0; i < POSSIBLE_FACES.length; i++) {
                    if (!subMaterials[i]) {
                        continue;
                    }
                    subMeshes.push(
                        new SubMesh(
                            subMeshes.length,
                            i,
                            verticesCount,
                            i * 6,
                            6,
                            box,
                            undefined,
                            true,
                            false
                        )
                    );
                }
                box.subMeshes = subMeshes;
                subMaterials = subMaterials.filter(mat => mat);

                // apply the materials to the submeshes
                const multiMat = new MultiMaterial(
                    `${data.name}-multiMat`,
                    scene
                );

                for (const material of subMaterials) {
                    multiMat.subMaterials.push(material);
                }

                box.material = multiMat;

                if (element.rotation) {
                    applyRotation(box, element.rotation);
                }

                if (modelHolder.x) {
                    box.rotate(Axis.X, -DEG2RAD * modelHolder.x, Space.WORLD);
                }
                if (modelHolder.y) {
                    box.rotate(Axis.Y, -DEG2RAD * modelHolder.y, Space.WORLD);
                }

                box.translate(Axis.X, element.from[0] + elementSize[0] / 2)
                    .translate(Axis.Y, element.from[1] + elementSize[1] / 2)
                    .translate(Axis.Z, element.from[2] + elementSize[2] / 2);
                group.push(box);
            }
        }

        for (const mesh of group) {
            mesh.setEnabled(false);
            mesh.isVisible = false;
        }
        // modelCache.set(data.name, group);
        modelCache.set(data.name, group);
        // create a deep copy of the group so that we can create instances of it
        return group.map((mesh, i) =>
            mesh.createInstance(`instance-${data.name}-${i}`)
        );
    };
    return {
        clearCache,
        getBlockModelData,
        getModelOption,
        getModel,
    };
}
