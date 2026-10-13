// The temple's scene extras, one function each (see docs/FEATURES.md).
// Each returns an update(dt, t, state) for the render loop, or nothing.
import { THREE, damp, motion, loadModel, portrait } from "./shared/base.js";
import { Water } from "three/addons/objects/Water.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const TAU = Math.PI * 2;
const { clamp, degToRad } = THREE.MathUtils;

// small seeded random so clouds, dust and streaks look the same on every load
const seeded = (s) => () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

function canvasTexture(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const softDot = () =>
  canvasTexture(64, 64, (x, w) => {
    const g = x.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g;
    x.fillRect(0, 0, w, w);
  });
// a puff of cloud: 18 soft blobs, layered. Computed pixel by pixel rather than with canvas gradients: Safari
// dithers those, and magnified across the sky the dithering showed as speckles.
const cloudTexture = (seed) =>
  canvasTexture(256, 256, (x, w) => {
    const rnd = seeded(seed);
    const blobs = Array.from({ length: 18 }, () => [w * (0.25 + rnd() * 0.5), w * (0.35 + rnd() * 0.3), w * (0.12 + rnd() * 0.16)]);
    const img = x.createImageData(w, w);
    for (let py = 0; py < w; py++)
      for (let px = 0; px < w; px++) {
        let clear = 1; // how much shows through all the blobs (each one painted over the last)
        for (const [cx, cy, r] of blobs) {
          const k = 1 - Math.hypot(px + 0.5 - cx, py + 0.5 - cy) / r;
          if (k > 0) clear *= 1 - 0.35 * k;
        }
        const i = (py * w + px) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = (1 - clear) * 255;
      }
    x.putImageData(img, 0, 0);
  });

// ---------------------------------------------------------------- sky
// Art-directed golden-hour sky: a gradient dome with a soft sun glow. It is also baked into an
// environment map, so the marble, gold and water are lit by and reflect the same sky. Moves the sun to match.
export const SUN = { elevation: degToRad(9), azimuth: -0.35 };
export const SKY_COLORS = { zenith: 0x1b2a4a, upper: 0x5d6a92, horizon: 0xf0a868, below: 0x3a2d3e, sun: 0xffd29a };
export function sky({ scene, renderer, sun, hemi }) {
  const dir = new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2 - SUN.elevation, SUN.azimuth);
  const c = (hex) => ({ value: new THREE.Color(hex) });
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(400, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uZenith: c(SKY_COLORS.zenith), uUpper: c(SKY_COLORS.upper), uHorizon: c(SKY_COLORS.horizon),
        uBelow: c(SKY_COLORS.below), uSun: c(SKY_COLORS.sun), uSunDir: { value: dir },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position.z = gl_Position.w; // always at the far plane
        }`,
      fragmentShader: `
        uniform vec3 uZenith, uUpper, uHorizon, uBelow, uSun, uSunDir;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          float toSun = max(dot(d, uSunDir), 0.0);
          // horizon glow is warmer and wider on the sun's side
          vec3 horizon = mix(uHorizon * 0.55, uHorizon, pow(toSun, 2.0));
          vec3 col = h > 0.0
            ? mix(mix(horizon, uUpper, smoothstep(0.0, 0.22, h)), uZenith, smoothstep(0.22, 0.85, h))
            : mix(horizon, uBelow, smoothstep(0.0, 0.35, -h));
          col += uSun * (pow(toSun, 900.0) * 6.0 + pow(toSun, 24.0) * 0.45 + pow(toSun, 4.0) * 0.12);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    })
  );
  dome.frustumCulled = false;
  dome.userData.noAO = true;

  const envScene = new THREE.Scene();
  envScene.add(dome);
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(envScene).texture;
  scene.environmentIntensity = 1.1; // the sky lights the shade: enough to read the island where the sun doesn't reach
  scene.add(dome);
  scene.background = null;
  scene.fog.color.set(0x6f6177); // haze matching the horizon below the island
  scene.fog.density = 0.018;

  sun.position.copy(dir).multiplyScalar(14);
  sun.color.set(0xffc792);
  sun.intensity = 3.6;
  Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, far: 40 });
  sun.shadow.camera.updateProjectionMatrix();
  hemi.intensity = 0.75;
  renderer.toneMappingExposure = 1.0;
  document.body.classList.add("has-sky"); // darkens behind the text for legibility
}

// ---------------------------------------------------------------- clouds
export function clouds({ scene, camera, lowPower }) {
  const group = new THREE.Group();
  group.position.z = -1.2; // centre of the island
  scene.add(group);
  const maps = [11, 23, 37].map(cloudTexture);
  const rnd = seeded(7);
  // (phones: half as many, a little larger: big overlapping see-through sprites are what a phone's GPU
  // struggles with most)
  const n = lowPower ? 40 : 80;
  for (let i = 0; i < n; i++) {
    // a bed of cloud below the island, and a distant ring behind it; nothing near the camera path
    const below = i < n * 0.625;
    const r = below ? 1 + rnd() * 6.5 : 16 + rnd() * 10;
    const a = rnd() * TAU;
    const mat = new THREE.SpriteMaterial({
      map: maps[i % 3],
      color: below ? 0xcdb3b8 : 0xf3d2b4, // cool violet in the shade below, warm where the low sun hits
      transparent: true,
      opacity: below ? 0.35 + rnd() * 0.3 : 0.5 + rnd() * 0.3,
      depthWrite: false,
      rotation: rnd() * TAU,
    });
    const s = new THREE.Sprite(mat);
    s.position.set(Math.sin(a) * r, below ? -1.6 - rnd() * 2.8 : -1 + rnd() * 5, Math.cos(a) * r);
    const k = (below ? 2.5 + rnd() * 3.5 : 5 + rnd() * 6) * (lowPower ? 1.2 : 1);
    s.scale.set(k * 1.7, k, 1);
    s.userData.noAO = true;
    s.userData.opacity = mat.opacity;
    group.add(s);
  }
  // clouds close to the camera fade out, so low views (the staircase) aren't behind a veil
  const p = new THREE.Vector3();
  return (dt) => {
    group.rotation.y += dt * 0.006 * motion;
    for (const s of group.children) {
      const near = s.getWorldPosition(p).distanceTo(camera.position) / s.scale.y; // in cloud sizes
      s.material.opacity = s.userData.opacity * THREE.MathUtils.smoothstep(near, 0.8, 1.6);
      s.visible = s.material.opacity > 0.005; // faded out: not drawn at all
    }
  };
}

// ---------------------------------------------------------------- ambient occlusion
export function ambientOcclusion({ composer, scene, camera }) {
  const pass = new GTAOPass(scene, camera, innerWidth, innerHeight);
  pass.blendIntensity = 0.9;
  pass.updateGtaoMaterial({ radius: 0.12, distanceExponent: 1.5, thickness: 1, scale: 1.2, samples: 16 });
  // keep sprites, shafts and other see-through extras out of the occlusion pass
  const hide = pass.overrideVisibility.bind(pass);
  pass.overrideVisibility = () => {
    hide();
    scene.traverse((o) => (o.isSprite || o.userData.noAO) && (o.visible = false));
  };
  composer.insertPass(pass, 1);
}

// ---------------------------------------------------------------- polished marble
// Swap to a physical material: a faint clear coat for polish and sheen for marble's soft glow at the edges.
export function polishMarble(meshes) {
  for (const m of meshes) {
    const o = m.material;
    m.material = new THREE.MeshPhysicalMaterial({
      map: o.map, normalMap: o.normalMap, normalScale: o.normalScale, roughnessMap: o.roughnessMap,
      color: o.color, roughness: 0.85, metalness: 0,
      clearcoat: 0.3, clearcoatRoughness: 0.35,
      sheen: 0.5, sheenRoughness: 0.55, sheenColor: new THREE.Color(0xfff0dc),
    });
  }
}

// ---------------------------------------------------------------- close-up detail
// Re-samples each material's own colour and normal maps at a fine tiling, so stretched 4K textures
// stay crisp up close.
export function detailTextures(meshes, tiling = 9) {
  const normals = THREE.ShaderChunk.normal_fragment_maps.replace(
    "mapN.xy *= normalScale;",
    `mapN.xy *= normalScale;
     vec3 detailN = texture2D( normalMap, vNormalMapUv * ${tiling.toFixed(1)} ).xyz * 2.0 - 1.0;
     mapN.xy += detailN.xy * 0.45;`
  );
  for (const m of meshes) {
    m.material.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <normal_fragment_maps>", normals)
        .replace(
          "#include <map_fragment>",
          `#include <map_fragment>
           diffuseColor.rgb *= 0.8 + 0.4 * dot( texture2D( map, vMapUv * ${tiling.toFixed(1)} ).rgb, vec3( 0.333 ) );`
        );
    };
    m.material.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- pool
// Swaps the painted quad for three's Water: live reflection, animated ripples, sun glints.
export function water({ scene, parts, sun }) {
  const pool = parts.Temple_sketchfab_water;
  const box = new THREE.Box3().setFromObject(pool);
  const size = box.getSize(new THREE.Vector3());
  pool.parent.remove(pool);
  const w = new Water(new THREE.PlaneGeometry(size.x, size.z), {
    textureWidth: 512,
    textureHeight: 512,
    waterNormals: new THREE.TextureLoader().load(
      "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/textures/waternormals.jpg",
      (t) => (t.wrapS = t.wrapT = THREE.RepeatWrapping)
    ),
    sunDirection: sun.position.clone().normalize(),
    sunColor: sun.color,
    waterColor: 0x2c7c74,
    alpha: 0.92,
    distortionScale: 1.2,
    fog: true,
  });
  w.rotation.x = -Math.PI / 2;
  w.position.copy(box.getCenter(new THREE.Vector3()));
  w.material.uniforms.size.value = 6; // ripple scale for a small pool
  w.material.transparent = true;
  scene.add(w);
  return (dt) => (w.material.uniforms.time.value += dt * 0.5 * motion);
}

// ---------------------------------------------------------------- waterfall
// Modelled on tall free-falling waterfalls (Staubbachfall, Bridalveil Fall): water leaves the pool over
// the rim, falls as a dense white sheet that speeds up and frays into a lacy veil, carries "comet"
// clumps with trailing streaks, and turns into a sunlit mist long before it reaches the clouds.
// Everything is lit by the scene's sun, including the glow when the sun shines through it.
// drop length, sheet width at the lip (fits the arched outlet), widening factor, and the short run the
// water makes out of the outlet before it tips over (the outlet is modelled into the platform in temple.glb)
const WF = { len: 5, width: 0.13, spread: 1.6, channel: 0.07, angle: 1.57, lipR: 0.8, lipY: 1.987 };
const TONGUE = -WF.channel / 1.6; // v at the pool end of the channel
const NOISE_GLSL = `
  float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float wNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(wHash(i), wHash(i + vec2(1, 0)), f.x), mix(wHash(i + vec2(0, 1)), wHash(i + vec2(1, 1)), f.x), f.y);
  }
  float wFbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * wNoise(p); p *= 2.03; a *= 0.5; }
    return v;
  }`;
// The fall's path in its own frame: lip at the origin, falling along -y, arcing out along +z.
// v < 0 is the tongue of water crossing the rim before it tips over.
const ARC_GLSL = `
  uniform float uLen, uWidth, uSpread;
  vec3 arc(float across, float v) {
    if (v < 0.0) return vec3(across * uWidth, 0.009 + v / ${TONGUE.toFixed(4)} * 0.009, v * 1.6); // along the channel, rising gently to the pool
    float drop = v * uLen;
    return vec3(across * uWidth * (1.0 + v * uSpread), -drop, 0.035 + 0.3 * sqrt(drop));
  }`;
const arcJS = (across, v, out) => {
  if (v < 0) return out.set(across * WF.width, 0.009 + (v / TONGUE) * 0.009, v * 1.6);
  const drop = v * WF.len;
  return out.set(across * WF.width * (1 + v * WF.spread), -drop, 0.035 + 0.3 * Math.sqrt(drop));
};

function waterUniforms(sun, extra = {}) {
  return THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uSunDir: { value: sun.position.clone().normalize() },
      uSunColor: { value: sun.color.clone().multiplyScalar(sun.intensity * 0.28) },
      uAmbient: { value: new THREE.Color(0.34, 0.37, 0.46) },
      uLen: { value: WF.len }, uWidth: { value: WF.width }, uSpread: { value: WF.spread },
      ...extra,
    },
  ]);
}
// Aerated water is white and scatters light: soft diffuse from the sun, plus a strong glow when the
// sun is behind it (forward scattering), on top of the sky's ambient light.
const WATER_LIGHT_GLSL = `
  uniform vec3 uSunDir, uSunColor, uAmbient;
  vec3 waterLight(vec3 N, vec3 V, float thin) {
    float diffuse = 0.55 + 0.45 * abs(dot(N, uSunDir));
    float through = pow(max(dot(-V, uSunDir), 0.0), 5.0) * (0.4 + thin);
    return vec3(0.93, 0.96, 1.0) * (uAmbient + uSunColor * diffuse) + uSunColor * through * 1.4;
  }`;

