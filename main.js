import {
  THREE, damp, motion, lowPower, portrait, loadModel, hideLoader, setProgress, createStage, createScroll,
  chapterMarker, pointerPicker,
} from "./shared/base.js";
import * as extra from "./extras.js";

// Six columns, six disciplines, in walking order round the temple (the climb ends at AWS, so cloud comes
// first). `name` is shown in the page; `latin` is carved on the ring above the column, in normal spelling
// (extras.js turns it into inscription form); `skills` fill the panel while that pillar is in view.
const PILLARS = [
  { name: "Cloud & Security", latin: "Nubes", skills: [ // clouds
    ["AWS", "Solutions Architect Professional and Security Specialty. Architectures for enterprise banks and insurers."],
    ["Google Cloud", "Professional Cloud Architect: multi-cloud design and migration."],
    ["Security & compliance", "Identity, encryption and audit trails that hold up under DORA and GDPR."],
    ["Resilience & FinOps", "Systems that survive outages, at a cost that holds up."],
  ] },
  { name: "Software Engineering", latin: "Officina", skills: [ // the workshop
    ["Python", "Computer vision, robot control, automation and back ends."],
    ["TypeScript & Node.js", "APIs and services for client products."],
    ["React & Next.js", "Web and mobile front ends."],
    ["Java", "Typed, long-lived back-end services."],
    ["SQL & DynamoDB", "Relational and NoSQL data models."],
    ["Integrations", "Stripe payments, Twilio voice, Google Maps, OAuth."],
  ] },
  { name: "Platforms & DevOps", latin: "Fundamenta", skills: [ // foundations
    ["Git", "Version control and CI/CD workflows across GitHub and GitLab."],
    ["Docker", "From robot cells on balenaOS to cloud services."],
    ["Linux & Bash", "Where everything I build ends up running."],
    ["Kubernetes", "Ran Telekom’s identity platform on it, for around 200,000 people."],
    ["Ansible & CI/CD", "Repeatable builds, deployments and configuration."],
    ["Keycloak & IAM", "Single sign-on and identity at enterprise scale."],
  ] },
  { name: "AI & Computer Vision", latin: "Ratio", skills: [ // reason
    ["Amazon Bedrock", "GenAI on AWS for enterprise customers: models, agents and guardrails."],
    ["AI-assisted development", "Claude Code, Kiro and Cursor in my daily work, from specs to code to reviews."],
    ["Computer vision", "OpenCV and NumPy vision that guided FANUC robots in production."],
  ] },
  { name: "Robotics & Automation", latin: "Automata", skills: [ // self-moving machines
    ["ROS", "Control software that made BMW’s line robots about 30% faster."],
    ["Universal Robots", "UR10 cells with state machines, across plants."],
    ["FANUC", "Bin picking and fabric handling in production."],
    ["SolidWorks & Blender", "Mechanical design and 3D modelling."],
  ] },
  { name: "Leadership & Delivery", latin: "Consilium", skills: [ // counsel
    ["Consulting", "Trusted advisor to everyone from CEOs and CISOs to engineers."],
    ["Agile software development", "Scrum (Professional Scrum Master): short cycles, clear goals, steady releases."],
    ["Project management", "Led five teams, sixty developers, through the ECB migration."],
    ["Stakeholder management", "Keeping scope, priorities and releases clear for everyone involved."],
  ] },
];
const ROMAN = ["I", "II", "III", "IV", "V", "VI"];
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- scroll poses
// [az, el, dist, shift, targetX, targetY, targetZ]. The temple sits at the origin; the island trails off to -Z.
// Order down the page: hero (the book at the foot of the stairs), Work (up the stairs), skills (the temple),
// contact. Scrolling through the skills section adds one walk around the colonnade on top of these, so
// the poses after it (contact) subtract that walk again.
const ORBIT = TAU * (5 / 6);
const STATES = {
  hero: [0.7, 0.12, 12.5, 0.2, 0, 0.9, -1.2],
  skills: [0.7, 0.12, 4.8, 0.16, 0, 2.8, 0],
  projects: [0.9, 0.42, 3.2, -0.2, 0, 1.2, -1.2], // sunlit side of the stairs; target climbs them
  contact: [0.3 - ORBIT, -0.04, 13.5, 0.2, 0, 1.0, -1.2],
};

