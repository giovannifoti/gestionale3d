import JSZip from "jszip";
import type {
  Bounds,
  BoxSize,
  EmptyPreview,
  MeshPreview,
  ParsedFile,
  PrintMetrics,
  ToolpathPreview,
  ToolpathSegment,
} from "../types";

const MAX_TOOLPATH_SEGMENTS = 55000;

type Position = {
  x: number;
  y: number;
  z: number;
  e: number;
};

type RawMesh = {
  vertices: number[];
  indices: number[];
};

type ObjectNode = {
  mesh?: RawMesh;
  components: Array<{ objectId: string; transform: Matrix3mf }>;
};

type Matrix3mf = number[];

const IDENTITY_MATRIX: Matrix3mf = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

export async function parsePrintFile(file: File): Promise<ParsedFile> {
  const extension = file.name.toLowerCase().split(".").pop();

  if (extension === "gcode" || extension === "gco" || extension === "gc") {
    const text = await file.text();
    return parseGcodeText(text, file.name, file.size, true);
  }

  if (extension === "3mf") {
    return parse3mf(file);
  }

  return {
    metrics: createBaseMetrics(file.name, file.size, "unknown", [
      "Formato non riconosciuto. Carica un file .3mf o .gcode.",
    ]),
    preview: { kind: "empty", message: "Formato non supportato." },
  };
}

function parseGcodeText(
  text: string,
  fileName: string,
  fileSize: number,
  includePreview: boolean,
): ParsedFile {
  const metrics = createBaseMetrics(fileName, fileSize, "gcode", []);
  const segments: ToolpathSegment[] = [];
  const bounds = createEmptyBounds();
  const pos: Position = { x: 0, y: 0, z: 0, e: 0 };
  const zLevels = new Set<string>();
  let isAbsolute = true;
  let isExtruderAbsolute = true;
  let totalExtrudedMm = 0;
  let layer = 0;
  let lastZKey = "";
  let skippedSegments = 0;

  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    updateGcodeMetadata(rawLine, metrics);
    const command = rawLine.split(";")[0].trim();
    if (!command) {
      continue;
    }

    const code = command.toUpperCase();
    if (code.startsWith("G90")) {
      isAbsolute = true;
      continue;
    }
    if (code.startsWith("G91")) {
      isAbsolute = false;
      continue;
    }
    if (code.startsWith("M82")) {
      isExtruderAbsolute = true;
      continue;
    }
    if (code.startsWith("M83")) {
      isExtruderAbsolute = false;
      continue;
    }

    if (code.startsWith("G92")) {
      const params = parseGcodeParams(command);
      pos.x = params.X ?? pos.x;
      pos.y = params.Y ?? pos.y;
      pos.z = params.Z ?? pos.z;
      pos.e = params.E ?? pos.e;
      continue;
    }

    if (!code.startsWith("G0") && !code.startsWith("G1")) {
      continue;
    }

    const params = parseGcodeParams(command);
    const next: Position = { ...pos };
    if (params.X !== undefined) {
      next.x = isAbsolute ? params.X : pos.x + params.X;
    }
    if (params.Y !== undefined) {
      next.y = isAbsolute ? params.Y : pos.y + params.Y;
    }
    if (params.Z !== undefined) {
      next.z = isAbsolute ? params.Z : pos.z + params.Z;
    }

    const hasExtrusion = params.E !== undefined;
    const nextE = hasExtrusion
      ? isExtruderAbsolute
        ? params.E ?? pos.e
        : pos.e + (params.E ?? 0)
      : pos.e;
    const extrudedDelta = hasExtrusion
      ? isExtruderAbsolute
        ? Math.max(0, nextE - pos.e)
        : Math.max(0, params.E ?? 0)
      : 0;
    const moved = next.x !== pos.x || next.y !== pos.y || next.z !== pos.z;
    const extrudingMove = extrudedDelta > 0 && moved;

    if (extrudingMove) {
      const zKey = next.z.toFixed(3);
      if (zKey !== lastZKey) {
        lastZKey = zKey;
        layer += 1;
        zLevels.add(zKey);
      }
      expandBounds(bounds, pos.x, pos.y, pos.z);
      expandBounds(bounds, next.x, next.y, next.z);
      if (includePreview && segments.length < MAX_TOOLPATH_SEGMENTS) {
        segments.push({
          from: [pos.x, pos.y, pos.z],
          to: [next.x, next.y, next.z],
          layer,
        });
      } else if (includePreview) {
        skippedSegments += 1;
      }
      totalExtrudedMm += extrudedDelta;
    }

    pos.x = next.x;
    pos.y = next.y;
    pos.z = next.z;
    pos.e = nextE;
  }

  if (!metrics.filamentMm && totalExtrudedMm > 0) {
    metrics.filamentMm = totalExtrudedMm;
    metrics.filamentMeters = totalExtrudedMm / 1000;
  }

  if (zLevels.size > 0) {
    metrics.layerCount = zLevels.size;
  }

  if (isFiniteBounds(bounds)) {
    metrics.boundingBox = boundsToBox(bounds);
  }

  if (!metrics.printTimeMinutes) {
    metrics.warnings.push("Tempo di stampa non trovato nel G-code: inseriscilo o correggilo nel pannello prezzi.");
  }
  if (!metrics.filamentGrams && !metrics.filamentMm && !metrics.filamentMeters) {
    metrics.warnings.push("Filamento non trovato nel G-code: inserisci i grammi nel pannello prezzi.");
  }
  if (skippedSegments > 0) {
    metrics.warnings.push(`Anteprima alleggerita: ${skippedSegments.toLocaleString("it-IT")} segmenti oltre il limite non sono stati disegnati.`);
  }

  const preview: ToolpathPreview | EmptyPreview = segments.length
    ? { kind: "toolpath", segments, bounds: isFiniteBounds(bounds) ? bounds : undefined }
    : { kind: "empty", message: "Nessun percorso estruso trovato nel G-code." };

  return { metrics, preview };
}

