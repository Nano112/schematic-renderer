// managers/RenderManager.ts
import * as THREE from "three";
// Lazy-loaded postprocessing imports to reduce initial bundle size (-3.3MB)
// import { EffectComposer, RenderPass, EffectPass } from "postprocessing";
// import { SMAAEffect } from "postprocessing";
// import { N8AOPostPass } from "n8ao";
// import { GammaCorrectionEffect } from "../effects/GammaCorrectionEffect";
import { EventEmitter } from "events";
import { SchematicRenderer } from "../SchematicRenderer";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { getClampedPixelRatio } from "../utils/pixelRatio";

// Dynamic imports for post-processing (loaded on-demand)
let EffectComposer: any = null;
let RenderPass: any = null;
let EffectPass: any = null;
let SMAAEffect: any = null;
let N8AOPostPass: any = null;
let GammaCorrectionEffect: any = null;
// Our own Scheimpflug tilt-shift effect. Lazy-loaded alongside postprocessing.
let TiltShiftPlaneEffect: any = null;
let postprocessingLoaded = false;

async function loadPostProcessing() {
	if (postprocessingLoaded) return;
	const postprocessing = await import("postprocessing");
	// @ts-ignore - n8ao doesn't have TypeScript definitions
	const n8ao = await import("n8ao");
	const gammaEffect = await import("../effects/GammaCorrectionEffect");

	EffectComposer = postprocessing.EffectComposer;
	RenderPass = postprocessing.RenderPass;
	EffectPass = postprocessing.EffectPass;
	SMAAEffect = postprocessing.SMAAEffect;
	N8AOPostPass = n8ao.N8AOPostPass;
	GammaCorrectionEffect = gammaEffect.GammaCorrectionEffect;
	const tiltModule = await import("../effects/TiltShiftPlaneEffect");
	TiltShiftPlaneEffect = tiltModule.TiltShiftPlaneEffect;
	postprocessingLoaded = true;
}

/**
 * Maps a 0..1 amount to DepthOfFieldEffect parameters so the user gets a
 * single "strength" knob that produces a miniature/tilt-shift look without
 * having to understand bokehScale/focusRange/focusDistance.
 *
 * - amount 0: wide focus, almost no blur
 * - amount 1: very narrow focus zone, strong bokeh
 *
 * `focusDistance` stays at 0 so the focus plane lives near the camera; the
 * orbit camera always centres the schematic, so that lands the focus on the
 * subject. `focusRange` controls how deep the in-focus slab is, `bokehScale`
 * controls how strong the blur is outside it.
 */
/**
 * Maps amount 0..1 to TiltShiftPlaneEffect parameters. We work in world
 * units (focusRange) and screen-UV units (blurStrength) so the controls
 * behave the same regardless of camera distance or canvas size.
 */
function tiltShiftAmountToParams(amount: number): {
	focusRange: number;
	blurStrength: number;
} {
	const a = Math.max(0, Math.min(1, amount));
	return {
		// Half-width of the in-focus slab in world units. Wide at 0, tight at 1.
		focusRange: 6 - a * 5.5,
		// Max sample radius in UV units. 0.005 ≈ subtle, 0.02 ≈ heavy bokeh.
		blurStrength: 0.005 + a * 0.02,
	};
}

// HDRI Cache using IndexedDB
const HDRI_CACHE_DB_NAME = "schematic-renderer-hdri-cache";
const HDRI_CACHE_STORE_NAME = "hdri-textures";
const HDRI_CACHE_VERSION = 1;

let hdriCacheDb: IDBDatabase | null = null;

async function openHdriCacheDb(): Promise<IDBDatabase> {
	if (hdriCacheDb) return hdriCacheDb;

	return new Promise((resolve, reject) => {
		const request = indexedDB.open(HDRI_CACHE_DB_NAME, HDRI_CACHE_VERSION);

		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			hdriCacheDb = request.result;
			resolve(hdriCacheDb);
		};

		request.onupgradeneeded = (event) => {
			const db = (event.target as IDBOpenDBRequest).result;
			if (!db.objectStoreNames.contains(HDRI_CACHE_STORE_NAME)) {
				db.createObjectStore(HDRI_CACHE_STORE_NAME, { keyPath: "url" });
			}
		};
	});
}

async function getCachedHdri(url: string): Promise<ArrayBuffer | null> {
	try {
		const db = await openHdriCacheDb();
		return new Promise((resolve) => {
			const transaction = db.transaction(HDRI_CACHE_STORE_NAME, "readonly");
			const store = transaction.objectStore(HDRI_CACHE_STORE_NAME);
			const request = store.get(url);

			request.onsuccess = () => {
				if (request.result) {
					console.log(`[HDRI Cache] Cache hit for: ${url}`);
					resolve(request.result.data);
				} else {
					resolve(null);
				}
			};
			request.onerror = () => resolve(null);
		});
	} catch {
		return null;
	}
}

async function cacheHdri(url: string, data: ArrayBuffer): Promise<void> {
	try {
		const db = await openHdriCacheDb();
		return new Promise((resolve) => {
			const transaction = db.transaction(HDRI_CACHE_STORE_NAME, "readwrite");
			const store = transaction.objectStore(HDRI_CACHE_STORE_NAME);
			store.put({ url, data, timestamp: Date.now() });
			transaction.oncomplete = () => {
				console.log(`[HDRI Cache] Cached: ${url}`);
				resolve();
			};
			transaction.onerror = () => resolve();
		});
	} catch {
		// Ignore cache errors
	}
}

// WebGPU imports (conditional - loaded dynamically)
let WebGPURenderer: any = null;
// @ts-expect-error Reserved for future WebGPU post-processing support
let _PostProcessing: any = null;
let Inspector: any = null;

// Type for renderer that can be either WebGL or WebGPU
type AnyRenderer = THREE.WebGLRenderer | any; // WebGPURenderer type

export class RenderManager {
	private schematicRenderer: SchematicRenderer;
	public renderer!: AnyRenderer;
	private composer!: any | null; // EffectComposer type (loaded dynamically)
	// @ts-expect-error Reserved for future WebGPU post-processing support
	private _postProcessing: any = null;
	private passes: Map<string, any> = new Map();
	private eventEmitter: EventEmitter;
	private pmremGenerator!: THREE.PMREMGenerator;
	private isRendering: boolean = false;
	private hdriPath: string | null = null;
	private hdriBackgroundOnly: boolean = true;
	private currentEnvMap: THREE.Texture | null = null;
	private disposed: boolean = false;
	private contextLost: boolean = false;
	private initialSizeSet: boolean = false;

	/**
	 * Device pixel ratio used to size every framebuffer, clamped (default 2) to keep
	 * GPU memory bounded on high-DPR mobile screens and avoid context-loss crashes.
	 */
	private get pixelRatio(): number {
		return getClampedPixelRatio(this.schematicRenderer.options.maxPixelRatio);
	}
	private resizeTimeout: number | null = null;
	private resizeHandler: (() => void) | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private cameraChangedHandler: ((event: { newCamera: string }) => void) | null = null;
	private renderFrameRequest: number | null = null;
	// Render-and-blit mode: when the context supplies a shared WebGL renderer, this
	// view renders into it and blits the result onto its own 2D canvas.
	private usesSharedRenderer = false;
	private blitCtx: CanvasRenderingContext2D | null = null;
	private renderRequested: boolean = false;

