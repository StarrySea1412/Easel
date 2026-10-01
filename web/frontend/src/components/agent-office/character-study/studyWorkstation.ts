import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { StudyPresetId } from './studyPresets';

export interface StudyWorkstation {
  root: THREE.Group;
  contactLeft: THREE.Vector3;
  contactRight: THREE.Vector3;
  penTarget: THREE.Vector3;
  dispose: () => void;
}

/** Each role changes the working surface, equipment, layout and hand contacts. */
export function createStudyWorkstation(preset: StudyPresetId): StudyWorkstation {
  const root = new THREE.Group();
  root.name = `Workstation_${preset}`;
  const geometry = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  const material = (color: number, roughness = .82) => { const m = new THREE.MeshStandardMaterial({ color, roughness }); materials.add(m); return m; };
  const wood = material(preset === 'research' ? 0xb4997a : preset === 'design' ? 0xd2b9a2 : 0xcfb89c);
  const cream = material(0xf5f1e8), metal = material(0x56625e, .45), dark = material(0x343f43), paper = material(0xf9f4e9), muted = material(0x90a598);
  function add(g: THREE.BufferGeometry, m: THREE.Material, p: [number, number, number], parent: THREE.Object3D = root) {
    geometry.add(g); const object = new THREE.Mesh(g, m); object.position.set(...p); object.castShadow = true; object.receiveShadow = true; parent.add(object); return object;
  }
  function box(size: [number, number, number], position: [number, number, number], m: THREE.Material, parent?: THREE.Object3D, radius = .018) {
    return add(new RoundedBoxGeometry(...size, 2, Math.min(radius, ...size.map((s) => s / 4))), m, position, parent);
  }
  function leg(x: number, z: number) { return box([.054, .87, .054], [x, .435, z], metal); }
  function lines(parent: THREE.Object3D, x: number, y: number, z: number, widths: number[], m = muted) {
    widths.forEach((w, i) => box([w, .0015, .005], [x, y, z + i * .035], m, parent, .001));
  }
  function keyboard(x = 0, z = .66) {
    box([.66, .032, .235], [x, .946, z], cream);
    for (let row = 0; row < 4; row++) for (let col = 0; col < 11; col++) {
      box([.047, .011, .035], [x - .267 + col * .0535, .969, z - .079 + row * .048], row === 3 && col > 3 && col < 7 ? muted : paper, undefined, .004);
    }
  }
  function monitor(x: number, z: number, mode: 'document' | 'sources' | 'art', angle = 0) {
    const group = new THREE.Group(); group.position.set(x, 0, z); group.rotation.y = angle; root.add(group);
    box([.29, .016, .23], [0, .932, 0], metal, group);
    box([.043, .18, .044], [0, 1.02, 0], metal, group);
    const screenWidth = mode === 'sources' ? .51 : .72, screenHeight = mode === 'sources' ? .66 : .47;
    box([screenWidth, screenHeight, .045], [0, 1.21 + (mode === 'sources' ? .1 : 0), 0], dark, group);
    const canvas = document.createElement('canvas'); canvas.width = 768; canvas.height = mode === 'sources' ? 900 : 512;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#f0f0e8'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#d9e4d8'; ctx.fillRect(0, 0, canvas.width, 64);
      ctx.fillStyle = '#52645d'; ctx.font = 'bold 28px sans-serif'; ctx.fillText('EASEL  /  STUDY', 34, 43);
      if (mode === 'art') {
        ctx.fillStyle = '#c7d8cc'; ctx.fillRect(100, 97, 570, 340);
        ctx.fillStyle = '#6d8c7d'; ctx.beginPath(); ctx.arc(344, 265, 132, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#e6c9a4'; ctx.fillRect(367, 200, 144, 170);
        ctx.fillStyle = '#f8eee0'; ctx.beginPath(); ctx.arc(355, 195, 72, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = '#445950'; ctx.font = 'bold 37px sans-serif'; ctx.fillText(mode === 'sources' ? 'Sources & notes' : 'A little room to think.', 52, 132);
        for (let i = 0; i < (mode === 'sources' ? 6 : 4); i++) {
          const yy = 178 + i * (mode === 'sources' ? 102 : 65);
          ctx.fillStyle = i === 1 ? '#8baa95' : '#bcc9bd'; ctx.fillRect(52, yy, 470 - (i % 3) * 66, 12);
          ctx.fillStyle = '#d5dcd2'; ctx.fillRect(52, yy + 26, 575 - (i % 2) * 106, 8);
        }
      }
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; textures.add(texture);
      const m = new THREE.MeshStandardMaterial({ map: texture, roughness: .85, emissive: 0xffffff, emissiveIntensity: .08 }); materials.add(m);
      const plane = add(new THREE.PlaneGeometry(screenWidth - .031, screenHeight - .032), m, [0, 1.21 + (mode === 'sources' ? .1 : 0), -.024], group);
      plane.rotation.y = Math.PI;
    }
    // The rear stays clean: the readable preview belongs to the study panel.
    box([.10, .014, .001], [0, 1.22, .024], metal, group);
  }
  // A tailored chair with a low back leaves the silhouette and tail visible.
  box([.55, .105, .52], [0, .585, -.015], material(0xabb8a7));
  box([.51, .40, .064], [0, .855, -.264], material(0x8fa28f));
  box([.045, .34, .045], [0, .38, -.08], metal);
  for (const sign of [-1, 1]) {
    box([.63, .035, .045], [0, .12, -.08], metal).rotation.y = sign * .58;
  }
  let contactLeft = new THREE.Vector3(-.245, 1.022, .525), contactRight = new THREE.Vector3(.245, 1.022, .525);
  let penTarget = new THREE.Vector3(.22, 1.004, .73);
  if (preset === 'writing') {
    box([2.02, .085, .94], [0, .881, .88], wood, undefined, .04);
    for (const x of [-.91, .91]) for (const z of [.52, 1.24]) leg(x, z);
    keyboard(); monitor(.67, 1.085, 'document', .95);
    const sheet = box([.33, .004, .42], [-.68, .929, .83], paper); sheet.rotation.y = -.12;
    lines(root, -.68, .933, .69, [.21, .23, .17, .20, .12]);
    box([.031, .013, .23], [-.91, .935, .82], metal).rotation.y = -.14;
    box([.075, .031, .115], [.48, .942, .65], cream, undefined, .02);
  } else if (preset === 'research') {
    box([1.80, .10, .94], [-.06, .877, .84], wood, undefined, .055);
    // Side reference wing and upright books make the layout functionally different.
    box([.48, .067, .52], [-.93, .99, .96], wood);
    for (const x of [-.84, .72]) for (const z of [.48, 1.22]) leg(x, z);
    monitor(-.74, .99, 'sources', -.9);
    const book = new THREE.Group(); book.position.set(.04, .94, .74); book.rotation.x = -.10; root.add(book);
    for (const sign of [-1, 1]) {
      const page = new THREE.Group(); page.position.x = sign * .14; page.rotation.z = -sign * .045; book.add(page);
      box([.29, .025, .35], [0, .003, 0], material(0xc5a57d), page);
      box([.274, .018, .326], [0, .025, -.005], paper, page);
      lines(page, 0, .035, -.12, [.20, .205, .18, .21, .17, .11]);
    }
    for (let i = 0; i < 4; i++) {
      box([.059, .30 + i % 2 * .055, .25], [.51 + i * .072, 1.098 + i % 2 * .027, 1.09], material([0x66847a, 0xc0a37e, 0x97a5b4, 0xcfb798][i]));
    }
    box([.37, .025, .32], [.63, .94, 1.09], metal);
    box([.025, .20, .29], [.83, 1.035, 1.09], metal);
    box([.27, .008, .21], [.60, .938, .66], paper);
    lines(root, .60, .944, .595, [.18, .17, .12]);
    contactLeft = new THREE.Vector3(-.225, 1.04, .568); contactRight = new THREE.Vector3(.254, 1.065, .621);
  } else {
    box([1.96, .068, 1.12], [.015, .884, .94], cream, undefined, .065);
    // Trestle supports, a tilted pen display, sample rail and swatches.
    for (const sign of [-1, 1]) {
      const support = box([.07, .88, .72], [sign * .80, .43, .96], wood); support.rotation.z = sign * .07;
    }
    const tablet = new THREE.Group(); tablet.position.set(.06, .965, .73); tablet.rotation.x = .18; root.add(tablet);
    box([.78, .04, .46], [0, 0, 0], dark, tablet, .028);
    box([.713, .003, .392], [0, .023, 0], material(0xc2d4c7), tablet);
    box([.30, .004, .275], [.055, .026, 0], paper, tablet);
    box([.15, .005, .20], [.11, .03, .025], material(0xcba481), tablet);
    box([.11, .006, .23], [-.045, .032, -.04], muted, tablet);
    for (let i = 0; i < 5; i++) box([.078, .003, .097], [-.65 + i * .045, .93 + i * .002, .73 + i * .032], material([0x4d675b, 0x86a899, 0xc7d6ba, 0xdab58c, 0xaf7961][i]));
    box([.41, .022, .10], [.61, .938, 1.16], wood);
    const sample = box([.32, .39, .015], [.63, 1.125, 1.175], paper); sample.rotation.x = -.10;
    box([.24, .25, .005], [.63, 1.13, 1.187], muted).rotation.x = -.10;
    contactLeft = new THREE.Vector3(-.248, 1.032, .549); contactRight = new THREE.Vector3(.231, 1.095, .554);
    penTarget = new THREE.Vector3(.244, 1.004, .730);
  }
  return { root, contactLeft, contactRight, penTarget, dispose: () => { root.removeFromParent(); geometry.forEach((g) => g.dispose()); materials.forEach((m) => m.dispose()); textures.forEach((t) => t.dispose()); } };
}
