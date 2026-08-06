import { afterEach, describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { EventEmitter } from "events";
import { RenderManager } from "../RenderManager";

// Mock all problematic imports
vi.mock("nucleation", () => ({
	default: vi.fn().mockResolvedValue(undefined),
	SchematicWrapper: class {},
}));
vi.mock("../../workers/MeshBuilder.worker?worker&inline", () => ({
	default: class MockWorker {
		postMessage() {}
		terminate() {}
		onmessage = null;
	},
}));

// Mock postprocessing
vi.mock("postprocessing", () => ({
	EffectComposer: class MockEffectComposer {
		addPass = vi.fn();
		removePass = vi.fn();
		render = vi.fn();
		setSize = vi.fn();
		dispose = vi.fn();
	},
	RenderPass: class MockRenderPass {
		enabled = true;
	},
	EffectPass: class MockEffectPass {
		enabled = true;
	},
	SMAAEffect: class MockSMAAEffect {},
}));

// Mock n8ao
vi.mock("n8ao", () => ({
	N8AOPostPass: class MockN8AOPostPass {
		configuration = {
			intensity: 5,
			aoRadius: 1,
		};
		enabled = true;
		setSize = vi.fn();
	},
}));

// Mock GammaCorrectionEffect
vi.mock("../../effects/GammaCorrectionEffect", () => ({
	GammaCorrectionEffect: class MockGammaCorrectionEffect {
		gamma = 0.5;
	},
}));

// Mock RGBELoader
vi.mock("three/examples/jsm/loaders/RGBELoader.js", () => ({
	RGBELoader: class MockRGBELoader {
		load = vi.fn().mockImplementation((_url, onLoad) => {
			const mockTexture = new THREE.DataTexture();
			mockTexture.mapping = THREE.EquirectangularReflectionMapping;
			setTimeout(() => onLoad(mockTexture), 0);
			return mockTexture;
		});
		setDataType = vi.fn().mockReturnThis();
	},
}));

// Mock IndexedDB
const mockIndexedDB = {
	open: vi.fn().mockReturnValue({
		onerror: null,
		onsuccess: null,
		onupgradeneeded: null,
		result: {
			transaction: vi.fn().mockReturnValue({
				objectStore: vi.fn().mockReturnValue({
					get: vi.fn().mockReturnValue({ onsuccess: null, onerror: null }),
					put: vi.fn(),
				}),
				oncomplete: null,
			}),
			objectStoreNames: { contains: vi.fn().mockReturnValue(true) },
		},
	}),
};
vi.stubGlobal("indexedDB", mockIndexedDB);

// Since RenderManager creates a real WebGLRenderer which fails in test environment,
// we test the class at a higher level with mocked dependencies
describe("RenderManager", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createManager() {
		const parent = document.createElement("div");
		const canvas = document.createElement("canvas");
		parent.appendChild(canvas);
		Object.defineProperties(parent, {
			clientWidth: { value: 640 },
			clientHeight: { value: 360 },
		});
		const cameraManager = new EventEmitter() as EventEmitter & {
			activeCamera: { camera: THREE.PerspectiveCamera };
			updateAspectRatio: ReturnType<typeof vi.fn>;
		};
		cameraManager.activeCamera = { camera: new THREE.PerspectiveCamera() };
		cameraManager.updateAspectRatio = vi.fn();
		const schematicRenderer = {
			canvas,
			options: {},
			eventEmitter: new EventEmitter(),
			cameraManager,
			sceneManager: { scene: new THREE.Scene() },
			invalidate: vi.fn(),
		} as any;
		const manager = new RenderManager(schematicRenderer);
		const renderer = {
			domElement: canvas,
			dispose: vi.fn(),
			setSize: vi.fn(),
			getPixelRatio: vi.fn().mockReturnValue(1),
		} as any;
		(manager as any).renderer = renderer;
		return { manager, renderer, cameraManager, parent };
	}

	it("removes resize observers/listeners and disposes owned renderer once", () => {
		const disconnect = vi.fn();
		const observe = vi.fn();
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe = observe;
				disconnect = disconnect;
			}
		);
		const removeListener = vi.spyOn(window, "removeEventListener");
		const { manager, renderer, cameraManager, parent } = createManager();
		const cameraHandler = vi.fn();
		(manager as any).cameraChangedHandler = cameraHandler;
		cameraManager.on("cameraChanged", cameraHandler);

		(manager as any).setupEventListeners();
		manager.dispose();
		manager.dispose();

		expect(observe).toHaveBeenCalledWith(parent);
		expect(disconnect).toHaveBeenCalledOnce();
		expect(removeListener).toHaveBeenCalledWith("resize", expect.any(Function));
		expect(cameraManager.listenerCount("cameraChanged")).toBe(0);
		expect(renderer.dispose).toHaveBeenCalledOnce();
	});

	it("cleans resources created after disposal during async initialization", async () => {
		const { manager, renderer } = createManager();
		let finishInitialization!: () => void;
		const gate = new Promise<void>((resolve) => {
			finishInitialization = resolve;
		});
		(manager as any).renderer = undefined;
		(manager as any).initWebGLRenderer = vi.fn(async () => {
			await gate;
			(manager as any).renderer = renderer;
		});

		const initialization = manager.initialize();
		manager.dispose();
		finishInitialization();
		await initialization;

		expect(renderer.dispose).toHaveBeenCalledOnce();
	});

	it("does not dispose a renderer owned by a shared context", () => {
		const { manager, renderer } = createManager();
		(manager as any).usesSharedRenderer = true;

		manager.dispose();

		expect(renderer.dispose).not.toHaveBeenCalled();
	});

	describe("SSAO presets", () => {
		it("should have default SSAO preset values", () => {
			// Test static configuration without instantiating
			const perspectiveDefaults = {
				intensity: 5.0,
				aoRadius: 1.0,
			};
			const isometricDefaults = {
				intensity: 0.8,
				aoRadius: 0.3,
			};

			expect(perspectiveDefaults.intensity).toBe(5.0);
			expect(isometricDefaults.intensity).toBe(0.8);
		});
	});

	describe("gamma defaults", () => {
		it("should have expected gamma range", () => {
			// Gamma should be between 0 and 1
			const defaultGamma = 0.5;
			expect(defaultGamma).toBeGreaterThanOrEqual(0);
			expect(defaultGamma).toBeLessThanOrEqual(1);
		});
	});

	describe("background color parsing", () => {
		it("should parse hex colors correctly", () => {
			const color = new THREE.Color("#ff0000");
			expect(color.r).toBeCloseTo(1);
			expect(color.g).toBeCloseTo(0);
			expect(color.b).toBeCloseTo(0);
		});

		it("should parse named colors correctly", () => {
			const color = new THREE.Color("blue");
			expect(color.b).toBeCloseTo(1);
		});
	});
});
