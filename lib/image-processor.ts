/**
 * Image processor
 *
 * For each product image:
 *  1. Download from the competitor URL
 *  2. Fully strip metadata (EXIF/IPTC/XMP) by re-encoding with sharp
 *     (sharp's default behavior on re-encoding is to drop metadata,
 *     unless you explicitly call .withMetadata())
 *  3. Upload to Shopify via the staged-upload process, so we control the
 *     bytes ourselves (instead of letting Shopify's "originalSource"
 *     download the competitor URL directly, which wouldn't strip the
 *     metadata)
 *
 * Shopify's staged-upload process in short:
 *  - stagedUploadsCreate: requests a temporary upload URL + parameters
 *  - POST the bytes to that URL (multipart/form-data, parameters FIRST,
 *    file as the LAST field — otherwise Shopify's storage rejects the
 *    upload)
 *  - the returned resourceUrl can be used as "originalSource" in the
 *    productSet mutation
 */

import sharp from "sharp";
import { shopifyGraphQL } from "./shopify-client";

export type ProcessedImage = {
  resourceUrl: string;
  filename: string;
};

const STAGED_UPLOADS_MUTATION = `
  mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`;

type StagedUploadsResponse = {
  stagedUploadsCreate: {
    stagedTargets: {
      url: string;
      resourceUrl: string;
      parameters: { name: string; value: string }[];
    }[];
    userErrors: { field: string[]; message: string }[];
  };
};

export class ImageProcessingError extends Error {}

/**
 * Downloads an image and strips all metadata by re-encoding it. Preserves
 * the original format (jpeg/png/webp) where possible.
 */
async function downloadAndStripMetadata(
  imageUrl: string
): Promise<{ buffer: Buffer; contentType: string; extension: string }> {
  const res = await fetch(imageUrl, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    throw new ImageProcessingError(`Could not download image (HTTP ${res.status}): ${imageUrl}`);
  }
  const originalBuffer = Buffer.from(await res.arrayBuffer());

  const image = sharp(originalBuffer);
  const metadata = await image.metadata();
  const format = metadata.format;

  // We always re-encode (never call .withMetadata()) — that's what
  // actually removes the EXIF/IPTC/XMP metadata.
  if (format === "png") {
    return { buffer: await image.png().toBuffer(), contentType: "image/png", extension: "png" };
  }
  if (format === "webp") {
    return { buffer: await image.webp({ quality: 90 }).toBuffer(), contentType: "image/webp", extension: "webp" };
  }
  // Fallback/default: jpeg (also covers gif/bmp/tiff sources as jpeg output)
  return { buffer: await image.jpeg({ quality: 90 }).toBuffer(), contentType: "image/jpeg", extension: "jpg" };
}

/**
 * Uploads an already-processed image (bytes) to Shopify via the
 * staged-upload process and returns the resourceUrl that can be used in
 * productSet.
 */
async function uploadToShopify(
  storeDomain: string,
  accessToken: string,
  buffer: Buffer,
  filename: string,
  contentType: string
): Promise<string> {
  const stagedResult = await shopifyGraphQL<StagedUploadsResponse>(
    storeDomain,
    accessToken,
    STAGED_UPLOADS_MUTATION,
    {
      input: [
        {
          filename,
          mimeType: contentType,
          resource: "PRODUCT_IMAGE",
          httpMethod: "POST",
          fileSize: String(buffer.byteLength),
        },
      ],
    }
  );

  if (stagedResult.stagedUploadsCreate.userErrors.length > 0) {
    throw new ImageProcessingError(
      `Requesting staged upload failed: ${stagedResult.stagedUploadsCreate.userErrors
        .map((e) => e.message)
        .join("; ")}`
    );
  }

  const target = stagedResult.stagedUploadsCreate.stagedTargets[0];
  if (!target) {
    throw new ImageProcessingError("No staged upload target received from Shopify.");
  }

  const formData = new FormData();
  // Parameters MUST be added before the file — otherwise Shopify's
  // storage backend rejects the upload.
  for (const param of target.parameters) {
    formData.append(param.name, param.value);
  }
  formData.append("file", new Blob([new Uint8Array(buffer)], { type: contentType }), filename);

  const uploadRes = await fetch(target.url, { method: "POST", body: formData });
  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => "");
    throw new ImageProcessingError(
      `Upload to Shopify storage failed (HTTP ${uploadRes.status}): ${text.slice(0, 300)}`
    );
  }

  return target.resourceUrl;
}

/**
 * Fully processes one image: download, strip metadata, rename to
 * `${slug}-${index}.ext`, and upload to Shopify.
 */
export async function processProductImage(
  imageUrl: string,
  slug: string,
  index: number,
  storeDomain: string,
  accessToken: string
): Promise<ProcessedImage> {
  const { buffer, contentType, extension } = await downloadAndStripMetadata(imageUrl);
  const filename = `${slug}-${index}.${extension}`;
  const resourceUrl = await uploadToShopify(storeDomain, accessToken, buffer, filename, contentType);
  return { resourceUrl, filename };
}