history.scrollRestoration = "manual";
const { scene, camera, renderer, composer, place, run } = createStage({ background: 0x0a0c12, bloom: [0.25, 0.4, 0.92], exposure: 1.25 });
camera.near = 0.04; // the closest view is the book at ~0.5 m; a nearer near plane wastes depth precision (the pages z-fight)
camera.updateProjectionMatrix();
scene.fog = new THREE.FogExp2(0x0a0c12, 0.035);
const scroll = createScroll(STATES);
const SKILLS_IDX = scroll.indexOf("skills"), PROJECTS_IDX = scroll.indexOf("projects"), CONTACT_IDX = scroll.indexOf("contact");
const setChapter = chapterMarker();


// ---------------------------------------------------------------- lighting: late-afternoon sun
const hemi = new THREE.HemisphereLight(0x8fa3c8, 0x1a1712, 1.5);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe3bf, 3.2);
sun.position.set(4, 7, 3);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(lowPower ? 1024 : 2048);
// Nothing in the scene moves except the camera and the book, so shadows are drawn once and kept (the book
// asks for a redraw while it opens or closes): no shadow pass over the whole temple every frame
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 20 });
sun.shadow.bias = -0.0005;
scene.add(sun);
const rim = new THREE.DirectionalLight(0x7d93ff, 0.8);
rim.position.set(-5, 3, -4);
scene.add(rim);
extra.sky({ scene, renderer, sun, hemi });

// ---------------------------------------------------------------- model
// one build for every device: 1-2K WebP maps (6.3 MB, ~220 MB of GPU memory). WebP rather than KTX2: on these
// textures KTX2 comes out darker and blurrier, with no saving in download size.
const model = await loadModel("temple.glb", [0, 0.75]);
model.traverse((o) => {
  if (o.isMesh) for (const t of ["map", "normalMap"]) if (o.material[t]) o.material[t].anisotropy = renderer.capabilities.getMaxAnisotropy();
});
model.scale.setScalar(0.001); // source units are millimetres
model.position.set(0.003, 0, -2.183); // temple centre to the origin
scene.add(model);
model.updateMatrixWorld(true);
const parts = {};
model.traverse((o) => {
  if (!o.isMesh) return;
  o.castShadow = o.receiveShadow = true;
  parts[o.name] = o;
});
extra.polishMarble([parts.column, parts.DefaultMaterial, parts.top_ring]);
extra.detailTextures([parts.ground, parts.rock_base, parts.hand, parts.steps]);

// Split a merged mesh (all six columns, or all six statues) into one mesh per column by angle.
function splitByAngle(mesh, a0) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position, idx = geo.index.array;
  const v = new THREE.Vector3();
  const buckets = PILLARS.map(() => []);
  for (let t = 0; t < idx.length; t += 3) {
    let x = 0, z = 0;
    for (let k = 0; k < 3; k++) {
      v.fromBufferAttribute(pos, idx[t + k]).applyMatrix4(mesh.matrixWorld);
      x += v.x;
      z += v.z;
    }
    const a = Math.atan2(x, z);
    const b = ((Math.round((a - a0) / (TAU / 6)) % 6) + 6) % 6;
    buckets[b].push(idx[t], idx[t + 1], idx[t + 2]);
  }
  mesh.parent.remove(mesh);
  return buckets.map((tris, i) => {
    const g = new THREE.BufferGeometry();
    for (const name in geo.attributes) g.setAttribute(name, geo.attributes[name]);
    g.setIndex(tris);
    const m = new THREE.Mesh(g, mesh.material.clone());
    m.material.emissive = new THREE.Color(0xffd9a6);
    m.material.emissiveIntensity = 0;
    m.applyMatrix4(mesh.matrixWorld);
    m.castShadow = m.receiveShadow = true;
    m.userData.pillar = i;
    scene.add(m);
    return m;
  });
}
// angle of the first column, measured once from the column mesh
const firstAngle = (() => {
  const pos = parts.column.geometry.attributes.position, v = new THREE.Vector3();
  const hist = new Array(360).fill(0);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(parts.column.matrixWorld);
    hist[Math.floor(((Math.atan2(v.x, v.z) + Math.PI) / TAU) * 360) % 360]++;
  }
  // fold the histogram onto one 60° sector; the peak is the column offset
  const fold = new Array(60).fill(0);
  hist.forEach((n, d) => (fold[d % 60] += n));
  const a = THREE.MathUtils.degToRad(fold.indexOf(Math.max(...fold)) + 0.5) - Math.PI;
  // start numbering at the column the camera meets first, so the walk goes I, II, III...
  const k = Math.round((STATES.skills[0] - a) / (TAU / 6));
  return a + (k * TAU) / 6;
})();
const columns = splitByAngle(parts.column, firstAngle);
const statues = splitByAngle(parts.DefaultMaterial, firstAngle);
// The columns are not exactly 60° apart in this model, so measure each one's real angle
// (centroid of its vertices) for anything that has to line up with it: lettering, panels, camera.
const COL_ANGLES = columns.map((m) => {
  m.updateMatrixWorld(true);
  const pos = m.geometry.attributes.position, idx = m.geometry.index.array, v = new THREE.Vector3();
  let x = 0, z = 0;
  for (let k = 0; k < idx.length; k++) {
    v.fromBufferAttribute(pos, idx[k]).applyMatrix4(m.matrixWorld);
    x += v.x;
    z += v.z;
  }
  return Math.atan2(x, z);
});
const colAngle = (i) => COL_ANGLES[i];

