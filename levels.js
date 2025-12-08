import * as THREE from 'three';
import Matter from 'matter-js';

// Collision Categories
const CAT_PARTICLE = 0x0001;
const CAT_WALL = 0x0002;
const CAT_SENSOR = 0x0004;

export class LevelManager {
    constructor(scene, world, particlesRef, colorPalette, onComplete, onScore) {
        this.scene = scene;
        this.world = world;
        this.particles = particlesRef;
        this.colors = colorPalette;
        this.onComplete = onComplete;
        this.onScore = onScore;

        this.currentLevelIdx = 0;
        this.levelObjects = []; // Stores meshes/bodies to cleanup
        this.emitters = [];
        this.goals = [];
        this.gates = [];
        this.isRunning = false;

        // Define Levels
        this.levels = [
            {
                name: "Starlight Falls",
                hint: "Draw a line to guide the stars into the crystal.",
                emitters: [
                    { x: -10, y: 30, color: 'white', rate: 5 }
                ],
                goals: [
                    { x: 10, y: -20, color: 'white', req: 30, w: 8, h: 5 }
                ],
                walls: []
            },
            {
                name: "The Divide",
                hint: "Split the stream to fill both crystals.",
                emitters: [
                    { x: 0, y: 35, color: 'white', rate: 8 }
                ],
                goals: [
                    { x: -20, y: -25, color: 'white', req: 40, w: 8, h: 5 },
                    { x: 20, y: -25, color: 'white', req: 40, w: 8, h: 5 }
                ],
                walls: [
                    { x: 0, y: 0, w: 4, h: 20, rot: 0 } // Middle obstacle
                ]
            },
            {
                name: "Prism Gate",
                hint: "Pass light through the gate to change its color.",
                emitters: [
                    { x: -20, y: 35, color: 'white', rate: 6 }
                ],
                goals: [
                    { x: 20, y: -25, color: 'red', req: 50, w: 8, h: 5 }
                ],
                gates: [
                    { x: 0, y: 10, w: 15, h: 2, color: 'red' }
                ],
                walls: []
            },
            {
                name: "Chromatic Crossing",
                hint: "Sort the colors correctly.",
                emitters: [
                    { x: -15, y: 35, color: 'white', rate: 5 },
                    { x: 15, y: 35, color: 'white', rate: 5 }
                ],
                goals: [
                    { x: -20, y: -30, color: 'blue', req: 40, w: 8, h: 5 },
                    { x: 20, y: -30, color: 'red', req: 40, w: 8, h: 5 }
                ],
                gates: [
                    { x: -15, y: 5, w: 10, h: 2, color: 'blue' },
                    { x: 15, y: 5, w: 10, h: 2, color: 'red' }
                ],
                walls: []
            },
            {
                name: "Anti-Gravity",
                hint: "Gravity is reversed! Guide the rising stars.",
                gravity: { x: 0, y: 1.5 }, // Stronger reverse gravity
                emitters: [
                    { x: 0, y: -30, color: 'white', rate: 10 }
                ],
                goals: [
                    { x: -20, y: 20, color: 'white', req: 30, w: 8, h: 5 },
                    { x: 20, y: 20, color: 'white', req: 30, w: 8, h: 5 }
                ],
                walls: [
                     { x: 0, y: 0, w: 10, h: 2, rot: 0.7 }
                ]
            }
        ];
    }