async function parse3mf(file: File): Promise<ParsedFile> {
  const metrics = createBaseMetrics(file.name, file.size, "3mf", []);

  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const modelFile = Object.values(zip.files).find(
      (entry) => !entry.dir && /(^|\/)3dmodel\.model$/i.test(entry.name),
    ) ?? Object.values(zip.files).find((entry) => !entry.dir && /\.model$/i.test(entry.name));

    if (!modelFile) {
      return {
        metrics: {
          ...metrics,
          warnings: ["Il 3MF non contiene un modello leggibile."],
        },
        preview: { kind: "empty", message: "Modello 3MF non trovato." },
      };
    }

    const xml = await modelFile.async("string");
    const document = new DOMParser().parseFromString(xml, "application/xml");
    const modelElement = firstElement(document, "model");
    const unitScale = unitToMm(modelElement?.getAttribute("unit"));
    const objects = parse3mfObjects(document, unitScale);
    const buildItems = elements(document, "item").filter((item) => item.parentElement?.tagName.toLowerCase().endsWith("build"));
    const vertices: number[] = [];
    const indices: number[] = [];
    const bounds = createEmptyBounds();

    if (buildItems.length) {
      for (const item of buildItems) {
        const objectId = item.getAttribute("objectid");
        if (!objectId) {
          continue;
        }
        appendObjectMesh(objectId, objects, [parseTransform(item.getAttribute("transform"))], vertices, indices, bounds);
      }
    } else {
      for (const objectId of objects.keys()) {
        appendObjectMesh(objectId, objects, [], vertices, indices, bounds);
      }
    }

    const embeddedGcode = Object.values(zip.files).find((entry) => !entry.dir && /\.gcode$/i.test(entry.name));
    if (embeddedGcode) {
      const embedded = parseGcodeText(await embeddedGcode.async("string"), file.name, file.size, false);
      mergeGcodeMetrics(metrics, embedded.metrics);
    }

    if (!vertices.length || !indices.length) {
      metrics.warnings.push("Geometria non trovata nel 3MF. Il file potrebbe contenere solo impostazioni di slicing.");
      return {
        metrics,
        preview: { kind: "empty", message: "Nessuna geometria disponibile." },
      };
    }

    metrics.boundingBox = isFiniteBounds(bounds) ? boundsToBox(bounds) : undefined;
    metrics.volumeCm3 = calculateMeshVolumeCm3(vertices, indices);

    if (!metrics.printTimeMinutes) {
      metrics.warnings.push("Il 3MF mostra la geometria, ma non contiene un tempo di stampa leggibile: inseriscilo nel pannello prezzi.");
    }
    if (!metrics.filamentGrams && !metrics.filamentMm && metrics.volumeCm3) {
      metrics.warnings.push("Filamento stimato dalla geometria: per un preventivo preciso usa un G-code o correggi i grammi.");
    }

    const preview: MeshPreview = {
      kind: "mesh",
      vertices,
      indices,
      bounds: isFiniteBounds(bounds) ? bounds : undefined,
    };

    return { metrics, preview };
  } catch (error) {
    return {
      metrics: {
        ...metrics,
        warnings: [`Errore lettura 3MF: ${error instanceof Error ? error.message : "file non valido"}`],
      },
      preview: { kind: "empty", message: "Impossibile leggere il 3MF." },
    };
  }
}