	// WebGPU state
	private _isWebGPU: boolean = false;
	// @ts-expect-error Reserved for future use
	private _webgpuInitialized: boolean = false;
	private inspector: any = null;

	// HDRI backup for camera switching
	private originalBackground: THREE.Texture | THREE.Color | null = null;
	private isometricBackground: THREE.Color;

	// Alpha mode state
	private _alphaMode: boolean = false;
	private _opaqueComposer: any | null = null;
	private _alphaComposer: any | null = null;

	// Background mode
	private _backgroundMode: "hdri" | "solid" | "transparent" | "image" = "hdri";
	private _forceBackground: boolean = false;
	private _imageBackground: THREE.Texture | null = null;

	// SSAO presets for different camera modes
	private ssaoPresets = {
		perspective: {
			aoRadius: 1.0,
			distanceFalloff: 0.4,
			intensity: 5.0,
		},
		isometric: {
			aoRadius: 0.3,
			distanceFalloff: 0.1,
			intensity: 0.8,
		},
	};

	constructor(schematicRenderer: SchematicRenderer) {
		this.schematicRenderer = schematicRenderer;
		this.eventEmitter = this.schematicRenderer.eventEmitter;

		// Create a pleasant background color for isometric view
		this.isometricBackground = new THREE.Color(0x7ea8ff); // Sky blue — matches the minecraft_day.hdr sky

		// Apply custom SSAO presets from options if provided
		const customSSAOPresets = schematicRenderer.options?.postProcessingOptions?.ssaoPresets;
		if (customSSAOPresets) {
			if (customSSAOPresets.perspective) {
				this.ssaoPresets.perspective = {
					...this.ssaoPresets.perspective,
					...customSSAOPresets.perspective,
				};
			}
			if (customSSAOPresets.isometric) {
				this.ssaoPresets.isometric = {
					...this.ssaoPresets.isometric,
					...customSSAOPresets.isometric,
				};
			}
		}

		this.setInitialSize();
	}

	/**
	 * Async initialization - must be called after constructor
	 */
	public async initialize(): Promise<void> {
		if (this.disposed) return;

		const webgpuOptions = this.schematicRenderer.options.webgpuOptions;
		const preferWebGPU = webgpuOptions?.preferWebGPU ?? false;
		const forceWebGPU = webgpuOptions?.forceWebGPU ?? false;

		if (preferWebGPU || forceWebGPU) {
			const webgpuAvailable = await this.checkWebGPUSupport();
			if (this.disposed) return;

			if (webgpuAvailable || forceWebGPU) {
				try {
					await this.initWebGPURenderer();
					this._isWebGPU = true;
					console.log(
						"%c[RenderManager] WebGPU Renderer initialized",
						"color: #4caf50; font-weight: bold"
					);
				} catch (error) {
					console.warn(
						"[RenderManager] WebGPU initialization failed, falling back to WebGL:",
						error
					);
					await this.initWebGLRenderer();
				}
			} else {
				console.log("[RenderManager] WebGPU not available, using WebGL");
				await this.initWebGLRenderer();
			}
		} else {
			await this.initWebGLRenderer();
		}

		// Initialization can outlive the owning SchematicRenderer. Dispose resources
		// created after teardown instead of attaching listeners to a dead instance.
		if (this.disposed) {
			this.dispose();
			return;
		}

		this.setupEventListeners();
		this.updateCanvasSize();

		// HDRI loading uses ShaderMaterials internally (PMREMGenerator, WebGLCubeRenderTarget)
		// which are not compatible with WebGPU's node-based material system.
		// Skip HDRI in WebGPU mode and use a solid color background.
		if (
			this.schematicRenderer.options?.hdri !== undefined &&
			this.schematicRenderer.options.hdri !== ""
		) {
			if (this._isWebGPU) {
				console.warn(
					"[RenderManager] HDRI backgrounds are not yet supported in WebGPU mode. Using solid color with enhanced lighting."
				);
				// Set a nice sky color
				this.schematicRenderer.sceneManager.scene.background = new THREE.Color(0x87ceeb);

				// Create a simple procedural environment for PBR materials
				// This provides basic ambient lighting for MeshStandardMaterial
				this.setupWebGPUEnvironment();
			} else {
				this.setupHDRIBackground(this.schematicRenderer.options.hdri);
			}
		}

		// Listen for camera changes to handle HDRI switching
		this.cameraChangedHandler = (event) => this.handleCameraChange(event.newCamera);
		this.schematicRenderer.cameraManager.on("cameraChanged", this.cameraChangedHandler);
	}

	/**
	 * Check if WebGPU is supported in the current browser
	 */
	private async checkWebGPUSupport(): Promise<boolean> {
		if (!navigator.gpu) {
			return false;
		}

		try {
			const adapter = await navigator.gpu.requestAdapter();
			if (!adapter) {
				return false;
			}

			// Try to get a device to verify full support
			const device = await adapter.requestDevice();
			device.destroy();

			return true;
		} catch (error) {
			console.warn("[RenderManager] WebGPU check failed:", error);
			return false;
		}
	}

	/**
	 * Check if currently using WebGPU renderer
	 */
	public get isWebGPU(): boolean {
		return this._isWebGPU;
	}

	/**
	 * Get the Three.js Inspector (WebGPU only)
	 */
	public getInspector(): any {
		return this.inspector;
	}

	/**
	 * Setup simple environment lighting for WebGPU mode
	 * Since HDRI/PMREMGenerator isn't compatible with WebGPU, we enhance
	 * the scene lighting to compensate for the lack of environment maps.
	 */
	private setupWebGPUEnvironment(): void {
		const scene = this.schematicRenderer.sceneManager.scene;
		const sceneManager = this.schematicRenderer.sceneManager;

		// Boost existing lights to compensate for no environment map
		// SceneManager stores lights in a Map, access via getLight if available
		if ((sceneManager as any).lights) {
			const lights = (sceneManager as any).lights as Map<string, THREE.Light>;
			const ambientLight = lights.get("ambientLight") as THREE.AmbientLight;
			if (ambientLight) {
				ambientLight.intensity = 3.5; // Boost ambient significantly
			}
			const directionalLight = lights.get("directionalLight") as THREE.DirectionalLight;
			if (directionalLight) {
				directionalLight.intensity = 1.5; // Boost directional
			}
		}

		// Add a hemisphere light for better sky/ground lighting
		const hemiLight = new THREE.HemisphereLight(
			0x87ceeb, // Sky color (light blue)
			0x666666, // Ground color (medium gray for better contrast)
			2.0 // Higher intensity
		);
		hemiLight.name = "webgpuHemiLight";
		scene.add(hemiLight);

		// Add a fill light from the opposite direction for better shading
		const fillLight = new THREE.DirectionalLight(0xffffff, 0.8);
		fillLight.position.set(-15, 15, 15);
		fillLight.name = "webgpuFillLight";
		scene.add(fillLight);

		// Add a back light for rim lighting effect
		const backLight = new THREE.DirectionalLight(0xffffcc, 0.4);
		backLight.position.set(0, -10, -20);
		backLight.name = "webgpuBackLight";
		scene.add(backLight);

		console.log("[RenderManager] WebGPU environment lighting configured");
	}

