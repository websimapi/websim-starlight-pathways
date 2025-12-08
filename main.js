import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import Matter from 'matter-js';
import { LevelManager } from './levels.js';

// --- Constants ---
const PHYSICS_SCALE = 0.1; // Scale down input coords to physics world
const PARTICLE_RADIUS = 3;
const MAX_PARTICLES = 1200;
const Z_PLANE = 0;

// --- Globals ---
let scene, camera, renderer, composer;
let engine, world;
let particles = [];
let drawnBodies = [];
let currentLineBody = null;
let lastDrawPoint = null;
let isDrawing = false;
let levelManager;
let raycaster = new THREE.Raycaster();
let pointer = new THREE.Vector2();
let particleInstancedMesh;
let dummy = new THREE.Object3D();
let cursorLight;
let colorPalette = {
    white: new THREE.Color(0xffffff),
    red: new THREE.Color(0xff3333),
    blue: new THREE.Color(0x3333ff),
    green: new THREE.Color(0x33ff33),
    purple: new THREE.Color(0xaa33ff)
};

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let bgGain;

// --- Assets ---
const textureLoader = new THREE.TextureLoader();
const particleTexture = textureLoader.load('./particle.png');
const bgTexture = textureLoader.load('./bg_stars.png');

// --- Initialization ---
function init() {
    // 1. Three.js Setup
    scene = new THREE.Scene();

    // Camera
    const aspect = window.innerWidth / window.innerHeight;
    const frustumSize = 100; // View height in world units roughly
    camera = new THREE.PerspectiveCamera(45, aspect, 1, 1000);
    camera.position.set(0, 0, 120);

    // Renderer
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Perf optimization
    document.getElementById('canvas-container').appendChild(renderer.domElement);

    // Post-processing (Bloom)
    const renderScene = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
    bloomPass.threshold = 0.1;
    bloomPass.strength = 1.2;
    bloomPass.radius = 0.5;

    composer = new EffectComposer(renderer);
    composer.addPass(renderScene);
    composer.addPass(bloomPass);

    // 2. Matter.js Setup
    engine = Matter.Engine.create();
    world = engine.world;
    engine.gravity.y = 0.5; // Positive is down in canvas usually, but let's check coord mapping

    // 3. Particles Visualization
    const particleGeo = new THREE.PlaneGeometry(2.5, 2.5);
    const particleMat = new THREE.MeshBasicMaterial({
        map: particleTexture,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        color: 0xffffff
    });
    particleInstancedMesh = new THREE.InstancedMesh(particleGeo, particleMat, MAX_PARTICLES);
    particleInstancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(particleInstancedMesh);

    // Cursor Light
    cursorLight = new THREE.PointLight(0xffaa00, 3, 25);
    cursorLight.position.set(0, 0, 5);
    cursorLight.visible = false;
    scene.add(cursorLight);

    // 4. Input Listeners
    window.addEventListener('resize', onWindowResize);
    const canvas = renderer.domElement;
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);

    // UI Buttons
    document.getElementById('btn-clear').addEventListener('click', clearDrawnLines);
    document.getElementById('btn-undo').addEventListener('click', undoLastLine);
    document.getElementById('btn-reset').addEventListener('click', () => {
        clearDrawnLines();
        levelManager.resetLevel();
    });
    document.getElementById('btn-next').addEventListener('click', () => {
        document.getElementById('overlay-message').classList.remove('visible');
        clearDrawnLines();
        levelManager.nextLevel();
    });

    // 5. Level System
    levelManager = new LevelManager(scene, world, particles, colorPalette, onLevelComplete, onScoreUpdate);
    levelManager.loadLevel(0);

    // 6. Audio
    initAudio();

    // Resize once to set correct zoom
    onWindowResize();

    // 7. Start Loop
    animate();
}

function initAudio() {
    window.addEventListener('click', () => {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        if (!bgGain) {
            playAmbient();
        }
    }, { once: true });
}

async function playAmbient() {
    const response = await fetch('./sound_hum.mp3');
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.loop = true;
    bgGain = audioCtx.createGain();
    bgGain.gain.value = 0.3;
    source.connect(bgGain);
    bgGain.connect(audioCtx.destination);
    source.start();
}

function playChime() {
    if (audioCtx.state === 'suspended') return;
    const audio = new Audio('./sound_chime.mp3');
    audio.volume = 0.2;
    audio.play().catch(e => {});
}

// --- Input Handling ---

function getWorldPoint(event) {
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const target = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, target);
    return target;
}

function onPointerDown(event) {
    if (event.target.closest('#ui-layer')) return; 
    isDrawing = true;
    const point = getWorldPoint(event);
    cursorLight.position.copy(point);
    cursorLight.position.z = 2;
    cursorLight.visible = true;
    startNewLine(point);
}

function onPointerMove(event) {
    if (!isDrawing) return;
    const point = getWorldPoint(event);
    cursorLight.position.copy(point);
    cursorLight.position.z = 2;
    extendLine(point);
}

