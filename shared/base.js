// Shared plumbing for the temple page: stage, scroll poses, page DOM, input.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

export { THREE };
export const damp = THREE.MathUtils.damp;
export const motion = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.25 : 1;
// Phones, tablets and machines with few cores or little memory get a lighter render (here and in main.js)
// Phone held upright: the scene goes in the upper part of the screen, the text below it (temple.css)
export const portrait = () => innerWidth < 800 && innerHeight > innerWidth;
export const lowPower =
  matchMedia("(pointer: coarse)").matches || (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;

// ---------------------------------------------------------------- model loading
const loaderEl = document.querySelector(".loader");
// The loading screen covers the page until everything is ready. setProgress(p) moves its bar (0..1);
// loadModel(url, [from, to]) moves it from `from` to `to` as the file downloads.
let logged = -1;
export const setProgress = (p) => {
  if (Math.floor(p * 10) > logged) window.__devlog?.("progress", { p: Math.round(p * 100) }), (logged = Math.floor(p * 10));
  const pct = loaderEl?.querySelector(".pct"), bar = loaderEl?.querySelector(".bar i");
  if (!bar) return; // (the loading screen is showing an error instead)
  pct.textContent = `${Math.round(p * 100)}%`;
  bar.style.width = `${p * 100}%`;
};
export async function loadModel(url, [from, to] = [0, 0]) {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url, (e) => to > from && e.total && setProgress(from + (to - from) * (e.loaded / e.total)));
  return gltf.scene;
}
export const hideLoader = () => loaderEl?.classList.add("done");

// ---------------------------------------------------------------- stage
export function createStage({ background = 0x05070c, bloom = [0.35, 0.5, 0.9], exposure = 1, fov = 35 } = {}) {
  // (no antialias: the composer draws into its own render targets, where the canvas's own wouldn't apply)
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
  let pixelRatio = Math.min(devicePixelRatio, lowPower ? 1.5 : 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.getElementById("scene").appendChild(renderer.domElement);
  renderer.domElement.addEventListener("webglcontextlost", () => window.__devlog?.("contextlost"));


  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);
  const camera = new THREE.PerspectiveCamera(fov, innerWidth / innerHeight, 0.01, 500);

  // Edge smoothing (4x MSAA) on screens under 1.5x, where jagged edges show; denser screens hardly need it.
  // The composer's own render targets carry it, since the scene is drawn into those, not onto the canvas.
  let msaa = !lowPower && pixelRatio < 1.5;
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: msaa ? 4 : 0 }));
  composer.setPixelRatio(pixelRatio);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), ...bloom);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  // The canvas fills the tallest the viewport gets (100lvh), so a phone's address bar sliding in and out
  // doesn't resize it (resizing rebuilds every buffer and jolts the view)
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;top:0;height:100vh;height:100lvh;width:0;visibility:hidden;pointer-events:none";
  document.body.append(probe);
  let size = "";
  const resize = () => {
    const w = innerWidth, h = Math.max(innerHeight, probe.offsetHeight);
    if (`${w}x${h}` === size) return;
    size = `${w}x${h}`;
    renderer.setSize(w, h);
    composer.setSize(w, h);
    camera.aspect = w / h;
  };
  addEventListener("resize", resize);
  resize();

  // Camera on a sphere around `target`. pose = [azimuth, elevation, distance, screen shift]; lift raises the
  // target on screen (a share of the height)
  const place = (target, [az, el, r, shift], lift = 0) => {
    if (innerWidth < 800) {
      r *= 1.45;
      shift = 0;
    }
    const [w, h] = size.split("x").map(Number);
    camera.position.set(
      target.x + r * Math.cos(el) * Math.sin(az),
      target.y + r * Math.sin(el),
      target.z + r * Math.cos(el) * Math.cos(az)
    );
    camera.lookAt(target);
    camera.setViewOffset(w, h, -shift * w, lift * h, w, h);
  };

  const run = (update) => {
    const clock = new THREE.Clock();
    let extra = 0; // simulated time from advance()
    const frame = (dt) => {
      update(dt, clock.elapsedTime + extra);
      composer.render();
    };
    // If frames come slower than ~40 a second for a few seconds, ease off: edge smoothing goes first, then the
    // resolution steps down, but never below one render pixel per screen pixel (below that it turns blurry).
    // It never goes back up (no flicker between sizes).
    let slow = 0, sum = 0, n = 0, worst = 0;
    const adapt = (dt) => {
      if (document.hidden || dt > 0.25) return; // a hidden tab or a hitch, not the steady rate
      sum += dt;
      worst = Math.max(worst, dt);
      if (++n < 90) return;
      // (test devices on the dev server report their frame rate: see shared/errors.js)
      if (lowPower || n / sum < 55) window.__devlog?.("fps", { fps: Math.round(n / sum), worstMs: Math.round(worst * 1000), pixelRatio, at: +(scrollY / innerHeight).toFixed(1) });
      worst = 0;
      slow = sum / n > 1 / 40 ? slow + 1 : 0;
      sum = n = 0;
      if (slow < 2) return;
      slow = 0;
      if (msaa) {
        msaa = false;
        for (const rt of [composer.renderTarget1, composer.renderTarget2]) (rt.samples = 0), rt.dispose(); // rebuilt on the next frame
      } else if (pixelRatio > 1) {
        pixelRatio = Math.max(1, pixelRatio - 0.25);
        renderer.setPixelRatio(pixelRatio);
        composer.setPixelRatio(pixelRatio);
      }
    };
    let reported = false;
    renderer.setAnimationLoop(() => {
      const dt = clock.getDelta();
      adapt(dt);
      try {
        frame(Math.min(dt, 0.05));
      } catch (e) {
        // (errors thrown from inside three.js, which comes from another origin, reach the page only as
        // "Script error.": report the real one)
        if (!reported) (reported = true), window.__devlog?.("loop", { message: e.message, stack: e.stack });
        throw e;
      }
    });
    // Step the scene forward by `seconds` and draw one frame: for the first frame before the loading screen
    // lifts, and for testing in tabs that aren't animating (window.__advance)
    const advance = (window.__advance = (seconds) => {
      for (let s = 0; s < seconds; s += 1 / 30) (extra += 1 / 30), update(1 / 30, clock.elapsedTime + extra);
      frame(0);
    });
    return advance;
  };
  return { renderer, scene, camera, composer, bloomPass, place, run };
}