	private setInitialSize(): void {
		const canvas = this.schematicRenderer.canvas;
		const parent = canvas.parentElement;

		if (!parent) {
			console.warn("Canvas parent element not found");
			return;
		}

		const rect = parent.getBoundingClientRect();
		const width = rect.width;
		const height = rect.height;

		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;
		canvas.width = width * this.pixelRatio;
		canvas.height = height * this.pixelRatio;

		this.initialSizeSet = true;
	}

	/**
	 * Initialize WebGPU Renderer
	 */
	private async initWebGPURenderer(): Promise<void> {
		// Dynamically import WebGPU modules
		const webgpuModule = await import("three/webgpu");
		WebGPURenderer = webgpuModule.WebGPURenderer;
		_PostProcessing = webgpuModule.PostProcessing;

		// Try to import Inspector
		try {
			const inspectorModule = await import("three/examples/jsm/inspector/Inspector.js");
			Inspector = inspectorModule.Inspector;
		} catch (e) {
			console.warn("[RenderManager] Three.js Inspector not available:", e);
		}

		this.renderer = new WebGPURenderer({
			canvas: this.schematicRenderer.canvas,
			antialias: true,
			powerPreference: "high-performance",
		});

		// WebGPU requires async initialization
		await this.renderer.init();

		if (this.initialSizeSet) {
			const parent = this.schematicRenderer.canvas.parentElement;
			if (parent) {
				const width = parent.clientWidth;
				const height = parent.clientHeight;
				this.renderer.setSize(width, height, false);
			}
		}

		this.renderer.setPixelRatio(this.pixelRatio);

		// Initialize Inspector if available
		if (Inspector && this.schematicRenderer.options.debugOptions?.enableInspector) {
			try {
				this.inspector = new Inspector();
				this.inspector.setRenderer(this.renderer);
				console.log("[RenderManager] Three.js Inspector initialized");
			} catch (e) {
				console.warn("[RenderManager] Failed to initialize Inspector:", e);
			}
		}

		// WebGPU uses different post-processing
		// For now, we'll skip the complex post-processing and use basic rendering
		// The postprocessing library doesn't support WebGPU yet
		this.composer = null;
		this._webgpuInitialized = true;

		this.renderer.resetState();

		// Create PMREMGenerator for HDRI
		this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
	}

	/**
	 * Initialize WebGL Renderer (original code)
	 */
	private async initWebGLRenderer(): Promise<void> {
		// Render-and-blit: if the context provides a shared WebGL renderer, use it
		// instead of creating one per view, and make this view's visible canvas a 2D
		// canvas we blit the GL output onto. Otherwise behave exactly as before.
		const sharedGL = this.schematicRenderer.options.context?.getSharedGLRenderer?.() ?? null;
		if (sharedGL) {
			this.renderer = sharedGL;
			this.usesSharedRenderer = true;
			this.blitCtx = this.schematicRenderer.canvas.getContext("2d");
		} else {
			this.renderer = new THREE.WebGLRenderer({
				canvas: this.schematicRenderer.canvas,
				alpha: true,
				antialias: true,
				powerPreference: "high-performance",
				preserveDrawingBuffer: true,
			});
		}

		if (this.initialSizeSet && !this.usesSharedRenderer) {
			const parent = this.schematicRenderer.canvas.parentElement;
			if (parent) {
				const width = parent.clientWidth;
				const height = parent.clientHeight;
				this.renderer.setSize(width, height, false);
			}
		}

		this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
		if (!this.usesSharedRenderer) this.renderer.setPixelRatio(this.pixelRatio);

		// this.renderer.resetState();

		await this.initComposer();
		this.initDefaultPasses(this.schematicRenderer.options);
	}

	private async initComposer(): Promise<void> {
		if (this._isWebGPU) return; // WebGPU uses different post-processing

		const postOpts = this.schematicRenderer.options.postProcessingOptions;
		// If master switch disabled, don't create composer
		if (postOpts && postOpts.enabled === false) return;

		// If all individual effects disabled, don't create composer
		if (
			postOpts &&
			postOpts.enableSSAO === false &&
			postOpts.enableSMAA === false &&
			postOpts.enableGamma === false
		) {
			return;
		}

		// Lazy-load post-processing modules only when needed
		await loadPostProcessing();

		this.composer = new EffectComposer(this.renderer);
		const renderPass = new RenderPass(
			this.schematicRenderer.sceneManager.scene,
			this.schematicRenderer.cameraManager.activeCamera.camera
		);
		this.composer.addPass(renderPass);
		this.passes.set("renderPass", renderPass);
	}

	/**
	 * Handle camera type changes to manage HDRI background and SSAO appropriately
	 */
	private handleCameraChange(cameraType: string): void {
		const scene = this.schematicRenderer.sceneManager.scene;

		if (cameraType === "isometric") {
			// Store the current background if it's HDRI
			if (scene.background && scene.background instanceof THREE.Texture) {
				this.originalBackground = scene.background;
			}
			// Switch to solid color background for isometric view (unless forced)
			if (!this._forceBackground) {
				scene.background = this.isometricBackground;
			}

			// Adjust SSAO for isometric view (orthographic cameras have different depth)
			this.setSSAOParameters(this.ssaoPresets.isometric);

			console.log("Switched to isometric mode (background + SSAO adjusted)");
		} else {
			// Restore HDRI background for perspective cameras
			if (this.originalBackground) {
				scene.background = this.originalBackground;
				console.log("Restored HDRI background");
			}

			// Restore perspective SSAO settings
			this.setSSAOParameters(this.ssaoPresets.perspective);

			console.log("Switched to perspective mode (SSAO restored)");
		}
	}

	/**
	 * Check if current camera is orthographic (isometric)
	 */
	private isOrthographicCamera(): boolean {
		const activeCamera = this.schematicRenderer.cameraManager.activeCamera.camera;
		return activeCamera instanceof THREE.OrthographicCamera;
	}

	public setupHDRIBackground(hdriPath: string, backgroundOnly: boolean = true): void {
		this.hdriPath = hdriPath;
		this.hdriBackgroundOnly = backgroundOnly;

		this.loadHDRI(hdriPath, backgroundOnly);

		const canvas = this.renderer.domElement;
		canvas.removeEventListener("webglcontextlost", this.handleContextLost);
		canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);

