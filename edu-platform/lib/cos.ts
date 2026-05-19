/**
 * Tencent COS — S3-compatible client for chat image attachments.
 *
 * Uses the already-installed @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner.
 * COS accepts AWS Signature V4, so no additional SDK is required.
 *
 * Generated presigned URLs have the form:
 *   https://{bucket}.cos.{region}.myqcloud.com/{key}?X-Amz-Algorithm=...
 * which is a public HTTPS URL accessible by external vision models.
 */

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getCosConfig } from "@/lib/config";

const PRESIGN_TTL_SECONDS = 3600; // 1 hour

function buildCosClient(): S3Client {
  const c = getCosConfig();
  return new S3Client({
    region: c.region,
    // Virtual-host endpoint: the SDK will prefix the bucket to form
    //   https://{bucket}.cos.{region}.myqcloud.com/{key}
    endpoint: `https://cos.${c.region}.myqcloud.com`,
    forcePathStyle: false,
    credentials: {
      accessKeyId: c.secretId,
      secretAccessKey: c.secretKey,
    },
  });
}

let _cosClient: S3Client | null = null;

/** Lazily-initialized singleton — only calls getCosConfig() on first use. */
export function getCosClient(): S3Client {
  if (!_cosClient) _cosClient = buildCosClient();
  return _cosClient;
}

export async function putCosObject(params: {
  objectKey: string;
  body: Buffer;
  contentType?: string;
}): Promise<void> {
  const { bucket } = getCosConfig();
  await getCosClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: params.objectKey,
      Body: params.body,
      ContentType: params.contentType,
      ContentLength: params.body.byteLength,
    }),
  );
}

export async function getCosPresignedUrl(objectKey: string): Promise<string> {
  const { bucket } = getCosConfig();
  return getSignedUrl(
    getCosClient(),
    new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
    { expiresIn: PRESIGN_TTL_SECONDS },
  );
}