// A column of water around the fall's path (see tubeGeo): it has thickness, so it reads from the side
// too. Its edges soften wherever the surface is seen edge-on, from any angle, and it breaks up into
// lace as it falls.
function sheetMaterial(sun, opacity, scale) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
    uniforms: waterUniforms(sun, { uOpacity: { value: opacity }, uScale: { value: scale } }),
    vertexShader: `
      #include <fog_pars_vertex>
      attribute vec2 aFlow; // x: around the column (-0.5..0.5), y: v along the fall
      varying vec2 vFlow;
      varying vec3 vWorld, vNormalW;
      void main() {
        vFlow = aFlow;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <fog_pars_fragment>
      ${NOISE_GLSL}
      ${WATER_LIGHT_GLSL}
      uniform float uTime, uOpacity, uScale;
      varying vec2 vFlow;
      varying vec3 vWorld, vNormalW;
      void main() {
        float fall = max(vFlow.y, 0.0);
        float s = vFlow.y < 0.0 ? vFlow.y * 1.2 : sqrt(fall); // ~ time since the lip: slow in the channel, accelerating as it falls
        float x = vFlow.x + 0.5;
        vec2 p = vec2(x * 14.0 * uScale, s * 4.2 - uTime * 1.05);
        float streak = smoothstep(0.32, 0.82, wFbm(vec2(p.x, p.y * 0.55)) * 0.6 + wFbm(vec2(x * 34.0 * uScale + 4.0, s * 9.0 - uTime * 1.8)) * 0.4);
        vec3 N = normalize(gl_FrontFacing ? vNormalW : -vNormalW);
        vec3 V = normalize(cameraPosition - vWorld);
        float rim = smoothstep(0.04, 0.45, abs(dot(N, V)));        // soft silhouette from every angle
        float lace = wNoise(vec2(x * 19.0 * uScale, s * 6.0 - uTime * 1.2));
        float holes = mix(1.0, smoothstep(0.25, 0.62, lace + streak * 0.35), smoothstep(0.1, 0.85, fall));
        float body = rim * holes;
        float density = mix(1.0, 0.22, smoothstep(0.0, 0.9, fall));
        float alpha = body * (0.3 + 0.7 * streak) * density * (1.0 - smoothstep(0.55, 0.95, fall));
        float lip = (1.0 - smoothstep(0.0, 0.06, abs(vFlow.y + 0.01))) * rim; // churning white where it tips over
        if (vFlow.y < 0.0) alpha = rim * (0.45 + 0.4 * streak);              // clearer water leaving the outlet
        vec3 col = waterLight(N, V, 1.0 - alpha) * mix(0.82, 1.05, streak);
        col = mix(col, waterLight(N, V, 0.0) * 1.1, lip * 0.6);
        gl_FragColor = vec4(col, clamp(alpha + lip * 0.55, 0.0, 1.0) * uOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

// The column's geometry: an elliptical cross-section around the fall's path that widens and deepens
// as the water falls and spreads. `offset` shifts it sideways (strands drift apart as they fall).
function tubeGeo(rows, segs, { widthScale = 1, depthScale = 1, offset = 0 } = {}) {
  const pos = [], nrm = [], flow = [], idx = [], c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let r = 0; r <= rows; r++) {
    const v = TONGUE + (r / rows) * (1 - TONGUE);
    arcJS(offset, v, c);
    const a = (WF.width / 2) * widthScale * (v < 0 ? 1 : 1 + v * WF.spread);
    const b = v < 0 ? 0.008 : (0.016 + 0.16 * Math.pow(v, 0.8)) * depthScale; // depth front-to-back
    for (let k = 0; k <= segs; k++) {
      const th = (k / segs) * TAU - Math.PI / 2; // seam at the back, against the rock
      pos.push(c.x + Math.cos(th) * a, c.y, c.z + Math.sin(th) * b);
      n.set(Math.cos(th) / a, 0, Math.sin(th) / b).normalize();
      nrm.push(n.x, n.y, n.z);
      flow.push(k / segs - 0.5, v);
    }
  }
  for (let r = 0; r < rows; r++)
    for (let k = 0; k < segs; k++) {
      const i = r * (segs + 1) + k, j = i + segs + 1;
      idx.push(i, j, i + 1, i + 1, j, j + 1);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute("aFlow", new THREE.Float32BufferAttribute(flow, 2));
  geo.setIndex(idx);
  return geo;
}

// Falling clumps: camera-facing streaks stretched along their velocity, bright head and fading tail,
// accelerating under gravity and spreading as they fall.
function cometMaterial(sun) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: true,
    uniforms: waterUniforms(sun),
    vertexShader: `
      #include <fog_pars_vertex>
      ${ARC_GLSL}
      uniform float uTime;
      attribute vec4 aComet; // across, phase, speed, size
      attribute vec3 aDrift;
      varying vec2 vUv;
      varying float vFall;
      varying vec3 vWorld;
      void main() {
        vUv = uv;
        float t = fract(uTime * aComet.z + aComet.y);
        float v = t * t * 0.95; // accelerating
        vFall = v;
        vec3 c = arc(aComet.x, v) + aDrift * v * 1.6;
        // safe normalize: a zero-length vector would give NaN, which bloom smears into a black block
        vec3 vel = arc(aComet.x, v + 0.01) - arc(aComet.x, v) + aDrift * 0.016;
        vel /= max(length(vel), 1e-6);
        vec3 cw = (modelMatrix * vec4(c, 1.0)).xyz;
        vec3 up = normalize(mat3(modelMatrix) * -vel);           // tail points back up the path
        vec3 side = cross(up, cameraPosition - cw);
        side /= max(length(side), 1e-6);
        float len = aComet.w * (0.5 + 3.5 * v), wid = aComet.w * (0.3 + 0.5 * v);
        vec3 world = cw + side * position.x * wid + up * (position.y + 0.5) * len;
        vWorld = world;
        vec4 mvPosition = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <fog_pars_fragment>
      ${WATER_LIGHT_GLSL}
      varying vec2 vUv;
      varying float vFall;
      varying vec3 vWorld;
      void main() {
        float head = pow(max(1.0 - vUv.y, 0.0), 1.6);           // bright at the leading end (pow of a negative is NaN)
        float dx = (vUv.x - 0.5) * 3.2, across = exp(-dx * dx);
        float life = smoothstep(0.0, 0.05, vFall) * (1.0 - smoothstep(0.5, 0.85, vFall));
        float alpha = head * across * life * 0.55;
        vec3 V = normalize(cameraPosition - vWorld);
        gl_FragColor = vec4(waterLight(V, V, 0.6), alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

export function waterfall({ scene, sun, camera, angle = WF.angle }) {
  const fall = new THREE.Group();
  fall.position.set(Math.sin(angle) * WF.lipR, WF.lipY, Math.cos(angle) * WF.lipR);
  fall.rotation.y = angle;

  // the water: a main column, a thin glinting shell around it, and two strands drifting apart
  const layers = [
    [tubeGeo(140, 40), sheetMaterial(sun, 0.78, 1)],
    [tubeGeo(140, 40, { widthScale: 1.06, depthScale: 1.15 }), sheetMaterial(sun, 0.32, 1.7)],
    [tubeGeo(140, 24, { widthScale: 0.34, depthScale: 0.6, offset: -0.34 }), sheetMaterial(sun, 0.6, 1.3)],
    [tubeGeo(140, 24, { widthScale: 0.3, depthScale: 0.55, offset: 0.36 }), sheetMaterial(sun, 0.55, 1.45)],
  ];
  const sheets = layers.map(([geo, mat]) => {
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.userData.noAO = true;
    fall.add(m);
    return m;
  });

  // comets
  const N = 320, rnd = seeded(13);
  const quad = new THREE.PlaneGeometry(1, 1);
  const cometGeo = new THREE.InstancedBufferGeometry();
  cometGeo.index = quad.index;
  cometGeo.setAttribute("position", quad.attributes.position);
  cometGeo.setAttribute("uv", quad.attributes.uv);
  const cAttr = new Float32Array(N * 4), dAttr = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const across = (rnd() - 0.5) * 0.9;
    cAttr.set([across, rnd(), 0.22 + rnd() * 0.16, 0.025 + rnd() * 0.035], i * 4);
    dAttr.set([across * 0.35 + (rnd() - 0.5) * 0.12, 0, (rnd() - 0.4) * 0.35], i * 3); // in front of and behind the column
  }
  cometGeo.setAttribute("aComet", new THREE.InstancedBufferAttribute(cAttr, 4));
  cometGeo.setAttribute("aDrift", new THREE.InstancedBufferAttribute(dAttr, 3));
  cometGeo.instanceCount = N;
  const comets = new THREE.Mesh(cometGeo, cometMaterial(sun));
  comets.frustumCulled = false;
  comets.userData.noAO = true;
  fall.add(comets);

  // fine spray at the lip
  const SPRAY = 260, sprayPos = new Float32Array(SPRAY * 3);
  const sprayDrops = Array.from({ length: SPRAY }, () => ({ across: (rnd() - 0.5) * 1.1, phase: rnd(), speed: 0.6 + rnd() * 0.5, out: new THREE.Vector3((rnd() - 0.5) * 0.3, rnd() * 0.1, 0.05 + rnd() * 0.25) }));
  const sprayGeo = new THREE.BufferGeometry();
  sprayGeo.setAttribute("position", new THREE.BufferAttribute(sprayPos, 3));
  const spray = new THREE.Points(sprayGeo, new THREE.PointsMaterial({ map: softDot(), size: 0.012, color: 0xfff8f0, transparent: true, opacity: 0.55, depthWrite: false }));
  spray.frustumCulled = false;
  spray.userData.noAO = true;
  fall.add(spray);

  // mist: the lower fall dissolves into sunlit vapour that billows outward and drifts down into the clouds
  const mistMap = cloudTexture(41);
  const sunTint = new THREE.Color(0xfff1e2).lerp(sun.color, 0.35);
  const mist = Array.from({ length: 22 }, (_, i) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: mistMap, color: sunTint, transparent: true, opacity: 0, depthWrite: false, rotation: rnd() * TAU }));
    s.userData = { phase: i / 22, x: (rnd() - 0.5) * 0.8, v0: 0.45 + rnd() * 0.35, size: 0.7 + rnd() * 0.9, noAO: true };
    fall.add(s);
    return s;
  });
  scene.add(fall);

  const v3 = new THREE.Vector3();
  return (dt, t) => {
    const time = t * motion;
    for (const m of [...sheets, comets]) m.material.uniforms.uTime.value = time;
    sprayDrops.forEach((d, i) => {
      const k = (time * d.speed + d.phase) % 1;
      arcJS(d.across, k * k * 0.25, v3).addScaledVector(d.out, k);
      sprayPos.set([v3.x, v3.y, v3.z], i * 3);
    });
    sprayGeo.attributes.position.needsUpdate = true;
    mist.forEach((s) => {
      const u = s.userData, k = (time * 0.05 + u.phase) % 1;
      arcJS(u.x, Math.min(u.v0 + k * 0.4, 1), v3);
      s.position.set(v3.x * 1.6, v3.y, v3.z + 0.1 + k * 0.5);
      s.scale.set(u.size * (1 + k * 1.1) * 1.4, u.size * (1 + k * 1.1), 1);
      // fades out as the camera comes close, so it never fills the screen (a flash) when the camera passes
      const near = s.getWorldPosition(v3).distanceTo(camera.position) / s.scale.y;
      s.material.opacity = Math.sin(k * Math.PI) * 0.24 * THREE.MathUtils.smoothstep(near, 0.8, 2);
    });
  };
}

// ---------------------------------------------------------------- site audio
// One speaker button in the nav turns all audio on and off (browsers block sound until a click).
// Each track is decoded once and looped seamlessly: its last `fade` seconds are crossfaded into its start.
const audio = { ctx: null, bus: null, on: false, tracks: [], btn: null };
async function loopBuffer(ctx, url, fade) {
  const raw = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
  const n = Math.floor(raw.sampleRate * fade), len = raw.length - n;
  const loop = ctx.createBuffer(raw.numberOfChannels, len, raw.sampleRate);
  for (let ch = 0; ch < raw.numberOfChannels; ch++) {
    const src = raw.getChannelData(ch), dst = loop.getChannelData(ch);
    dst.set(src.subarray(0, len));
    for (let i = 0; i < n; i++) {
      const k = i / n; // equal-power crossfade of the tail into the head
      dst[i] = src[i] * Math.sin((k * Math.PI) / 2) + src[len + i] * Math.cos((k * Math.PI) / 2);
    }
  }
  return loop;
}
async function startTrack(t) {
  const node = audio.ctx.createBufferSource();
  node.buffer = await loopBuffer(audio.ctx, t.url, t.fade);
  node.loop = true;
  t.gain = audio.ctx.createGain();
  t.gain.gain.value = 0;
  node.connect(t.gain).connect(audio.bus);
  node.start();
}
function audioButton() {
  if (audio.btn) return;
  const btn = (audio.btn = document.createElement("button"));
  btn.className = "sound";
  btn.type = "button";
  btn.setAttribute("aria-label", "Sound");
  btn.innerHTML = `<em class="sound-label" aria-hidden="true">Turn on sound</em><span></span><span></span><span></span><span></span>`;
  btn.classList.add("hinting");
  document.querySelector(".nav nav")?.append(btn);
  // while the sound is off the button says so, in gold, and its bars ripple; switched on, that folds away
  btn.addEventListener("click", async () => {
    audio.on = !audio.on;
    btn.classList.toggle("on", audio.on);
    btn.classList.toggle("hinting", !audio.on);
    if (audio.on && !audio.ctx) {
      audio.ctx = new AudioContext();
      // every track goes through one low-pass filter: open by default, used by muffle()
      audio.bus = audio.ctx.createBiquadFilter();
      audio.bus.type = "lowpass";
      audio.bus.frequency.value = 20000;
      audio.bus.Q.value = 0.7;
      audio.bus.connect(audio.ctx.destination);
      await Promise.all(audio.tracks.map(startTrack));
    } else if (audio.ctx) audio.on ? audio.ctx.resume() : audio.ctx.suspend();
  });
}
// Registers a looping track; level() is read every frame. Returns the per-frame update.
function addTrack(url, fade, level) {
  const t = { url, fade, level, gain: null };
  audio.tracks.push(t);
  audioButton();
  if (audio.ctx) startTrack(t);
  return () => t.gain && t.gain.gain.setTargetAtTime(audio.on ? t.level() : 0, audio.ctx.currentTime, 0.3);
}