		// Only add context lost handlers for WebGL
		if (!this._isWebGPU) {
			canvas.addEventListener("webglcontextlost", this.handleContextLost, false);
			canvas.addEventListener("webglcontextrestored", this.handleContextRestored, false);
		}
	}

	private isPMREMGeneratorDisposed(): boolean {
		return !this.pmremGenerator || (this.pmremGenerator as any)._blurMaterial === null;
	}

	private loadHDRI(hdriPath: string, backgroundOnly: boolean): void {
		// Try to load from cache first
		this.loadHDRIWithCache(hdriPath, backgroundOnly);
	}

	private async loadHDRIWithCache(hdriPath: string, backgroundOnly: boolean): Promise<void> {
		const hdriLoader = new RGBELoader();
		hdriLoader.setDataType(THREE.HalfFloatType);

		// Check cache first
		const cachedData = await getCachedHdri(hdriPath);

		if (cachedData) {
			// Load from cached ArrayBuffer
			try {
				const parseResult = hdriLoader.parse(cachedData);
				// Cast to DataTexture since parse returns RGBE type but actually gives us a texture
				const texture = parseResult as unknown as THREE.DataTexture;
				// Ensure texture has required properties for PMREMGenerator
				if (texture && texture.image && texture.image.width && texture.image.height) {
					texture.mapping = THREE.EquirectangularReflectionMapping;
					this.applyHDRITexture(texture, backgroundOnly, hdriPath);
					return;
				} else {
					console.warn("[HDRI Cache] Cached texture missing required properties, fetching fresh");
				}
			} catch (error) {
				console.warn("[HDRI Cache] Failed to parse cached data, fetching fresh:", error);
			}
		}

		// Fetch and cache using the standard load method which properly sets all texture properties
		hdriLoader.load(
			hdriPath,
			(texture) => {
				texture.mapping = THREE.EquirectangularReflectionMapping;
				this.applyHDRITexture(texture, backgroundOnly, hdriPath);

				// Cache the raw data for next time by re-fetching (load doesn't expose ArrayBuffer)
				fetch(hdriPath)
					.then((response) => response.arrayBuffer())
					.then((arrayBuffer) => cacheHdri(hdriPath, arrayBuffer))
					.catch(() => {
						/* Ignore cache errors */
					});
			},
			undefined,
			(error) => {
				console.error("HDRI loading failed:", error);
				this.eventEmitter.emit("hdriError", { error });
			}
		);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private applyHDRITexture(texture: any, backgroundOnly: boolean, hdriPath: string): void {
		if (this.disposed) {
			texture.dispose();
			return;
		}

		if (this.isPMREMGeneratorDisposed()) {
			this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
		}

		const envMap = this.pmremGenerator.fromEquirectangular(texture).texture;
		this.currentEnvMap = envMap;

		if (backgroundOnly) {
			const backgroundTexture = new THREE.WebGLCubeRenderTarget(1024).fromEquirectangularTexture(
				this.renderer,
				texture
			);

			// Only set HDRI background if not in isometric mode
			if (!this.isOrthographicCamera()) {
				this.schematicRenderer.sceneManager.scene.background = backgroundTexture.texture;
				// Store as original background for camera switching
				this.originalBackground = backgroundTexture.texture;
			} else {
				// Store for later use when switching back to perspective
				this.originalBackground = backgroundTexture.texture;
				// Keep isometric background
				this.schematicRenderer.sceneManager.scene.background = this.isometricBackground;
			}
		} else {
			this.schematicRenderer.sceneManager.scene.environment = envMap;
			if (!this.isOrthographicCamera()) {
				this.schematicRenderer.sceneManager.scene.background = envMap;
				this.originalBackground = envMap;
			} else {
				this.originalBackground = envMap;
				this.schematicRenderer.sceneManager.scene.background = this.isometricBackground;
			}
		}

		texture.dispose();
		this.pmremGenerator.dispose();
		this.eventEmitter.emit("hdriLoaded", { path: hdriPath });
	}

	/**
	 * Set the background color for isometric view
	 */
	public setIsometricBackgroundColor(color: THREE.ColorRepresentation): void {
		this.isometricBackground.set(color);

		// If currently in isometric mode, update the scene background immediately
		if (this.isOrthographicCamera()) {
			this.schematicRenderer.sceneManager.scene.background = this.isometricBackground;
		}
	}

	/**
	 * Get the current isometric background color
	 */
	public getIsometricBackgroundColor(): THREE.Color {
		return this.isometricBackground.clone();
	}

	private handleContextLost = (event: Event): void => {
		event.preventDefault();
		this.contextLost = true;
		this.isRendering = false;
		console.log("WebGL context lost. Suspending render operations...");
		this.eventEmitter.emit("webglContextLost");
	};

	private handleContextRestored = async (): Promise<void> => {
		console.log("WebGL context restored. Reinitializing renderer...");

		try {
			await new Promise((resolve) => setTimeout(resolve, 300));

			this.contextLost = false;

			await this.initWebGLRenderer();
			this.updateCanvasSize();

			if (this.hdriPath) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				this.loadHDRI(this.hdriPath, this.hdriBackgroundOnly);
			}

			this.eventEmitter.emit("webglContextRestored");

			requestAnimationFrame(() => {
				if (!this.contextLost) {
					this.render();
				}
			});
		} catch (error) {
			console.error("Error during context restoration:", error);
			this.eventEmitter.emit("webglContextError", { error });
		}
	};

	private initDefaultPasses(options: any): void {
		if (this._isWebGPU || !this.composer) return;

		const postOpts = this.schematicRenderer.options.postProcessingOptions;
		const effects = [];

		if (postOpts?.enableGamma !== false) {
			const gammaCorrectionEffect = new GammaCorrectionEffect(options.gamma ?? 0.5);
			this.passes.set("gammaCorrection", gammaCorrectionEffect);
			effects.push(gammaCorrectionEffect);
		}

		if (postOpts?.enableSMAA !== false) {
			const smaaEffect = new SMAAEffect();
			this.passes.set("smaa", smaaEffect);
			effects.push(smaaEffect);
		}

		// Depth-of-field (the "tilt-shift" miniature look). DepthOfFieldEffect
		// requires a depth texture and is expensive; we only construct the
		// effect + its pass the first time the user actually turns it on, so
		// the default render path is unchanged when it's off.

		if (postOpts?.enableSSAO !== false) {
			try {
				const parent = this.schematicRenderer.canvas.parentElement;
				const width = parent ? parent.clientWidth : window.innerWidth;
				const height = parent ? parent.clientHeight : window.innerHeight;

				const n8aoPass = new N8AOPostPass(
					this.schematicRenderer.sceneManager.scene,
					this.schematicRenderer.cameraManager.activeCamera.camera,
					width,
					height
				) as any;

				n8aoPass.configuration.aoRadius = 1.0;
				n8aoPass.configuration.distanceFalloff = 0.4;
				n8aoPass.configuration.intensity = 5.0;
				n8aoPass.configuration.gammaCorrection = false;
				n8aoPass.setQualityMode("Medium");

				this.passes.set("ssao", n8aoPass);
				this.composer.addPass(n8aoPass);
			} catch (error) {
				console.warn("Failed to initialize N8AO SSAO:", error);
			}
		}

		let effectPass: any = null;
		if (effects.length > 0) {
			effectPass = new EffectPass(
				this.schematicRenderer.cameraManager.activeCamera.camera,
				...effects
			);
			this.composer.addPass(effectPass);
			this.passes.set("effectPass", effectPass);
		}

		if (effectPass) {
			effectPass.renderToScreen = true;
		} else if (this.composer.passes.length > 1) {
			const lastPass = this.composer.passes[this.composer.passes.length - 1];
			if (lastPass) lastPass.renderToScreen = true;
		} else {
			this.composer = null;
		}

		// Honour `enableTiltShift: true` at boot by lazily building the pass
		// the same way a runtime toggle would.
		if (postOpts?.enableTiltShift === true) {
			this.setTiltShiftEnabled(true);
		}
	}

	private setupEventListeners(): void {
		if (this.resizeHandler || this.disposed) return;

		this.resizeHandler = () => {
			if (this.disposed) return;
			if (this.resizeTimeout) {
				window.cancelAnimationFrame(this.resizeTimeout);
			}
			this.resizeTimeout = window.requestAnimationFrame(() => {
				this.resizeTimeout = null;
				if (!this.disposed) this.updateCanvasSize();
			});
		};

		window.addEventListener("resize", this.resizeHandler);

		// Element resize catches layout changes that do not emit window.resize
		// (sidebar toggles, modal resizing, responsive grid changes, etc.).
		const parent = this.schematicRenderer.canvas.parentElement;
		if (parent && typeof ResizeObserver !== "undefined") {
			this.resizeObserver = new ResizeObserver(this.resizeHandler);
			this.resizeObserver.observe(parent);
		}
	}

	public updateCanvasSize(): void {
		if (this.disposed || !this.renderer) return;
		const canvas = this.schematicRenderer.canvas;
		const parent = canvas.parentElement;
		if (!parent) return;

		const width = parent.clientWidth;
		const height = parent.clientHeight;

		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;

		if (this.usesSharedRenderer) {
			// 2D blit canvas: size its backing store to device pixels (the shared GL
			// renderer is sized per-render in renderSharedAndBlit, not here).
			const dpr = this.pixelRatio;
			canvas.width = Math.max(1, Math.floor(width * dpr));
			canvas.height = Math.max(1, Math.floor(height * dpr));
			// Camera-type-aware (perspective or orthographic/isometric) + re-frames.
			this.schematicRenderer.cameraManager.updateAspectRatio(width / height);
		} else if (!this.contextLost) {
			this.renderer.setSize(width, height, false);

			if (this.composer) {
				this.composer.setSize(width, height);
			}

			const camera = this.schematicRenderer.cameraManager.activeCamera
				.camera as THREE.PerspectiveCamera;
			camera.aspect = width / height;
			camera.updateProjectionMatrix();

			const ssaoPass = this.passes.get("ssao");
			if (ssaoPass && ssaoPass.setSize) {
				const dpr = this.renderer.getPixelRatio();
				ssaoPass.setSize(width * dpr, height * dpr);
			}
		}
		// On-demand rendering: redraw at the new size.
		this.schematicRenderer.invalidate();
	}

	public enableEffect(effectName: string): void {
		const effect = this.passes.get(effectName);
		if (effect) {
			effect.enabled = true;
		}
	}

	public disableEffect(effectName: string): void {
		const effect = this.passes.get(effectName);
		if (effect) {
			effect.enabled = false;
		}
	}

	public setGamma(value: number): void {
		const gammaEffect = this.passes.get("gammaCorrection");
		if (gammaEffect) {
			gammaEffect.setGamma(value);
		}
	}

	/**
	 * Update the tilt-shift strength at runtime. `amount` is 0..1 where 0
	 * leaves nearly the whole frame in focus and 1 is a thin focus band with
	 * dramatic blur outside.
	 */
	/**
	 * Pending amount for tilt-shift when the effect doesn't exist yet (the
	 * user moved the slider before turning the effect on).
	 */
	private _pendingTiltShiftAmount: number | null = null;

	public setTiltShiftAmount(amount: number): void {
		const effect = this.passes.get("tiltShift");
		if (!effect) {
			this._pendingTiltShiftAmount = amount;
			return;
		}
		const params = tiltShiftAmountToParams(amount);
		effect.setFocusRange?.(params.focusRange);
		effect.setBlurStrength?.(params.blurStrength);
		this.updateTiltShiftGizmo();
	}

	/**
	 * Read focus params back off the effect's uniforms and push them into the
	 * gizmo so the visual stays in sync with the shader.
	 */
	private updateTiltShiftGizmo(): void {
		if (!this.tiltShiftGizmo) return;
		const effect = this.passes.get("tiltShift");
		if (!effect?.uniforms) return;
		const point = effect.uniforms.get("focusPoint")?.value as THREE.Vector3 | undefined;
		const normal = effect.uniforms.get("focusNormal")?.value as THREE.Vector3 | undefined;
		const range = effect.uniforms.get("focusRange")?.value as number | undefined;
		if (!point || !normal || range == null) return;
		this.tiltShiftGizmo.update(point, normal, range);
	}

	/** Show or hide the tilt-shift focus-plane gizmo. */
	public setTiltShiftGizmoVisible(visible: boolean): void {
		this.tiltShiftGizmoVisible = visible;
		this.tiltShiftGizmo?.setVisible(visible);
	}

	/**
	 * Move the tilt-shift focus point to a specific world-space position.
	 * Used by the click-to-focus picker after a raycast hit.
	 */
	public setTiltShiftFocusPoint(point: THREE.Vector3): void {
		const effect = this.passes.get("tiltShift");
		effect?.setFocusPoint?.(point);
		this.updateTiltShiftGizmo();
	}

	/**
	 * Tilt the focus plane by `pitchDeg` (around camera right) and
	 * `yawDeg` (around camera up). Pitch is the actual Scheimpflug tilt;
	 * a non-zero value is what makes this different from regular DOF.
	 */
	public setTiltShiftTilt(pitchDeg: number, yawDeg: number): void {
		const effect = this.passes.get("tiltShift");
		effect?.setTiltAngles?.(pitchDeg, yawDeg);
		this._pendingTiltPitch = pitchDeg;
		this._pendingTiltYaw = yawDeg;
		this.updateTiltShiftGizmo();
	}

	private _pendingTiltPitch = 0;
	private _pendingTiltYaw = 0;
	private tiltShiftGizmo: import("../effects/TiltShiftGizmo").TiltShiftGizmo | null = null;
	private tiltShiftGizmoVisible = true;

	private _focusPickRaycaster: THREE.Raycaster | null = null;

	/**
	 * Arm a one-shot click handler that raycasts the next canvas click into
	 * the schematic, computes the world distance from camera to the hit
	 * point, and sets that as the tilt-shift focus plane. Escape cancels.
	 */
	public pickTiltShiftFocus(): void {
		const canvas = this.schematicRenderer.canvas;
		const prevCursor = canvas.style.cursor;
		canvas.style.cursor = "crosshair";

		const onClick = (e: MouseEvent) => {
			e.stopPropagation();
			e.preventDefault();
			cleanup();
			this.focusTiltShiftOnScreenPoint(e.clientX, e.clientY);
		};
		const onEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") cleanup();
		};
		const cleanup = () => {
			canvas.style.cursor = prevCursor;
			canvas.removeEventListener("click", onClick, true);
			window.removeEventListener("keydown", onEscape);
		};

		// Capture-phase so we run before any block-interaction handlers can
		// claim the click.
		canvas.addEventListener("click", onClick, true);
		window.addEventListener("keydown", onEscape);
	}

	/**
	 * Raycast through the screen point into all loaded schematics; if any
	 * geometry is hit, set the tilt-shift focus distance to the hit's
	 * camera-space depth.
	 */
	private focusTiltShiftOnScreenPoint(clientX: number, clientY: number): void {
		const canvas = this.schematicRenderer.canvas;
		const camera = this.schematicRenderer.cameraManager?.activeCamera?.camera;
		if (!camera) return;

		const rect = canvas.getBoundingClientRect();
		const ndc = new THREE.Vector2(
			((clientX - rect.left) / rect.width) * 2 - 1,
			-(((clientY - rect.top) / rect.height) * 2 - 1)
		);

		if (!this._focusPickRaycaster) this._focusPickRaycaster = new THREE.Raycaster();
		this._focusPickRaycaster.setFromCamera(ndc, camera);

		const targets: THREE.Object3D[] = [];
		const schematics = this.schematicRenderer.schematicManager?.getAllSchematics?.() ?? [];
		for (const s of schematics) if (s.group) targets.push(s.group);
		if (targets.length === 0) return;

		const hits = this._focusPickRaycaster.intersectObjects(targets, true);
		if (hits.length === 0) return;
		// The Scheimpflug effect anchors focus on a world-space point, not a
		// distance — that way the plane's tilt makes sense in the scene rather
		// than around the camera.
		this.setTiltShiftFocusPoint(hits[0].point);
	}

	/**
	 * Compute a sensible initial focus point in world space — the centre of
	 * the first loaded schematic when available, falling back to the camera's
	 * lookAt target or origin.
	 */
	private computeSubjectWorldPosition(): THREE.Vector3 {
		const sm = this.schematicRenderer.schematicManager;
		const first = sm?.getFirstSchematic?.();
		if (first?.group) {
			const p = new THREE.Vector3();
			first.group.getWorldPosition(p);
			return p;
		}
		const cam = this.schematicRenderer.cameraManager?.activeCamera?.camera as any;
		return (cam?.userData?.target as THREE.Vector3 | undefined) ?? new THREE.Vector3();
	}

	/**
	 * Enable or disable the depth-of-field/tilt-shift pass. The first call
	 * with `true` lazily constructs the effect + pass (DepthOfFieldEffect is
	 * expensive and needs a depth texture, so we only allocate it when
	 * actually used). Subsequent toggles just flip `pass.enabled` and move
	 * `renderToScreen` to whichever pass is the final visible one.
	 */
	public setTiltShiftEnabled(enabled: boolean): void {
		if (!this.composer || !TiltShiftPlaneEffect || !EffectPass) return;
		let tiltPass = this.passes.get("tiltShiftPass");
		const effectPass = this.passes.get("effectPass");

		if (enabled && !tiltPass) {
			const amount = this._pendingTiltShiftAmount ?? 0.5;
			const params = tiltShiftAmountToParams(amount);
			const camera = this.schematicRenderer.cameraManager.activeCamera.camera;
			const focusPoint = this.computeSubjectWorldPosition();

			const effect = new TiltShiftPlaneEffect(camera, {
				focusPoint,
				focusRange: params.focusRange,
				blurStrength: params.blurStrength,
			});
			effect.setTiltAngles(this._pendingTiltPitch, this._pendingTiltYaw);

			tiltPass = new EffectPass(camera, effect);
			this.passes.set("tiltShift", effect);
			this.passes.set("tiltShiftPass", tiltPass);
			this.composer.addPass(tiltPass);

			const parent = this.schematicRenderer.canvas.parentElement;
			const width = parent ? parent.clientWidth : window.innerWidth;
			const height = parent ? parent.clientHeight : window.innerHeight;
			this.composer.setSize?.(width, height);

			// Lazy-build the gizmo too so the scene shows the focus plane.
			void this.ensureTiltShiftGizmo();
		}

		if (!tiltPass) return;
		tiltPass.enabled = enabled;
		if (effectPass) effectPass.renderToScreen = !enabled;
		tiltPass.renderToScreen = enabled;
		// Gizmo follows the effect's enable state, but only if the user
		// hasn't explicitly hidden it via setTiltShiftGizmoVisible(false).
		this.tiltShiftGizmo?.setVisible(enabled && this.tiltShiftGizmoVisible);
		if (enabled) this.updateTiltShiftGizmo();
	}

	/**
	 * Build the focus-plane gizmo and attach it to the scene the first time
	 * tilt-shift is enabled. Subsequent calls are no-ops.
	 */
	private async ensureTiltShiftGizmo(): Promise<void> {
		if (this.tiltShiftGizmo) return;
		const { TiltShiftGizmo } = await import("../effects/TiltShiftGizmo");
		const scene = this.schematicRenderer.sceneManager?.scene;
		if (!scene) return;
		this.tiltShiftGizmo = new TiltShiftGizmo(scene);
		this.tiltShiftGizmo.setVisible(this.tiltShiftGizmoVisible);
		this.updateTiltShiftGizmo();
	}

	/**
	 * Enable or disable SSAO at runtime
	 * Useful for auto-disabling on small schematics or performance optimization
	 */
	public setSSAOEnabled(enabled: boolean): void {
		const ssaoPass = this.passes.get("ssao");
		if (ssaoPass) {
			ssaoPass.enabled = enabled;
			if (!enabled) {
				console.log("[RenderManager] SSAO disabled for performance");
			}
		}
	}

	/**
	 * Check if SSAO is currently enabled
	 */
	public isSSAOEnabled(): boolean {
		const ssaoPass = this.passes.get("ssao");
		return ssaoPass?.enabled ?? false;
	}

	public setSSAOParameters(params: {
		aoRadius?: number;
		distanceFalloff?: number;
		intensity?: number;
		qualityMode?: "Performance" | "Low" | "Medium" | "High" | "Ultra";
	}): void {
		const ssaoEffect = this.passes.get("ssao");
		if (ssaoEffect && ssaoEffect.configuration) {
			if (params.aoRadius !== undefined) {
				ssaoEffect.configuration.aoRadius = params.aoRadius;
			}
			if (params.distanceFalloff !== undefined) {
				ssaoEffect.configuration.distanceFalloff = params.distanceFalloff;
			}
			if (params.intensity !== undefined) {
				ssaoEffect.configuration.intensity = params.intensity;
			}
			if (params.qualityMode !== undefined) {
				ssaoEffect.setQualityMode(params.qualityMode);
			}
		}
	}

	/**
	 * Customize SSAO presets for different camera modes
	 * @param mode - Camera mode ('perspective' or 'isometric')
	 * @param params - SSAO parameters to apply for this mode
	 */
	public setSSAOPreset(
		mode: "perspective" | "isometric",
		params: {
			aoRadius?: number;
			distanceFalloff?: number;
			intensity?: number;
		}
	): void {
		this.ssaoPresets[mode] = {
			...this.ssaoPresets[mode],
			...params,
		};

		// If we're currently in this mode, apply the changes immediately
		const currentCameraType = this.isOrthographicCamera() ? "isometric" : "perspective";
		if (currentCameraType === mode) {
			this.setSSAOParameters(this.ssaoPresets[mode]);
		}

		console.log(`SSAO preset updated for ${mode} mode:`, this.ssaoPresets[mode]);
	}

	/**
	 * Get current SSAO presets
	 */
	public getSSAOPresets(): {
		perspective: { aoRadius: number; distanceFalloff: number; intensity: number };
		isometric: { aoRadius: number; distanceFalloff: number; intensity: number };
	} {
		return {
			perspective: { ...this.ssaoPresets.perspective },
			isometric: { ...this.ssaoPresets.isometric },
		};
	}

	public renderSingleFrameAndGetStats(): {
		renderTimeMs: number;
		rendererInfo: THREE.WebGLInfo | null;
	} {
		if (this.isRendering || this.contextLost || this.disposed) {
			console.warn(
				"[RenderManager] Attempted renderSingleFrameAndGetStats while busy, context lost, or disposed."
			);
			return { renderTimeMs: 0, rendererInfo: null };
		}

		const scene = this.schematicRenderer.sceneManager.scene;
		const camera = this.schematicRenderer.cameraManager.activeCamera.camera;
		const renderer = this.renderer;

		if (!renderer || !scene || !camera) {
			console.error(
				"[RenderManager] Renderer, scene, or camera not available for renderSingleFrameAndGetStats."
			);
			return { renderTimeMs: 0, rendererInfo: renderer ? renderer.info : null };
		}

		// Skip context check for WebGPU
		if (!this._isWebGPU) {
			const gl = renderer.getContext();
			if (!gl || gl.isContextLost()) {
				console.warn("[RenderManager] Attempted to render with lost WebGL context for stats.");
				this.contextLost = true;
				return { renderTimeMs: 0, rendererInfo: renderer.info };
			}
		}

		const renderStartTime = performance.now();
		try {
			this.isRendering = true;

			if (this._isWebGPU) {
				// WebGPU direct rendering
				this.renderer.render(scene, camera);
			} else if (this.composer) {
				this.composer.render();
			} else {
				this.renderer.render(scene, camera);
			}
		} catch (error) {
			console.error("[RenderManager] Error during renderSingleFrameAndGetStats:", error);
			this.eventEmitter.emit("renderError", { error });
			return {
				renderTimeMs: performance.now() - renderStartTime,
				rendererInfo: renderer.info,
			};
		} finally {
			this.isRendering = false;
		}
		const renderTimeMs = performance.now() - renderStartTime;

		return { renderTimeMs, rendererInfo: renderer.info };
	}

	/**
	 * Render-and-blit: size the shared WebGL renderer to this view, render this
	 * view's scene (through its own composer, so post-processing/gamma is preserved),
	 * then copy the GL canvas onto this view's visible 2D canvas.
	 */
	private renderSharedAndBlit(): void {
		const viewCanvas = this.schematicRenderer.canvas;
		// CSS-pixel size (the shared renderer applies its own pixelRatio to get the
		// device-pixel drawing buffer — same convention as the non-shared path).
		const cssW = viewCanvas.clientWidth;
		const cssH = viewCanvas.clientHeight;
		if (cssW === 0 || cssH === 0 || !this.blitCtx) return;

		// Self-size the 2D backing store + camera aspect to match the laid-out canvas
		// (this view's canvas isn't sized by the shared renderer, so do it here).
		const dpr = this.pixelRatio;
		const dw = Math.max(1, Math.floor(cssW * dpr));
		const dh = Math.max(1, Math.floor(cssH * dpr));
		if (viewCanvas.width !== dw || viewCanvas.height !== dh) {
			viewCanvas.width = dw;
			viewCanvas.height = dh;
			// Camera-type-aware (perspective or orthographic/isometric) + re-frames.
			this.schematicRenderer.cameraManager.updateAspectRatio(cssW / cssH);
		}

		// Match the shared renderer to this view before rendering it.
		this.renderer.setSize(cssW, cssH, false);
		if (this.composer) {
			this.composer.setSize(cssW, cssH);
			this.composer.render();
		} else {
			this.renderer.render(
				this.schematicRenderer.sceneManager.scene,
				this.schematicRenderer.cameraManager.activeCamera.camera
			);
		}

		// Copy the GL frame onto this view's 2D canvas, scaling the shared GL canvas
		// (device-pixel buffer) to fill this canvas's device-pixel backing store 1:1.
		this.blitCtx.clearRect(0, 0, dw, dh);
		this.blitCtx.drawImage(this.renderer.domElement, 0, 0, dw, dh);
	}

	public render(): void {
		if (this.isRendering || this.contextLost || this.disposed) return;

		try {
			this.isRendering = true;

			// Skip context check for WebGPU
			if (!this._isWebGPU) {
				const gl = this.renderer.getContext();
				if (!gl || gl.isContextLost()) {
					console.warn("Attempted to render with lost WebGL context");
					this.contextLost = true;
					return;
				}
			}

			if (this._isWebGPU) {
				// WebGPU rendering
				const scene = this.schematicRenderer.sceneManager.scene;
				const camera = this.schematicRenderer.cameraManager.activeCamera.camera;
				this.renderer.render(scene, camera);

				// Resolve timestamp queries to prevent overflow (for Inspector)
				if (this.renderer.resolveTimestampsAsync) {
					this.renderer.resolveTimestampsAsync("render").catch(() => {
						// Silently ignore - timestamps are optional for profiling
					});
				}
			} else if (this.usesSharedRenderer) {
				this.renderSharedAndBlit();
			} else if (this.composer) {
				this.composer.render();
			} else {
				// Fallback for WebGL without composer (post-processing disabled)
				this.renderer.render(
					this.schematicRenderer.sceneManager.scene,
					this.schematicRenderer.cameraManager.activeCamera.camera
				);
			}

			// if (!this._isWebGPU) {
			// 	this.renderer.resetState();
			// }
		} catch (error) {
			console.error("Render error:", error);
			this.eventEmitter.emit("renderError", { error });
		} finally {
			this.isRendering = false;
		}
	}

	public requestRender(): void {
		if (!this.renderRequested && !this.contextLost && !this.disposed) {
			this.renderRequested = true;
			this.renderFrameRequest = requestAnimationFrame(() => {
				this.renderFrameRequest = null;
				if (!this.contextLost && !this.disposed) {
					this.render();
				}
				this.renderRequested = false;
			});
		}
	}

	public resize(width: number, height: number): void {
		if (this.contextLost) return;

		this.renderer.setSize(width, height, false);

		if (this.composer) {
			this.composer.setSize(width, height);
		}

		const camera = this.schematicRenderer.cameraManager.activeCamera
			.camera as THREE.PerspectiveCamera;
		camera.aspect = width / height;
		camera.updateProjectionMatrix();

		const ssaoPass = this.passes.get("ssao");
		if (ssaoPass && ssaoPass.setSize) {
			ssaoPass.setSize(width, height);
		}
	}

	public updateCamera(camera: THREE.Camera): void {
		const renderPass = this.passes.get("renderPass");
		if (renderPass) {
			renderPass.camera = camera;
		}

		const effectPass = this.passes.get("effectPass");
		if (effectPass) {
			effectPass.camera = camera;
		}

		const ssaoEffect = this.passes.get("ssao");
		if (ssaoEffect && ssaoEffect.camera) {
			ssaoEffect.camera = camera;
		}
	}

	public getRenderer(): AnyRenderer {
		return this.renderer;
	}

	public getEffect(effectName: string): any {
		return this.passes.get(effectName);
	}

	public dispose(): void {
		this.disposed = true;
		this.contextLost = true;

		if (this.resizeTimeout !== null) {
			window.cancelAnimationFrame(this.resizeTimeout);
			this.resizeTimeout = null;
		}

		if (this.renderFrameRequest !== null) {
			cancelAnimationFrame(this.renderFrameRequest);
			this.renderFrameRequest = null;
			this.renderRequested = false;
		}

		if (this.resizeHandler) {
			window.removeEventListener("resize", this.resizeHandler);
			this.resizeHandler = null;
		}
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;

		if (this.cameraChangedHandler) {
			this.schematicRenderer.cameraManager.off("cameraChanged", this.cameraChangedHandler);
			this.cameraChangedHandler = null;
		}

		const renderer = this.renderer;
		const canvas = renderer?.domElement;
		canvas?.removeEventListener("webglcontextlost", this.handleContextLost);
		canvas?.removeEventListener("webglcontextrestored", this.handleContextRestored);

		this.passes.forEach((pass) => {
			if (pass.dispose) pass.dispose();
		});
		this.passes.clear();

		const composers = new Set(
			[this.composer, this._opaqueComposer, this._alphaComposer].filter(Boolean)
		);
		composers.forEach((composer) => composer.dispose?.());
		this.composer = null;
		this._opaqueComposer = null;
		this._alphaComposer = null;

		if (this.pmremGenerator && !this.isPMREMGeneratorDisposed()) {
			this.pmremGenerator.dispose();
		}
		this.pmremGenerator = undefined as unknown as THREE.PMREMGenerator;

		const textures = new Set<THREE.Texture>();
		if (this.currentEnvMap) textures.add(this.currentEnvMap);
		if (this.originalBackground instanceof THREE.Texture) textures.add(this.originalBackground);
		if (this._imageBackground) textures.add(this._imageBackground);
		textures.forEach((texture) => texture.dispose());
		this.currentEnvMap = null;
		this.originalBackground = null;
		this._imageBackground = null;

		const scene = this.schematicRenderer.sceneManager?.scene;
		if (scene?.background instanceof THREE.Texture && textures.has(scene.background)) {
			scene.background = null;
		}
		if (scene?.environment && textures.has(scene.environment)) {
			scene.environment = null;
		}

		if (this.inspector) {
			// Inspector cleanup if needed
			this.inspector = null;
		}

		// Don't dispose a shared renderer — it's owned by the context and used by
		// sibling views. The context disposes it.
		if (!this.usesSharedRenderer && renderer) {
			renderer.dispose();
		}
		this.renderer = undefined as unknown as AnyRenderer;
		this.blitCtx = null;
	}

	// ===== ALPHA MODE API =====

	/**
	 * Enable or disable alpha-aware rendering for transparent backgrounds.
	 * When enabled, creates an EffectComposer with { alpha: true } that preserves
	 * the alpha channel through the post-processing pipeline (gamma, SMAA, etc.).
	 */
	public async setAlphaMode(enabled: boolean): Promise<void> {
		if (this.disposed || this._alphaMode === enabled) return;
		this._alphaMode = enabled;

		if (enabled) {
			// Save the opaque composer
			if (this.composer && !this._opaqueComposer) {
				this._opaqueComposer = this.composer;
			}

			// Build fresh alpha composer
			await loadPostProcessing();
			if (this.disposed) return;
			const glRenderer = this.renderer as THREE.WebGLRenderer;
			const cam = this.schematicRenderer.cameraManager.activeCamera.camera;
			const scene = this.schematicRenderer.sceneManager.scene;
			const gamma = this.schematicRenderer.options.gamma ?? 0.5;

			const alphaComposer = new EffectComposer(glRenderer, { alpha: true });
			const renderPass = new RenderPass(scene, cam);
			alphaComposer.addPass(renderPass);

			const effects: any[] = [];
			effects.push(new GammaCorrectionEffect(gamma));
			try {
				effects.push(new SMAAEffect());
			} catch (_) {}

			if (effects.length > 0) {
				const effectPass = new EffectPass(cam, ...effects);
				effectPass.renderToScreen = true;
				alphaComposer.addPass(effectPass);
			}

			// Dispose previous alpha composer if exists
			if (this._alphaComposer) {
				try {
					this._alphaComposer.dispose();
				} catch (_) {}
			}
			this._alphaComposer = alphaComposer;
			this.composer = alphaComposer;

			glRenderer.setClearColor(0x000000, 0);
		} else {
			// Restore opaque composer
			if (this._alphaComposer && this.composer === this._alphaComposer) {
				try {
					this._alphaComposer.dispose();
				} catch (_) {}
				this._alphaComposer = null;
			}
			if (this._opaqueComposer) {
				this.composer = this._opaqueComposer;
			}

			const glRenderer = this.renderer as THREE.WebGLRenderer;
			glRenderer.setClearColor(0x000000, 1);
		}
	}

	/** Returns whether alpha mode is currently active */
	public isAlphaMode(): boolean {
		return this._alphaMode;
	}

	// ===== BACKGROUND MODE API =====

	/**
	 * Set the background rendering mode.
	 * @param mode - The background mode
	 * @param options - Mode-specific options
	 */
	public async setBackgroundMode(
		mode: "hdri" | "solid" | "transparent" | "image",
		options: {
			/** HDRI file path (for "hdri" mode) */
			hdriPath?: string;
			/** Whether HDRI is background-only vs environment+background (default true) */
			hdriBackgroundOnly?: boolean;
			/** Solid color (for "solid" mode) */
			color?: THREE.ColorRepresentation;
			/** Image texture (for "image" mode) */
			imageTexture?: THREE.Texture;
			/** Force this background even in isometric mode (default false) */
			force?: boolean;
		} = {}
	): Promise<void> {
		this._backgroundMode = mode;
		this._forceBackground = options.force ?? false;
		const scene = this.schematicRenderer.sceneManager.scene;

		switch (mode) {
			case "hdri":
				await this.setAlphaMode(false);
				if (options.hdriPath) {
					this.setupHDRIBackground(options.hdriPath, options.hdriBackgroundOnly ?? true);
				}
				// Force HDRI even in isometric if requested
				if (this._forceBackground && this.isOrthographicCamera() && this.originalBackground) {
					scene.background = this.originalBackground;
				}
				break;

			case "solid": {
				await this.setAlphaMode(false);
				const color = new THREE.Color(options.color ?? 0x222222);
				scene.background = color;
				(this.renderer as THREE.WebGLRenderer).setClearColor(color, 1);
				break;
			}

			case "transparent":
				await this.setAlphaMode(true);
				scene.background = null;
				scene.environment = null;
				break;

			case "image":
				await this.setAlphaMode(false);
				if (options.imageTexture) {
					if (this._imageBackground) this._imageBackground.dispose();
					this._imageBackground = options.imageTexture;
				}
				if (this._imageBackground) {
					scene.background = this._imageBackground;
				}
				(this.renderer as THREE.WebGLRenderer).setClearColor(0x000000, 1);
				break;
		}
	}

	/** Get current background mode */
	public getBackgroundMode(): string {
		return this._backgroundMode;
	}
}