    loadLevel(index) {
        this.cleanup();
        this.currentLevelIdx = index;
        const data = this.levels[index];

        if (!data) return; // End of game

        // UI Updates
        document.getElementById('level-title').innerText = data.name;
        document.getElementById('level-hint').innerText = data.hint;

        // Physics Gravity reset
        if (data.gravity) {
            this.world.gravity.x = data.gravity.x;
            this.world.gravity.y = data.gravity.y;
        } else {
            this.world.gravity.x = 0;
            this.world.gravity.y = -2.0; // Stronger gravity for better fall feel
        }

        // Spawn Walls
        if (data.walls) {
            data.walls.forEach(w => {
                const body = Matter.Bodies.rectangle(w.x, w.y, w.w, w.h, {
                    isStatic: true,
                    angle: w.rot || 0,
                    friction: 0.1,
                    render: { fillStyle: '#444' }
                });
                Matter.Composite.add(this.world, body);

                // Visual
                const mesh = new THREE.Mesh(
                    new THREE.BoxGeometry(w.w, w.h, 5),
                    new THREE.MeshStandardMaterial({ color: 0x666677, roughness: 0.2, metalness: 0.5 })
                );
                mesh.position.set(w.x, w.y, 0);
                mesh.rotation.z = w.rot || 0;
                this.scene.add(mesh);
                this.levelObjects.push({ body, mesh });
            });
        }

        // Spawn Gates
        if (data.gates) {
            data.gates.forEach(g => {
                const body = Matter.Bodies.rectangle(g.x, g.y, g.w, g.h, {
                    isStatic: true,
                    isSensor: true,
                    label: 'gate_' + g.color
                });
                Matter.Composite.add(this.world, body);

                // Visual
                const mesh = new THREE.Mesh(
                    new THREE.BoxGeometry(g.w, g.h, 0.5),
                    new THREE.MeshBasicMaterial({ 
                        color: this.colors[g.color], 
                        transparent: true, 
                        opacity: 0.4,
                        side: THREE.DoubleSide
                    })
                );
                mesh.position.set(g.x, g.y, 0);
                this.scene.add(mesh);

                // Glow effect for gate
                const glow = new THREE.Mesh(
                    new THREE.PlaneGeometry(g.w + 2, g.h + 2),
                    new THREE.MeshBasicMaterial({
                        color: this.colors[g.color], 
                        transparent: true, 
                        opacity: 0.2,
                        blending: THREE.AdditiveBlending
                    })
                );
                glow.position.set(g.x, g.y, -0.1);
                this.scene.add(glow);

                this.levelObjects.push({ body, mesh: mesh }); // Storing mesh allows cleanup
                this.levelObjects.push({ mesh: glow });
                this.gates.push({ body, color: g.color });
            });
        }

        // Spawn Goals (Crystals)
        this.goals = data.goals.map(g => {
            // New Goal Visual: A glowing platform/cup
            const cupGroup = new THREE.Group();
            cupGroup.position.set(g.x, g.y, 0);

            // 1. The Base Platform
            const baseGeo = new THREE.BoxGeometry(g.w + 2, 1, 4);
            const baseMat = new THREE.MeshStandardMaterial({ 
                color: 0x444444, 
                roughness: 0.3 
            });
            const base = new THREE.Mesh(baseGeo, baseMat);
            base.position.y = -g.h/2;
            cupGroup.add(base);

            // 2. The Collection Zone Glow
            const zoneGeo = new THREE.BoxGeometry(g.w, g.h, 4);
            const zoneMat = new THREE.MeshBasicMaterial({
                color: this.colors[g.color] || 0xffffff,
                transparent: true,
                opacity: 0.15,
                depthWrite: false,
                blending: THREE.AdditiveBlending
            });
            const zone = new THREE.Mesh(zoneGeo, zoneMat);
            cupGroup.add(zone);

            // 3. Floating Crystal Icon
            const crystalGeo = new THREE.OctahedronGeometry(2.5);
            const crystalMat = new THREE.MeshPhongMaterial({
                color: this.colors[g.color] || 0xffffff,
                transparent: true,
                opacity: 0.9,
                shininess: 100,
                emissive: this.colors[g.color] || 0xffffff,
                emissiveIntensity: 0.5
            });
            const crystal = new THREE.Mesh(crystalGeo, crystalMat);
            crystal.userData.spin = true;
            cupGroup.add(crystal);

            // 4. Indicator Ring
            const ringGeo = new THREE.TorusGeometry(3.5, 0.1, 8, 32);
            const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            ring.userData.pulse = true;
            cupGroup.add(ring);

            this.scene.add(cupGroup);

            // Physics Sensor
            const sensor = Matter.Bodies.rectangle(g.x, g.y, g.w, g.h, {
                isStatic: true,
                isSensor: true,
                label: 'goal'
            });
            Matter.Composite.add(this.world, sensor);

            this.levelObjects.push({ body: sensor, mesh: cupGroup });

            return {
                ...g,
                current: 0,
                sensorBody: sensor,
                visual: cupGroup
            };
        });

        // Setup Emitters
        this.emitters = data.emitters.map(e => {
            // Visual for Emitter
            const emGroup = new THREE.Group();
            emGroup.position.set(e.x, e.y, 0);

            const coreGeo = new THREE.SphereGeometry(1.5, 16, 16);
            const coreMat = new THREE.MeshBasicMaterial({
                color: this.colors[e.color] || 0xffffff,
                transparent: true,
                opacity: 0.8
            });
            const core = new THREE.Mesh(coreGeo, coreMat);
            emGroup.add(core);

            const glowGeo = new THREE.SphereGeometry(3, 16, 16);
            const glowMat = new THREE.MeshBasicMaterial({
                color: this.colors[e.color] || 0xffffff,
                transparent: true,
                opacity: 0.2,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            });
            const glow = new THREE.Mesh(glowGeo, glowMat);
            glow.scale.set(0.8, 0.8, 0.8);
            glow.userData.pulse = true;
            emGroup.add(glow);

            this.scene.add(emGroup);
            this.levelObjects.push({ mesh: emGroup });

            return { 
                ...e,
                timer: 0
            };
        });

        this.isRunning = true;

        // Initial Score UI
        this.updateScoreUI();
    }

    updateScoreUI() {
        const progress = {};
        this.goals.forEach(g => {
            if(!progress[g.color]) progress[g.color] = { current: 0, required: 0 };
            progress[g.color].current += g.current;
            progress[g.color].required += g.req;
        });
        this.onScore(progress);
    }