// Waterfall ambience: louder as the camera nears the fall.
const VOLUME = 0.5; // overall level of the waterfall sound (1 = original)
export function waterfallSound({ camera, angle = WF.angle }) {
  const source = new THREE.Vector3(Math.sin(angle) * WF.lipR, 0.5, Math.cos(angle) * WF.lipR);
  return addTrack("assets/audio/waterfall.m4a", 3, () => {
    const near = 1 / (1 + Math.max(0, camera.position.distanceTo(source) - 2) * 0.35);
    return VOLUME * (0.15 + 0.6 * near);
  });
}

// "Wax in the ears" (the Sirens episode): far from the temple everything is muffled through a low-pass
// filter; as the camera closes in, the filter opens and the sound becomes clear and present.
const MUFFLE = { closed: 380, open: 20000, far: 10, near: 5.5 }; // cutoff Hz when muffled/clear; camera distance (m)
// How clear it is follows the way through the page: muffled at the book, clearing step by step up the
// stairs, fully clear at the temple, and muffled again as the view pulls away for Contact (or, without
// the book, wherever the camera is far from the temple).
export function muffle({ camera }) {
  const temple = new THREE.Vector3(0, 2.6, 0);
  return (dt, t, s) => {
    if (!audio.bus) return;
    const near = THREE.MathUtils.smoothstep(MUFFLE.far - camera.position.distanceTo(temple), 0, MUFFLE.far - MUFFLE.near);
    const story = (s.skillsW ?? 0) + (s.projectsW ?? 0) * (s.climb ?? 0) * 0.85;
    const clear = s.book ? Math.min(1, story) : near;
    const hz = MUFFLE.closed * Math.pow(MUFFLE.open / MUFFLE.closed, clear); // sweep evenly in pitch
    audio.bus.frequency.setTargetAtTime(hz, audio.ctx.currentTime, 0.5);
  };
}

// Background music: steady level, under the waterfall.
const MUSIC_VOLUME = 0.35;
export function music() {
  return addTrack("assets/audio/sirens.m4a", 4, () => MUSIC_VOLUME);
}

// ---------------------------------------------------------------- carved, gilded names
// Inscription form: capitals and an interpunct between words (U and J kept as written, for legibility).
export const epigraph = (text) =>
  text.toUpperCase().trim().split(/\s+/).join(" · ");

