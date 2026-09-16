import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Vector3,
} from "three";
import {
  faceRegionGeometry,
  visibleSurfacePoint,
} from "../web/surface-visibility.js";

test("face highlight includes the connected planar patch, not other faces", () => {
  const geometry = new BufferGeometry().setAttribute(
    "position",
    new Float32BufferAttribute(
      [
        0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0,
        0, 0, 1, 10, 0, 0, 11, 0, 0, 10, 1, 0,
      ],
      3,
    ),
  );
  const region = faceRegionGeometry(geometry, 0);
  assert.equal(region.getAttribute("position").count, 6);
  region.computeBoundingBox();
  assert.equal(region.boundingBox?.max.x, 1);
  assert.equal(region.boundingBox?.max.z, 0);
  assert.equal(
    faceRegionGeometry(geometry, 1).getAttribute("position").count,
    6,
  );
  assert.equal(
    faceRegionGeometry(geometry, 2).getAttribute("position").count,
    3,
  );
});

test("only the frontmost surface point can be highlighted", () => {
  const camera = new PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 0, 20);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const front = new Mesh(new PlaneGeometry(20, 20), new MeshBasicMaterial());
  const back = new Mesh(new PlaneGeometry(20, 20), new MeshBasicMaterial());
  back.position.z = -10;
  front.updateMatrixWorld(true);
  back.updateMatrixWorld(true);
  const meshes = [front, back];
  assert.equal(
    visibleSurfacePoint(new Vector3(2, 2, 0), camera, 800, 800, meshes),
    true,
  );
  assert.equal(
    visibleSurfacePoint(new Vector3(2, 2, -10), camera, 800, 800, meshes),
    false,
  );
  back.visible = false;
  assert.equal(
    visibleSurfacePoint(new Vector3(2, 2, -10), camera, 800, 800, [front]),
    false,
  );
});
