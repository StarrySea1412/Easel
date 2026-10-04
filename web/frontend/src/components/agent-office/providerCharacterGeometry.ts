import * as THREE from 'three';
export type ProviderStudyId = 'doubao' | 'deepseek' | 'unknown';
export type ProviderStudyPose = 'standing' | 'seated';
type Point = [number, number, number];

/** Locally authored review sculptures, not generated or official brand assets. */
export function createProviderStudyCharacter(provider: ProviderStudyId, pose: ProviderStudyPose): THREE.Group {
  const root = new THREE.Group(); root.name = `provider-study:${provider}:${pose}`;
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const mat = (color: string) => {
    if (!materials.has(color)) materials.set(color, new THREE.MeshStandardMaterial({ color, roughness: .58, metalness: provider === 'unknown' ? .18 : 0 }));
    return materials.get(color)!;
  };
  const mesh = (name: string, geometry: THREE.BufferGeometry, color: string, position: Point = [0, 0, 0]) => {
    const part = new THREE.Mesh(geometry, mat(color)); part.name = name; part.position.set(...position);
    part.castShadow = true; part.receiveShadow = true; root.add(part); return part;
  };
  const sphere = new THREE.SphereGeometry(1, 32, 20);
  const oval = (name: string, color: string, position: Point, scale: Point) => { const part = mesh(name, sphere, color, position); part.scale.set(...scale); return part; };
  const surface = (name: string, color: string, sample: (u: number, v: number) => Point, columns = 64, rows = 32, reverse = false) => {
    const positions: number[] = [], indices: number[] = [];
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= columns; i++) positions.push(...sample(i / columns, j / rows));
    for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) { const a = j * (columns + 1) + i, b = a + columns + 1; if (reverse) indices.push(a, a + 1, b, b, a + 1, b + 1); else indices.push(a, b, a + 1, b, b + 1, a + 1); }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
    const normal = geometry.getAttribute('normal');
    for (let j = 0; j <= rows; j++) { const a = j * (columns + 1), b = a + columns; const n = new THREE.Vector3().fromBufferAttribute(normal, a).add(new THREE.Vector3().fromBufferAttribute(normal, b)).normalize(); normal.setXYZ(a, n.x, n.y, n.z); normal.setXYZ(b, n.x, n.y, n.z); }
    return mesh(name, geometry, color);
  };
  // A tapered, closed, continuous surface replaces separate elbow/knee capsules.
  const sweep = (name: string, color: string, points: Point[], radii: number[], flatten = 1) => {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
    const frames = curve.computeFrenetFrames(32, false);
    return surface(name, color, (u, v) => {
      const p = curve.getPointAt(v), index = Math.min(radii.length - 2, Math.floor(v * (radii.length - 1)));
      const radius = THREE.MathUtils.lerp(radii[index], radii[index + 1], v * (radii.length - 1) - index) * Math.min(1, Math.sin(Math.PI * v) * 12);
      const f = Math.round(v * 32), a = u * Math.PI * 2;
      p.addScaledVector(frames.normals[f], Math.cos(a) * radius).addScaledVector(frames.binormals[f], Math.sin(a) * radius * flatten);
      return p.toArray() as Point;
    }, 24, 32, true);
  };
  const loft = (name: string, color: string, profile: Point[], centerY: number) => {
    const curve = new THREE.CatmullRomCurve3(profile.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
    return surface(name, color, (u, v) => { const p = curve.getPoint(v), a = u * Math.PI * 2; return [Math.sin(a) * p.x, p.y + centerY, Math.cos(a) * p.z]; }, 64, 32, true);
  };
  const plate = (name: string, color: string, position: Point, w: number, h: number, d: number, r: number) => {
    const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
    s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r); s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
    const geometry = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: true, bevelThickness: .015, bevelSize: .015, bevelSegments: 3, curveSegments: 8 }); geometry.translate(0, 0, -d / 2);
    return mesh(name, geometry, color, position);
  };
  const line = (name: string, color: string, points: Point[], radius = .008) => mesh(name, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p))), 24, radius, 6, false), color);
  const seated = pose === 'seated', base = seated ? -.4 : 0;
  const skin = '#efc5a6', ink = '#202934', blue = '#357de9', pale = '#daeeff';
  const body = provider === 'doubao' ? '#272e3b' : provider === 'deepseek' ? blue : '#667583';
  loft('continuous-torso', body, [[0, .9, 0], [.24, .91, .18], [.32, 1.12, .23], [.33, 1.42, .22], [.32, 1.55, .19], [.18, 1.66, .14], [0, 1.67, 0]], base);
  for (const side of [-1, 1]) {
    sweep(`continuous-leg-${side}`, body, [[side * .18, 1.04 + base, 0], [side * .21, seated ? .57 : .58, seated ? .41 : .02], [side * .21, .13, seated ? .48 : .02]], [.145, .12, .1]);
    plate(`shoe-${side}`, ink, [side * .21, .12, seated ? .56 : .11], .25, .13, .37, .05);
    plate(`sole-${side}`, '#8993a0', [side * .21, .035, seated ? .56 : .11], .255, .035, .38, .017);
    const shoulder: Point = [side * .16, 1.49 + base, 0], elbow: Point = [side * .45, seated ? 1.02 : 1.23, seated ? .23 : .01], wrist: Point = [side * .41, seated ? 1.10 : .99, seated ? .54 : .09];
    sweep(`continuous-sleeve-${side}`, body, [shoulder, elbow, wrist], [.12, .105, .077], provider === 'deepseek' ? .7 : 1);
    const hand: Point = [wrist[0], wrist[1] - (seated ? 0 : .04), wrist[2] + .035];
    oval(`hand-${side}`, provider === 'doubao' ? skin : body, hand, [.083, .105, .11]);
    if (provider === 'doubao') oval(`thumb-${side}`, skin, [hand[0] - side * .056, hand[1] + .018, hand[2] + .047], [.039, .057, .05]);
    if (provider === 'unknown') { oval(`shoulder-bearing-${side}`, '#34414c', shoulder, [.135, .135, .135]); plate(`wrist-band-${side}`, '#becbd1', wrist, .16, .048, .13, .02); }
  }
  if (provider === 'doubao') {
    sweep('neck', skin, [[0, 1.57 + base, 0], [0, 1.78 + base, 0], [0, 1.91 + base, 0]], [.12, .12, .10]);
    loft('sculpted-head', skin, [[0, 1.76, 0], [.18, 1.8, .16], [.32, 1.93, .27], [.38, 2.15, .31], [.35, 2.39, .28], [.21, 2.52, .19], [0, 2.56, 0]], base);
    // An enclosing short bob follows the full head volume. Its low asymmetric
    // front edge makes the swept fringe solid, including from profile views.
    const hairPoint = (angle: number, fraction: number, lift = 0): Point => {
      const front = Math.max(0, Math.cos(angle));
      const edge = 1.90 - .49 * Math.cos(angle) + .19 * Math.sin(angle) * front;
      const theta = fraction * edge;
      return [(.438 + lift) * Math.sin(theta) * Math.sin(angle), 2.18 + base + (.46 + lift) * Math.cos(theta), (.385 + lift) * Math.sin(theta) * Math.cos(angle)];
    };
    surface('continuous-side-part-hair', '#51372f', (u, v) => hairPoint(u * Math.PI * 2, v));
    // Only subtle grooves on the enclosing hair surface, never over exposed skin.
    for (const offset of [-.7, -.3, .35]) {
      const points: Point[] = [];
      for (let i = 0; i <= 12; i++) { const t = i / 12; points.push(hairPoint(offset + .25 * (1 - t), .18 + .76 * t, .002)); }
      line(`hair-strand-${offset}`, '#5b3e32', points, .003);
    }
    for (const side of [-1, 1]) {
      oval(`ear-${side}`, skin, [side * .37, 2.05 + base, .005], [.062, .10, .07]);
      oval(`eye-white-${side}`, '#fffbef', [side * .145, 2.14 + base, .283], [.087, .105, .034]);
      oval(`iris-${side}`, '#654936', [side * .145, 2.14 + base, .311], [.052, .07, .016]);
      oval(`pupil-${side}`, ink, [side * .145, 2.14 + base, .323], [.028, .049, .008]);
      oval(`eye-light-${side}`, '#fffbef', [side * .145 - .015, 2.17 + base, .331], [.012, .016, .006]);
      line(`brow-${side}`, '#51372f', [[side * .23, 2.285 + base, .235], [side * .15, 2.31 + base, .267], [side * .075, 2.29 + base, .28]], .012);
      const collar = plate(`collar-${side}`, '#fffbef', [side * .1, 1.59 + base, .161], .14, .15, .022, .025); collar.rotation.z = side * .45;
    }
    oval('nose', skin, [0, 2.06 + base, .309], [.043, .059, .043]);
    line('smile', '#a46561', [[-.067, 1.963 + base, .27], [0, 1.948 + base, .286], [.067, 1.963 + base, .27]], .008);
    line('shirt-placket', '#404959', [[0, 1.49 + base, .219], [0, 1.27 + base, .232], [0, 1.05 + base, .215]], .005);
    for (let i = 0; i < 3; i++) oval(`button-${i}`, '#fffbef', [0, 1.43 + base - i * .13, .236], [.014, .014, .009]);
  } else if (provider === 'deepseek') {
    const head = surface('continuous-whale-head', blue, (u, v) => { const theta = v * Math.PI, a = u * Math.PI * 2, y = Math.cos(theta), ring = Math.sin(theta); return [.63 * ring * Math.sin(a), 2.01 + base + .46 * y, .05 + .44 * ring * Math.cos(a) * (1 + .15 * Math.max(0, -y))]; });
    // The belly is vertex color on the head itself, with no intersecting muzzle spheres.
    const colors: number[] = [], positions = head.geometry.getAttribute('position'), upper = new THREE.Color(blue), lower = new THREE.Color(pale);
    for (let i = 0; i < positions.count; i++) { const y = positions.getY(i) - base, z = positions.getZ(i), blend = THREE.MathUtils.smoothstep(1.91 - y + .035 * Math.cos(positions.getX(i) * 5), 0, .045) * THREE.MathUtils.smoothstep(z, -.1, .12), color = upper.clone().lerp(lower, blend); colors.push(color.r, color.g, color.b); }
    head.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); const whaleMat = mat('#ffffff'); whaleMat.vertexColors = true; head.material = whaleMat;
    for (const side of [-1, 1]) {
      oval(`whale-eye-${side}`, '#172c54', [side * .34, 2.09 + base, .418], [.045, .057, .026]); oval(`whale-eye-light-${side}`, '#f8fcff', [side * .35, 2.108 + base, .441], [.012, .015, .006]);
      sweep(`whale-flipper-${side}`, blue, [[side * .43, 1.85 + base, .01], [side * .61, 1.74 + base, .02], [side * .73, 1.63 + base, .10]], [.12, .09, 0], .45);
    }
    line('whale-smile', '#22539b', [[-.25, 1.91 + base, .45], [0, 1.87 + base, .485], [.25, 1.91 + base, .45]], .008);
    sweep('tail-stem', blue, [[.30, 2.21 + base, -.2], [.52, 2.43 + base, -.15], [.59, 2.57 + base, -.12]], [.15, .10, .065]);
    for (const side of [-1, 1]) sweep(`tail-fluke-${side}`, blue, [[.59, 2.54 + base, -.12], [.59 + side * .13, 2.62 + base, -.12], [.59 + side * .25, 2.66 + base, -.12]], [.085, .10, 0], .5);
    oval('belly', pale, [0, 1.28 + base, .219], [.22, .265, .025]);
  } else {
    sweep('neck-bearing', '#34414c', [[0, 1.58 + base, 0], [0, 1.77 + base, 0], [0, 1.88 + base, 0]], [.13, .13, .12]);
    plate('unibody-head-shell', '#82929f', [0, 2.08 + base, 0], .84, .69, .48, .18);
    plate('visor-gasket', '#34414c', [0, 2.085 + base, .252], .73, .47, .045, .15);
    plate('curved-dark-visor', '#182632', [0, 2.09 + base, .287], .66, .40, .035, .13);
    for (const side of [-1, 1]) { plate(`visor-eye-${side}`, '#bdebe2', [side * .135, 2.12 + base, .335], .052, .088, .005, .022); plate(`ear-cover-${side}`, '#becbd1', [side * .452, 2.07 + base, 0], .075, .23, .25, .035); }
    line('visor-expression', '#bdebe2', [[-.07, 1.99 + base, .335], [0, 1.973 + base, .335], [.07, 1.99 + base, .335]], .007);
    sweep('antenna', '#becbd1', [[0, 2.4 + base, 0], [0, 2.52 + base, 0], [0, 2.62 + base, 0]], [.032, .025, .025]); oval('antenna-tip', '#bdebe2', [0, 2.62 + base, 0], [.056, .056, .056]);
    plate('chest-inset', '#34414c', [0, 1.40 + base, .215], .29, .20, .016, .055); plate('status-light', '#bdebe2', [0, 1.43 + base, .258], .15, .023, .008, .01);
    for (let i = -1; i <= 1; i++) line(`speaker-${i}`, '#becbd1', [[i * .045, 1.36 + base, .258], [i * .045, 1.32 + base, .258]], .006);
  }
  return root;
}