// Each discipline's name is cut into the ring's own marble in the shader: darkened recesses whose
// bevelled edges catch the light, with a little gilding in the grooves. Every name has its own row in
// the letter texture, centred on its column's measured angle, at one shared size, and with the same
// pixel density across and up the stone so the letters keep their true proportions.
// Revealed once the ring has settled; the active column's name glows.
export async function inscriptions({ parts, pillars, colAngle }) {
  await document.fonts.load('600 120px "Cinzel"');
  const ring = parts.top_ring;
  const BAND = [3.138, 3.202]; // world-space height of the lettering on the ring's outer face
  const FACE_R = 0.76; // radius of that face
  const angles = pillars.map((_, i) => colAngle(i));
  const sorted = [...angles].sort((p, q) => p - q);
  const minGap = Math.min(...sorted.map((v, i) => (i ? v - sorted[i - 1] : v + TAU - sorted[sorted.length - 1])));
  const SPAN = minGap * 0.9; // each name's slot, never overlapping the next
  const ROW_W = 2048;
  const ROW_H = Math.round((ROW_W * (BAND[1] - BAND[0])) / (FACE_R * SPAN)); // same texels per metre both ways
  const texts = pillars.map((p) => epigraph(p.latin ?? p.name));

  // one size for every name: the largest at which the longest still fits its slot
  const probe = document.createElement("canvas").getContext("2d");
  let px = Math.round(ROW_H * 0.66);
  const fits = () => {
    probe.font = `600 ${px}px "Cinzel"`;
    probe.letterSpacing = `${Math.round(px * 0.16)}px`;
    return Math.max(...texts.map((t) => probe.measureText(t).width)) <= ROW_W * 0.9;
  };
  while (!fits()) px--;

  const draw = (blur) => {
    const c = document.createElement("canvas");
    c.width = ROW_W;
    c.height = ROW_H * pillars.length;
    const x = c.getContext("2d");
    x.fillStyle = "#000";
    x.fillRect(0, 0, c.width, c.height);
    x.filter = blur ? `blur(${blur}px)` : "none";
    x.fillStyle = "#fff";
    x.font = `600 ${px}px "Cinzel"`;
    x.letterSpacing = `${Math.round(px * 0.16)}px`;
    x.textAlign = "center";
    x.textBaseline = "middle";
    texts.forEach((t, i) => x.fillText(t, ROW_W / 2, ROW_H * (i + 0.5) + px * 0.04));
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 16;
    return tex;
  };
  const uniforms = {
    uCarveMask: { value: draw(0) },
    uCarveSoft: { value: draw(2) }, // softened copy used as the depth of the cut
    uCarveBand: { value: new THREE.Vector2(...BAND) },
    uCarveTexel: { value: new THREE.Vector2(1.5 / ROW_W, 1.5 / (ROW_H * pillars.length)) },
    uColAng: { value: angles },
    uSpan: { value: SPAN },
    uCarveGlow: { value: new Array(6).fill(0) },
    uCarveReveal: { value: 0 },
  };
  const mat = ring.material;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>
        varying vec3 vCarveWorld;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vCarveWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vCarveWorld;
        uniform sampler2D uCarveMask, uCarveSoft;
        uniform vec2 uCarveBand, uCarveTexel;
        uniform float uColAng[6], uCarveGlow[6];
        uniform float uSpan, uCarveReveal;`)
      .replace("#include <map_fragment>", `#include <map_fragment>
        // which column's name this fragment belongs to, and where it sits within that name's slot
        float cAng = atan(vCarveWorld.x, vCarveWorld.z);
        int cIdx = 0;
        float cBest = 10.0, cDiff = 0.0, cGlow = 0.0;
        for (int i = 0; i < 6; i++) {
          float d = cAng - uColAng[i];
          d = atan(sin(d), cos(d));
          if (abs(d) < cBest) { cBest = abs(d); cIdx = i; cDiff = d; cGlow = uCarveGlow[i]; }
        }
        float cU = cDiff / uSpan + 0.5;
        float cV = (vCarveWorld.y - uCarveBand.x) / (uCarveBand.y - uCarveBand.x);
        float cOn = step(0.74, length(vCarveWorld.xz)) * step(0.0, cU) * step(cU, 1.0) * step(0.0, cV) * step(cV, 1.0) * uCarveReveal;
        vec2 cUv = vec2(cU, 1.0 - (float(cIdx) + 1.0 - cV) / 6.0);
        float cMask = texture2D(uCarveMask, cUv).r * cOn;
        vec2 cGrad = vec2(
          texture2D(uCarveSoft, cUv + vec2(uCarveTexel.x, 0.0)).r - texture2D(uCarveSoft, cUv - vec2(uCarveTexel.x, 0.0)).r,
          texture2D(uCarveSoft, cUv + vec2(0.0, uCarveTexel.y)).r - texture2D(uCarveSoft, cUv - vec2(0.0, uCarveTexel.y)).r) * cOn;
        diffuseColor.rgb *= 1.0 - 0.6 * cMask;                                          // the shadowed groove
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.74, 0.55, 0.25), cMask * 0.3); // a trace of gilding`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.4, cMask * 0.7);`)
      .replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.4, cMask * 0.7);`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
        // tilt the normal along the cut's slope so its walls catch and shade the light
        vec3 cT = normalize((viewMatrix * vec4(cos(cAng), 0.0, -sin(cAng), 0.0)).xyz);
        vec3 cB = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
        normal = normalize(normal + (cT * cGrad.x + cB * cGrad.y) * 3.5);`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(0.9, 0.55, 0.2) * cMask * cGlow;`);
  };
  mat.needsUpdate = true;
  return (dt, t, s) => {
    uniforms.uCarveReveal.value = damp(uniforms.uCarveReveal.value, s.introDone ? 1 : 0, 1.5, dt);
    const glow = uniforms.uCarveGlow.value;
    for (let i = 0; i < 6; i++) glow[i] = damp(glow[i], i === s.activeCol ? 0.45 * Math.max(s.skillsW, 0.25) : 0, 5, dt);
  };
}

// ---------------------------------------------------------------- career staircase
// The career told as a climb: each chapter is cut into the front face (riser) of a real step, bottom =
// earliest, in weathered Roman capitals carved into the stone itself, so the lettering is part of the
// steps and never drifts. In Work the camera looks up the staircase and stops at each chapter's step in
// turn (see main.js); that step's engraving catches fire (the `fire` option), or glows warm without it.
// The stairs are a time scale: each chapter sits on the step matching its start date (year + month),
// today is STEP.future steps below the top, and those top steps stay uncut for what comes next (an
// undated entry is carved in their middle).
// `carve` is the short form cut into the step, converted with epigraph() and given a Roman year (words get
// interpuncts; "_" joins them with a plain space); the rest is the plain-text timeline beside the stairs
// (`desc` may hold links). Edit both together.
export const MILESTONES = [
  { year: 2020, month: 6, carve: "B.Eng", title: "B.Eng. Mechanical Engineering", org: "Specialisation in robotics",
    desc: "I studied mechanical engineering with a focus on robotics, because I wanted to know how to make a machine move on its own. Four years of gears, circuits and control theory later, I graduated with distinction and a lasting soft spot for robots." },
  { year: 2020, month: 12, to: 2021, carve: "Education", title: "Design & Technology Teacher", org: "Cambridge AS-Level · grades 11 and 12",
    desc: "I taught Design & Technology to grades 11 and 12, the subject where students take an idea from a sketch to a working product: CAD, materials, prototypes and all. I set up the school’s first Cambridge AS-Level class and learned that explaining something clearly to a room of teenagers is harder than any exam I ever sat." },
  { year: 2021, month: 6, carve: "Robotics_I", title: "Robotics & Software Engineer", org: "BMW Group · SortBot",
    desc: "At BMW I worked on SortBot: a UR10 robot arm with cameras, conveyor belts, grippers, sensors, PLCs and safety equipment around it, sorting the KLTs, the small containers that carry parts through vehicle production. I made the line’s robot arms about 30% faster with Python and ROS, and programmed the UR10s with state machines that now run in plants with five to ten cells each. It was my first taste of code that moves real things, and I was hooked." },
  // listed before sewts (graduated during it), so the degree reads as finished first
  { year: 2022, month: 5, carve: "M.Sc", title: "M.Sc. Software Engineering", org: "Emphasis in AI engineering",
    desc: "I went back for a master’s in software engineering with a focus on AI, and my research made it into the <i>Journal of Bionic Engineering</i>: a fuzzy-logic exoskeleton that keeps paraplegic patients balanced as they walk on crutches. I graduated with distinction, on a scholarship." },
  // started 11/2021; shown as 2022 and placed just after the M.Sc
  { year: 2022, month: 6, carve: "Robotics_II", title: "Robotics & Software Engineer", org: "sewts · VELUM",
    desc: "At sewts, a Munich start-up, I helped teach robots to handle fabric, one of the hardest things a machine can pick up: it never lands the same way twice. Our system, VELUM, reads the corners and seams of deformable materials with 3D cameras and AI, and FANUC robots spread them out and feed them into industrial laundries’ folding machines. As in any start-up I did a bit of everything: the computer vision (which lifted output by over 40%), the robots, the processes and, now and then, the hardware." },
  { year: 2022, month: 12, to: 2025, carve: "Software", title: "Software Architect & Project Manager", org: "Deutsche Telekom · T-Systems",
    desc: "I spent three years at Deutsche Telekom, mostly facing customers: consulting as a solutions architect, building, and running their projects. I built the identity platform (Keycloak on Kubernetes) that lets around 200,000 Telekom employees sign in once and get on with their day. On Open Telekom Cloud I designed and migrated cloud infrastructure for large logistics and healthcare companies, right down to procuring the hardware. And for the European Central Bank I led five teams, sixty developers, through a legacy migration that landed on schedule." },
  { year: 2023, month: 1, to: "present", carve: "Ventures", title: "Evolve Consulting & CloudChamp", org: "My own ventures",
    desc: [
      "Alongside my day job I ran <a href=\"https://www.linkedin.com/feed/update/urn:li:activity:7384455242941087744\" target=\"_blank\" rel=\"noopener\">Evolve Consulting</a> (2023-2025): start-ups and small businesses came to me with an idea, a free first consultation tested it, and I turned it into a product, fast. I built mostly in Node.js and TypeScript, React and Next.js, with AWS behind it all, plus Stripe payments and Twilio voice. My two favourites: a social platform for athletes, and an augmented-reality app that drops designer furniture and art into your living room through your phone’s camera.",
      "<a href=\"https://cloudchamp.de\" target=\"_blank\" rel=\"noopener\">CloudChamp</a> is still going: a study platform I built for anyone preparing for an AWS certification, with learning paths that take you from the basics to the exam.",
    ] },
  { year: 2026, month: 1, to: "present", carve: "Cloud", title: "Technical Account Manager", org: "Amazon Web Services",
    desc: "I’m a Technical Account Manager at AWS, working with banks and insurers. I consult everyone from CEOs and CISOs to engineers on GenAI, security, resilience and cost, help them move to AWS without breaking any rules (DORA and GDPR included), and stay with them when things go wrong. So far that has added up to over $2M a year in AWS revenue." },
  // no date: carved in the middle of the uncut steps at the top
  { carve: "Plus Ultra", title: "What comes next", org: "Plus ultra · further beyond",
    desc: "The steps above are still uncut. I want to keep climbing: deeper into cloud architecture and GenAI, new skills, and projects that make me lose track of time, alongside people I can learn from." },
];
export const roman = (n) =>
  [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]]
    .reduce((s, [v, r]) => { while (n >= v) (s += r), (n -= v); return s; }, "");

// fade: how far the dark panel fades in from the riser's edges (share of its height) · panel: panel brightness
// future: uncut steps above today. panel: brightness of the stone around an active (burning) engraving
// dress: how much the stone's detail is smoothed around the letters (0 = raw stone)
export const STEP = { fade: 0.25, panel: 0.5, gap: 0.03, future: 3, wear: 1, dress: 0.65 }; // wear: 0 = crisp, 1 = weathered // gap: riser faces closer than this (m, along the stairs) are one step
export async function staircase({ scene, parts, fire: withFire }) {
  const mesh = parts.steps;
  mesh.updateMatrixWorld(true);
  const pos = mesh.geometry.attributes.position, idx = mesh.geometry.index.array;
  const tri = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], n = new THREE.Vector3();
  const treads = [], sides = [];
  for (let t = 0; t < idx.length; t += 3) {
    tri.forEach((v, k) => v.fromBufferAttribute(pos, idx[t + k]).applyMatrix4(mesh.matrixWorld));
    n.subVectors(tri[1], tri[0]).cross(tri[2].clone().sub(tri[0]));
    const area = n.length() / 2;
    n.normalize();
    const c = tri[0].clone().add(tri[1]).add(tri[2]).divideScalar(3);
    if (n.y > 0.9) treads.push({ c, area });
    else if (Math.abs(n.y) < 0.25) sides.push({ c, area, n: n.clone(), verts: tri.map((v) => v.clone()) });
  }
  // downhill: from the top tread towards the bottom one, flattened
  treads.sort((a, b) => a.c.y - b.c.y);
  const downhill = treads[0].c.clone().sub(treads[treads.length - 1].c).setY(0).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  // risers: faces looking down the stairs, grouped by how far along the stairs they stand (each step's
  // front face is one roughly flat wall), so no riser is split or merged with the next
  const faces = sides.filter((s) => s.n.dot(downhill) > 0.6).map((s) => Object.assign(s, { d: s.c.dot(downhill) })).sort((a, b) => a.d - b.d);
  const groups = [];
  for (const f of faces) {
    const g = groups.at(-1);
    if (g && f.d - g.at(-1).d < STEP.gap) g.push(f);
    else groups.push([f]);
  }
  // each riser's own plane and axes. A riser is a quad (2 triangles; the detail is in the texture), which
  // can lean back and be rolled sideways: the lettering runs along its top and bottom edges and stays
  // inside all four corners
  const rects = groups.map((tris) => {
    const area = tris.reduce((a, s) => a + s.area, 0);
    const normal = tris.reduce((a, s) => a.addScaledVector(s.n, s.area), new THREE.Vector3()).normalize();
    const t0 = new THREE.Vector3().crossVectors(up, normal).normalize(), u0 = new THREE.Vector3().crossVectors(normal, t0);
    const vs = [];
    for (const p of tris.flatMap((s) => s.verts)) if (!vs.some((q) => q.distanceToSquared(p) < 1e-8)) vs.push(p);
    vs.sort((a, b) => a.dot(u0) - b.dot(u0));
    const lo = vs.slice(0, 2), hi = vs.slice(-2);
    const dir = ([a, b]) => ((a = b.clone().sub(a).normalize()), a.dot(t0) < 0 ? a.negate() : a);
    const tan = dir(hi).add(dir(lo)).projectOnPlane(normal).normalize();
    const vUp = new THREE.Vector3().crossVectors(normal, tan);
    const x = (p) => p.dot(tan), y = (p) => p.dot(vUp);
    const x0 = Math.max(Math.min(...lo.map(x)), Math.min(...hi.map(x))), x1 = Math.min(Math.max(...lo.map(x)), Math.max(...hi.map(x)));
    const y0 = Math.max(...lo.map(y)), y1 = Math.min(...hi.map(y));
    const ref = vs[0], off = ref.dot(normal); // plane offset, so the centre lies on the face
    const centre = tan.clone().multiplyScalar((x0 + x1) / 2).addScaledVector(vUp, (y0 + y1) / 2).addScaledVector(normal, off);
    return { centre, normal, tan, up: vUp, w: x1 - x0, h: y1 - y0, area, roll: Math.asin(tan.y) };
  }).filter((r) => r.w > 0.14 && r.h > 0.035 && r.area > 0.01).sort((a, b) => a.centre.y - b.centre.y);
  // the bottom face runs on into the ground: only the part above the ground just in front of it counts
  parts.ground.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(), from = new THREE.Vector3(), down = new THREE.Vector3(0, -1, 0);
  for (const r of rects) {
    ray.set(from.copy(r.centre).addScaledVector(r.normal, 0.04).setY(r.centre.y + 1), down);
    const g = ray.intersectObject(parts.ground, false)[0]?.point.y ?? -Infinity;
    const top = r.centre.y + (r.h / 2) * r.up.y, h = (top - g - 0.01) / r.up.y;
    if (h < r.h) r.centre.addScaledVector(r.up, (r.h - h) / 2), (r.h = h);
  }
  // a face can run down behind the tread below it: only the part above the riser beneath is visible
  rects.forEach((r, i) => {
    if (!i) return;
    const top = r.centre.y + (r.h / 2) * r.up.y, below = rects[i - 1].centre.y + (rects[i - 1].h / 2) * rects[i - 1].up.y;
    const h = (top - below) / r.up.y;
    if (h < r.h) r.centre.addScaledVector(r.up, (r.h - h) / 2), (r.h = h);
  });
  // each carved chapter on the step of its start date: first chapter = bottom step, today = STEP.future
  // steps below the top. Two chapters on one step: the later one moves up to the next free step.
  const carved = MILESTONES.filter((m) => m.carve), N = carved.length, dated = MILESTONES.filter((m) => m.year);
  const date = (m) => m.year + (m.month - 1) / 12, now = new Date();
  const t0 = date(dated[0]), tNow = now.getFullYear() + now.getMonth() / 12, last = rects.length - 1 - STEP.future;
  let k = -1;
  const at = new Map(dated.map((m) => [m, rects[(k = Math.max(k + 1, Math.round(((date(m) - t0) / (tNow - t0)) * last)))]]));
  const rectOf = MILESTONES.map((m) => at.get(m) ?? rects[rects.length - 1 - (STEP.future >> 1)]);
  const chosen = carved.map((m) => rectOf[MILESTONES.indexOf(m)]);

  // letter atlas: one row per milestone, each row with the riser's own proportions
  await document.fonts.load('700 120px "Cinzel"');
  const ROW_W = 1024, MARGIN = 0.7; // MARGIN: widest lettering as a share of the riser (its ends can sit behind the rock)
  const rowsH = chosen.map((r) => Math.round((ROW_W * r.h) / r.w));
  const H = rowsH.reduce((a, b) => a + b, 0);
  const texts = carved.map((m) => epigraph(`${m.year ? roman(m.year) : ""} ${m.carve}`).replace(/_/g, " ")); // "_": a space without an interpunct
  const draw = (blur) => {
    const c = document.createElement("canvas");
    c.width = ROW_W;
    c.height = H;
    const x = c.getContext("2d");
    x.fillStyle = "#000";
    x.fillRect(0, 0, ROW_W, H);
    x.filter = blur ? `blur(${blur}px)` : "none";
    x.fillStyle = "#fff";
    x.textAlign = "center";
    x.textBaseline = "middle";
    let y = 0;
    texts.forEach((t, i) => {
      let px = Math.round(rowsH[i] * 0.5); // capitals fill about 35% of the riser's height
      const fit = () => ((x.font = `700 ${px}px "Cinzel"`), (x.letterSpacing = `${Math.round(px * 0.12)}px`), x.measureText(t).width <= ROW_W * MARGIN);
      while (!fit()) px--;
      x.fillText(t, ROW_W / 2, y + rowsH[i] / 2 + px * 0.04);
      y += rowsH[i];
    });
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 16;
    return tex;
  };
  let v = 0;
  const rows = rowsH.map((h) => {
    const r = new THREE.Vector2(1 - (v + h) / H, 1 - v / H); // canvas top = v 1
    v += h;
    return r;
  });
  const uniforms = {
    uStepMask: { value: draw(0) },
    uStepSoft: { value: draw(2) },
    uStepTexel: { value: new THREE.Vector2(1.5 / ROW_W, 1.5 / H) },
    uStepC: { value: chosen.map((r) => r.centre) },
    uStepT: { value: chosen.map((r) => r.tan) },
    uStepN: { value: chosen.map((r) => r.normal) },
    uStepU: { value: chosen.map((r) => r.up) },
    uStepSize: { value: chosen.map((r) => new THREE.Vector2(r.w, r.h)) },
    uStepRow: { value: rows },
    uStepGlow: { value: new Array(N).fill(0) },
    uStepTime: { value: 0 },
  };
  const mat = mesh.material;
  const prev = mat.onBeforeCompile; // detailTextures() may already patch this material: ours runs first, then it
  mat.onBeforeCompile = (sh, r) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>
        varying vec3 vStepWorld;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vStepWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vStepWorld;
        uniform sampler2D uStepMask, uStepSoft;
        uniform vec2 uStepTexel;
        uniform vec3 uStepC[${N}], uStepT[${N}], uStepN[${N}], uStepU[${N}];
        uniform vec2 uStepSize[${N}], uStepRow[${N}];
        uniform float uStepGlow[${N}], uStepTime;
        float stepHash(vec3 p) { p = fract(p * 0.3183099 + 0.1) * 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float stepNoise(vec3 x) { // value noise, for the weathering
          vec3 i = floor(x), f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(stepHash(i), stepHash(i + vec3(1, 0, 0)), f.x), mix(stepHash(i + vec3(0, 1, 0)), stepHash(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(stepHash(i + vec3(0, 0, 1)), stepHash(i + vec3(1, 0, 1)), f.x), mix(stepHash(i + vec3(0, 1, 1)), stepHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }`)
      .replace("#include <map_fragment>", `#include <map_fragment>
        // is this fragment on one of the milestone risers? where, in that riser's lettering?
        float sMask = 0.0, sSoft = 0.0, sRim = 0.0, sPanel = 0.0, sGlow = 0.0;
        vec2 sM = vec2(0.0); // position on the riser, in metres
        vec2 sGrad = vec2(0.0);
        vec3 sT = vec3(1.0, 0.0, 0.0), sU = vec3(0.0, 1.0, 0.0);
        for (int i = 0; i < ${N}; i++) {
          vec3 d = vStepWorld - uStepC[i];
          vec2 q = vec2(dot(d, uStepT[i]) / uStepSize[i].x, dot(d, uStepU[i]) / uStepSize[i].y) + 0.5;
          if (abs(dot(d, uStepN[i])) < 0.02 && q.x > 0.0 && q.x < 1.0 && q.y > 0.0 && q.y < 1.0) {
            vec2 uv = vec2(q.x, mix(uStepRow[i].x, uStepRow[i].y, q.y));
            sMask = texture2D(uStepMask, uv).r;
            sSoft = texture2D(uStepSoft, uv).r;
            sRim = clamp(sSoft * 1.8 - sMask, 0.0, 1.0); // shadowed groove walls
            // the dressed panel fades in from the riser's (chipped) edges: no hard border
            vec2 e = min(q, 1.0 - q) * uStepSize[i] / uStepSize[i].y;
            sPanel = smoothstep(0.0, STEP_FADE, min(e.x, e.y));
            sGrad = vec2(
              texture2D(uStepSoft, uv + vec2(uStepTexel.x, 0.0)).r - texture2D(uStepSoft, uv - vec2(uStepTexel.x, 0.0)).r,
              texture2D(uStepSoft, uv + vec2(0.0, uStepTexel.y)).r - texture2D(uStepSoft, uv - vec2(0.0, uStepTexel.y)).r);
            sGlow = uStepGlow[i];
            sM = q * uStepSize[i];
            sT = uStepT[i];
            sU = uStepU[i];
          }
        }
        // weathering: chipped, uneven letter edges
        float sN1 = stepNoise(vStepWorld * 110.0);
        float sCut = sMask > 0.0 ? sMask * smoothstep(0.25, 0.6, sSoft + (sN1 - 0.5) * 0.9 * STEP_WEAR) : 0.0; // the cut letters
        // the carving is the stone's own: a shadowed recess whose walls catch the light (normal, below), cut
        // into a dressed face (the same stone, its busy detail smoothed: a blurred sample of its own texture,
        // fading out towards the riser's edges). Around the active engraving the stone darkens a little, so
        // the fire stands out.
        #ifdef USE_MAP
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuse * texture2D(map, vMapUv, 5.0).rgb, STEP_DRESS * sPanel);
        #endif
        diffuseColor.rgb *= mix(1.0, STEP_PANEL, sPanel * sGlow);
        diffuseColor.rgb *= 1.0 - 0.65 * sRim;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.25 + vec3(0.025, 0.022, 0.02), 0.75 * sCut); // deep, even shadow in the cut
        // fire (active step), inside the grooves only: a dark red bed with thin tongues of flame rising and
        // flickering through each stroke (ridged noise, stretched upwards), brightest where the stroke is deepest
        float sFire = 0.0;
        vec3 sFireCol = vec3(0.0);
        #if STEP_FIRE
          if (sCut > 0.0 && sGlow > 0.0) {
            float t = uStepTime;
            float r1 = 1.0 - abs(stepNoise(vec3(sM.x * 140.0, sM.y * 28.0 - t * 2.6, t * 0.8)) * 2.0 - 1.0);
            float r2 = 1.0 - abs(stepNoise(vec3(sM.x * 260.0 + 5.0, sM.y * 55.0 - t * 4.1, t * 1.3)) * 2.0 - 1.0);
            float tongues = pow(r1, 4.0) * 0.7 + pow(r2, 6.0) * 0.5;
            float bed = stepNoise(vec3(sM.x * 40.0, sM.y * 40.0 - t * 0.6, t * 0.4));
            float heat = clamp((0.18 + 0.25 * bed + tongues) * smoothstep(0.3, 0.9, sSoft), 0.0, 1.0) * sCut * sGlow;
            sFire = heat;
            sFireCol = mix(vec3(0.3, 0.02, 0.0), vec3(1.0, 0.3, 0.03), smoothstep(0.1, 0.5, heat));
            sFireCol = mix(sFireCol, vec3(1.0, 0.68, 0.3), smoothstep(0.55, 0.95, heat));
            diffuseColor.rgb *= 1.0 - 0.8 * sCut * sGlow; // the stone under the fire goes dark
          }
        #endif`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
        normal = normalize(normal + ((viewMatrix * vec4(sT, 0.0)).xyz * sGrad.x + (viewMatrix * vec4(sU, 0.0)).xyz * sGrad.y) * 4.5);`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.56, 0.2) * sCut * sGlow * 0.5 * (1.0 - STEP_FIRE_F); // without fire: a warm glow
        totalEmissiveRadiance += sFireCol * sFire * 1.2 + vec3(1.0, 0.32, 0.06) * sRim * sGlow * 0.11 * STEP_FIRE_F; // embers, and their glow on the groove walls`);
    sh.fragmentShader = `#define STEP_FADE ${STEP.fade.toFixed(3)}
#define STEP_PANEL ${STEP.panel.toFixed(3)}
#define STEP_WEAR ${STEP.wear.toFixed(3)}
#define STEP_DRESS ${STEP.dress.toFixed(3)}
#define STEP_FIRE ${withFire ? 1 : 0}
#define STEP_FIRE_F ${withFire ? "1.0" : "0.0"}
` + sh.fragmentShader;
    prev?.(sh, r);
  };
  mat.needsUpdate = true;

  // warm lamp in front of the active step, so its face isn't lost against the low sun (a faint flicker with `fire`)
  const lamp = new THREE.PointLight(withFire ? 0xffb070 : 0xffd6a0, 0, 2.2, 1.4);
  scene.add(lamp);
  let lampLevel = 0;
  // where the camera looks for milestone i: the riser's centre, nudged up the stairs a little
  const point = (i, out) => out.copy(rectOf[i].centre).addScaledVector(up, 0.06);
  const facing = (i) => rectOf[i].normal;
  const update = (dt, t, s) => {
    const glow = uniforms.uStepGlow.value;
    for (let i = 0; i < N; i++) glow[i] = damp(glow[i], carved[i] === MILESTONES[s.milestone] ? s.projectsW : 0, 4, dt);
    const r = rectOf[s.milestone];
    if (r) lamp.position.copy(r.centre).addScaledVector(r.normal, 0.55).addScaledVector(up, 0.35);
    lampLevel = damp(lampLevel, 2 * s.projectsW, 4, dt);
    lamp.intensity = lampLevel * (withFire ? 0.92 + 0.05 * Math.sin(t * 7.3) + 0.03 * Math.sin(t * 17.9 + 1.3) : 1);
    uniforms.uStepTime.value = t;
  };
  return { update, point, facing, count: MILESTONES.length };
}

