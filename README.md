# Jad Eid · The Island Temple

My portfolio at [jad-eid.com](https://jad-eid.com): a scroll through a classical temple on a floating island, in the
browser with [three.js](https://threejs.org).

- **The book**: you arrive at a worn leather book on a lectern. Scrolling opens it to a few words about me, my
  profiles and my certifications (each one a link).
- **Work**: the camera climbs a staircase whose steps carry my career, each chapter carved into the step for the year
  it began. The step for the entry you're reading catches fire.
- **Expertise**: the camera walks round the temple's six columns, one discipline per column, its Latin name carved and
  gilded above it.
- **Contact**: the view pulls back to the whole island.

Plus a waterfall, sound (waterfall and music, muffled until you reach the temple) and a Greek version of my name.

The previous portfolio (Next.js, a 3D keyboard) is tagged [`v1-keyboard`](../../tree/v1-keyboard).

## Run it locally

No build step and no dependencies: plain HTML, CSS and JavaScript modules, with three.js loaded from a CDN.

```bash
python tools/serve.py
```

Then open http://localhost:5181. The server turns off caching, so a reload always shows your latest edits.

**On a phone**: open `http://<this computer's IP>:5181` on the same Wi-Fi (Windows: allow port 5181 through the
firewall first). Phones report their errors, loading stages and frame rate back to the server, which prints them and
writes them to `tools/devlog.txt`. Phones have no console, so this is how you see what went wrong. This only happens
on the local server, never on the live site.

## Deploy

Vercel deploys `main` to jad-eid.com: merge to `main` and it's live. Branches get preview URLs. `vercel.json` marks
the site as static (no framework, no build) and sets caching for the model and assets.

## Files

| | |
|---|---|
| `index.html` | the page: text for each section, menu, loading screen |
| `main.js` | the scene: temple, camera path, sections, the Expertise pillars (`PILLARS`) |
| `extras.js` | everything else in the scene: sky, clouds, water, waterfall, sound, carved names, staircase (`MILESTONES`: the career), the book (`ABOUT`, `CERTS`, `PROFILES`) |
| `shared/` | loading, stage and camera plumbing (`base.js`), base styles, the error screen (`errors.js`) |
| `temple.css` | the site's styles, phones included |
| `temple.glb`, `assets/` | the 3D model (6.3 MB), lectern, textures, badges, audio, icons, social preview image |
| `docs/FEATURES.md` | each feature in detail, and how the site adapts to phones and slow devices |
| `tools/serve.py` | the local server |

The source models and textures, and the scripts that prepared them (Blender, gltf-transform), live outside this
repo.