// ---------------------------------------------------------------- scene extras (extras.js)
const ctx = { scene, camera, renderer, composer, sun, parts, columns, statues, pillars: PILLARS, colAngle, lowPower };
const updates = [];
const add = (fn) => fn && updates.push(fn);
// the rippling, reflecting pool draws the scene a second time each frame: phones keep the model's own still water
if (!lowPower) add(extra.water(ctx));
add(extra.clouds(ctx));
add(extra.waterfall(ctx));
add(extra.waterfallSound(ctx));
add(extra.music(ctx));
add(extra.muffle(ctx));
add(await extra.inscriptions(ctx));
setProgress(0.8);
const stairs = await extra.staircase({ ...ctx, fire: true });
setProgress(0.86);
// Work looks up the staircase from below, a little to one side, close enough to read the carving
const down = stairs.facing(0);
const workAz = Math.atan2(down.x, down.z) + 0.5;
STATES.projects.splice(0, 4, workAz, 0.2, 2.4, -0.24);
// The hero: a book on a lectern at the foot of the stairs (it moves the hero pose itself as it opens)
const book = await extra.heroBook({ ...ctx, pose: STATES.hero, work: STATES.projects });
add(book.update);
add(stairs.update);
if (!lowPower) extra.ambientOcclusion(ctx); // contact shadows: the costliest pass
setProgress(0.9);
// nothing shows until it's all ready: fonts in, every shader compiled, a first frame drawn (see the end)
await document.fonts.ready;
// (compiled for an off-screen target: the composer, the pool's reflection and the effects all draw into one. A
// shader built for the screen (sRGB, tone mapped) is a different program, and the right one would otherwise be
// compiled mid-scroll, a 30-70 ms hitch, the first time each material comes into view.)
renderer.setRenderTarget(composer.readBuffer);
const compiled = renderer.compileAsync(scene, camera);
renderer.setRenderTarget(null);
await compiled;
setProgress(0.96);
// and every texture on the GPU now, not the first time it comes into view (which stalls the scroll)
scene.traverse((o) => {
  for (const m of [].concat(o.material ?? []))
    for (const v of Object.values(m)) if (v?.isTexture) renderer.initTexture(v);
});