// ---------------------------------------------------------------- hero: the book on the lectern
// Visitors start close on a closed leather book lying on a lectern at the foot of the stairs, name and
// current role stamped in gold on its cover. The first scroll opens it: the cover swings over, then a few
// pages turn, curling as they go, to a spread with a short introduction on the left and the
// certifications on the right (each one a link). Scrolling on, the camera pulls back and climbs the
// stairs. The HTML hero stays in the page for screen readers.
// the introduction on the open book's left page
export const ABOUT = "This is my story so far, told as a climb. It starts at the foot of these stairs with robots, winds up through software and reaches, for now, the cloud. Every step is a chapter, and I’m always ready for the next one.";
export const PRESENTLY = ["Technical Account Manager", "Amazon Web Services"];
export const COVER = { name: "Jad Eid", lines: ["Software Engineer", "Cloud Architect"] };
// From the latest CV. url: the public verification page (null: not linked yet)
export const CERTS = [
  { name: "Solutions Architect - Professional", issuer: "Amazon Web Services", badge: "aws-certified-solutions-architect-professional.png", url: "https://www.credly.com/badges/3555ea61-2f8d-4002-a23a-1ec8a1901593/public_url" },
  { name: "Security - Specialty", issuer: "Amazon Web Services", badge: "aws-certified-security-specialty.png", url: "https://www.credly.com/badges/40337c25-9cd8-4e32-9b6e-b899f47de45c/public_url" },
  { name: "Solutions Architect - Associate", issuer: "Amazon Web Services", badge: "aws-certified-solutions-architect-associate.png", url: "https://www.credly.com/badges/748da346-648f-443b-aa8b-50fc4e3e1646/public_url" },
  { name: "Professional Cloud Architect", issuer: "Google Cloud", badge: "professional-cloud-architect-certification.png", url: "https://www.credly.com/badges/048240ca-c89f-41a7-b8e3-d5946a609d6b/public_url" },
  { name: "Professional Scrum Master I", issuer: "Scrum.org", badge: "professional-scrum-master-i.png", url: "https://www.credly.com/badges/f91b6b95-2620-4c01-badb-2b2b3cae6271/public_url" },
];
// under the introduction, with their icons
export const PROFILES = [
  { icon: "linkedin", label: "LinkedIn", url: "https://www.linkedin.com/in/jadeid99/" },
  { icon: "cv", label: "CV", url: "https://drive.google.com/file/d/1vVBf0OVJAkedMu4y8bwIIkTMLeyUnaAk/view?usp=sharing" },
  { icon: "github", label: "GitHub", url: "https://github.com/JadEid99" },
];
// The pages turned on the way in: Homer's Odyssey in the Greek (public domain), [book, first line, lines]
const ODYSSEY = {
  proem: ["Α", 1, [
    "Ἄνδρα μοι ἔννεπε, Μοῦσα, πολύτροπον, ὃς μάλα πολλὰ",
    "πλάγχθη, ἐπεὶ Τροίης ἱερὸν πτολίεθρον ἔπερσε·",
    "πολλῶν δ᾽ ἀνθρώπων ἴδεν ἄστεα καὶ νόον ἔγνω,",
    "πολλὰ δ᾽ ὅ γ᾽ ἐν πόντῳ πάθεν ἄλγεα ὃν κατὰ θυμόν,",
    "ἀρνύμενος ἥν τε ψυχὴν καὶ νόστον ἑταίρων.",
    "ἀλλ᾽ οὐδ᾽ ὧς ἑτάρους ἐρρύσατο, ἱέμενός περ·",
    "αὐτῶν γὰρ σφετέρῃσιν ἀτασθαλίῃσιν ὄλοντο,",
    "νήπιοι, οἳ κατὰ βοῦς Ὑπερίονος Ἠελίοιο",
    "ἤσθιον· αὐτὰρ ὁ τοῖσιν ἀφείλετο νόστιμον ἦμαρ.",
    "τῶν ἁμόθεν γε, θεά, θύγατερ Διός, εἰπὲ καὶ ἡμῖν.",
  ]],
  outis: ["Ι", 364, [
    "Κύκλωψ, εἰρωτᾷς μ᾽ ὄνομα κλυτόν, αὐτὰρ ἐγώ τοι",
    "ἐξερέω· σὺ δέ μοι δὸς ξείνιον, ὥς περ ὑπέστης.",
    "Οὖτις ἐμοί γ᾽ ὄνομα· Οὖτιν δέ με κικλήσκουσι",
    "μήτηρ ἠδὲ πατὴρ ἠδ᾽ ἄλλοι πάντες ἑταῖροι.",
  ]],
  sirens: ["Μ", 184, [
    "δεῦρ᾽ ἄγ᾽ ἰών, πολύαιν᾽ Ὀδυσεῦ, μέγα κῦδος Ἀχαιῶν,",
    "νῆα κατάστησον, ἵνα νωϊτέρην ὄπ᾽ ἀκούσῃς.",
    "οὐ γάρ πώ τις τῇδε παρήλασε νηῒ μελαίνῃ,",
    "πρίν γ᾽ ἡμέων μελίγηρυν ἀπὸ στομάτων ὄπ᾽ ἀκοῦσαι,",
    "ἀλλ᾽ ὅ γε τερψάμενος νεῖται καὶ πλείονα εἰδώς.",
    "ἴδμεν γάρ τοι πάνθ᾽, ὅσ᾽ ἐνὶ Τροίῃ εὐρείῃ",
    "Ἀργεῖοι Τρῶές τε θεῶν ἰότητι μόγησαν,",
    "ἴδμεν δ᾽, ὅσσα γένηται ἐπὶ χθονὶ πουλυβοτείρῃ.",
  ]],
};
// Sizes in scene units (1 ≈ 1.4 m, judging by the steps). lectern: height · bearing: which way from the
// island's middle it stands (radians; 0.3 = the right as seen in Contact), facing out · inset: how far in from
// the edge · open: seconds the opening takes ·
// pages: pages that turn · curl: how far a turning page's edge lags · fill: how much of the screen the book
// takes (the closed cover, then the open spread)
export const BOOK = { w: 0.15, h: 0.2, board: 0.004, stack: 0.011, lectern: 0.8, bearing: 0.3, inset: 0.6, open: 2.6, pages: 3, curl: 0.9, fill: 0.74 };

const PAGE_PX = [1024, Math.round((1024 * BOOK.h) / BOOK.w)];
const easeIO = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// aged paper: warm base, faint stains, grain, darker worn edges
function parchment([w, h], rnd) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d");
  x.fillStyle = "#d9c193";
  x.fillRect(0, 0, w, h);
  for (let i = 0; i < 110; i++) {
    const r = (0.04 + rnd() * 0.24) * w, px = rnd() * w, py = rnd() * h, a = 0.03 + rnd() * 0.07;
    const g = x.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, `rgba(140,100,50,${a})`);
    g.addColorStop(1, "rgba(140,100,50,0)");
    x.fillStyle = g;
    x.fillRect(px - r, py - r, 2 * r, 2 * r);
  }
  const img = x.getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 12;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  x.putImageData(img, 0, 0);
  // foxing: small rust-brown spots
  for (let i = 0; i < 70; i++) {
    const r = 2 + rnd() * 6, px = rnd() * w, py = rnd() * h, g = x.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, `rgba(120,70,30,${0.15 + rnd() * 0.25})`);
    g.addColorStop(1, "rgba(120,70,30,0)");
    x.fillStyle = g;
    x.fillRect(px - r, py - r, 2 * r, 2 * r);
  }
  // worn, nicked edges: dark bites along the border
  for (let i = 0; i < 160; i++) {
    const t = rnd(), side = Math.floor(rnd() * 4), r = 3 + rnd() * 14;
    const [px, py] = [[t * w, 0], [t * w, h], [0, t * h], [w, t * h]][side];
    const g = x.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, `rgba(95,60,25,${0.25 + rnd() * 0.3})`);
    g.addColorStop(1, "rgba(95,60,25,0)");
    x.fillStyle = g;
    x.fillRect(px - r, py - r, 2 * r, 2 * r);
  }
  const e = 0.06 * w;
  for (const [x0, y0, x1, y1, rx, ry, rw, rh] of [[0, 0, e, 0, 0, 0, e, h], [w, 0, w - e, 0, w - e, 0, e, h], [0, 0, 0, e, 0, 0, w, e], [0, h, 0, h - e, 0, h - e, w, e]]) {
    const g = x.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, "rgba(100,64,28,0.45)");
    g.addColorStop(1, "rgba(105,70,32,0)");
    x.fillStyle = g;
    x.fillRect(rx, ry, rw, rh);
  }
  return c;
}

function wrapText(x, text, width) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    const t = line ? `${line} ${word}` : word;
    if (x.measureText(t).width > width(lines.length) && line) lines.push(line), (line = word);
    else line = t;
  }
  return line ? [...lines, line] : lines;
}

// a centred rule with a lozenge in the middle
function rule(x, cx, y, half, colour) {
  x.strokeStyle = x.fillStyle = colour;
  x.lineWidth = 2;
  x.beginPath();
  x.moveTo(cx - half, y);
  x.lineTo(cx - 14, y);
  x.moveTo(cx + 14, y);
  x.lineTo(cx + half, y);
  x.stroke();
  x.beginPath();
  x.moveTo(cx, y - 8);
  x.lineTo(cx + 8, y);
  x.lineTo(cx, y + 8);
  x.lineTo(cx - 8, y);
  x.fill();
}

const INK = "#3a2916", SEPIA = "#74552d", RED = "#8a2f1d";

