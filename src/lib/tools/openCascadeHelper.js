/*
 * @Author: wuyifan0203 1208097313@qq.com
 * @Date: 2025-04-29 09:56:12
 * @LastEditors: wuyifan0203 1208097313@qq.com
 * @LastEditTime: 2025-05-27 16:54:52
 * @FilePath: \threejs-demo\src\lib\tools\openCascadeHelper.js
 * Copyright (c) 2024 by wuyifan email: 1208097313@qq.com, All Rights Reserved.
 */
import potpack from "../other/potpack.js";

class Vec3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  copy({ x, y, z }) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  distanceTo({ x, y, z }) {
    return Math.sqrt(
      Math.pow(x - this.x, 2) +
      Math.pow(y - this.y, 2) +
      Math.pow(z - this.z, 2)
    );
  }
}

const _v1 = new Vec3();
const _v2 = new Vec3();
class OpenCascadeHelper {
  constructor(occ) {
    this.occ = occ;
    this.typeEnum = {
      [occ.TopAbs_ShapeEnum.TopAbs_FACE.value]: occ.TopoDS.Face_1,
      [occ.TopAbs_ShapeEnum.TopAbs_EDGE.value]: occ.TopoDS.Edge_1,
      [occ.TopAbs_ShapeEnum.TopAbs_VERTEX.value]: occ.TopoDS.Vertex_1,
      [occ.TopAbs_ShapeEnum.TopAbs_SHELL.value]: occ.TopoDS.Shell_1,
      [occ.TopAbs_ShapeEnum.TopAbs_SOLID.value]: occ.TopoDS.Solid_1,
    };
  }

  static MAX_HASH = 100000000;

