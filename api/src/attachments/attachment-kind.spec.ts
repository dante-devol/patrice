import { attachmentKindFor } from './attachment-kind';

describe('attachmentKindFor', () => {
  it('classifies common MIME families', () => {
    expect(attachmentKindFor('image/png')).toBe('image');
    expect(attachmentKindFor('image/jpeg')).toBe('image');
    expect(attachmentKindFor('audio/mpeg')).toBe('audio');
    expect(attachmentKindFor('text/plain')).toBe('text');
    expect(attachmentKindFor('text/markdown; charset=utf-8')).toBe('text');
  });

  it('classifies 3D model types', () => {
    expect(attachmentKindFor('model/gltf-binary')).toBe('model');
    expect(attachmentKindFor('application/octet-stream')).toBe('model');
  });

  it('falls back to other', () => {
    expect(attachmentKindFor('application/pdf')).toBe('other');
    expect(attachmentKindFor('application/zip')).toBe('other');
  });
});