// ---------------------------------------------------------------- scroll poses
// STATES: { sectionName: number[] }, all the same length. Each [data-state] section contributes
// an enter and a leave stop, so tall sections hold their pose while scrolled through.
export function createScroll(STATES) {
  const sections = [...document.querySelectorAll("[data-state]")];
  const names = sections.map((s) => s.dataset.state);
  const vecs = names.map((n) => STATES[n]);
  let stops = [];
  const build = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    stops = [];
    sections.forEach((s, i) => {
      const top = Math.min(s.offsetTop, max);
      const end = Math.min(s.offsetTop + s.offsetHeight - innerHeight, max);
      stops.push({ y: top, i });
      if (end > top + 1) stops.push({ y: end, i });
    });
  };
  addEventListener("resize", build);
  new ResizeObserver(build).observe(document.querySelector("main")); // web fonts change heights after load
  build();

  const sample = (y = scrollY) => {
    const w = names.map(() => 0);
    let a = stops[0], b = stops[0], f = 0;
    if (y > a.y) {
      const k = stops.findIndex((s) => s.y >= y);
      if (k === -1) a = b = stops[stops.length - 1];
      else {
        a = stops[k - 1];
        b = stops[k];
        f = (y - a.y) / Math.max(1, b.y - a.y);
        f = f * f * (3 - 2 * f);
      }
    }
    w[a.i] += 1 - f;
    w[b.i] += f;
    return { vec: vecs[a.i].map((v, j) => v + (vecs[b.i][j] - v) * f), w };
  };
  // 0..1 progress through a tall section while it is pinned
  const progress = (name) => {
    const s = sections[names.indexOf(name)];
    return THREE.MathUtils.clamp((scrollY - s.offsetTop) / Math.max(1, s.offsetHeight - innerHeight), 0, 1);
  };
  return { names, sections, sample, progress, indexOf: (n) => names.indexOf(n) };
}

// ---------------------------------------------------------------- page DOM
const hex = (c) => `#${c.toString(16).padStart(6, "0")}`;

export function chapterMarker() {
  const links = [...document.querySelectorAll("#chapters a")];
  let cur = -1;
  return (i) => {
    if (i === cur) return;
    cur = i;
    links.forEach((a, j) => a.classList.toggle("on", j === i));
  };
}

// Returns a function that raycasts the current pointer against `objects`.
export function pointerPicker(renderer, camera) {
  const ndc = new THREE.Vector2();
  const ray = new THREE.Raycaster();
  let inside = false;
  // (pointerdown too: a tap on a phone has no move before it)
  const at = (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    inside = true;
  };
  renderer.domElement.addEventListener("pointermove", at);
  renderer.domElement.addEventListener("pointerdown", at);
  renderer.domElement.addEventListener("pointerleave", () => (inside = false));
  return (objects) => {
    if (!inside) return null;
    ray.setFromCamera(ndc, camera);
    return ray.intersectObjects(objects, false)[0] ?? null;
  };
}