  #forEach(shape, callback, type) {
    let index = 0;
    const exporter = new this.occ.TopExp_Explorer_2(shape, type, this.occ.TopAbs_ShapeEnum.TopAbs_SHAPE);
    exporter.Init(shape, type, this.occ.TopAbs_ShapeEnum.TopAbs_SHAPE);
    while (exporter.More()) {
      callback(this.typeEnum[type.value](exporter.Current()), index++);
      exporter.Next();
    }
  }

  shape2Buffer(shapes, lineDeviation, angleDeviation) {
    shapes = Array.isArray(shapes) ? shapes : [shapes];
    const compound = new this.occ.TopoDS_Compound();
    const builder = new this.occ.BRep_Builder();
    builder.MakeCompound(compound);

    const totalEdgeHashes = {};
    const totalFaceHashes = {};
    shapes.forEach((shape) => {
      Object.assign(totalEdgeHashes, this.forEachEdge(shape, () => { }));
      this.forEachFace(shape, (face, index) => {
        totalFaceHashes[face.HashCode(OpenCascadeHelper.MAX_HASH)] = index;
      });
      builder.Add(compound, shape);
    });

    return this.#convertShape(compound, totalFaceHashes, totalEdgeHashes, lineDeviation, angleDeviation);
  }

  #convertShape(compound, totalFaceHashes, totalEdgeHashes, lineDeviation = 0.1, angleDeviation = 0.5) {
    const faceList = [];
    const edgeList = [];

    let currentFace = 0;
    try {
      const shape = compound;
      new this.occ.BRepMesh_IncrementalMesh_2(shape, lineDeviation, false, angleDeviation, true);

      const totalEdgeHashes2 = {};
      const triangulations = [];
      const uvBoxes = [];

      this.forEachFace(shape, (face) => {
        const location = new this.occ.TopLoc_Location_1();
        const handelTriangulation = this.occ.BRep_Tool.Triangulation(face, location, 0/* == Poly_MeshPurpose_NONE */);
        if (handelTriangulation.IsNull()) {
          console.error("Encountered Null Face!");
          return;
        }
        const faceInfo = createFaceInfo(
          totalFaceHashes[face.HashCode(OpenCascadeHelper.MAX_HASH)]
        );

        const pc = new this.occ.Poly_Connect_2(handelTriangulation);
        const triangulation = handelTriangulation.get();
        const nodesLength = triangulation.NbNodes();

        // vertex buffer
        faceInfo.vertex = new Array(nodesLength * 3);
        for (let i = 0, l = nodesLength, j = i; i < l; i++, j = i * 3) {
          const point = triangulation.Node(i + 1).Transformed(location.Transformation());
          faceInfo.vertex[j + 0] = point.X();
          faceInfo.vertex[j + 1] = point.Y();
          faceInfo.vertex[j + 2] = point.Z();
        }

        // uv buffer
        const orientation = face.Orientation_1();
        if (triangulation.HasUVNodes()) {
          let [uMax, uMin, vMax, vMin] = [0, 0, 0, 0];

          faceInfo.uv = new Array(nodesLength * 2);
          for (let i = 0, j = i; i < nodesLength; i++, j = i * 2) {
            const point = triangulation.UVNode(i + 1);
            const x = point.X(), y = point.Y();
            faceInfo.uv[j + 0] = x;
            faceInfo.uv[j + 1] = y;

            // compute uv bounds
            if (i === 0) {
              [uMax, uMin, vMax, vMin] = [x, x, y, y];
            }
            if (x < uMin) {
              uMin = x;
            } else if (x > uMax) {
              uMax = x;
            }
            if (y < vMin) {
              vMin = y;
            } else if (y > vMax) {
              vMax = y;
            }
          }

          const surface = this.occ.BRep_Tool.Surface_2(face).get();
          // min + (max -min) * 0.5 => (min + max) * 0.5
          const handleUIsoCurve = surface.UIso((uMax + uMin) * 0.5);
          const handleVIsoCurve = surface.VIso((vMax + vMin) * 0.5);
          const uAdaptor = new this.occ.GeomAdaptor_Curve_2(handleVIsoCurve);
          const vAdaptor = new this.occ.GeomAdaptor_Curve_2(handleUIsoCurve);
          uvBoxes.push({
            w: this.lengthOfCurve(uAdaptor, uMin, uMax),
            h: this.lengthOfCurve(vAdaptor, vMin, vMax),
            index: currentFace,
          });

          //
          for (let i = 0, j = i; i < nodesLength; i++, j = i * 2) {
            _v1.x = faceInfo.uv[j + 0];
            _v1.y = faceInfo.uv[j + 1];

            _v1.x = (_v1.x - uMin) / (uMax - uMin);
            _v1.y = (_v1.y - vMin) / (vMax - vMin);

            if (orientation !== this.occ.TopAbs_Orientation.TopAbs_FORWARD) {
              _v1.x = 1 - _v1.y;
            }

            faceInfo.uv[j + 0] = _v1.x;
            faceInfo.uv[j + 1] = _v1.y;
          }
        }

        // normal buffer
        const normal = new this.occ.TColgp_Array1OfDir_2(1, nodesLength);
        this.occ.StdPrs_ToolTriangulatedShape.Normal(face, pc, normal);
        faceInfo.normal = new Array(normal.Length() * 3);
        for (let i = 0, l = normal.Length(), j = i; i < l; i++, j = i * 3) {
          const point = normal.Value(i + 1).Transformed(location.Transformation());
          faceInfo.normal[j + 0] = point.X();
          faceInfo.normal[j + 1] = point.Y();
          faceInfo.normal[j + 2] = point.Z();
        }

        // triangle buffer
        const triangles = triangulation.Triangles();
        faceInfo.index = new Array(triangles.Length() * 3);
        let validFaceTriCount = 0;
        for (let t = 1; t <= triangulation.NbTriangles(); t++) {
          const triangle = triangles.Value(t);
          let n1 = triangle.Value(1);
          let n2 = triangle.Value(2);
          let n3 = triangle.Value(3);
          if (orientation !== this.occ.TopAbs_Orientation.TopAbs_FORWARD) {
            const tmp = n1;
            n1 = n2;
            n2 = tmp;
          }

          let j = validFaceTriCount * 3;
          faceInfo.index[j + 0] = n1 - 1;
          faceInfo.index[j + 1] = n2 - 1;
          faceInfo.index[j + 2] = n3 - 1;
          validFaceTriCount++;
        }

        faceInfo.triangleCount = validFaceTriCount;
        faceList.push(faceInfo);
        currentFace += 1;

        this.forEachEdge(face, (edge) => {
          const edgeHash = edge.HashCode(OpenCascadeHelper.MAX_HASH);
          if (totalEdgeHashes2.hasOwnProperty(edgeHash)) {
            const edgeInfo = createEdgeInfo();

            const handlePolygonTra = this.occ.BRep_Tool.PolygonOnTriangulation_1(edge, handelTriangulation, location);
            const edgeNodes = handlePolygonTra.get().Nodes();

            // vertex buffer
            edgeInfo.vertex = new Array(edgeNodes.Length() * 3);
            for (let i = 0, l = edgeNodes.Length(), j = i; i < l; i++, j = i * 3) {
              const vertexIndex = (edgeNodes.Value(i + 1) - 1) * 3;
              edgeInfo.vertex[j + 0] = faceInfo.vertex[vertexIndex + 0];
              edgeInfo.vertex[j + 1] = faceInfo.vertex[vertexIndex + 1];
              edgeInfo.vertex[j + 2] = faceInfo.vertex[vertexIndex + 2];
            }

            edgeInfo.index = totalEdgeHashes[edgeHash];

            edgeList.push(edgeInfo);
          } else {
            totalEdgeHashes2[edgeHash] = edgeHash;
          }
        });
        triangulations.push(handelTriangulation);
      });

      const padding = 2;
      for (let i = 0, l = uvBoxes.length; i < l; i++) {
        uvBoxes[i].w += padding;
        uvBoxes[i].h += padding;
      }
      const packing = potpack(uvBoxes);

      for (let i = 0; i < uvBoxes.length; i++) {
        const box = uvBoxes[i];
        const faceInfo = faceList[box.index];

        for (let j = 0, k = 0, l = faceInfo.uv.length / 2; j < l; j++, k = j * 2) {
          _v1.x = faceInfo.uv[k + 0];
          _v1.y = faceInfo.uv[k + 1];

          _v1.x = (_v1.x * (box.w - padding) + (box.x + padding / 2)) / Math.max(packing.w, packing.h);
          _v1.y = (_v1.y * (box.h - padding) + (box.y + padding / 2)) / Math.max(packing.w, packing.h);

          faceInfo.uv[k + 0] = _v1.x;
          faceInfo.uv[k + 1] = _v1.y;
        }
      }

      for (let index = 0; index < triangulations.length; index++)
        triangulations[index].Nullify();

      this.forEachEdge(shape, (edge) => {
        const edgeHash = edge.HashCode(OpenCascadeHelper.MAX_HASH);
        if (!totalEdgeHashes2.hasOwnProperty(edgeHash)) {
          const edgeInfo = createEdgeInfo();

          const location = new this.occ.TopLoc_Location();
          const adaptorCurve = new this.occ.BRepAdaptor_Curve(edge);
          const deflection = new this.occ.GCPnts_TangentialDeflection(adaptorCurve, lineDeviation, 0.1);

          edgeInfo.vertex = new Array(deflection.NbPoints() * 3);
          for (let i = 0, l = deflection.NbPoints(), j = 0; i < l; i++, j = i * 3) {
            const point = deflection.Value(i + 1).Transformed(location.Transformation());
            edgeInfo.vertex[j + 0] = point.X();
            edgeInfo.vertex[j + 1] = point.Y();
            edgeInfo.vertex[j + 2] = point.Z();
          }

          edgeInfo.index = totalEdgeHashes[edgeHash];
          totalEdgeHashes2[edgeHash] = edgeHash;

          edgeList.push(edgeInfo);
        }
      });
    } catch (error) {
      console.error(error);
    }

    return {
      faceList,
      edgeList,
    };
  }

  lengthOfCurve(geomAdaptor, min, max, segment = 5) {
    const gpPnt = new this.occ.gp_Pnt_1();
    let length = 0;
    for (let i = min; i <= max; i += (max - min) / segment) {
      geomAdaptor.D0(i, gpPnt);
      _v1.set(gpPnt.X(), gpPnt.Y(), gpPnt.Z());
      if (i !== min) {
        length += _v1.distanceTo(_v2);
      }
      _v2.copy(_v1);
    }
    return length;
  }

  forEachFace(shape, callback) {
    this.#forEach(shape, callback, this.occ.TopAbs_ShapeEnum.TopAbs_FACE);
  }

  forEachWire(shape, callback) {
    this.#forEach(shape, callback, this.occ.TopAbs_ShapeEnum.TopAbs_WIRE);
  }

  forEachShell(shape, callback) {
    this.#forEach(shape, callback, this.occ.TopAbs_ShapeEnum.TopAbs_SHELL);
  }

  forEachVertex(shape, callback) {
    this.#forEach(shape, callback, this.occ.TopAbs_ShapeEnum.TopAbs_VERTEX);
  }
  forEachEdge(shape, callback) {
    const hashes = {};
    let index = 0;
    this.#forEach(shape, (edge) => {
      const hash = edge.HashCode(OpenCascadeHelper.MAX_HASH);
      if (!hashes.hasOwnProperty(hash)) {
        hashes[hash] = index;
        callback(edge, index++);
      }
    }, this.occ.TopAbs_ShapeEnum.TopAbs_EDGE);
    return hashes;
  }
}

function createFaceInfo(faceIndex) {
  return {
    vertex: [],
    uv: [],
    normal: [],
    index: [],
    triangleCount: 0,
    faceIndex,
  };
}

function createEdgeInfo() {
  return {
    vertex: [],
    index: -1,
  };
}

export { OpenCascadeHelper };
