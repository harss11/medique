import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { AppError } from "../../utils/http.js";

/**
 * File storage behind an interface so the provider can change (Cloudinary now,
 * S3 possible later). Files are never written to the API's local disk.
 */
export interface StoredFile {
  url: string;
  /** Provider key used to delete or replace the file later. */
  key: string;
}

export interface ImageUploadOptions {
  /** Folder below STORAGE_FOLDER, e.g. "hospitals/<id>/doctors" */
  folder: string;
  /** Square-crop around faces (doctor photos). */
  avatar?: boolean;
}

export interface StorageProvider {
  readonly name: string;
  readonly configured: boolean;
  uploadImage(file: Buffer, options: ImageUploadOptions): Promise<StoredFile>;
  delete(key: string): Promise<void>;
}

class CloudinaryStorage implements StorageProvider {
  readonly name = "cloudinary";
  readonly configured = true;

  constructor() {
    cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }

  uploadImage(file: Buffer, options: ImageUploadOptions): Promise<StoredFile> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `${env.STORAGE_FOLDER}/${options.folder}`,
          resource_type: "image",
          // Strip EXIF (GPS etc.) and bound the size; avatars become 600x600 face crops.
          transformation: options.avatar
            ? [{ width: 600, height: 600, crop: "fill", gravity: "face" }]
            : [{ width: 2000, height: 2000, crop: "limit" }],
          overwrite: false,
        },
        (error, result?: UploadApiResponse) => {
          if (error || !result) return reject(error ?? new Error("empty upload result"));
          resolve({ url: result.secure_url, key: result.public_id });
        },
      );
      stream.end(file);
    });
  }

  async delete(key: string): Promise<void> {
    await cloudinary.uploader.destroy(key, { resource_type: "image", invalidate: true });
  }
}

/** Used until Cloudinary keys are set: uploads fail with a clear 503. */
class UnconfiguredStorage implements StorageProvider {
  readonly name = "none";
  readonly configured = false;

  async uploadImage(): Promise<StoredFile> {
    throw new AppError(
      503,
      "STORAGE_NOT_CONFIGURED",
      "Photo uploads are not configured yet. Add the CLOUDINARY_* keys to the API .env.",
    );
  }

  async delete(): Promise<void> {
    // Nothing was ever stored.
  }
}

export const storage: StorageProvider =
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET
    ? new CloudinaryStorage()
    : new UnconfiguredStorage();

/** Best-effort delete: a leftover file must not fail the user's request. */
export async function deleteFileQuietly(key: string | null | undefined): Promise<void> {
  if (!key) return;
  try {
    await storage.delete(key);
  } catch (err) {
    logger.warn({ err, key }, "failed to delete stored file");
  }
}

// ---------------------------------------------------------------------------
// Image validation (by content, not by the client-supplied MIME type)
// ---------------------------------------------------------------------------

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function detectImageType(buf: Buffer): "jpeg" | "png" | "webp" | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "png";
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  return null;
}