function onPointerUp() {
    isDrawing = false;
    cursorLight.visible = false;
    currentLineBody = null;
    lastDrawPoint = null;
}

// --- Line Logic ---

function startNewLine(point) {
    lastDrawPoint = point.clone();

    const material = new THREE.LineBasicMaterial({
        color: 0xffddaa,
        linewidth: 4 
    });

    const geometry = new THREE.BufferGeometry().setFromPoints([point, point]);
    const line = new THREE.Line(geometry, material);
    scene.add(line);

    currentLineBody = {
        visual: line,
        points: [point.clone()],
        physicsBodies: []
    };
    drawnBodies.push(currentLineBody);
}

function extendLine(point) {
    if (!lastDrawPoint || !currentLineBody) return;

    const dist = lastDrawPoint.distanceTo(point);
    if (dist < 1.0) return; // Smoother lines

    currentLineBody.points.push(point.clone());
    currentLineBody.visual.geometry.setFromPoints(currentLineBody.points);

    const midX = (lastDrawPoint.x + point.x) / 2;
    const midY = (lastDrawPoint.y + point.y) / 2;
    const angle = Math.atan2(point.y - lastDrawPoint.y, point.x - lastDrawPoint.x);
    const len = dist;

    const body = Matter.Bodies.rectangle(midX, midY, len, 0.5, {
        isStatic: true,
        angle: angle,
        friction: 0,
        restitution: 0.2 // Reduced restitution to prevent excessive bouncing
    });

    Matter.Composite.add(world, body);
    currentLineBody.physicsBodies.push(body);

    lastDrawPoint = point.clone();
}

function clearDrawnLines() {
    drawnBodies.forEach(line => {
        scene.remove(line.visual);
        line.visual.geometry.dispose();
        line.physicsBodies.forEach(b => Matter.Composite.remove(world, b));
    });
    drawnBodies = [];
}

function undoLastLine() {
    if (drawnBodies.length === 0) return;
    const line = drawnBodies.pop();
    scene.remove(line.visual);
    line.visual.geometry.dispose();
    line.physicsBodies.forEach(b => Matter.Composite.remove(world, b));
}

// --- Game Loop ---

function animate() {
    requestAnimationFrame(animate);

    const delta = 1000 / 60; 
    Matter.Engine.update(engine, delta);

    levelManager.update(delta);
    updateParticles();

    composer.render();
}

function updateParticles() {
    let activeCount = 0;

    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        if (p.isDead) {
            Matter.Composite.remove(world, p.body);
            particles.splice(i, 1);
            continue;
        }

        // Expanded bounds check to handle anti-gravity (upwards) particles too
        if (Math.abs(p.body.position.y) > 70 || Math.abs(p.body.position.x) > 60) {
            Matter.Composite.remove(world, p.body);
            particles.splice(i, 1);
            continue;
        }

        if (activeCount < MAX_PARTICLES) {
            dummy.position.set(p.body.position.x, p.body.position.y, 0);
            dummy.rotation.z = p.body.angle;
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            particleInstancedMesh.setMatrixAt(activeCount, dummy.matrix);

            const col = colorPalette[p.colorName] || colorPalette.white;
            particleInstancedMesh.setColorAt(activeCount, col);

            activeCount++;
        }
    }

    particleInstancedMesh.count = activeCount;
    particleInstancedMesh.instanceMatrix.needsUpdate = true;
    if (particleInstancedMesh.instanceColor) particleInstancedMesh.instanceColor.needsUpdate = true;
}

// --- Callbacks ---

function onLevelComplete() {
    document.getElementById('overlay-message').classList.add('visible');
    playChime();
}

function onScoreUpdate(progressData) {
    const container = document.getElementById('trackers');
    const goals = Object.keys(progressData);

    if (container.children.length !== goals.length) {
        container.innerHTML = '';
        goals.forEach(color => {
            const div = document.createElement('div');
            div.className = 'crystal-tracker';
            div.innerHTML = `
                <img class="tracker-icon" src="./crystal.png" style="filter: drop-shadow(0 0 5px ${getColorCss(color)})">
                <div class="tracker-fill" style="background-color:${getColorCss(color)}; height: 0%"></div>
            `;
            div.dataset.color = color;
            container.appendChild(div);
        });
    }

    Array.from(container.children).forEach(div => {
        const color = div.dataset.color;
        const p = progressData[color];
        const fill = div.querySelector('.tracker-fill');
        fill.style.height = `${Math.min(100, (p.current / p.required) * 100)}%`;

        if (p.current >= p.required) {
            fill.style.boxShadow = `0 0 20px 5px ${getColorCss(color)}`;
        }
    });
}

function getColorCss(name) {
    const map = {
        white: '#ffffff',
        red: '#ff4444',
        blue: '#4444ff',
        green: '#44ff44',
        purple: '#aa44ff'
    };
    return map[name] || '#fff';
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;

    if (camera.aspect < 1) {
        camera.position.z = 100 / camera.aspect; 
    } else {
        camera.position.z = 100;
    }

    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
}

// Start
init();