function updateGcodeMetadata(line: string, metrics: PrintMetrics): void {
  const clean = line.trim();
  const lower = clean.toLowerCase();

  const timeSeconds = clean.match(/;\s*time\s*:\s*(\d+)/i)?.[1];
  if (timeSeconds && !metrics.printTimeMinutes) {
    metrics.printTimeMinutes = Number(timeSeconds) / 60;
  }

  if (!metrics.printTimeMinutes && /(estimated|print|printing|total).*time|tempo/i.test(clean)) {
    const value = clean.split(/[:=]/).slice(1).join(":").trim();
    const minutes = parseDurationToMinutes(value);
    if (minutes) {
      metrics.printTimeMinutes = minutes;
    }
  }

  if (lower.includes("filament") || lower.includes("filamento")) {
    const grams = clean.match(/(?:filament|filamento).*?(?:\[g\]|grams?|g)\s*[=:]?\s*([0-9]+(?:[.,][0-9]+)?)/i)
      ?? clean.match(/([0-9]+(?:[.,][0-9]+)?)\s*g\b/i);
    const meters = clean.match(/(?:filament|filamento).*?(?:\[m\]|meters?|metri|m)\s*[=:]?\s*([0-9]+(?:[.,][0-9]+)?)/i)
      ?? clean.match(/([0-9]+(?:[.,][0-9]+)?)\s*m\b/i);
    const millimeters = clean.match(/(?:filament|filamento).*?(?:\[mm\]|millimeters?|mm)\s*[=:]?\s*([0-9]+(?:[.,][0-9]+)?)/i);

    if (!metrics.filamentGrams && grams) {
      metrics.filamentGrams = parseLocaleNumber(grams[1]);
    }
    if (!metrics.filamentMeters && meters && !clean.toLowerCase().includes("mm")) {
      metrics.filamentMeters = parseLocaleNumber(meters[1]);
      metrics.filamentMm = metrics.filamentMeters * 1000;
    }
    if (!metrics.filamentMm && millimeters) {
      metrics.filamentMm = parseLocaleNumber(millimeters[1]);
      metrics.filamentMeters = metrics.filamentMm / 1000;
    }

    const filamentType = clean.match(/filament(?:_type| type)?\s*[=:]\s*([A-Za-z0-9+\-\s]+)/i)?.[1];
    if (!metrics.detectedMaterial && filamentType) {
      metrics.detectedMaterial = filamentType.trim();
    }
  }

  const printer = clean.match(/(?:printer_model|printer|generated by)\s*[=:]\s*([^;]+)/i)?.[1];
  if (!metrics.detectedPrinter && printer) {
    metrics.detectedPrinter = printer.trim();
  }
}