    cleanup() {
        this.isRunning = false;
        // Remove old particles
        this.particles.forEach(p => {
            Matter.Composite.remove(this.world, p.body);
        });
        this.particles.length = 0; // clear array logic handled in main loop mostly
        // Force clear particles array ref
        while(this.particles.length > 0) this.particles.pop();

        // Remove level objects
        this.levelObjects.forEach(obj => {
            if (obj.body) Matter.Composite.remove(this.world, obj.body);
            if (obj.mesh) {
                this.scene.remove(obj.mesh);
                if (obj.mesh.geometry) obj.mesh.geometry.dispose();
            }
        });
        this.levelObjects = [];
        this.emitters = [];
        this.goals = [];
        this.gates = [];
    }

    resetLevel() {
        this.loadLevel(this.currentLevelIdx);
        // Also clear drawn lines via event or main call? 
        // We'll let main handle clearing drawn lines via UI button, but resetting level usually clears everything.
        // It's better if the 'Reset' button in main calls clearDrawnLines() AND levelManager.resetLevel().
        // For now, let's assume the user manually clears lines or we keep them. Usually reset clears lines.
        // The main.js handles the button click, let's make sure it clears lines too.
    }

    nextLevel() {
        if (this.currentLevelIdx < this.levels.length - 1) {
            this.loadLevel(this.currentLevelIdx + 1);
        } else {
            console.log("All levels complete!");
            // Maybe loop or show credits
            this.loadLevel(0);
        }
    }

    update(dt) {
        if (!this.isRunning) return;

        // 1. Emit Particles
        this.emitters.forEach(e => {
            e.timer += dt;
            const interval = 1000 / (e.rate * 10); 
            if (e.timer > interval) { // Fixed timing
                e.timer = 0;
                this.spawnParticle(e.x + (Math.random() - 0.5) * 2, e.y, e.color);
            }
        });

        // 2. Check Collisions / Sensors
        // Instead of full collision events which can be heavy, we check sensors manually for active particles
        // Optimization: use Matter.Query or spatial hash.
        // Since we have ~500 particles, simple loop is okay.

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];

            // Check Gates
            for (let gate of this.gates) {
                if (Matter.Bounds.overlaps(p.body.bounds, gate.body.bounds)) {
                    // Simple AABB check first
                    if (Matter.Collision.collides(p.body, gate.body) != null) {
                        p.colorName = gate.color;
                    }
                }
            }

            // Check Goals
            for (let goal of this.goals) {
                if (goal.current >= goal.req) continue; // Full

                if (Matter.Bounds.overlaps(p.body.bounds, goal.sensorBody.bounds)) {
                     // Check exact color
                     if (p.colorName === goal.color || goal.color === 'any') {
                         goal.current++;
                         p.isDead = true; // Absorbed
                         
                         // Visual Feedback
                         if (goal.visual) {
                             goal.visual.scale.set(1.2, 1.2, 1.2); // Pulse
                         }

                         this.updateScoreUI();
                         this.checkWinCondition();
                     }
                }
            }
        }

        // Spin crystals & Animate visuals
        this.levelObjects.forEach(obj => {
            if (obj.mesh) {
                // Scale return
                if (obj.mesh.children.length > 2 && obj.mesh.scale.x > 1) {
                     obj.mesh.scale.lerp(new THREE.Vector3(1,1,1), 0.1);
                }

                if (obj.mesh.children) {
                    obj.mesh.children.forEach(c => {
                        if (c.userData.spin) {
                            c.rotation.y += 0.02;
                            c.rotation.z += 0.01;
                        }
                        if (c.userData.pulse) {
                            const s = 1 + Math.sin(Date.now() * 0.005) * 0.2;
                            c.scale.set(s, s, s);
                        }
                    });
                }
            }
        });
    }

    spawnParticle(x, y, color) {
        if (this.particles.length >= 1000) return; // Hard limit

        const size = 0.5; // Slightly larger physics body too
        const body = Matter.Bodies.circle(x, y, size, {
            friction: 0.0,
            restitution: 0.3, // Reduced bounciness
            frictionAir: 0.005, // Significantly reduced drag so particles actually fall
            mass: 0.1,
            render: { visible: false } // We use Three.js
        });

        Matter.Composite.add(this.world, body);

        // Initial velocity variation
        Matter.Body.setVelocity(body, { 
            x: (Math.random() - 0.5) * 0.5, 
            y: (Math.random() - 0.5) * 0.5 
        });

        this.particles.push({
            body: body,
            colorName: color,
            isDead: false
        });
    }

    checkWinCondition() {
        const allMet = this.goals.every(g => g.current >= g.req);
        if (allMet) {
            this.isRunning = false;
            setTimeout(() => this.onComplete(), 500);
        }
    }
}