// Weathering for the lectern: patches of grime (world-space noise, so it doesn't follow the UVs), metal
// parts tarnished duller and browner, and every surface less polished
function weather(mat) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWeatherW;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWeatherW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vWeatherW;
        float wHash(vec3 p) { p = fract(p * 0.3183099 + 0.1) * 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float wNoise3(vec3 x) {
          vec3 i = floor(x), f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(wHash(i), wHash(i + vec3(1, 0, 0)), f.x), mix(wHash(i + vec3(0, 1, 0)), wHash(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(wHash(i + vec3(0, 0, 1)), wHash(i + vec3(1, 0, 1)), f.x), mix(wHash(i + vec3(0, 1, 1)), wHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }`)
      .replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>
        float wN = wNoise3(vWeatherW * 14.0) * 0.6 + wNoise3(vWeatherW * 60.0) * 0.4;
        float wDirt = smoothstep(0.35, 0.85, wN);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.62, 0.5, 0.38), metalnessFactor * (0.5 + 0.4 * wDirt)); // tarnish
        diffuseColor.rgb *= 1.0 - 0.32 * wDirt;                                                                            // grime
        roughnessFactor = clamp(roughnessFactor + 0.22 + 0.3 * wDirt, 0.0, 1.0);
        metalnessFactor *= 1.0 - 0.25 * wDirt;`);
    prev?.(sh, r);
  };
  mat.needsUpdate = true;
  return mat;
}

// small line icons for the profile links, drawn in ink
const GITHUB_MARK = new Path2D("M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z");
function drawIcon(x, kind, cx, cy, s, colour) {
  x.save();
  x.translate(cx - s / 2, cy - s / 2);
  x.fillStyle = x.strokeStyle = colour;
  if (kind === "github") {
    x.scale(s / 16, s / 16);
    x.fill(GITHUB_MARK);
  } else if (kind === "linkedin") {
    x.beginPath();
    x.roundRect(0, 0, s, s, s * 0.16);
    x.fill();
    x.fillStyle = "#e6d5ae";
    x.fillRect(s * 0.18, s * 0.42, s * 0.14, s * 0.4);
    x.beginPath();
    x.arc(s * 0.25, s * 0.27, s * 0.085, 0, Math.PI * 2);
    x.fill();
    x.fillRect(s * 0.41, s * 0.42, s * 0.13, s * 0.4);
    x.beginPath();
    x.moveTo(s * 0.54, s * 0.55);
    x.quadraticCurveTo(s * 0.56, s * 0.4, s * 0.68, s * 0.41);
    x.quadraticCurveTo(s * 0.83, s * 0.42, s * 0.83, s * 0.58);
    x.lineTo(s * 0.83, s * 0.82);
    x.lineTo(s * 0.7, s * 0.82);
    x.lineTo(s * 0.7, s * 0.6);
    x.quadraticCurveTo(s * 0.69, s * 0.52, s * 0.62, s * 0.53);
    x.quadraticCurveTo(s * 0.55, s * 0.54, s * 0.54, s * 0.62);
    x.lineTo(s * 0.54, s * 0.82);
    x.fill();
  } else if (kind === "link") {
    // two interlocking links, on the diagonal
    x.lineWidth = s * 0.14;
    x.translate(s / 2, s / 2);
    x.rotate(-Math.PI / 4);
    const L = s * 0.5, r = s * 0.17;
    for (const dx of [-L * 0.36, L * 0.36]) {
      x.beginPath();
      x.roundRect(dx - L / 2, -r, L, 2 * r, r);
      x.stroke();
    }
  } else {
    // a résumé: a solid page with a folded corner, a portrait and lines of text knocked out of it
    x.beginPath();
    x.moveTo(s * 0.16, s * 0.04);
    x.lineTo(s * 0.62, s * 0.04);
    x.lineTo(s * 0.86, s * 0.28);
    x.lineTo(s * 0.86, s * 0.96);
    x.lineTo(s * 0.16, s * 0.96);
    x.closePath();
    x.fill();
    x.fillStyle = "#dcc79a";
    x.globalAlpha = 0.5;
    x.beginPath();
    x.moveTo(s * 0.62, s * 0.04);
    x.lineTo(s * 0.62, s * 0.28);
    x.lineTo(s * 0.86, s * 0.28);
    x.closePath();
    x.fill();
    x.globalAlpha = 1;
    x.beginPath();
    x.arc(s * 0.36, s * 0.3, s * 0.085, 0, Math.PI * 2);
    x.fill();
    x.fillRect(s * 0.27, s * 0.42, s * 0.18, s * 0.05);
    for (const y of [0.56, 0.68, 0.8]) x.fillRect(s * 0.27, s * y, s * 0.46, s * 0.05);
  }
  x.restore();
}

export async function heroBook({ scene, renderer, camera, parts, pose, work }) {
  await Promise.all(['500 40px "Cinzel"', '700 40px "Cinzel"', 'italic 400 40px "Cormorant Garamond"', '500 40px "Cormorant Garamond"', '400 40px "GFS Didot"'].map((f) => document.fonts.load(f)));
  const rnd = seeded(29);
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const canvasTex = (c) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = aniso;
    return t;
  };
  const badges = Object.fromEntries(await Promise.all(CERTS.map((c) => new Promise((ok) => {
    const im = new Image();
    im.onload = () => ok([c.badge, im]);
    im.onerror = () => ok([c.badge, null]);
    im.src = `assets/${c.badge}`;
  }))));

  // ---- the lectern stands near the lower island's edge, on the right as seen in Contact (beyond the
  // waterfall), its front (the black podium's gold stripe) facing out from the island; the reader stands
  // on the island side and looks out over the book
  const outward = new THREE.Vector3(Math.cos(BOOK.bearing), 0, -Math.sin(BOOK.bearing));
  const lectern = await loadModel("assets/lectern-black.glb");
  lectern.traverse((o) => o.isMesh && (o.castShadow = o.receiveShadow = true) && weather(o.material));
  let box = new THREE.Box3().setFromObject(lectern);
  lectern.scale.setScalar(BOOK.lectern / (box.max.y - box.min.y));
  const reader = outward.clone().negate(); // from the lectern towards the reader (and the camera)
  const ray = new THREE.Raycaster(), downDir = new THREE.Vector3(0, -1, 0);
  parts.ground.updateMatrixWorld(true);
  const groundAt = (x, z) => {
    ray.set(new THREE.Vector3(x, 10, z), downDir);
    return ray.intersectObject(parts.ground, false)[0]?.point.y;
  };
  // walk out from the middle of the island to its edge, then step back in
  const isle = new THREE.Box3().setFromObject(parts.ground).getCenter(new THREE.Vector3());
  let edge = 0;
  for (let d = 0; d < 6; d += 0.02) if (groundAt(isle.x + outward.x * d, isle.z + outward.z * d) !== undefined) edge = d;
  const base = isle.clone().addScaledVector(outward, edge - BOOK.inset);
  base.y = groundAt(base.x, base.z) ?? 0;
  const holder = new THREE.Group();
  holder.add(lectern);
  scene.add(holder);
  const settle = () => {
    holder.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(lectern);
    holder.position.x += base.x - (box.min.x + box.max.x) / 2;
    holder.position.z += base.z - (box.min.z + box.max.z) / 2;
    holder.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(lectern);
    // the lowest ground under its footprint, so no corner hangs in the air (it sinks a touch elsewhere)
    const ys = [];
    for (const fx of [0, 0.25, 0.5, 0.75, 1]) for (const fz of [0, 0.25, 0.5, 0.75, 1]) {
      const y = groundAt(box.min.x + (box.max.x - box.min.x) * fx, box.min.z + (box.max.z - box.min.z) * fz);
      if (y !== undefined) ys.push(y);
    }
    holder.position.y += (ys.length ? Math.min(...ys) : base.y) - 0.004 - box.min.y;
    holder.updateMatrixWorld(true);
  };
  // the reading surface: a grid of rays straight down onto the top, the hits grouped into planes; the desk
  // is the highest plane with a fair share of the hits (below it there can be trims sticking out, like the
  // black lectern's gold plates), and its middle is the centroid of its hits
  const desk = () => {
    box = new THREE.Box3().setFromObject(lectern);
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const hits = [];
    for (let i = -8; i <= 8; i++)
      for (let j = -8; j <= 8; j++) {
        ray.set(new THREE.Vector3(c.x + (i / 8) * size.x * 0.49, box.max.y + 1, c.z + (j / 8) * size.z * 0.49), downDir);
        const hit = ray.intersectObject(lectern, true)[0];
        if (!hit || hit.point.y < box.max.y - size.y * 0.3) continue; // not down the side
        const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        if (normal.y < 0) normal.negate(); // some models are wound inside out (double-sided materials)
        if (normal.y > 0.5) hits.push({ point: hit.point, normal });
      }
    const planes = [];
    for (const h of hits) {
      const pl = planes.find((q) => q.normal.dot(h.normal) > 0.995 && Math.abs(q.normal.dot(h.point.clone().sub(q.on[0].point))) < 0.01);
      if (pl) pl.on.push(h);
      else planes.push({ normal: h.normal, on: [h] });
    }
    const height = (q) => q.on.reduce((a, o) => a + o.point.y, 0) / q.on.length;
    const desk = planes.filter((q) => q.on.length >= hits.length * 0.1).sort((a, b) => height(b) - height(a))[0];
    return { point: desk.on.reduce((a, o) => a.add(o.point), new THREE.Vector3()).divideScalar(desk.on.length), normal: desk.normal };
  };
  // facing: the model's front (+z: the black podium's gold stripe) away from the reader, off the island;
  // a sloped desk slopes down towards the reader
  holder.rotation.y = Math.atan2(-reader.x, -reader.z);
  settle();
  const tilt = desk().normal.setY(0);
  if (tilt.length() > 0.05) holder.rotation.y += Math.atan2(reader.x, reader.z) - Math.atan2(tilt.x, tilt.z);
  settle();
  // an open-topped box (the black podium's top is hollow, walls round a floor): lay a polished black lid
  // across it, on the walls' top edges (a plane fitted through them: they slope), for the book to rest on
  {
    const floor = lectern.worldToLocal(desk().point.clone()).y, v = new THREE.Vector3(), top = [];
    lectern.traverse((m) => {
      if (!m.isMesh) return;
      const pos = m.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        lectern.worldToLocal(v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
        if (v.y > floor + 0.01 / lectern.scale.x) top.push(v.clone());
      }
    });
    if (top.length) {
      const b = new THREE.Box3().setFromPoints(top), t = 0.006 / lectern.scale.x;
      // the highest point in each small cell across the top: the walls' edges; then y = a x + b z + c through them
      const cell = 0.03, high = new Map();
      for (const q of top) {
        const k = `${Math.round(q.x / cell)},${Math.round(q.z / cell)}`;
        if (!high.has(k) || high.get(k).y < q.y) high.set(k, q);
      }
      const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0];
      for (const q of high.values()) {
        const row = [q.x, q.z, 1];
        for (let i = 0; i < 3; i++) {
          r[i] += row[i] * q.y;
          for (let j = 0; j < 3; j++) M[i][j] += row[i] * row[j];
        }
      }
      const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
      const D = det(M), [pa, pb, pc] = [0, 1, 2].map((k) => det(M.map((row, i) => row.map((v, j) => (j === k ? r[i] : v)))) / D);
      const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2, up = new THREE.Vector3(-pa, 1, -pb).normalize();
      const lid = new THREE.Mesh(new THREE.BoxGeometry(b.max.x - b.min.x, t, (b.max.z - b.min.z) / up.y), weather(new THREE.MeshStandardMaterial({ color: 0x17171a, roughness: 0.45 })));
      lid.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
      lid.position.set(cx, pa * cx + pb * cz + pc, cz).addScaledVector(up, t / 2);
      lid.castShadow = lid.receiveShadow = true;
      lectern.add(lid);
      lectern.updateMatrixWorld(true);
    }
  }
  // the lid slopes: turn the lectern so it slopes down towards the reader
  {
    const slope = desk().normal.setY(0);
    if (slope.length() > 0.05) holder.rotation.y += Math.atan2(reader.x, reader.z) - Math.atan2(slope.x, slope.z);
    settle();
  }
  const { point, normal } = desk();
  // a sloped desk: the reader looks straight down its slope (the book and the camera both follow it)
  if (new THREE.Vector3(normal.x, 0, normal.z).length() > 0.05) reader.set(normal.x, 0, normal.z).normalize();

  // ---- the book: local frame on the desk, x to the reader's right, y up the slope, z out of the desk; spine at x = 0
  const book = new THREE.Group();
  const bx = new THREE.Vector3().crossVectors(reader.clone().negate(), normal).normalize();
  const by = new THREE.Vector3().crossVectors(normal, bx);
  book.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(bx, by, normal));
  book.position.copy(point).addScaledVector(normal, 0.0012);
  scene.add(book);
  const centre = book.position.clone();
  const { w: W, h: H, board: B, stack: S } = BOOK;
  const WC = W + 0.006, HC = H + 0.012, SP = 0.004, ZM = B + S; // cover size, spine width, the hinge height
  const GAP = 0.0012, LOOSE = BOOK.pages * GAP; // between turning pages; the room they take, below the hinge

  const tl = new THREE.TextureLoader();
  const leatherTex = (f, srgb) => {
    const t = tl.load(`assets/leather_${f}.webp`);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = aniso;
    return t;
  };
  // worn leather: the hide darkened and mottled, burnished lighter along the edges and corners where hands
  // rub it, scuffed, with a darker crease along the hinge
  const hide = await new Promise((ok) => {
    const im = new Image();
    im.onload = () => ok(im);
    im.src = "assets/leather_albedo.webp";
  });
  const wornCanvas = document.createElement("canvas");
  [wornCanvas.width, wornCanvas.height] = PAGE_PX;
  {
    const x = wornCanvas.getContext("2d"), [w, h] = PAGE_PX;
    x.drawImage(hide, 0, 0, w, h);
    x.fillStyle = "rgba(28,16,8,0.5)";
    x.fillRect(0, 0, w, h);
    const blot = (px, py, r, colour) => {
      const g = x.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, colour);
      g.addColorStop(1, "rgba(0,0,0,0)");
      x.fillStyle = g;
      x.fillRect(px - r, py - r, 2 * r, 2 * r);
    };
    for (let i = 0; i < 45; i++) blot(rnd() * w, rnd() * h, 40 + rnd() * 220, rnd() < 0.55 ? `rgba(12,6,3,${0.15 + rnd() * 0.25})` : `rgba(150,96,55,${0.06 + rnd() * 0.12})`);
    x.lineCap = "round";
    for (let i = 0; i < 160; i++) {
      const px = rnd() * w, py = rnd() * h, a = rnd() * Math.PI, l = 10 + rnd() * 60;
      x.strokeStyle = `rgba(170,118,72,${0.04 + rnd() * 0.12})`;
      x.lineWidth = 1 + rnd() * 3;
      x.beginPath();
      x.moveTo(px, py);
      x.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
      x.stroke();
    }
    const e = 70;
    for (const [x0, y0, x1, y1, rx, ry, rw, rh] of [[0, 0, e, 0, 0, 0, e, h], [w, 0, w - e, 0, w - e, 0, e, h], [0, 0, 0, e, 0, 0, w, e], [0, h, 0, h - e, 0, h - e, w, e]]) {
      const g = x.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, "rgba(150,95,52,0.42)");
      g.addColorStop(1, "rgba(150,95,52,0)");
      x.fillStyle = g;
      x.fillRect(rx, ry, rw, rh);
    }
    for (const [cx, cy] of [[0, 0], [w, 0], [0, h], [w, h]]) blot(cx, cy, 170, "rgba(165,108,62,0.45)");
    const crease = x.createLinearGradient(0, 0, 90, 0);
    crease.addColorStop(0, "rgba(10,5,2,0)");
    crease.addColorStop(0.55, "rgba(10,5,2,0.45)");
    crease.addColorStop(1, "rgba(10,5,2,0)");
    x.fillStyle = crease;
    x.fillRect(20, 0, 90, h);
  }
  const leather = new THREE.MeshStandardMaterial({ map: canvasTex(wornCanvas), normalMap: leatherTex("normal"), roughnessMap: leatherTex("rough"), roughness: 1.05 });
  // rough, fibrous page edges, stained darker in places
  const edgeCanvas = document.createElement("canvas");
  edgeCanvas.width = edgeCanvas.height = 256;
  {
    const ex = edgeCanvas.getContext("2d");
    ex.fillStyle = "#c7a771";
    ex.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 1400; i++) {
      const px = rnd() * 256, py = rnd() * 256, a = rnd() * Math.PI, l = 2 + rnd() * 9;
      ex.strokeStyle = rnd() < 0.5 ? `rgba(95,62,28,${0.15 + rnd() * 0.35})` : `rgba(235,214,170,${0.15 + rnd() * 0.3})`;
      ex.lineWidth = 0.6 + rnd() * 1.4;
      ex.beginPath();
      ex.moveTo(px, py);
      ex.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
      ex.stroke();
    }
    for (let i = 0; i < 18; i++) {
      const px = rnd() * 256, py = rnd() * 256, r = 10 + rnd() * 40, g = ex.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(90,55,22,${0.15 + rnd() * 0.25})`);
      g.addColorStop(1, "rgba(90,55,22,0)");
      ex.fillStyle = g;
      ex.fillRect(px - r, py - r, 2 * r, 2 * r);
    }
  }
  const edges = new THREE.MeshStandardMaterial({ map: canvasTex(edgeCanvas), roughness: 0.95 });
  const paper = (c) => new THREE.MeshStandardMaterial({ map: canvasTex(c), roughness: 0.85 });

  // pages: the parchment, a shadow towards the gutter, then the content
  const sheet = parchment(PAGE_PX, rnd);
  const page = (gutter, draw) => {
    const c = document.createElement("canvas");
    [c.width, c.height] = PAGE_PX;
    const x = c.getContext("2d");
    x.drawImage(sheet, 0, 0);
    const gx = gutter === "left" ? 0 : c.width, g = x.createLinearGradient(gx, 0, gutter === "left" ? 180 : c.width - 180, 0);
    g.addColorStop(0, "rgba(70,45,20,0.28)");
    g.addColorStop(1, "rgba(70,45,20,0)");
    x.fillStyle = g;
    x.fillRect(0, 0, c.width, c.height);
    draw?.(x, c.width, c.height);
    return c;
  };
  const heading = (x, w, text) => {
    x.font = '500 30px "Cinzel"';
    x.letterSpacing = "10px";
    x.fillStyle = SEPIA;
    x.textAlign = "center";
    x.fillText(text.toUpperCase(), w / 2 + 5, 200);
    rule(x, w / 2, 240, 150, SEPIA);
    x.letterSpacing = "0px";
  };
  // left: the introduction, with a red initial, then the profile links (they remember where they are)
  const links = [];
  const drawLeft = (hover) => (x, w, h) => {
    heading(x, w, "Prologue");
    const first = ABOUT[0], rest = ABOUT.slice(1);
    x.font = '500 190px "Cormorant Garamond"';
    x.textAlign = "left";
    x.fillStyle = RED;
    const capW = x.measureText(first).width + 18;
    x.fillText(first, 130, 520);
    // the words, as large as fits above the "Presently" line
    let px = 56, lines;
    do {
      x.font = `italic 400 ${px}px "Cormorant Garamond"`;
      lines = wrapText(x, rest, (i) => (i < 2 ? 764 - capW : 764));
    } while (420 + (lines.length - 1) * px * 1.36 > h - 470 && px-- > 40);
    x.fillStyle = INK;
    lines.forEach((l, i) => x.fillText(l, i < 2 ? 130 + capW : 130, 420 + i * px * 1.36));
    // presently
    x.textAlign = "center";
    rule(x, w / 2, h - 410, 120, "rgba(116,85,45,0.6)");
    x.font = '500 24px "Cinzel"';
    x.letterSpacing = "8px";
    x.fillStyle = SEPIA;
    x.fillText("PRESENTLY", w / 2 + 4, h - 356);
    x.letterSpacing = "0px";
    x.font = '500 42px "Cormorant Garamond"';
    x.fillStyle = INK;
    x.fillText(PRESENTLY[0], w / 2, h - 305);
    x.font = 'italic 400 36px "Cormorant Garamond"';
    x.fillStyle = SEPIA;
    x.fillText(PRESENTLY[1], w / 2, h - 262);
    links.length = 0;
    PROFILES.forEach((l, i) => {
      const cx = w * (0.3 + i * 0.2), cy = h - 160, lit = i === hover;
      drawIcon(x, l.icon, cx, cy, 64, lit ? RED : INK);
      x.font = 'italic 400 32px "Cormorant Garamond"';
      x.textAlign = "center";
      x.fillStyle = lit ? RED : SEPIA;
      x.fillText(l.label, cx, cy + 74);
      links.push({ ...l, x0: cx - 95, x1: cx + 95, y0: cy - 50, y1: cy + 90 });
    });
  };
  const leftCanvas = page("right", drawLeft(-1));
  // the turned pages: Homer's Odyssey; a title page first
  const title = (x, w, h) => {
    x.textAlign = "center";
    x.fillStyle = SEPIA;
    x.font = '400 40px "GFS Didot"';
    x.letterSpacing = "12px";
    x.fillText("ΟΜΗΡΟΥ", w / 2 + 6, h * 0.36);
    x.fillStyle = INK;
    x.font = '400 110px "GFS Didot"';
    x.letterSpacing = "8px";
    x.fillText("ΟΔΥΣΣΕΙΑ", w / 2 + 4, h * 0.36 + 150);
    x.letterSpacing = "0px";
    rule(x, w / 2, h * 0.36 + 220, 160, SEPIA);
    x.font = 'italic 400 40px "Cormorant Garamond"';
    x.fillStyle = SEPIA;
    x.fillText("Homer · The Odyssey", w / 2, h * 0.36 + 300);
  };
  const verses = ([book, first, lines]) => (x, w, h) => {
    if (book) {
      x.textAlign = "center";
      x.fillStyle = RED;
      x.font = '400 64px "GFS Didot"';
      x.fillText(book, w / 2, 220);
      rule(x, w / 2, 262, 110, SEPIA);
    }
    let px = 42;
    do x.font = `400 ${px--}px "GFS Didot"`;
    while (Math.max(...lines.map((l) => x.measureText(l).width)) > 740);
    lines.forEach((l, i) => {
      const y = 360 + i * px * 1.62;
      x.textAlign = "left";
      x.fillStyle = INK;
      x.fillText(l, 150, y);
      const n = first + i;
      if (n % 5 === 0) {
        x.font = 'italic 400 28px "Cormorant Garamond"';
        x.fillStyle = SEPIA;
        x.textAlign = "right";
        x.fillText(n, 128, y);
        x.font = `400 ${px}px "GFS Didot"`;
      }
    });
  };
  const sirens = ODYSSEY.sirens[2];
  // what each turning page carries, front (on the right before it turns) and back (on the left after)
  const LEAVES = [
    [title, verses(ODYSSEY.proem)],
    [verses(ODYSSEY.outis), verses(["Μ", 184, sirens.slice(0, 5)])],
    [verses(["", 189, sirens.slice(5)]), null], // the last one's back is the introduction
  ];
  // right: the certifications; rows remember where they are for the links
  const ROW0 = 330, ROW_H = 178;
  const rows = CERTS.map((c, i) => ({ ...c, y0: ROW0 + i * ROW_H, y1: ROW0 + (i + 1) * ROW_H }));
  const drawCerts = (hover) => (x, w, h) => {
    heading(x, w, "Certifications");
    rows.forEach((r, i) => {
      const lit = i === hover && r.url;
      if (lit) {
        x.fillStyle = "rgba(170,120,40,0.13)";
        x.fillRect(110, r.y0 + 8, w - 220, ROW_H - 16);
      }
      const im = badges[r.badge];
      if (im) x.drawImage(im, 130, r.y0 + 19, 140, 140);
      x.textAlign = "left";
      let np = 46;
      do x.font = `500 ${np--}px "Cormorant Garamond"`;
      while (x.measureText(r.name).width > w - 300 - 190);
      x.fillStyle = lit ? RED : INK;
      x.fillText(r.name, 300, r.y0 + 82);
      x.font = 'italic 400 34px "Cormorant Garamond"';
      x.fillStyle = SEPIA;
      x.fillText(r.issuer, 300, r.y0 + 128);
      if (r.url) drawIcon(x, "link", w - 150, r.y0 + ROW_H / 2, 46, lit ? RED : "rgba(116,85,45,0.85)"); // it's a link
    });
  };
  const rightCanvas = page("left", drawCerts(-1));
  const rightMat = paper(rightCanvas);
  const ornament = (gutter) => page(gutter, (x, w, h) => rule(x, w / 2, h / 2, 90, "rgba(116,85,45,0.55)"));

  // the cover, gold-tooled: title and frame pressed into the leather and gilded. One plane over the board carries
  // it all: a height map of the tooling gives the recess (a normal map, so its walls catch the light); round it
  // the pressed leather is darker; the gilding is worn.
  const [PW, PH] = PAGE_PX, NPX = PW * PH;
  const shapes = (draw) => {
    const c = document.createElement("canvas");
    [c.width, c.height] = PAGE_PX;
    const x = c.getContext("2d");
    x.fillStyle = "#000";
    x.fillRect(0, 0, PW, PH);
    x.strokeStyle = x.fillStyle = "#fff";
    draw(x);
    const d = x.getImageData(0, 0, PW, PH).data, out = new Float32Array(NPX);
    for (let i = 0; i < NPX; i++) out[i] = d[i * 4] / 255;
    return out;
  };
  const border = shapes((x) => {
    x.lineWidth = 7;
    x.strokeRect(58, 58, PW - 116, PH - 116);
    x.lineWidth = 2.5;
    x.strokeRect(84, 84, PW - 168, PH - 168);
    for (const [cx, cy] of [[84, 84], [PW - 84, 84], [84, PH - 84], [PW - 84, PH - 84]]) {
      x.beginPath();
      x.moveTo(cx, cy - 18);
      x.lineTo(cx + 18, cy);
      x.lineTo(cx, cy + 18);
      x.lineTo(cx - 18, cy);
      x.fill();
    }
  });
  const lettering = shapes((x) => {
    x.textAlign = "center";
    const fit = (text, font, px, max) => {
      do x.font = `${font} ${px--}px "Cinzel"`;
      while (x.measureText(text).width > max);
    };
    // the name, its A drawn without a crossbar (Λ, as in early Greek inscriptions): Cinzel's V turned upside
    // down, so it keeps the font's own strokes and serifs
    const drawName = (text, cx, y, gap) => {
      x.letterSpacing = "0px";
      x.textAlign = "left";
      const chars = [...text], w = chars.map((c) => x.measureText(c).width);
      let px = cx - (w.reduce((s, v) => s + v) + gap * (chars.length - 1)) / 2;
      chars.forEach((c, i) => {
        if (c === "A") {
          const h = x.measureText("V").actualBoundingBoxAscent;
          x.save();
          x.translate(px + w[i] / 2, y - h / 2);
          x.rotate(Math.PI);
          x.textAlign = "center";
          x.fillText("V", 0, h / 2);
          x.restore();
        } else x.fillText(c, px, y);
        px += w[i] + gap;
      });
      x.textAlign = "center";
    };
    const name = COVER.name.toUpperCase();
    x.letterSpacing = "14px";
    fit(name, "700", 132, PW - 260);
    drawName(name, PW / 2, PH * 0.4, 14);
    rule(x, PW / 2, PH * 0.4 + 70, 210, "#fff");
    x.letterSpacing = "6px";
    COVER.lines.forEach((l, i) => {
      fit(l.toUpperCase(), "700", 46, PW - 280);
      x.fillText(l.toUpperCase(), PW / 2 + 3, PH * 0.4 + 170 + i * 76);
    });
    rule(x, PW / 2, PH - 230, 60, "#fff");
  });
  // wear: 1 where the gold has rubbed away (specks, patches, most at the corners); tarnish: slow variation
  const wear = shapes((x) => {
    x.fillStyle = "#fff";
    for (let i = 0; i < 2600; i++) {
      x.globalAlpha = 0.3 + rnd() * 0.6;
      x.beginPath();
      x.arc(rnd() * PW, rnd() * PH, 0.6 + rnd() * 2.6, 0, TAU);
      x.fill();
    }
    x.globalAlpha = 1;
    const patch = (px, py, r, a) => {
      const g = x.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
      x.fillStyle = g;
      x.fillRect(px - r, py - r, 2 * r, 2 * r);
    };
    for (let i = 0; i < 26; i++) patch(rnd() * PW, rnd() * PH, 30 + rnd() * 110, 0.25 + rnd() * 0.35);
    for (const [cx, cy] of [[0, 0], [PW, 0], [0, PH], [PW, PH]]) patch(cx, cy, 260, 0.75);
  });
  const tarnish = shapes((x) => {
    for (let i = 0; i < 40; i++) {
      const px = rnd() * PW, py = rnd() * PH, r = 40 + rnd() * 160, g = x.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(255,255,255,${0.2 + rnd() * 0.4})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
      x.fillStyle = g;
      x.fillRect(px - r, py - r, 2 * r, 2 * r);
    }
  });
  // separable box blur, run twice (close to a gaussian)
  const blur = (src, r) => {
    const a = Float32Array.from(src), b = new Float32Array(NPX), n = 2 * r + 1;
    for (let p = 0; p < 2; p++) {
      for (let y = 0; y < PH; y++) {
        let s = 0;
        const o = y * PW;
        for (let i = -r; i < PW; i++) {
          if (i + r < PW) s += a[o + i + r];
          if (i - r - 1 >= 0) s -= a[o + i - r - 1];
          if (i >= 0) b[o + i] = s / n;
        }
      }
      for (let xx = 0; xx < PW; xx++) {
        let s = 0;
        for (let i = -r; i < PH; i++) {
          if (i + r < PH) s += b[(i + r) * PW + xx];
          if (i - r - 1 >= 0) s -= b[(i - r - 1) * PW + xx];
          if (i >= 0) a[i * PW + xx] = s / n;
        }
      }
    }
    return a;
  };
  const tooled = new Float32Array(NPX);
  for (let i = 0; i < NPX; i++) tooled[i] = Math.max(lettering[i], border[i]);
  const gilt = tooled;
  const depth = blur(tooled, 3), halo = blur(tooled, 9); // (soft walls: sharp ones shimmer as the cover moves)
  const colour = new ImageData(PW, PH), bump = new ImageData(PW, PH), orm = new ImageData(PW, PH);
  const DEEP = 4.5; // how steep the recess walls are
  for (let y = 0; y < PH; y++)
    for (let xx = 0; xx < PW; xx++) {
      const i = y * PW + xx, k = i * 4;
      // recess: surface height -depth; canvas y runs down, texture v up
      const dx = depth[Math.min(i + 1, NPX - 1)] - depth[Math.max(i - 1, 0)];
      const dy = depth[Math.min(i + PW, NPX - 1)] - depth[Math.max(i - PW, 0)];
      let nx = DEEP * dx, ny = -DEEP * dy;
      const nl = Math.hypot(nx, ny, 1);
      bump.data[k] = (nx / nl) * 127.5 + 127.5;
      bump.data[k + 1] = (ny / nl) * 127.5 + 127.5;
      bump.data[k + 2] = (1 / nl) * 127.5 + 127.5;
      bump.data[k + 3] = 255;
      // gold where gilt and not rubbed off; elsewhere pressed leather, darker and a little glossier
      const g = gilt[i] * clamp01(1 - wear[i] * 1.15), t = tarnish[i];
      const leatherA = clamp01(halo[i] * 0.55 + tooled[i] * 0.45 + Math.abs(dx + dy) * 4);
      colour.data[k] = (1 - g) * 34 + g * (248 - 30 * t); // gold: a rich yellow (#F8C463), tarnished in places
      colour.data[k + 1] = (1 - g) * 21 + g * (196 - 40 * t);
      colour.data[k + 2] = (1 - g) * 11 + g * (99 - 40 * t);
      colour.data[k + 3] = 255 * Math.max(g, leatherA * (1 - g) * 0.85);
      orm.data[k + 1] = 255 * ((1 - g) * 0.62 + g * (0.38 + 0.2 * t + 0.15 * wear[i])); // roughness (G): burnished gold, satin enough that highlights glide, not glitter
      orm.data[k + 2] = 255 * g; // metalness (B)
      orm.data[k + 3] = 255;
    }
  const imageTex = (data, srgb) => {
    const c = document.createElement("canvas");
    [c.width, c.height] = PAGE_PX;
    c.getContext("2d").putImageData(data, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = aniso;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const colourTex = imageTex(colour, true);
  const ormTex = imageTex(orm);
  const gold = new THREE.MeshStandardMaterial({
    map: colourTex, normalMap: imageTex(bump), roughnessMap: ormTex, metalnessMap: ormTex, metalness: 1, roughness: 1,
    transparent: true,
    // gold only looks like gold when it has something bright to reflect, and the sky round the book is dark: it
    // reflects a soft studio room of its own instead
    envMap: new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture, envMapIntensity: 0.75,
  });

  const boxMesh = (w, h, d, mats, round) => {
    const m = new THREE.Mesh(round ? new RoundedBoxGeometry(w, h, d, 2, round) : new THREE.BoxGeometry(w, h, d), mats);
    m.castShadow = m.receiveShadow = true;
    return m;
  };
  // back board and the right half of the pages stay put
  const back = boxMesh(WC, HC, B, leather, B * 0.45); // softened, worn corners
  back.position.set(WC / 2 - SP, 0, B / 2);
  const right = boxMesh(W, H, S - LOOSE, [edges, edges, edges, edges, rightMat, edges]); // its top sits below the turning pages
  right.position.set(W / 2, 0, B + (S - LOOSE) / 2);
  book.add(back, right);
  // the cover and the left half of the pages swing over together, about the hinge
  const flap = new THREE.Group();
  flap.position.z = ZM;
  const left = boxMesh(W, H, S, [edges, edges, edges, edges, edges, paper(ornament("right"))]); // its underside becomes the left page
  left.position.set(W / 2, 0, S / 2);
  const cover = boxMesh(WC, HC, B, leather, B * 0.45);
  cover.position.set(WC / 2 - SP, 0, S + B / 2);
  const stamp = new THREE.Mesh(new THREE.PlaneGeometry(WC * 0.97, HC * 0.97), gold);
  stamp.position.set(WC / 2 - SP, 0, S + B + 0.0003);
  flap.add(left, cover, stamp);
  // the spine, seen only while the book is (nearly) closed; once the cover is past upright it's out of sight
  // (a hair larger than the boards' edge and set just off it, so no faces coincide and z-fight)
  const spine = boxMesh(SP + 0.0003, HC + 0.0008, 2 * ZM + 0.0008, leather);
  spine.position.set(-SP / 2 - 0.00045, 0, ZM);
  book.add(flap, spine);

  // loose pages that turn one after another, curling as they go (vertices bent along the page each frame)
  const SEG = 28;
  const leaves = Array.from({ length: BOOK.pages }, (_, j) => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array((SEG + 1) * 2 * 3), uv = new Float32Array((SEG + 1) * 2 * 2), idx = [];
    for (let i = 0; i <= SEG; i++) {
      uv.set([i / SEG, 0, i / SEG, 1], i * 4);
      if (i < SEG) idx.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    const [onFront, onBack] = LEAVES[j] ?? [null, null];
    const backTex = canvasTex(onBack ? page("right", onBack) : leftCanvas);
    backTex.repeat.x = -1; // seen from behind once turned
    backTex.offset.x = 1;
    const frontMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: canvasTex(page("left", onFront)), roughness: 0.85 }));
    const backMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: backTex, roughness: 0.85, side: THREE.BackSide }));
    for (const m of [frontMesh, backMesh]) (m.castShadow = m.receiveShadow = true), book.add(m);
    // turns top-first; the first one to go ends up lowest on the left
    return { g, pos, back: backMesh, start: 0.32 + j * 0.13, zRight: ZM - LOOSE + (BOOK.pages - j - 0.5) * GAP, zLeft: ZM + (j + 0.5) * GAP };
  });
  const bend = (leaf, k) => {
    const th = Math.PI * easeIO(k), z0 = leaf.zRight + (leaf.zLeft - leaf.zRight) * k + Math.sin(Math.PI * k) * 0.004;
    let x = 0, z = z0;
    for (let i = 0; i <= SEG; i++) {
      leaf.pos.set([x, -H / 2, z, x, H / 2, z], i * 6);
      const a = th - BOOK.curl * Math.sin(th) * (i / SEG); // the free edge lags behind
      x += (Math.cos(a) * W) / SEG;
      z += (Math.sin(a) * W) / SEG;
    }
    leaf.g.attributes.position.needsUpdate = true;
    leaf.g.computeVertexNormals();
    leaf.g.computeBoundingSphere();
  };

  // a warm reading light on the pages while the book is in view; it casts shadows, so a turning page
  // shades the one below it (without, the pages look weightless, as if see-through)
  const lamp = new THREE.SpotLight(0xffe2b4, 0, 1.6, 0.75, 0.8, 2);
  lamp.position.copy(point).addScaledVector(normal, 0.42).addScaledVector(reader, 0.24);
  lamp.target.position.copy(point);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(1024, 1024);
  Object.assign(lamp.shadow.camera, { near: 0.1, far: 1 });
  lamp.shadow.bias = -0.0004;
  lamp.shadow.normalBias = 0.002;
  scene.add(lamp, lamp.target);

  // camera: square onto the book (along the desk's normal, so it shows as a true rectangle), centred on it,
  // far enough back to frame it: the closed cover, then the open spread. On a flat desk, from the reader's side.
  // (az within half a turn of Work's, so the camera takes the short way round to the stairs, in front of
  // them, rather than circling through the hand's wrist)
  const flat = new THREE.Vector3(normal.x, 0, normal.z);
  let az = flat.length() > 0.05 ? Math.atan2(flat.x, flat.z) : Math.atan2(reader.x, reader.z);
  const el = Math.min(Math.atan2(normal.y, flat.length()), 1.35); // never quite straight down (the view would spin)
  while (az > work[0] + Math.PI) az -= Math.PI * 2;
  while (az < work[0] - Math.PI) az += Math.PI * 2;
  const target = new THREE.Vector3();
  const frame = (w, h) => {
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2), aspect = innerWidth / innerHeight;
    const d = Math.max(h / (2 * t * BOOK.fill), w / (2 * t * aspect * BOOK.fill));
    return innerWidth < 800 ? d / 1.45 : d; // (narrow screens pull every pose back by 1.45)
  };
  // k: how far open (0..1). On an upright phone the open spread would be too small to read, so the view stays
  // one page wide and pans from the left page to the right one (pan 0..1) as the visitor scrolls on.
  const setPose = (k, pan) => {
    target.copy(centre).addScaledVector(normal, ZM * (2 - k));
    let d = frame(WC, HC) + (frame(2 * WC, HC) - frame(WC, HC)) * k;
    if (portrait()) {
      target.addScaledVector(bx, (W / 2) * (2 * pan - 1) * k);
      d = frame(WC * 1.06, HC);
    }
    pose.splice(0, 7, az, el, d, 0, target.x, target.y, target.z);
  };

  // links: the certificates on the right page, the profiles on the left (the last turned page's back)
  let hover = null, p = 0;
  const leftPageMesh = leaves[leaves.length - 1].back, leftTex = leftPageMesh.material.map;
  const pickable = [right, leftPageMesh];
  const redraw = (canvas, tex, draw) => {
    canvas.getContext("2d").drawImage(page(canvas === leftCanvas ? "right" : "left", draw), 0, 0);
    tex.needsUpdate = true;
  };
  const setHover = (h) => {
    if (h?.url === hover?.url) return;
    const was = hover;
    hover = h;
    for (const side of new Set([was?.side, h?.side])) {
      if (side === "right") redraw(rightCanvas, rightMat.map, drawCerts(h?.side === "right" ? h.i : -1));
      if (side === "left") redraw(leftCanvas, leftTex, drawLeft(h?.side === "left" ? h.i : -1));
    }
  };
  renderer.domElement.addEventListener("click", () => hover?.url && window.open(hover.url, "_blank", "noopener"));

  let shadowAt = -1;
  const update = (dt, t, s) => {
    const want = scrollY > 24 ? 1 : 0;
    p = clamp01(p + (want ? 1 : -1) * (dt / BOOK.open));
    // the scene's shadows are drawn once and kept (main.js); the book is the only thing that moves and casts
    // one, so they're redrawn only while it opens or closes
    if (p !== shadowAt) (renderer.shadowMap.needsUpdate = true), (shadowAt = p);
    document.body.classList.toggle("book-open", p > 0.02);
    const kc = easeIO(clamp01(p / 0.5));
    flap.rotation.y = -Math.PI * kc;
    book.position.copy(centre).addScaledVector(bx, -(W / 2) * (1 - kc));
    spine.visible = flap.rotation.y > -Math.PI / 2;
    leaves.forEach((l) => bend(l, clamp01((p - l.start) / 0.42)));
    setPose(easeIO(clamp01(p / 0.75)), THREE.MathUtils.smoothstep(scrollY, innerHeight * 0.3, innerHeight * 0.75));
    lamp.intensity = 0.28 * (s.heroW ?? 1);
    // out of view: no shadow pass. (Not by hiding the lamp: a light coming or going makes every material
    // recompile its shaders, a hitch of a few hundred milliseconds in the scroll to the stairs.)
    lamp.shadow.autoUpdate = lamp.intensity > 0.005;
  };
  update(0, 0, {});
  return {
    update,
    get open() { return p > 0.99; },
    pickable,
    // the pointer over a page: which link, if any
    pick(hit) {
      let h = null;
      if (hit && p > 0.99) {
        const y = (1 - hit.uv.y) * PAGE_PX[1];
        if (hit.object === right && hit.face.normal.z > 0.5) {
          const i = rows.findIndex((r) => y > r.y0 && y < r.y1 && hit.uv.x > 0.1 && hit.uv.x < 0.9);
          if (i >= 0) h = { side: "right", i, url: rows[i].url };
        } else if (hit.object === leftPageMesh) {
          const x = (1 - hit.uv.x) * PAGE_PX[0]; // seen from behind: mirrored
          const i = links.findIndex((l) => x > l.x0 && x < l.x1 && y > l.y0 && y < l.y1);
          if (i >= 0) h = { side: "left", i, url: links[i].url };
        }
      }
      setHover(h);
      return !!h?.url;
    },
  };
}
