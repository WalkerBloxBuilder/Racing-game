// index.js (CommonJS)
// Express static server + Socket.IO + cannon RaycastVehicle physics.
// Spawns cars at road intersections, applies engine/steer/brake,
// supports reset, and streams transforms to clients.
// Also generates a simple city block layout (server sends building list).

const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const CANNON = require("cannon"); // CommonJS-friendly (no ESM hassle)

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Serve client
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;

// ---------------- Physics world ----------------
const world = new CANNON.World();
world.broadphase = new CANNON.NaiveBroadphase();
world.gravity.set(0, -9.82, 0);
world.solver.iterations = 12;
world.solver.tolerance = 0.001;

// Ground plane
const groundMat = new CANNON.Material("ground");
const ground = new CANNON.Body({ mass: 0, material: groundMat });
ground.addShape(new CANNON.Plane());
ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(ground);

// --------------- City layout (colliders only) ---------------
const GRID_SPACING = 36; // distance between intersections
const ROAD_HALF = 7;     // half road width
const buildings = [];
let bid = 1;

function addBuildingCollider(x, z, w, d, h) {
  const shape = new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2));
  const body = new CANNON.Body({ mass: 0 });
  body.addShape(shape);
  body.position.set(x, h / 2, z);
  world.addBody(body);
  buildings.push({ id: `b${bid++}`, x, y: h / 2, z, w, h, d });
}

// Create blocks of buildings around intersections, leaving roads clear
for (let gx = -3; gx <= 3; gx++) {
  for (let gz = -3; gz <= 3; gz++) {
    const cx = gx * GRID_SPACING;
    const cz = gz * GRID_SPACING;
    const count = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      const w = 10 + Math.random() * 14;
      const d = 8 + Math.random() * 16;
      const h = 12 + Math.random() * 60;
      const px = cx + (Math.random() - 0.5) * (GRID_SPACING * 0.6);
      const pz = cz + (Math.random() - 0.5) * (GRID_SPACING * 0.6);
      if (Math.abs(px - cx) < ROAD_HALF || Math.abs(pz - cz) < ROAD_HALF) continue;
      addBuildingCollider(px, pz, w, d, h);
    }
  }
}

// Intersection spawn points
const spawns = [];
for (let gx = -2; gx <= 2; gx++) {
  for (let gz = -2; gz <= 2; gz++) {
    spawns.push([gx * GRID_SPACING, gz * GRID_SPACING]);
  }
}
let spawnIdx = 0;
function pickSpawn() {
  const [x, z] = spawns[(spawnIdx++) % spawns.length];
  // slight offset so cars don’t overlap exactly
  return { x: x + (Math.random() - 0.5) * 2, z: z + (Math.random() - 0.5) * 2 };
}

// ---------------- Vehicles ----------------
const players = {}; // id -> { vehicle, chassis, input }

function createVehicle(x, z) {
  // Chassis (approx 2.1w x 0.9h x 3.9l)
  const chassisShape = new CANNON.Box(new CANNON.Vec3(1.05, 0.45, 1.95));
  const chassisBody = new CANNON.Body({ mass: 380 });
  chassisBody.addShape(chassisShape);
  chassisBody.position.set(x, 1.8, z);
  chassisBody.angularDamping = 0.45;
  world.addBody(chassisBody);

  // RaycastVehicle
  const vehicle = new CANNON.RaycastVehicle({
    chassisBody,
    indexRightAxis: 0,
    indexUpAxis: 1,
    indexForwardAxis: 2
  });

  const halfW = 1.05;
  const halfL = 1.35;
  const wheel = {
    radius: 0.48,
    directionLocal: new CANNON.Vec3(0, -1, 0),
    axleLocal: new CANNON.Vec3(1, 0, 0),
    suspensionRestLength: 0.28,
    suspensionStiffness: 45,
    dampingCompression: 3.8,
    dampingRelaxation: 4.3,
    frictionSlip: 5.2,
    rollInfluence: 0.02,
    maxSuspensionForce: 100000,
    customSlidingRotationalSpeed: -30,
    useCustomSlidingRotationalSpeed: true
  };

  // FL / FR (front steer)
  vehicle.addWheel({ ...wheel, chassisConnectionPointLocal: new CANNON.Vec3(-halfW, 0,  halfL), isFrontWheel: true });
  vehicle.addWheel({ ...wheel, chassisConnectionPointLocal: new CANNON.Vec3( halfW, 0,  halfL), isFrontWheel: true });
  // BL / BR (drive)
  vehicle.addWheel({ ...wheel, chassisConnectionPointLocal: new CANNON.Vec3(-halfW, 0, -halfL), isFrontWheel: false });
  vehicle.addWheel({ ...wheel, chassisConnectionPointLocal: new CANNON.Vec3( halfW, 0, -halfL), isFrontWheel: false });

  vehicle.addToWorld(world);

  return { vehicle, chassisBody };
}

