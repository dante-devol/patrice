/**
 * S3 adapter behaviour with the AWS SDK mocked — verifies it issues the right
 * commands and resolves a pre-signed download URL, without a live bucket.
 */
const sendMock = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: sendMock })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ __type: 'Put', input })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ __type: 'Get', input })),
  DeleteObjectCommand: jest.fn().mockImplementation((input) => ({ __type: 'Del', input })),
}));

const getSignedUrlMock = jest.fn();
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => getSignedUrlMock(...args),
}));

import { S3StorageAdapter } from './s3.adapter';

describe('S3StorageAdapter', () => {
  const cfg = { bucket: 'patrice', region: 'us-east-1', forcePathStyle: true };
  beforeEach(() => {
    sendMock.mockReset();
    getSignedUrlMock.mockReset();
  });

  it('uploads with PutObjectCommand carrying key + content type', async () => {
    sendMock.mockResolvedValue({});
    const s3 = new S3StorageAdapter(cfg);
    await s3.put('attachments/o/k', Buffer.from('data'), 'image/png');
    const cmd = sendMock.mock.calls[0][0];
    expect(cmd.__type).toBe('Put');
    expect(cmd.input).toMatchObject({
      Bucket: 'patrice',
      Key: 'attachments/o/k',
      ContentType: 'image/png',
    });
  });

  it('resolves a pre-signed download URL', async () => {
    getSignedUrlMock.mockResolvedValue('https://patrice.s3/signed?sig=abc');
    const s3 = new S3StorageAdapter(cfg);
    const url = await s3.getSignedUrl('attachments/o/k', 'photo.png');
    expect(url).toBe('https://patrice.s3/signed?sig=abc');
    const getCmd = getSignedUrlMock.mock.calls[0][1];
    expect(getCmd.input.Key).toBe('attachments/o/k');
    expect(getCmd.input.ResponseContentDisposition).toContain('photo.png');
  });
});
