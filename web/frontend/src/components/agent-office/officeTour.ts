import type { OfficeAreaId } from './officeAreas';

type Point = readonly [number, number];
export interface OfficeTourStop { area: OfficeAreaId; point: Point; pause: number }

/** Explicit scene demonstration: perimeter aisles, never a live Agent action. */
export function officeTourRoute(width: number, depth: number): OfficeTourStop[] {
  const right = width / 2 - .85, left = -width / 2 + .85;
  const front = depth / 2 - .45, back = -depth / 2 + 2.3;
  return [
    { area:'work', point:[0, front], pause:2 },
    { area:'fitness', point:[right, front], pause:0 },
    { area:'fitness', point:[width / 2 - 3.25, front], pause:3 },
    { area:'lounge', point:[right, front], pause:0 },
    { area:'lounge', point:[right, back], pause:0 },
    { area:'lounge', point:[width / 2 - 2.1, back], pause:3 },
    { area:'coffee', point:[-width / 2 + 2.05, back], pause:3 },
    { area:'washroom', point:[left, back], pause:0 },
    { area:'washroom', point:[left, depth / 2 - 3.0], pause:3 },
    { area:'work', point:[left, back], pause:0 },
    { area:'work', point:[right, back], pause:0 },
    { area:'work', point:[right, front], pause:0 },
    { area:'work', point:[0, front], pause:2 },
  ];
}

export function officeTourPose(route: readonly OfficeTourStop[], seconds: number) {
  const speed = .85;
  let remaining = Math.max(0, seconds);
  const duration = route.reduce((sum, stop, i) => sum + stop.pause + (i ? Math.hypot(stop.point[0] - route[i - 1].point[0], stop.point[1] - route[i - 1].point[1]) / speed : 0), 0);
  remaining %= duration;
  let heading = 0;
  for (let i = 0; i < route.length; i++) {
    const stop = route[i], previous = route[Math.max(0, i - 1)];
    const dx = stop.point[0] - previous.point[0], dz = stop.point[1] - previous.point[1];
    const travel = Math.hypot(dx, dz) / speed;
    if (travel) heading = Math.atan2(-dx, -dz);
    if (remaining < travel) {
      const amount = remaining / travel;
      return { x:previous.point[0] + dx * amount, z:previous.point[1] + dz * amount, heading, walking:true, area:stop.area };
    }
    remaining -= travel;
    if (remaining < stop.pause) return { x:stop.point[0], z:stop.point[1], heading, walking:false, area:stop.area };
    remaining -= stop.pause;
  }
  return { x:route[0].point[0], z:route[0].point[1], heading, walking:false, area:route[0].area };
}