// ---------------------------------------------------------------- page wiring
// Phones: the links fold into a full-screen menu (the sound button stays in the header)
{
  const nav = document.querySelector(".nav"), btn = nav.querySelector(".menu-btn");
  const set = (open) => {
    nav.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", open);
    btn.textContent = open ? "Close" : "Menu";
  };
  btn.addEventListener("click", () => set(!nav.classList.contains("open")));
  nav.querySelectorAll("nav a").forEach((a) => a.addEventListener("click", () => set(false)));
}
// The scroll cue stays on screen all the way down ("Scroll to open" on the closed book), hidden only at the end.
// Clicking it moves on by most of a screen.
const cue = document.querySelector(".scroll-cue"), cueText = cue.querySelector("b");
cue.addEventListener("click", (e) => {
  e.preventDefault();
  scrollBy({ top: innerHeight * 0.85, behavior: "smooth" });
});
const updateCue = () => {
  const max = document.documentElement.scrollHeight - innerHeight;
  cueText.textContent = scrollY < 24 ? "Scroll to open" : "Scroll";
  cue.classList.toggle("gone", scrollY > max - 8);
};
addEventListener("scroll", updateCue, { passive: true });
updateCue();
// The name in the corner: JAD, and every 10 s its Greek form and back, the letters scrambling through Greek
// and Latin capitals before settling, left to right (a plain swap with reduced motion)
{
  const el = document.querySelector(".nav .mono"), forms = ["JAD", "Τζαντ"], glyphs = "ΓΔΘΛΞΠΣΦΨΩαβγδεζηθλμξπρσφψωABDGHKMRSXZ"; // (Greek in lower case: its capitals look Latin)
  let at = 0;
  const morph = (to) => {
    el.lang = to === forms[0] ? "en" : "el";
    if (motion < 1) return void (el.textContent = to);
    const from = el.textContent, n = Math.max(from.length, to.length), t0 = performance.now(), dur = 1100;
    const step = (now) => {
      const k = (now - t0) / dur;
      let out = "";
      for (let c = 0; c < n; c++) {
        const settle = (c + 1) / (n + 1);
        out += k > settle ? to[c] ?? "" : k > settle - 0.45 ? glyphs[(Math.random() * glyphs.length) | 0] : from[c] ?? "";
      }
      el.textContent = out;
      if (k < 1) requestAnimationFrame(step);
      else el.textContent = to;
    };
    requestAnimationFrame(step);
  };
  setInterval(() => morph(forms[(at = (at + 1) % forms.length)]), 10000);
}
// Expertise: scroll walks round the colonnade; the column facing the camera lights up, its row in the list
// is marked, and the panel below shows what's in that pillar. Scroll is the only control (no hover).
const legendRows = PILLARS.map((p, i) => {
  const li = document.createElement("li");
  li.textContent = ROMAN[i];
  document.getElementById("pillar-index").append(li);
  return li;
});
const pillarPanel = document.getElementById("pillar");
let shownCol = -1;
const showPillar = (i) => {
  if (i === shownCol) return;
  shownCol = i;
  legendRows.forEach((li, j) => li.classList.toggle("on", j === i));
  const p = PILLARS[i];
  pillarPanel.innerHTML = `<span class="yr">${ROMAN[i]}<small>${p.latin}</small></span><h3>${p.name}</h3><ul>${p.skills
    .map(([label, desc]) => `<li><b>${label}</b><span>${desc}</span></li>`)
    .join("")}</ul>`;
  pillarPanel.classList.remove("in");
  void pillarPanel.offsetWidth; // restart the fade-in
  pillarPanel.classList.add("in");
};
showPillar(0);
// Work: the career timeline beside the carved steps; the entry nearest the middle of the screen is active
const ascent = extra.MILESTONES.map((m) => {
  const li = document.createElement("li");
  const yr = m.year ? `${extra.roman(m.year)}<small>${m.year}${m.to ? ` - ${m.to}` : ""}</small>` : "Next";
  li.innerHTML = `<span class="yr">${yr}</span><h3>${m.title}</h3><p class="org">${m.org}</p>${[].concat(m.desc).map((d) => `<p class="desc">${d}</p>`).join("")}`;
  document.getElementById("ascent").append(li);
  return li;
});
let milestone = 0;
const pick = pointerPicker(renderer, camera);

// ---------------------------------------------------------------- loop
let cur = [...scroll.sample().vec];
let curW = scroll.names.map((_, i) => +(i === 0));
const target = new THREE.Vector3(), climbPoint = new THREE.Vector3(), climbGoal = new THREE.Vector3();
let climbReady = false;

const state = { introDone: true }; // (the carved names show from the start)

