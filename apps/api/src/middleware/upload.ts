import type { Request } from "express";
import multer from "multer";
import { MAX_IMAGE_BYTES, detectImageType } from "../services/storage/index.js";
import { AppError } from "../utils/http.js";

/**
 * Single image upload kept in memory (never written to disk) and streamed on
 * to the storage provider. Size is capped by multer; type is checked by the
 * file's actual bytes, not the client-declared MIME type.
 */
export const singleImage = (field: string) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 5 },
  }).single(field);

export function requireImage(req: Request): Buffer {
  const file = req.file;
  if (!file) throw AppError.badRequest("Attach an image file", "FILE_REQUIRED");
  if (!detectImageType(file.buffer)) {
    throw AppError.badRequest("Only JPEG, PNG or WebP images are allowed", "INVALID_FILE_TYPE");
  }
  return file.buffer;
}
