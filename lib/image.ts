// Server-side image downscaling. See SPEC.md → Image Handling Rules and
// Error Handling ("Image too large → downscale server-side to max 1568px long
// edge before sending to Claude").

import sharp from "sharp";

/** Max long-edge in pixels sent to Claude vision. SPEC.md → Image Handling. */
export const MAX_LONG_EDGE = 1568;

export type NormalizedMediaType = "image/png" | "image/jpeg";

export interface EncodedImage {
  data: string; // base64
  media_type: NormalizedMediaType;
}

function normalizeMediaType(mt: string, sharpFormat?: string): NormalizedMediaType {
  if (sharpFormat === "png" || mt === "image/png") return "image/png";
  return "image/jpeg";
}

/**
 * Downscale a base64 image so its long edge is at most MAX_LONG_EDGE, honoring
 * EXIF orientation. Only shrinks — never enlarges. PNG stays PNG; everything
 * else is re-encoded as JPEG. On any failure, returns the original bytes
 * unchanged (better to send a large image than to fail extraction).
 */
export async function downscaleImage(
  base64: string,
  mediaType: string,
): Promise<EncodedImage> {
  try {
    const input = Buffer.from(base64, "base64");
    const pipeline = sharp(input, { failOn: "none" }).rotate(); // apply EXIF orientation
    const meta = await pipeline.metadata();
    const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
    const outType = normalizeMediaType(mediaType, meta.format);

    let out = pipeline;
    if (longEdge > MAX_LONG_EDGE) {
      out = out.resize({
        width: MAX_LONG_EDGE,
        height: MAX_LONG_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      });
    }
    out = outType === "image/png" ? out.png() : out.jpeg({ quality: 82 });

    const buf = await out.toBuffer();
    return { data: buf.toString("base64"), media_type: outType };
  } catch {
    // Not a decodable image / sharp unavailable — pass through unchanged.
    return { data: base64, media_type: normalizeMediaType(mediaType) };
  }
}

/** Downscale a batch of images in parallel. */
export async function downscaleImages(
  images: Array<{ data: string; media_type: string }>,
): Promise<EncodedImage[]> {
  return Promise.all(images.map((img) => downscaleImage(img.data, img.media_type)));
}
