/**
 * Persistent topological naming grammar (PLAN §7.3). Lead-owned.
 *
 *   name     := featureTag ":" role [ "(" name ")" ] [ "#" index ]
 *   featureTag := "F" featureId
 *
 * Examples:
 *   F01J…:start              extrude start cap
 *   F01J…:side(S01H…:e7)      extrude side face generated from sketch edge e7
 *   F01K…:fillet(F01J…:edge(…))
 *   F01J…:face.top#0          primitive face, split index 0 (sorted by geometric key)
 *
 * Primitive (M0) roles, box in its local frame:
 *   faces:    face.xmin face.xmax face.ymin face.ymax face.zmin face.zmax
 *   edges:    edge(<faceRoleA>|<faceRoleB>) with the two face roles sorted lexicographically
 *   vertices: vertex(<x>,<y>,<z>) with each of x,y,z in {min,max}
 */

export type PersistentName = string;

/** Sub-shape index space of a single shape handle, as enumerated by TopExp::MapShapes. */
export interface NamingEntry {
  name: PersistentName;
  kind: 'face' | 'edge' | 'vertex';
  /** 0-based index into the shape's TopExp map for `kind` (stable for the lifetime of the handle). */
  index: number;
}

export type NamingMap = NamingEntry[];