// ---------------- Sockets ----------------
io.on("connection", (socket) => {
  const s = pickSpawn();
  const { vehicle, chassisBody } = createVehicle(s.x, s.z);
  players[socket.id] = {
    vehicle,
    chassis: chassisBody,
    input: { forward: 0, turn: 0, brake: false }
  };

  // Send world info on join
  socket.emit("worldInit", {
    id: socket.id,
    grid: { spacing: GRID_SPACING, roadHalf: ROAD_HALF },
    buildings
  });

  socket.on("input", (data) => {
    const p = players[socket.id];
    if (!p) return;
    // forward: +1 forward, -1 reverse
    // turn: -1 left, +1 right
    p.input.forward = Math.max(-1, Math.min(1, Number(data.forward) || 0));
    p.input.turn = Math.max(-1, Math.min(1, Number(data.turn) || 0));
    p.input.brake = !!data.brake;
  });

  socket.on("reset", () => {
    const p = players[socket.id];
    if (!p) return;
    const ns = pickSpawn();
    p.chassis.position.set(ns.x, 1.8, ns.z);
    p.chassis.velocity.set(0, 0, 0);
    p.chassis.angularVelocity.set(0, 0, 0);
    p.chassis.quaternion.set(0, 0, 0, 1);
  });

  socket.on("disconnect", () => {
    const p = players[socket.id];
    if (p) {
      try { p.vehicle.removeFromWorld(world); } catch {}
      try { world.removeBody(p.chassis); } catch {}
      delete players[socket.id];
    }
  });
});

// ---------------- Sim loop ----------------
const TICK = 60;
const ENGINE_FORCE = 7200;
const REVERSE_FORCE = 3000;
const MAX_STEER = 0.5;
const BRAKE_FORCE = 20;

setInterval(() => {
  // Apply inputs
  for (const id in players) {
    const { vehicle, chassis, input } = players[id];

    for (let i = 0; i < 4; i++) {
      vehicle.setBrake(0, i);
      vehicle.applyEngineForce(0, i);
    }

    // throttle on rear wheels (2,3)
    if (input.forward > 0) {
      const f = -ENGINE_FORCE * input.forward;
      vehicle.applyEngineForce(f, 2);
      vehicle.applyEngineForce(f, 3);
    } else if (input.forward < 0) {
      const f = REVERSE_FORCE * (-input.forward);
      vehicle.applyEngineForce(f, 2);
      vehicle.applyEngineForce(f, 3);
    }

    // steering on front (0,1). left negative, right positive
    const steer = input.turn * MAX_STEER;
    vehicle.setSteeringValue(steer, 0);
    vehicle.setSteeringValue(steer, 1);

    // brake
    if (input.brake) for (let i = 0; i < 4; i++) vehicle.setBrake(BRAKE_FORCE, i);

    // upright stabilizer (gentle)
    const up = new CANNON.Vec3(0, 1, 0);
    const curUp = new CANNON.Vec3(0, 1, 0);
    chassis.quaternion.vmult(curUp, curUp);
    const corr = curUp.cross(up);
    corr.scale(-12, corr);
    chassis.torque.vadd(corr, chassis.torque);
  }

  world.step(1 / TICK);

  // broadcast snapshot
  const state = {};
  for (const id in players) {
    const b = players[id].chassis;
    state[id] = {
      position: { x: b.position.x, y: b.position.y, z: b.position.z },
      quaternion: { x: b.quaternion.x, y: b.quaternion.y, z: b.quaternion.z, w: b.quaternion.w }
    };
  }
  io.emit("state", state);
}, 1000 / TICK);

// ---------------- Start ----------------
server.listen(PORT, () => console.log(`🚗 Server running at http://localhost:${PORT}`));