function parseDurationToMinutes(value: string): number | undefined {
  const normalized = value.toLowerCase().replaceAll(",", ".").trim();
  const colon = normalized.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (colon) {
    const first = Number(colon[1]);
    const second = Number(colon[2]);
    const third = Number(colon[3] ?? 0);
    return colon[3] ? first * 60 + second + third / 60 : first + second / 60;
  }

  let minutes = 0;
  let matched = false;
  const units = normalized.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*(days?|giorni?|d|hours?|hrs?|ore?|h|minutes?|mins?|minuti?|m|seconds?|secs?|secondi?|s)\b/g);
  for (const match of units) {
    const amount = Number(match[1]);
    const unit = match[2];
    matched = true;
    if (/^d|day|giorn/.test(unit)) {
      minutes += amount * 1440;
    } else if (/^h|hour|hr|or/.test(unit)) {
      minutes += amount * 60;
    } else if (/^m|min/.test(unit)) {
      minutes += amount;
    } else {
      minutes += amount / 60;
    }
  }
  return matched && minutes > 0 ? minutes : undefined;
}

function parseGcodeParams(command: string): Partial<Record<"X" | "Y" | "Z" | "E" | "F", number>> {
  const params: Partial<Record<"X" | "Y" | "Z" | "E" | "F", number>> = {};
  for (const match of command.matchAll(/([XYZEF])\s*(-?[0-9]+(?:\.[0-9]+)?)/gi)) {
    const key = match[1].toUpperCase() as "X" | "Y" | "Z" | "E" | "F";
    params[key] = Number(match[2]);
  }
  return params;
}

function parse3mfObjects(document: Document, unitScale: number): Map<string, ObjectNode> {
  const result = new Map<string, ObjectNode>();

  for (const object of elements(document, "object")) {
    const id = object.getAttribute("id");
    if (!id) {
      continue;
    }

    const meshElement = firstChildElement(object, "mesh");
    const componentsElement = firstChildElement(object, "components");
    const node: ObjectNode = { components: [] };

    if (meshElement) {
      const vertices: number[] = [];
      const indices: number[] = [];
      for (const vertex of elements(meshElement, "vertex")) {
        vertices.push(
          parseFloat(vertex.getAttribute("x") ?? "0") * unitScale,
          parseFloat(vertex.getAttribute("y") ?? "0") * unitScale,
          parseFloat(vertex.getAttribute("z") ?? "0") * unitScale,
        );
      }
      for (const triangle of elements(meshElement, "triangle")) {
        indices.push(
          Number(triangle.getAttribute("v1") ?? 0),
          Number(triangle.getAttribute("v2") ?? 0),
          Number(triangle.getAttribute("v3") ?? 0),
        );
      }
      node.mesh = { vertices, indices };
    }

    if (componentsElement) {
      for (const component of elements(componentsElement, "component")) {
        const objectId = component.getAttribute("objectid");
        if (objectId) {
          node.components.push({
            objectId,
            transform: parseTransform(component.getAttribute("transform")),
          });
        }
      }
    }

    result.set(id, node);
  }

  return result;
}

function appendObjectMesh(
  objectId: string,
  objects: Map<string, ObjectNode>,
  transforms: Matrix3mf[],
  vertices: number[],
  indices: number[],
  bounds: Bounds,
  stack: string[] = [],
): void {
  if (stack.includes(objectId)) {
    return;
  }
  const node = objects.get(objectId);
  if (!node) {
    return;
  }

  if (node.mesh) {
    const offset = vertices.length / 3;
    for (let i = 0; i < node.mesh.vertices.length; i += 3) {
      let point: [number, number, number] = [
        node.mesh.vertices[i],
        node.mesh.vertices[i + 1],
        node.mesh.vertices[i + 2],
      ];
      for (const transform of transforms) {
        point = applyTransform(point, transform);
      }
      vertices.push(point[0], point[1], point[2]);
      expandBounds(bounds, point[0], point[1], point[2]);
    }
    for (const index of node.mesh.indices) {
      indices.push(index + offset);
    }
  }

  for (const component of node.components) {
    appendObjectMesh(
      component.objectId,
      objects,
      [component.transform, ...transforms],
      vertices,
      indices,
      bounds,
      [...stack, objectId],
    );
  }
}