const advance = run((dt, t) => {
  const { vec, w } = scroll.sample();
  cur = cur.map((c, i) => damp(c, vec[i], 4, dt));
  curW = curW.map((c, i) => damp(c, w[i], 4, dt));
  const idx = w.indexOf(Math.max(...w));
  setChapter(idx);
  document.body.classList.toggle("at-work", idx === PROJECTS_IDX); // scrim swaps sides (temple.css)
  document.body.classList.toggle("at-book", idx === 0); // no text over the book: no scrim
  const skillsW = curW[SKILLS_IDX], projectsW = curW[PROJECTS_IDX];

  const bookLink = book.pick(curW[0] > 0.5 ? pick(book.pickable) : null); // a certificate under the pointer
  renderer.domElement.style.cursor = bookLink ? "pointer" : "";

  // Camera: section pose + one walk around the colonnade while the skills section is pinned. Scroll is the
  // only thing that moves it.
  const [az, el, r, shift, tx, ty, tz] = cur;
  // (a slow idle sway, but none on the book: looking down on it, any sway reads as the picture turning)
  const baseAz = az + scroll.progress("skills") * ORBIT + Math.sin(t * 0.07) * 0.04 * motion * (1 - curW[0]);
  target.set(tx, ty, tz);
  // In Work, the camera stops at the carved step of whichever timeline entry is in view (on an upright phone
  // the text runs in the lower part of the screen, so "in view" is lower down too)
  let near = Infinity;
  const readAt = innerHeight * (portrait() ? 0.62 : 0.5);
  ascent.forEach((li, i) => {
    const r = li.getBoundingClientRect(), d = Math.abs(r.top + r.height / 2 - readAt);
    if (d < near) (near = d), (milestone = i);
  });
  ascent.forEach((li, i) => li.classList.toggle("on", i === milestone));
  stairs.point(milestone, climbGoal);
  if (!climbReady) (climbPoint.copy(climbGoal), (climbReady = true));
  climbPoint.lerp(climbGoal, 1 - Math.exp(-3 * dt));
  target.lerp(climbPoint, projectsW);
  // Moving to or from the stairs, the camera swings a little wide instead of cutting through the island
  // (the arm and the waterfall would flash past the lens).
  const swing = 4 * projectsW * (1 - projectsW);
  // upright phone: the scene sits above the text (the book has the screen to itself); the temple stands a
  // little further off, to fit between the heading and the pillar's panel
  const tall = portrait();
  const lift = tall ? 0.3 * projectsW + 0.2 * skillsW + 0.2 * curW[CONTACT_IDX] : 0;
  place(target, [baseAz, el, r * (1 + 0.6 * swing) * (tall ? 1 + 0.35 * skillsW : 1), shift], lift);

  // The pillar in view follows the scroll itself (the walk is 5/6 of a turn: one column per fifth), not the
  // camera, which lags behind as it swings in from the stairs: pillar I on the way in, then in step with the scroll.
  const activeCol = Math.round(scroll.progress("skills") * 5);
  if (skillsW > 0.5) showPillar(activeCol);

  for (let i = 0; i < 6; i++) {
    const lit = i === activeCol && skillsW > 0.5 ? 1 : 0;
    columns[i].material.emissiveIntensity = damp(columns[i].material.emissiveIntensity, lit * 0.45, 6, dt);
    statues[i].material.emissiveIntensity = damp(statues[i].material.emissiveIntensity, lit * 0.18, 6, dt);

  }

  const maxScroll = document.documentElement.scrollHeight - innerHeight;
  Object.assign(state, {
    heroW: curW[0], activeCol, skillsW, projectsW, milestone, pageProgress: maxScroll > 0 ? scrollY / maxScroll : 0,
    climb: milestone / Math.max(1, ascent.length - 1), book: true, // how far up the stairs; the page starts at the book (muffle)
  });
  for (const u of updates) u(dt, t, state);
});
// the loading screen lifts once a first frame is drawn; the visit starts at the book (or at a linked section),
// not wherever the browser last left off
requestAnimationFrame(() => {
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
  else scrollTo(0, 0);
  advance(0);
  setProgress(1);
  hideLoader();
});
