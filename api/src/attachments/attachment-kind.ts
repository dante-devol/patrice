import { AttachmentKind } from '@prisma/client';

/**
 * Map a MIME content type to the coarse `AttachmentKind` bucket (Slice 4.3). Kept
 * pure so the classification is unit-testable. `model` covers 3D assets (glTF/OBJ/STL)
 * which lack a stable top-level MIME family; everything unrecognised falls to `other`.
 */
const MODEL_TYPES = new Set([
  'model/gltf-binary',
  'model/gltf+json',
  'model/obj',
  'model/stl',
  'application/octet-stream', // common fallback for .glb/.stl uploads
]);

export function attachmentKindFor(contentType: string): AttachmentKind {
  const ct = contentType.toLowerCase().split(';')[0].trim();
  if (ct.startsWith('image/')) return AttachmentKind.image;
  if (ct.startsWith('audio/')) return AttachmentKind.audio;
  if (ct.startsWith('text/')) return AttachmentKind.text;
  if (ct.startsWith('model/') || MODEL_TYPES.has(ct)) return AttachmentKind.model;
  return AttachmentKind.other;
}