function parseTransform(value: string | null): Matrix3mf {
  if (!value) {
    return IDENTITY_MATRIX;
  }
  const numbers = value
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((number) => Number.isFinite(number));
  return numbers.length === 12 ? numbers : IDENTITY_MATRIX;
}

function applyTransform(point: [number, number, number], matrix: Matrix3mf): [number, number, number] {
  const [x, y, z] = point;
  return [
    x * matrix[0] + y * matrix[3] + z * matrix[6] + matrix[9],
    x * matrix[1] + y * matrix[4] + z * matrix[7] + matrix[10],
    x * matrix[2] + y * matrix[5] + z * matrix[8] + matrix[11],
  ];
}

function calculateMeshVolumeCm3(vertices: number[], indices: number[]): number {
  let volume = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const ai = indices[i] * 3;
    const bi = indices[i + 1] * 3;
    const ci = indices[i + 2] * 3;
    const ax = vertices[ai];
    const ay = vertices[ai + 1];
    const az = vertices[ai + 2];
    const bx = vertices[bi];
    const by = vertices[bi + 1];
    const bz = vertices[bi + 2];
    const cx = vertices[ci];
    const cy = vertices[ci + 1];
    const cz = vertices[ci + 2];
    volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return Math.abs(volume / 6) / 1000;
}

function mergeGcodeMetrics(target: PrintMetrics, source: PrintMetrics): void {
  target.printTimeMinutes = target.printTimeMinutes ?? source.printTimeMinutes;
  target.filamentGrams = target.filamentGrams ?? source.filamentGrams;
  target.filamentMeters = target.filamentMeters ?? source.filamentMeters;
  target.filamentMm = target.filamentMm ?? source.filamentMm;
  target.layerCount = target.layerCount ?? source.layerCount;
  target.detectedPrinter = target.detectedPrinter ?? source.detectedPrinter;
  target.detectedMaterial = target.detectedMaterial ?? source.detectedMaterial;
}

function createBaseMetrics(fileName: string, fileSize: number, kind: PrintMetrics["kind"], warnings: string[]): PrintMetrics {
  return {
    fileName,
    fileSize,
    kind,
    warnings,
  };
}

function createEmptyBounds(): Bounds {
  return {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
}

function expandBounds(bounds: Bounds, x: number, y: number, z: number): void {
  bounds.minX = Math.min(bounds.minX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.minZ = Math.min(bounds.minZ, z);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.maxY = Math.max(bounds.maxY, y);
  bounds.maxZ = Math.max(bounds.maxZ, z);
}

function isFiniteBounds(bounds: Bounds): boolean {
  return Number.isFinite(bounds.minX) && Number.isFinite(bounds.maxX);
}

function boundsToBox(bounds: Bounds): BoxSize {
  return {
    x: Math.max(0, bounds.maxX - bounds.minX),
    y: Math.max(0, bounds.maxY - bounds.minY),
    z: Math.max(0, bounds.maxZ - bounds.minZ),
  };
}

function unitToMm(unit: string | null | undefined): number {
  switch (unit?.toLowerCase()) {
    case "micron":
      return 0.001;
    case "centimeter":
      return 10;
    case "inch":
      return 25.4;
    case "foot":
      return 304.8;
    case "meter":
      return 1000;
    case "millimeter":
    default:
      return 1;
  }
}

function firstElement(document: Document, tag: string): Element | undefined {
  return elements(document, tag)[0];
}

function firstChildElement(element: Element, tag: string): Element | undefined {
  return Array.from(element.children).find((child) => child.tagName.toLowerCase().endsWith(tag));
}

function elements(root: Document | Element, tag: string): Element[] {
  return Array.from(root.getElementsByTagName("*")).filter((element) =>
    element.tagName.toLowerCase().endsWith(tag.toLowerCase()),
  );
}

function parseLocaleNumber(value: string): number {
  return Number(value.replace(",", "."));
}
